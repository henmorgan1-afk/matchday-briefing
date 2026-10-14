// P0+P1 orchestrator: the entry point for the hourly workflow and for manual runs (SPEC.md §3.1).
//
// Usage:
//   node scripts/run-pipeline.js                    fetch, then generate for every eligible finished match
//   node scripts/run-pipeline.js --match <id>       fetch, then only that match (normal eligibility rules)
//   node scripts/run-pipeline.js --match <id> --dry-run
//       One attempt per perspective of a finished match, ignoring eligibility (the generation gate
//       included). Uses the stored FPL player data, if any. Prints every candidate with each step's
//       result as JSON on stdout (logs go to stderr) and saves the same JSON to
//       review/dryrun-<id>.json. Skips the fetch and writes nothing to Supabase.
//
// Each side's lines go through these steps in order (Revision 21), each seeing only the lines that
// passed every step before it: generate; format check (with dashes replaced); first checker; code
// gate; claim check; second checker (Groq by default, lib/second-checker.js); duplicates and variety;
// pick the best (lib/select-lines.js, at most MAX_PUBLISHED_PER_PERSPECTIVE live lines); write.
//
// Exits non-zero if the fetch or its FPL step fails, or if any model call or comment write fails.
// A perspective whose attempt failed keeps its old attempt counter and is retried on the next run.
// Some stops end the run's model calls early: the attempt in progress is undone, no new match starts,
// and the remaining matches are done on a later run. Cloudflare's free daily AI allowance running out
// and Groq's daily limit leave the exit code alone (Revisions 18 and 21); Groq down after retries,
// an unknown or withdrawn Groq model, or a rejected Groq key make it non-zero. GROQ_API_KEY missing
// at start-up means nothing is generated and the run exits non-zero. The 40-minute limit on starting
// a new match leaves the exit code alone.

const fs = require('fs');
const path = require('path');
const { getServiceClient, unwrap, readAll } = require('./lib/supabase-client');
const {
  PROVIDER, GENERATION_MODEL, CHECK_MODEL, CLAIM_MODEL, AI_DESCRIPTION, isAllowanceUsedUp, neuronSummary,
} = require('./lib/ai-client');
const { PROMPT_VERSION, buildMatchData, londonIsoDate } = require('./lib/match-data');
const { codeGateProblems, openingWords } = require('./lib/code-gate');
const { readPlayerData, readNameIndex, perspectiveNames } = require('./lib/player-data');
const { selectLines } = require('./lib/select-lines');
const { SECOND_CHECK } = require('./lib/second-checker');
const { GROQ_REASONING, GroqError, createGroqClient } = require('./lib/groq-client');
const {
  MIN_PASSING_COUNT, MAX_PUBLISHED_PER_PERSPECTIVE, MAX_GENERATION_ATTEMPTS, PLAYER_DATA_READY,
} = require('./lib/constants');

const USAGE = 'usage: node scripts/run-pipeline.js [--match <id> [--dry-run]]';
const SIDES = ['home', 'away'];
const ID_CHUNK = 100;
const REVIEW_DIR = path.join(__dirname, '..', 'review');
// No new match is started after this much run time; pipeline.yml's timeout-minutes is 60 (Revision 18).
const NEW_MATCH_CUTOFF_MINUTES = 40;
const ALLOWANCE_LINE = 'The free daily AI allowance is used up, so the remaining matches will be done on a later run.';
const GROQ_DAILY_LINE = "Groq's free daily limit is used up, so the remaining matches will be done on a later run.";
const CUTOFF_LINE = `This run has been going for ${NEW_MATCH_CUTOFF_MINUTES} minutes, so the remaining matches will be done on a later run.`;
const GROQ_KEY_MISSING_LINE = 'GROQ_API_KEY is missing, so nothing is generated this run.';
const STEPS = ['format', 'checker', 'code_gate', 'claim_check', 'second_check', 'variety', 'selection'];
const FIRST_CHECKER = `first checker (${CHECK_MODEL})`;

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
  return {
    generationCalls: 0, safetyCheckCalls: 0, claimCheckCalls: 0, secondCheckCalls: 0,
    inputTokens: 0, outputTokens: 0, neurons: 0,
    byModel: {}, // Cloudflare (or Ollama) model -> { calls, input, output, neurons }
    groq: { calls: 0, input: 0, output: 0 },
  };
}

