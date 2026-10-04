// P0+P1 orchestrator: the entry point for the hourly workflow and for manual runs (SPEC.md §3.1).
//
// Usage:
//   node scripts/run-pipeline.js                    fetch, then generate for every eligible finished match
//   node scripts/run-pipeline.js --match <id>       fetch, then only that match (normal eligibility rules)
//   node scripts/run-pipeline.js --match <id> --dry-run
//       One attempt per perspective of a finished match, ignoring eligibility. Prints every
//       candidate with its pass/fail result as JSON on stdout (logs go to stderr) and saves the
//       same JSON to review/dryrun-<id>.json. Skips the fetch and writes nothing to Supabase.
//
// Exits non-zero if the fetch fails, or if any model call or comment write fails. A perspective
// whose attempt failed keeps its old attempt counter and is retried on the next run.

const fs = require('fs');
const path = require('path');
const { getServiceClient, unwrap } = require('./lib/supabase-client');
const { GENERATION_MODEL } = require('./lib/claude-client');
const { PROMPT_VERSION, buildMatchData, londonIsoDate } = require('./lib/match-data');
const { MIN_PASSING_COUNT, MAX_COMMENTS_PER_PERSPECTIVE, MAX_GENERATION_ATTEMPTS } = require('./lib/constants');

const USAGE = 'usage: node scripts/run-pipeline.js [--match <id> [--dry-run]]';
const SIDES = ['home', 'away'];
const CHECK_CONCURRENCY = 4;
const PAGE_SIZE = 1000;
const ID_CHUNK = 100;
const REVIEW_DIR = path.join(__dirname, '..', 'review');

let log = console.log; // a dry run sends logs to stderr so stdout stays pure JSON

function parseArgs(argv) {
  const opts = { matchId: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--match') opts.matchId = argv[++i] ?? '';
    else if (argv[i] === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (opts.matchId !== null && !/^\d+$/.test(opts.matchId)) {
    throw new Error(`--match expects a numeric football-data.org match id, got "${opts.matchId}"`);
  }
  if (opts.dryRun && opts.matchId === null) throw new Error('--dry-run must be combined with --match <id>');
  return opts;
}

// SPEC.md §3.1 step 4: duplicates are matched case-insensitively, whitespace-trimmed.
const dedupeKey = (text) => text.trim().toLowerCase();

function newStats() {
  return { generationCalls: 0, safetyCheckCalls: 0, inputTokens: 0, outputTokens: 0 };
}

function addUsage(stats, usage) {
  stats.inputTokens += usage.input_tokens;
  stats.outputTokens += usage.output_tokens;
}

// ---------------------------------------------------------------- model work

// Runs fn over items, at most `limit` at a time, and never rejects. After the first outright
// failure no new call starts (the attempt is void anyway); calls already in flight finish.
async function settleWithLimit(items, limit, fn) {
  const results = items.map(() => ({ status: 'skipped' }));
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// One generation call, then a safety check per well-formed candidate. Returns every candidate
// with its verdict. Throws if any model call failed outright, after counting the ones that returned.
async function runAttempt(matchData, stats, deps) {
  const gen = await deps.generateComments(matchData);
  stats.generationCalls += 1;
  addUsage(stats, gen.usage);

  const toCheck = gen.candidates.filter((c) => !c.rejected);
  const settled = await settleWithLimit(toCheck, CHECK_CONCURRENCY, (c) => deps.safetyCheck(matchData, c));
  const verdicts = new Map();
  let failure = null;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      stats.safetyCheckCalls += 1;
      addUsage(stats, s.value.usage);
      verdicts.set(toCheck[i], s.value);
    } else if (s.status === 'rejected' && !failure) {
      failure = s.reason;
    }
  });
  if (failure) throw failure;

  const candidates = gen.candidates.map((c) => {
    const verdict = verdicts.get(c);
    return {
      type: c.type,
      text: c.text,
      note: c.note,
      result: verdict ? verdict.result : 'fail',
      reason: verdict ? verdict.reason : c.rejected,
    };
  });
  return {
    candidates,
    generation: { stop_reason: gen.stopReason, usage: gen.usage, parse_error: gen.parseError, raw_text: gen.rawText },
  };
}

// ---------------------------------------------------------------- Supabase