// A call to the AI_PROVIDER's endpoint.
function addUsage(stats, model, usage) {
  stats.inputTokens += usage.input_tokens;
  stats.outputTokens += usage.output_tokens;
  stats.neurons += usage.neurons ?? 0;
  const m = (stats.byModel[model] ??= { calls: 0, input: 0, output: 0, neurons: 0 });
  m.calls += 1;
  m.input += usage.input_tokens;
  m.output += usage.output_tokens;
  m.neurons += usage.neurons ?? 0;
}

// The stop an error calls for: { line, fail } when the run must make no more model calls (fail: the
// run exits non-zero), or null for an ordinary outright failure of this attempt.
function stopFor(err) {
  if (isAllowanceUsedUp(err)) return { line: ALLOWANCE_LINE, fail: false, kind: 'allowance' };
  if (err instanceof GroqError) {
    if (err.kind === 'daily_limit') return { line: GROQ_DAILY_LINE, fail: false, kind: 'groq_daily_limit' };
    if (err.kind === 'unavailable') return { line: `GROQ UNAVAILABLE: ${err.message}. The remaining matches will be done on a later run.`, fail: true, kind: 'groq_unavailable' };
    if (err.kind === 'model_unavailable') return { line: `GROQ MODEL UNAVAILABLE: ${err.message}. Nothing more is generated; switch the second checker in scripts/lib/second-checker.js if Groq has withdrawn it.`, fail: true, kind: 'groq_model_unavailable' };
    if (err.kind === 'key_rejected') return { line: `GROQ KEY REJECTED: ${err.message}. Nothing more is generated; check the GROQ_API_KEY secret.`, fail: true, kind: 'groq_key_rejected' };
  }
  return null;
}

// ---------------------------------------------------------------- model work

const notReached = () => Object.fromEntries(STEPS.map((s) => [s, 'not reached']));

// A verdict that didn't pass, as the candidate's result fields. "unsure" from either checker is its own
// failed_by, naming the checker in the reason (Revision 21).
function verdictFailure(verdict, failedBy, checkerName) {
  if (verdict.result === 'unsure') return { result: 'fail', failed_by: 'unsure', reason: `unsure (${checkerName}): ${verdict.reason}` };
  return { result: 'fail', failed_by: failedBy, reason: failedBy === 'checker' ? verdict.reason : `${checkerName}: ${verdict.reason}` };
}

// One attempt for one side, up to and including the second checker (Revision 21's steps 1-6):
// generation, the format check, the first checker on every well-formed line, the code gate, the claim
// check and the second checker, each step only on the lines that passed every step before it.
// `names` is the perspective's name context for the gate's name rules. Returns every candidate with
// each step's result; result "pass" means it passed all six. Throws if a model call failed outright,
// after counting the calls that returned.
async function runAttempt(matchData, names, stats, deps) {
  const gen = await deps.generateComments(matchData);
  stats.generationCalls += 1;
  addUsage(stats, GENERATION_MODEL, gen.usage);

  const candidates = gen.candidates.map((c) => {
    const steps = notReached();
    steps.format = c.rejected ? 'fail' : 'pass';
    return {
      type: c.type,
      text: c.text,
      note: c.note,
      result: c.rejected ? 'fail' : 'pass',
      reason: c.rejected ?? '',
      failed_by: c.rejected ? 'format' : undefined,
      steps,
    };
  });
  const passing = () => candidates.filter((c) => c.result === 'pass');
  const out = { candidates, generation: { stop_reason: gen.stopReason, usage: gen.usage, parse_error: gen.parseError, raw_text: gen.rawText } };

  // 3. First checker, one call for the side's well-formed lines.
  let lines = passing();
  if (lines.length) {
    const check = await deps.safetyCheck(matchData, lines);
    stats.safetyCheckCalls += 1;
    addUsage(stats, CHECK_MODEL, check.usage);
    out.check = { stop_reason: check.stopReason, usage: check.usage, problem: check.problem, raw_text: check.rawText };
    lines.forEach((c, i) => {
      const verdict = check.verdicts[i];
      c.rule_checks = verdict.rules; // for review only; never stored
      c.steps.checker = verdict.result;
      if (verdict.result !== 'pass') Object.assign(c, verdictFailure(verdict, 'checker', FIRST_CHECKER));
    });
  }

  // 4. Code gate (Revision 7; idea 3's number rule since Revision 21).
  for (const c of passing()) {
    const problems = codeGateProblems(c, matchData, names);
    c.steps.code_gate = problems.length ? 'fail' : 'pass';
    if (problems.length) Object.assign(c, { result: 'fail', reason: `code gate: ${problems.join('; ')}`, failed_by: 'code_gate' });
  }

  // 5. Claim check, one call for the lines left.
  lines = passing();
  if (lines.length) {
    const claims = await deps.claimCheck(matchData, lines);
    stats.claimCheckCalls += 1;
    addUsage(stats, CLAIM_MODEL, claims.usage);
    out.claim_check = { stop_reason: claims.stopReason, usage: claims.usage, problem: claims.problem, raw_text: claims.rawText };
    lines.forEach((c, i) => {
      const r = claims.results[i];
      Object.assign(c, { claims: r.claims, claims_checked: r.checked });
      c.steps.claim_check = r.result;
      if (r.result !== 'pass') Object.assign(c, { result: 'fail', reason: r.reason, failed_by: 'claim_check' });
    });
  }

  // 6. Second checker, on the lines left. A line goes live only if both checkers pass it.
  lines = passing();
  if (lines.length) {
    const second = await deps.secondCheck(matchData, lines);
    stats.secondCheckCalls += second.calls.length;
    if (SECOND_CHECK.provider === 'groq') {
      stats.groq.calls += second.calls.length;
      stats.groq.input += second.usage.input_tokens;
      stats.groq.output += second.usage.output_tokens;
    } else {
      for (const call of second.calls) addUsage(stats, SECOND_CHECK.model, call.usage);
    }
    out.second_check = { checker: SECOND_CHECK.name, calls: second.calls, usage: second.usage, problem: second.problem };
    lines.forEach((c, i) => {
      const verdict = second.verdicts[i];
      c.second_rule_checks = verdict.rules;
      c.steps.second_check = verdict.result;
      if (verdict.result !== 'pass') Object.assign(c, verdictFailure(verdict, SECOND_CHECK.failedBy, SECOND_CHECK.name));
    });
  }
  return out;
}