// Reads every row of an ordered query, a page at a time, until a page comes back empty, so a
// lower max-rows setting on the project can't silently truncate the result.
async function readAll(buildQuery, context) {
  const rows = [];
  for (;;) {
    const page = unwrap(await buildQuery().range(rows.length, rows.length + PAGE_SIZE - 1), context);
    if (page.length === 0) return rows;
    rows.push(...page);
  }
}

async function readMatch(supabase, matchId) {
  const rows = unwrap(await supabase.from('matches').select('*').eq('id', matchId), `read match ${matchId}`);
  return rows[0] ?? null;
}

// Every finished match with at least one perspective still under the attempt cap, oldest first.
function readCandidateMatches(supabase) {
  return readAll(
    () => supabase.from('matches').select('*').eq('status', 'finished')
      .or(`home_generation_attempts.lt.${MAX_GENERATION_ATTEMPTS},away_generation_attempts.lt.${MAX_GENERATION_ATTEMPTS}`)
      .order('kickoff_at').order('id'),
    'read finished matches',
  );
}

async function readTeams(supabase) {
  const rows = unwrap(await supabase.from('teams').select('id, short_name, tla, slug'), 'read teams');
  return new Map(rows.map((t) => [t.id, t]));
}

// Live (not superseded) comment counts keyed by "<match id>:<perspective team id>".
async function readLiveCounts(supabase, matchIds) {
  const counts = new Map();
  for (let i = 0; i < matchIds.length; i += ID_CHUNK) {
    const chunk = matchIds.slice(i, i + ID_CHUNK);
    const rows = await readAll(
      () => supabase.from('comments').select('id, match_id, perspective_team_id')
        .in('match_id', chunk).is('superseded_at', null).order('id'),
      'read live comment counts',
    );
    for (const r of rows) {
      const key = `${r.match_id}:${r.perspective_team_id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

async function readLiveTexts(supabase, matchId, teamId) {
  const rows = await readAll(
    () => supabase.from('comments').select('id, text').eq('match_id', matchId)
      .eq('perspective_team_id', teamId).is('superseded_at', null).order('id'),
    `read live comments for match ${matchId}`,
  );
  return rows.map((r) => r.text);
}

// Moves an attempt counter from `from` to `to` only if it still reads `from`, so two overlapping
// runs can't both claim the same attempt. Returns whether the update happened.
async function moveAttemptCounter(supabase, matchId, field, from, to) {
  const rows = unwrap(
    await supabase.from('matches').update({ [field]: to }).eq('id', matchId).eq(field, from).select('id'),
    `set ${field} ${from} -> ${to} on match ${matchId}`,
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------- pipeline

function matchLabel(match, teams) {
  return `${londonIsoDate(match.kickoff_at)} ${teams.get(match.home_team_id).tla} v ${teams.get(match.away_team_id).tla}`;
}

function sideTeams(match, side, teams) {
  const [own, other] = side === 'home' ? [match.home_team_id, match.away_team_id] : [match.away_team_id, match.home_team_id];
  return { team: teams.get(own), opponent: teams.get(other) };
}

function describeFailure(err) {
  const status = err?.status ? ` ${err.status}` : '';
  return `${err?.name ?? 'Error'}${status}: ${err?.message ?? err}`;
}

// SPEC.md §3.1 steps 2-5 for one perspective. Returns a report for the summary line.
async function processPerspective(supabase, match, side, teams, liveCount, stats, deps, label) {
  const { team, opponent } = sideTeams(match, side, teams);
  const field = `${side}_generation_attempts`;
  let attempts = match[field];
  let live = liveCount;
  const report = { slug: team.slug, attempts: [], live, failed: false, note: null };

  if (!(live < MIN_PASSING_COUNT && attempts < MAX_GENERATION_ATTEMPTS)) return report;

  const matchData = buildMatchData(match, team, opponent);
  const liveKeys = new Set((await readLiveTexts(supabase, match.id, team.id)).map(dedupeKey));

  while (live < MIN_PASSING_COUNT && attempts < MAX_GENERATION_ATTEMPTS) {
    if (!(await moveAttemptCounter(supabase, match.id, field, attempts, attempts + 1))) {
      report.note = 'attempt counter changed by another run; skipped';
      log(`WARNING ${label} ${team.slug}: ${report.note}`);
      break;
    }
    attempts += 1;

    let attempt;
    try {
      attempt = await runAttempt(matchData, stats, deps);
    } catch (err) {
      await undoAttempt(supabase, match.id, field, attempts);
      log(`MODEL CALL FAILED: ${label} ${team.slug} attempt ${attempts}: ${describeFailure(err)}; nothing written, attempt undone, retried next run`);
      report.failed = true;
      break;
    }
    if (attempt.generation.parse_error) log(`${label} ${team.slug} attempt ${attempts}: ${attempt.generation.parse_error}`);

    const rows = [];
    for (const c of attempt.candidates) {
      if (c.result !== 'pass') {
        log(`  FAILED ${label} ${team.slug} [${c.type}] ${JSON.stringify(c.text)}: ${c.reason}`);
        continue;
      }
      const key = dedupeKey(c.text);
      if (liveKeys.has(key)) {
        log(`  DROPPED ${label} ${team.slug} [${c.type}] ${JSON.stringify(c.text)}: duplicate of a live comment`);
        continue;
      }
      if (live + rows.length >= MAX_COMMENTS_PER_PERSPECTIVE) {
        log(`  DROPPED ${label} ${team.slug} [${c.type}] ${JSON.stringify(c.text)}: perspective already has ${MAX_COMMENTS_PER_PERSPECTIVE} live comments`);
        continue;
      }
      liveKeys.add(key);
      rows.push({
        match_id: match.id,
        perspective_team_id: team.id,
        type: c.type,
        text: c.text,
        note: c.note,
        prompt_version: PROMPT_VERSION,
      });
    }

    if (rows.length) {
      const { error } = await supabase.from('comments').insert(rows);
      if (error) {
        await undoAttempt(supabase, match.id, field, attempts);
        log(`WRITE FAILED: ${label} ${team.slug} attempt ${attempts}: ${error.message}; attempt undone, retried next run`);
        report.failed = true;
        break;
      }
    }
    live += rows.length;
    const passed = attempt.candidates.filter((c) => c.result === 'pass').length;
    report.attempts.push({ number: attempts, passed, returned: attempt.candidates.length, written: rows.length });
  }

  report.live = live;
  return report;
}

async function undoAttempt(supabase, matchId, field, attempts) {
  try {
    await moveAttemptCounter(supabase, matchId, field, attempts, attempts - 1);
  } catch (err) {
    log(`WARNING could not undo ${field} on match ${matchId}: ${err.message}`);
  }
}

function formatPerspective(report) {
  if (report.attempts.length === 0) {
    const base = `${report.slug}: ${report.live} stored`;
    if (report.failed) return `${base}, MODEL CALL FAILED (retried next run)`;
    if (report.note) return `${base} (${report.note})`;
    return report.live < MIN_PASSING_COUNT ? `${base} (attempt cap reached)` : base;
  }
  const parts = report.attempts.map((a) => `${a.passed}/${a.returned} passed (attempt ${a.number})`).join(', then ');
  const passed = report.attempts.reduce((n, a) => n + a.passed, 0);
  const written = report.attempts.reduce((n, a) => n + a.written, 0);
  let line = `${report.slug}: ${parts}`;
  if (written !== passed) line += ` [${written} written]`;
  if (report.failed) line += ', then MODEL CALL FAILED (retried next run)';
  return line;
}

function printTotals(stats, print) {
  print(`generation calls this run: ${stats.generationCalls}`);
  print(`safety-check calls this run: ${stats.safetyCheckCalls}`);
  print(`model tokens this run: ${stats.inputTokens} input, ${stats.outputTokens} output`);
}

async function runNormal(opts, deps) {
  if (deps.fetchMatches) {
    const fetched = await deps.fetchMatches();
    if (fetched) require('./fetch-matches').logFetchSummary(fetched);
  }
  const supabase = deps.supabase;
  const stats = newStats();
  let matches;
  if (opts.matchId) {
    const match = await readMatch(supabase, opts.matchId);
    if (!match) throw new Error(`match ${opts.matchId} is not in Supabase`);
    if (match.status !== 'finished') {
      log(`match ${match.id} is '${match.status}', not finished: nothing to generate`);
      matches = [];
    } else {
      matches = [match];
    }
  } else {
    matches = await readCandidateMatches(supabase);
  }

  let ok = true;
  if (matches.length) {
    const teams = await readTeams(supabase);
    const liveCounts = await readLiveCounts(supabase, matches.map((m) => m.id));
    for (const match of matches) {
      const label = matchLabel(match, teams);
      const reports = [];
      for (const side of SIDES) {
        const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
        const report = await processPerspective(supabase, match, side, teams, liveCounts.get(`${match.id}:${teamId}`) ?? 0, stats, deps, label);
        if (report.failed) ok = false;
        reports.push(report);
      }
      const touched = reports.some((r) => r.attempts.length || r.failed || r.note);
      if (touched || opts.matchId) log(`${label} — ${reports.map(formatPerspective).join(', ')}`);
    }
  }
  printTotals(stats, log);
  return { ok, stats };
}

async function runDry(opts, deps) {
  const supabase = deps.supabase;
  const match = await readMatch(supabase, opts.matchId);
  if (!match) throw new Error(`match ${opts.matchId} is not in Supabase`);
  if (match.status !== 'finished') throw new Error(`--dry-run needs a finished match; ${match.id} is '${match.status}'`);
  const teams = await readTeams(supabase);
  const label = matchLabel(match, teams);
  const stats = newStats();

  const ht = match.home_ht_score == null ? '' : ` (HT ${match.home_ht_score}-${match.away_ht_score})`;
  const output = {
    dry_run: true,
    match_id: match.id,
    match: label,
    score: `${match.home_score}-${match.away_score}${ht}`,
    prompt_version: PROMPT_VERSION,
    generation_model: GENERATION_MODEL,
    run_at: new Date().toISOString(),
    perspectives: [],
  };

  let ok = true;
  for (const side of SIDES) {
    const { team, opponent } = sideTeams(match, side, teams);
    const matchData = buildMatchData(match, team, opponent);
    const perspective = { side, team_id: team.id, team: team.short_name, slug: team.slug, match_data: matchData };
    try {
      const attempt = await runAttempt(matchData, stats, deps);
      perspective.generation = attempt.generation;
      perspective.passed = attempt.candidates.filter((c) => c.result === 'pass').length;
      perspective.returned = attempt.candidates.length;
      perspective.candidates = attempt.candidates;
      if (attempt.generation.parse_error) log(`${label} ${team.slug}: ${attempt.generation.parse_error}`);
    } catch (err) {
      perspective.error = `MODEL CALL FAILED: ${describeFailure(err)}`;
      log(`${label} ${team.slug}: ${perspective.error}`);
      ok = false;
    }
    output.perspectives.push(perspective);
  }

  output.calls = { generation: stats.generationCalls, safety_check: stats.safetyCheckCalls };
  output.tokens = { input: stats.inputTokens, output: stats.outputTokens };

  const json = `${JSON.stringify(output, null, 2)}\n`;
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  const reviewFile = path.join(REVIEW_DIR, `dryrun-${match.id}.json`);
  fs.writeFileSync(reviewFile, json);
  process.stdout.write(json);

  const summary = output.perspectives
    .map((p) => (p.error ? `${p.slug}: ${p.error}` : `${p.slug}: ${p.passed}/${p.returned} passed`))
    .join(', ');
  log(`${label} (dry run, nothing written) — ${summary}`);
  printTotals(stats, log);
  log(`dry-run output saved to ${path.relative(process.cwd(), reviewFile)}`);
  return { ok, stats, output };
}

function defaultDeps() {
  return {
    supabase: getServiceClient(),
    fetchMatches: require('./fetch-matches').fetchMatches,
    generateComments: require('./generate-comments').generateComments,
    safetyCheck: require('./safety-check').safetyCheck,
  };
}

async function runPipeline(opts, deps = defaultDeps()) {
  log = opts.dryRun ? console.error : console.log;
  return opts.dryRun ? runDry(opts, deps) : runNormal(opts, deps);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`run-pipeline: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { ok } = await runPipeline(opts);
  // exitCode rather than exit(): a dry run's JSON on a pipe must be flushed before the process ends.
  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`run-pipeline failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runPipeline, parseArgs };