// Steps 7 and 8 for one attempt's candidates: duplicates of the perspective's live lines, variety
// (first three words) against `openings` (lines already written or chosen for either side) and the
// side's own earlier passing lines, then the pick of the best into the places left. Marks every
// candidate and returns the chosen ones, in the order the model wrote them. Only chosen lines add
// their opening words to `openings`.
function finishAttempt(candidates, { liveKeys, openings, liveTypes, places }) {
  const publishable = [];
  const ownOpenings = new Set();
  for (const c of candidates) {
    if (c.result !== 'pass') continue;
    const opening = openingWords(c.text);
    if (liveKeys.has(dedupeKey(c.text))) {
      Object.assign(c, { result: 'fail', reason: 'duplicate of a live comment', failed_by: 'duplicate' });
      c.steps.variety = 'fail';
    } else if (openings.has(opening) || ownOpenings.has(opening)) {
      Object.assign(c, { result: 'fail', reason: `variety: opens with the same three words as a line already passed for this match, ${JSON.stringify(opening)}`, failed_by: 'variety' });
      c.steps.variety = 'fail';
    } else {
      c.steps.variety = 'pass';
      ownOpenings.add(opening);
      publishable.push(c);
    }
  }
  const chosen = new Set(selectLines(publishable, places, liveTypes));
  for (const c of publishable) {
    c.published = chosen.has(c);
    c.steps.selection = c.published ? 'chosen' : 'not chosen';
    if (c.published) {
      openings.add(openingWords(c.text));
      liveKeys.add(dedupeKey(c.text));
      liveTypes.push(c.type);
    } else {
      Object.assign(c, {
        result: 'fail',
        failed_by: 'not_selected',
        reason: `not selected: ${publishable.length} lines passed every step for ${Math.max(places, 0)} place${places === 1 ? '' : 's'}, so types took turns and lines with fewer checked claims came first`,
      });
    }
  }
  for (const c of candidates) c.published ??= false;
  return { publishable, chosen: candidates.filter((c) => c.published) };
}

// ---------------------------------------------------------------- Supabase

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

// One perspective's live comments, as { text, type }.
function readLiveLines(supabase, matchId, teamId) {
  return readAll(
    () => supabase.from('comments').select('id, text, type').eq('match_id', matchId)
      .eq('perspective_team_id', teamId).is('superseded_at', null).order('id'),
    `read live comments for match ${matchId}`,
  );
}

// Live comment texts for both perspectives of a match, for the variety check.
async function readLiveMatchTexts(supabase, matchId) {
  const rows = await readAll(
    () => supabase.from('comments').select('id, text').eq('match_id', matchId).is('superseded_at', null).order('id'),
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

// The run's name index, and each match's stored player data and opening words, each read at most
// once, and only when a perspective actually needs an attempt.
function runContext(supabase) {
  let nameIndex = null;
  const playerData = new Map();
  const openings = new Map();
  return {
    async nameIndex() {
      nameIndex ??= await readNameIndex(supabase);
      return nameIndex;
    },
    async playerData(match) {
      if (!playerData.has(match.id)) playerData.set(match.id, await readPlayerData(supabase, match));
      return playerData.get(match.id);
    },
    // The first three words of every line written for either side of the match: its live comments,
    // plus every line this run writes for it (the Set is shared by both perspectives).
    async openings(match) {
      if (!openings.has(match.id)) openings.set(match.id, new Set((await readLiveMatchTexts(supabase, match.id)).map(openingWords)));
      return openings.get(match.id);
    },
  };
}

// SPEC.md §3.1 step 2's first two conditions: under MIN_PASSING_COUNT live comments, under the attempt cap.
function needsAttempt(match, side, live) {
  return live < MIN_PASSING_COUNT && match[`${side}_generation_attempts`] < MAX_GENERATION_ATTEMPTS;
}

// SPEC.md §3.1 steps 2-5 for one perspective. Returns a report for the summary line. The match has
// already passed the generation gate.
async function processPerspective(supabase, match, side, teams, liveCount, stats, deps, label, ctx) {
  const { team, opponent } = sideTeams(match, side, teams);
  const field = `${side}_generation_attempts`;
  let attempts = match[field];
  let live = liveCount;
  const report = { slug: team.slug, attempts: [], live, failed: false, deferred: false, stop: null, note: null };

  if (!needsAttempt(match, side, live)) return report;

  const playerData = await ctx.playerData(match);
  const matchData = buildMatchData(match, team, opponent, playerData);
  const names = perspectiveNames(await ctx.nameIndex(), match, team, playerData);
  const liveLines = await readLiveLines(supabase, match.id, team.id);
  const liveKeys = new Set(liveLines.map((r) => dedupeKey(r.text)));
  const liveTypes = liveLines.map((r) => r.type);
  const openings = await ctx.openings(match);

  while (live < MIN_PASSING_COUNT && attempts < MAX_GENERATION_ATTEMPTS) {
    if (!(await moveAttemptCounter(supabase, match.id, field, attempts, attempts + 1))) {
      report.note = 'attempt counter changed by another run; skipped';
      log(`WARNING ${label} ${team.slug}: ${report.note}`);
      break;
    }
    attempts += 1;

    let attempt;
    try {
      attempt = await runAttempt(matchData, names, stats, deps);
    } catch (err) {
      await undoAttempt(supabase, match.id, field, attempts);
      const stop = stopFor(err);
      if (stop) {
        // The caller logs the stop's line once and makes no more model calls.
        Object.assign(report, { deferred: true, stop });
        break;
      }
      log(`MODEL CALL FAILED: ${label} ${team.slug} attempt ${attempts}: ${describeFailure(err)}; nothing written, attempt undone, retried next run`);
      report.failed = true;
      break;
    }
    if (attempt.generation.parse_error) log(`${label} ${team.slug} attempt ${attempts}: ${attempt.generation.parse_error}`);
    if (attempt.check?.problem) log(`${label} ${team.slug} attempt ${attempts}: checker: ${attempt.check.problem}`);
    if (attempt.claim_check?.problem) log(`${label} ${team.slug} attempt ${attempts}: claim check: ${attempt.claim_check.problem}`);
    if (attempt.second_check?.problem) log(`${label} ${team.slug} attempt ${attempts}: ${SECOND_CHECK.name}: ${attempt.second_check.problem}`);

    const places = MAX_PUBLISHED_PER_PERSPECTIVE - live;
    const { publishable, chosen } = finishAttempt(attempt.candidates, { liveKeys, openings, liveTypes, places });
    for (const c of attempt.candidates) {
      if (c.published) continue;
      const verb = ['duplicate', 'variety', 'not_selected'].includes(c.failed_by) ? 'DROPPED' : 'FAILED';
      log(`  ${verb} ${label} ${team.slug} [${c.type}] ${JSON.stringify(c.text)}: ${c.reason}`);
    }
    const rows = chosen.map((c) => ({
      match_id: match.id,
      perspective_team_id: team.id,
      type: c.type,
      text: c.text,
      note: c.note,
      prompt_version: PROMPT_VERSION,
    }));

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
    report.attempts.push({ number: attempts, passed: publishable.length, returned: attempt.candidates.length, written: rows.length });
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
    if (report.deferred) return `${base}, deferred to a later run`;
    if (report.note) return `${base} (${report.note})`;
    return report.live < MIN_PASSING_COUNT ? `${base} (attempt cap reached)` : base;
  }
  const parts = report.attempts.map((a) => `${a.passed}/${a.returned} passed (attempt ${a.number})`).join(', then ');
  const passed = report.attempts.reduce((n, a) => n + a.passed, 0);
  const written = report.attempts.reduce((n, a) => n + a.written, 0);
  let line = `${report.slug}: ${parts}`;
  if (written !== passed) line += ` [${written} written]`;
  if (report.failed) line += ', then MODEL CALL FAILED (retried next run)';
  if (report.deferred) line += ', then deferred to a later run';
  return line;
}

const reasoningDescription = () => (SECOND_CHECK.provider === 'groq'
  ? `, reasoning_effort ${GROQ_REASONING.reasoning_effort}, reasoning_format ${GROQ_REASONING.reasoning_format}` : '');

function printTotals(stats, print, deps, startedAt) {
  const groqStats = deps.groqStats;
  print(`AI provider: ${AI_DESCRIPTION}`);
  print(`second checker: ${SECOND_CHECK.name}${reasoningDescription()}`);
  print(`generation calls this run: ${stats.generationCalls}`);
  print(`safety-check calls this run: ${stats.safetyCheckCalls} (first checker), ${stats.secondCheckCalls} (second checker)`);
  print(`claim-check calls this run: ${stats.claimCheckCalls}`);
  print(`model tokens this run: ${stats.inputTokens} input, ${stats.outputTokens} output (${PROVIDER})`);
  for (const [model, m] of Object.entries(stats.byModel)) {
    print(`  ${model}: ${m.calls} call${m.calls === 1 ? '' : 's'}, ${m.input} input, ${m.output} output, about ${Math.round(m.neurons)} neurons`);
  }
  if (SECOND_CHECK.provider === 'groq') {
    const waited = groqStats ? ` waited ${(groqStats.waitedMs / 1000).toFixed(1)} s in ${groqStats.waits} wait${groqStats.waits === 1 ? '' : 's'}` : '';
    print(`Groq this run: ${stats.groq.calls} call${stats.groq.calls === 1 ? '' : 's'}, ${stats.groq.input} input, ${stats.groq.output} output tokens;${waited}`);
  }
  print(neuronSummary(stats.neurons));
  if (startedAt) print(`run time: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
}

async function runNormal(opts, deps) {
  const supabase = deps.supabase;
  const stats = newStats();
  const startedAt = Date.now();
  if (deps.fetchMatches) {
    const fetched = await deps.fetchMatches();
    if (fetched) require('./fetch-matches').logFetchSummary(fetched);
    // SPEC.md §2.3: if the FPL step failed, nothing is generated this run, and the run fails.
    if (fetched?.fpl?.error) {
      log('FPL step failed, so nothing is generated this run');
      printTotals(stats, log, deps, startedAt);
      return { ok: false, stats };
    }
  }
  // Revision 21: with no Groq key, the second checker can't run, so nothing is generated. The fetch
  // above still runs, so scores stay current.
  if (deps.secondCheckKeyMissing) {
    log(GROQ_KEY_MISSING_LINE);
    printTotals(stats, log, deps, startedAt);
    return { ok: false, stats };
  }
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
  // Set once a stop (stopFor) or the cutoff happens. After that no model call is made, and matches
  // with work left wait for a later run.
  let stopped = false;
  let preflightDone = !deps.secondCheckPreflight;
  const stopRun = (stop) => {
    log(stop.line);
    stopped = true;
    if (stop.fail) ok = false;
  };
  if (matches.length) {
    const teams = await readTeams(supabase);
    const liveCounts = await readLiveCounts(supabase, matches.map((m) => m.id));
    const ctx = runContext(supabase);
    for (const match of matches) {
      const label = matchLabel(match, teams);
      // The generation gate (SPEC.md §3.1 step 2): a match waiting for FPL isn't attempted. The fetch
      // summary lists every waiting match on every run; a --match run also says so here.
      if (!PLAYER_DATA_READY.includes(match.player_data)) {
        if (opts.matchId) log(`${label} — waiting for FPL player data (player_data ${match.player_data}); nothing generated`);
        continue;
      }
      const live = Object.fromEntries(SIDES.map((side) => {
        const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
        return [side, liveCounts.get(`${match.id}:${teamId}`) ?? 0];
      }));
      const hasWork = SIDES.some((side) => needsAttempt(match, side, live[side]));
      if (hasWork && !stopped && Date.now() - startedAt >= NEW_MATCH_CUTOFF_MINUTES * 60 * 1000) {
        log(CUTOFF_LINE);
        stopped = true;
      }
      // Revision 21: before the run's first generation, check the Groq key and model, so a rejected
      // key or a withdrawn model generates nothing.
      if (hasWork && !stopped && !preflightDone) {
        preflightDone = true;
        try {
          await deps.secondCheckPreflight();
        } catch (err) {
          stopRun(stopFor(err) ?? { line: `GROQ CHECK FAILED: ${describeFailure(err)}; nothing generated`, fail: true });
        }
      }
      const reports = [];
      for (const side of SIDES) {
        // A stop on the home side leaves the away side for a later run too.
        const report = stopped && needsAttempt(match, side, live[side])
          ? { slug: sideTeams(match, side, teams).team.slug, attempts: [], live: live[side], deferred: true }
          : await processPerspective(supabase, match, side, teams, live[side], stats, deps, label, ctx);
        if (report.failed) ok = false;
        if (report.stop) stopRun(report.stop);
        reports.push(report);
      }
      const touched = reports.some((r) => r.attempts.length || r.failed || r.deferred || r.note);
      if (touched || opts.matchId) log(`${label} — ${reports.map(formatPerspective).join(', ')}`);
    }
  }
  printTotals(stats, log, deps, startedAt);
  return { ok, stats };
}

async function runDry(opts, deps) {
  const supabase = deps.supabase;
  const startedAt = Date.now();
  const match = await readMatch(supabase, opts.matchId);
  if (!match) throw new Error(`match ${opts.matchId} is not in Supabase`);
  if (match.status !== 'finished') throw new Error(`--dry-run needs a finished match; ${match.id} is '${match.status}'`);
  if (deps.secondCheckKeyMissing) throw new Error(GROQ_KEY_MISSING_LINE);
  const teams = await readTeams(supabase);
  const label = matchLabel(match, teams);
  const stats = newStats();

  // The dry run ignores the generation gate and makes no FPL request: it uses whatever is stored.
  // Its variety check compares candidates only with each other, across both sides in order (home
  // first), as a fresh generation of the match would; stored comments don't count.
  const ctx = runContext(supabase);
  const playerData = await ctx.playerData(match);
  const nameIndex = await ctx.nameIndex();
  const openings = new Set();

  const ht = match.home_ht_score == null ? '' : ` (HT ${match.home_ht_score}-${match.away_ht_score})`;
  const output = {
    dry_run: true,
    match_id: match.id,
    match: label,
    score: `${match.home_score}-${match.away_score}${ht}`,
    player_data: match.player_data,
    prompt_version: PROMPT_VERSION,
    ai_provider: PROVIDER,
    generation_model: GENERATION_MODEL,
    check_model: CHECK_MODEL,
    claim_model: CLAIM_MODEL,
    second_check: { provider: SECOND_CHECK.provider, model: SECOND_CHECK.model, ...(SECOND_CHECK.provider === 'groq' ? GROQ_REASONING : {}) },
    max_published_per_side: MAX_PUBLISHED_PER_PERSPECTIVE,
    run_at: new Date().toISOString(),
    perspectives: [],
  };

  let ok = true;
  let stop = null; // no model call after a stop (stopFor)
  if (deps.secondCheckPreflight) {
    try {
      await deps.secondCheckPreflight();
    } catch (err) {
      stop = stopFor(err) ?? { line: `GROQ CHECK FAILED: ${describeFailure(err)}; nothing generated`, fail: true };
      log(stop.line);
      ok = false;
    }
  }
  for (const side of SIDES) {
    const { team, opponent } = sideTeams(match, side, teams);
    const matchData = buildMatchData(match, team, opponent, playerData);
    const names = perspectiveNames(nameIndex, match, team, playerData);
    const perspective = { side, team_id: team.id, team: team.short_name, slug: team.slug, match_data: matchData };
    if (stop) {
      perspective.error = `not attempted: ${stop.line}`;
      output.perspectives.push(perspective);
      continue;
    }
    try {
      const attempt = await runAttempt(matchData, names, stats, deps);
      const { publishable, chosen } = finishAttempt(attempt.candidates, {
        liveKeys: new Set(), openings, liveTypes: [], places: MAX_PUBLISHED_PER_PERSPECTIVE,
      });
      perspective.generation = attempt.generation;
      perspective.check = attempt.check;
      perspective.claim_check = attempt.claim_check;
      perspective.second_check = attempt.second_check;
      perspective.returned = attempt.candidates.length;
      perspective.passed = publishable.length;
      perspective.published = chosen.length;
      perspective.candidates = attempt.candidates;
      if (attempt.generation.parse_error) log(`${label} ${team.slug}: ${attempt.generation.parse_error}`);
      if (attempt.check?.problem) log(`${label} ${team.slug}: checker: ${attempt.check.problem}`);
      if (attempt.claim_check?.problem) log(`${label} ${team.slug}: claim check: ${attempt.claim_check.problem}`);
      if (attempt.second_check?.problem) log(`${label} ${team.slug}: ${SECOND_CHECK.name}: ${attempt.second_check.problem}`);
    } catch (err) {
      // A dry run that couldn't finish still exits non-zero, since its output is incomplete.
      stop = stopFor(err);
      perspective.error = stop ? stop.line : `MODEL CALL FAILED: ${describeFailure(err)}`;
      log(`${label} ${team.slug}: ${perspective.error}`);
      ok = false;
    }
    output.perspectives.push(perspective);
  }

  output.calls = {
    generation: stats.generationCalls,
    safety_check: stats.safetyCheckCalls,
    claim_check: stats.claimCheckCalls,
    second_check: stats.secondCheckCalls,
  };
  output.tokens = { input: stats.inputTokens, output: stats.outputTokens };
  output.neurons_by_model = Object.fromEntries(Object.entries(stats.byModel).map(([m, v]) => [m, { ...v, neurons: Math.round(v.neurons) }]));
  output.estimated_neurons = PROVIDER === 'cloudflare' ? Math.round(stats.neurons) : null;
  if (SECOND_CHECK.provider === 'groq') {
    output.groq = {
      calls: stats.groq.calls,
      input_tokens: stats.groq.input,
      output_tokens: stats.groq.output,
      waited_seconds: deps.groqStats ? Math.round(deps.groqStats.waitedMs / 100) / 10 : null,
    };
  }
  output.run_seconds = Math.round((Date.now() - startedAt) / 100) / 10;

  const json = `${JSON.stringify(output, null, 2)}\n`;
  const reviewDir = deps.reviewDir ?? REVIEW_DIR;
  fs.mkdirSync(reviewDir, { recursive: true });
  const reviewFile = path.join(reviewDir, `dryrun-${match.id}.json`);
  fs.writeFileSync(reviewFile, json);
  if (!deps.quietStdout) process.stdout.write(json);

  const summary = output.perspectives
    .map((p) => (p.error ? `${p.slug}: ${p.error}` : `${p.slug}: ${p.passed}/${p.returned} passed, ${p.published} published`))
    .join(', ');
  log(`${label} (dry run, nothing written) — ${summary}`);
  printTotals(stats, log, deps, startedAt);
  log(`dry-run output saved to ${path.relative(process.cwd(), reviewFile)}`);
  return { ok, stats, output };
}

function defaultDeps() {
  const groq = SECOND_CHECK.provider === 'groq' ? createGroqClient({ log: (m) => log(m) }) : null;
  const { secondCheck } = require('./safety-check');
  return {
    supabase: getServiceClient(),
    fetchMatches: require('./fetch-matches').fetchMatches,
    generateComments: require('./generate-comments').generateComments,
    safetyCheck: require('./safety-check').safetyCheck,
    claimCheck: require('./claim-check').claimCheck,
    secondCheck: (matchData, lines) => secondCheck(matchData, lines, { groq }),
    secondCheckPreflight: groq ? () => groq.preflight() : null,
    secondCheckKeyMissing: Boolean(groq) && !(process.env.GROQ_API_KEY ?? '').trim(),
    groqStats: groq?.stats ?? null,
  };
}

async function runPipeline(opts, deps = defaultDeps()) {
  log = deps.log ?? (opts.dryRun ? console.error : console.log);
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

module.exports = { runPipeline, parseArgs, finishAttempt, stopFor };
