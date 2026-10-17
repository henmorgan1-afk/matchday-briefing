// P1 check (SPEC.md §9). Runs `run-pipeline.js --match <id> --dry-run` against a finished match and
// asserts the published candidates are fit to write. Prints PASS/FAIL check-p1 and exits 0/1. Never
// prints secrets. The dry run makes model calls (per side since Revision 21: one generation and one
// first-checker call on the AI_PROVIDER, plus one claim-check call when the claim check is on, which
// it isn't since Revision 24; on Cloudflare these come out of the free allowance. Then one or more
// second-checker calls on Groq's free plan.)
// With --from <file> it checks an existing dry-run file instead, and makes no model call at all.
// The number, banned-term and name rules (N1, N2, N5) are the pipeline's own code gate
// (lib/code-gate.js), re-applied here to the stored match and its stored FPL events, so a published line
// that slips past the gate still fails the check. Since Revision 21 HOT_TAKE and BANTER lines and notes
// hold no number at all, and each side must publish at least MIN_PASSING_COUNT and at most
// MAX_PUBLISHED_PER_PERSPECTIVE lines.
//
// Usage: node scripts/check-p1.js --match <id> [--from review/dryrun-<id>.json]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getServiceClient, unwrap } = require('./lib/supabase-client');
const { buildMatchData } = require('./lib/match-data');
const { numbersIn, allowedNumbers, namesIn, openingWords, codeGateProblems } = require('./lib/code-gate');
const { readPlayerData, readNameIndex, perspectiveNames } = require('./lib/player-data');
const { COMMENT_TYPES, MIN_PASSING_COUNT, MAX_PUBLISHED_PER_PERSPECTIVE } = require('./lib/constants');

const dedupeKey = (text) => String(text).trim().toLowerCase();

// What only P1 writes: comments rows and the match's attempt counters. matches/teams are left out
// on purpose, because the hourly fetch on main may legitimately update them while the check runs.
async function snapshot(supabase, matchId) {
  const { count, error } = await supabase.from('comments').select('id', { count: 'exact', head: true });
  if (error) throw new Error(`count comments: ${error.message}`);
  const latest = unwrap(await supabase.from('comments').select('created_at').order('created_at', { ascending: false }).limit(1), 'read latest comment');
  const [match] = unwrap(await supabase.from('matches').select('home_generation_attempts, away_generation_attempts').eq('id', matchId), 'read match');
  return { comments: count, latestCommentAt: latest[0]?.created_at ?? null, ...match };
}

function parseArgs(argv) {
  const i = argv.indexOf('--match');
  const matchId = i >= 0 ? argv[i + 1] : undefined;
  if (!matchId || !/^\d+$/.test(matchId)) throw new Error('usage: node scripts/check-p1.js --match <finished match id> [--from <dry-run file>]');
  const f = argv.indexOf('--from');
  const from = f >= 0 ? argv[f + 1] : null;
  if (f >= 0 && !from) throw new Error('--from expects a dry-run file');
  return { matchId, from };
}

// The dry run's JSON: from an existing file (no model calls), or from a fresh dry run, whose
// before/after Supabase snapshot proves it wrote nothing.
async function dryRunOutput(supabase, matchId, from, fail) {
  if (from) {
    try {
      return JSON.parse(fs.readFileSync(from, 'utf8'));
    } catch (err) {
      fail(`can't read ${from}: ${err.message}`);
      return null;
    }
  }
  const before = await snapshot(supabase, matchId);
  const run = spawnSync(process.execPath, [path.join(__dirname, 'run-pipeline.js'), '--match', matchId, '--dry-run'], {
    stdio: ['ignore', 'pipe', 'inherit'], // the dry run's logs stream through; its JSON comes back on stdout
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const after = await snapshot(supabase, matchId);
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) fail(`dry run changed Supabase: ${key} was ${before[key]}, now ${after[key]}`);
  }
  console.log(`  Supabase before/after: ${after.comments} comments rows, attempts ${after.home_generation_attempts}/${after.away_generation_attempts}`);
  if (run.status !== 0) fail(`run-pipeline.js --dry-run exited with status ${run.status}`);
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    fail(`dry-run stdout isn't JSON: ${err.message}`);
    return null;
  }
}

async function main() {
  const { matchId, from } = parseArgs(process.argv.slice(2));
  const supabase = getServiceClient();
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const info = (msg) => console.log(`  ${msg}`);

  const [match] = unwrap(await supabase.from('matches').select('*').eq('id', matchId), 'read match');
  if (!match) throw new Error(`match ${matchId} is not in Supabase`);
  if (match.status !== 'finished') throw new Error(`match ${matchId} is '${match.status}', not finished`);
  const teamRows = unwrap(await supabase.from('teams').select('id, short_name, tla, slug').in('id', [match.home_team_id, match.away_team_id]), 'read teams');
  const teams = new Map(teamRows.map((t) => [t.id, t]));

  console.log('check-p1');
  if (from) info(`checking the existing dry-run file ${from}; no model calls`);
  const output = await dryRunOutput(supabase, matchId, from, fail);
  if (output && String(output.match_id) !== matchId) fail(`${from} is a dry run of match ${output.match_id}, not ${matchId}`);
  for (const p of output?.perspectives ?? []) {
    if (p.error) continue;
    if (!p.candidates.every((c) => typeof c.published === 'boolean')) fail(`${p.slug}: the dry-run file has no "published" flags; it predates Revision 21`);
  }

  // Player data and names come from what's stored, not from the dry run's own output.
  const playerData = await readPlayerData(supabase, match);
  const nameIndex = await readNameIndex(supabase);
  info(`player_data: ${match.player_data}` +
    (playerData ? ` (${playerData.events.length} stored events)` : '; no player data, so any FPL player name fails'));

  const totals = [];
  const named = [];
  const openings = new Map(); // Revision 9 variety: first three words -> the passing line that has them
  let linesChecked = 0;
  if (output) {
    info(`match ${output.match_id}: ${output.match} ${output.score}; prompt_version ${output.prompt_version}; ` +
      `calls: ${output.calls.generation} generation, ${output.calls.safety_check} first checker, ` +
      `${output.calls.claim_check ?? 0} claim check, ${output.calls.second_check ?? 0} second checker`);
    const neurons = output.estimated_neurons == null ? '' : `; about ${output.estimated_neurons} Cloudflare neurons`;
    info(`AI provider ${output.ai_provider}: generation ${output.generation_model}, safety checks ${output.check_model}, ` +
      `claim check ${output.claim_model}, second checker ${output.second_check?.provider} ${output.second_check?.model}${neurons}`);

    for (const side of ['home', 'away']) {
      const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
      const team = teams.get(teamId);
      const opponent = teams.get(side === 'home' ? match.away_team_id : match.home_team_id);
      const p = output.perspectives.find((x) => x.team_id === teamId);
      if (!p) { fail(`no ${side} perspective (${team.slug}) in the dry-run output`); continue; }
      if (p.error) { fail(`${team.slug}: ${p.error}`); continue; }

      // Revision 21: what counts is the published lines, those that passed every step and were chosen.
      const passing = p.candidates.filter((c) => c.result === 'pass' && c.published === true);
      const unique = new Set(passing.map((c) => dedupeKey(c.text)));
      if (unique.size < MIN_PASSING_COUNT) fail(`${team.slug}: ${unique.size} distinct published lines, need at least ${MIN_PASSING_COUNT}`);
      if (passing.length > MAX_PUBLISHED_PER_PERSPECTIVE) fail(`${team.slug}: ${passing.length} published lines, at most ${MAX_PUBLISHED_PER_PERSPECTIVE} allowed`);
      if (p.candidates.some((c) => c.published && c.result !== 'pass')) fail(`${team.slug}: a line marked published didn't pass every step`);

      for (const c of passing) {
        if (!COMMENT_TYPES.includes(c.type)) fail(`${team.slug}: passing candidate has invalid type ${JSON.stringify(c.type)}: ${JSON.stringify(c.text)}`);
        if (typeof c.note !== 'string' || !c.note.trim()) fail(`${team.slug}: passing candidate has an empty note: ${JSON.stringify(c.text)}`);
        if (typeof c.text !== 'string' || !c.text.trim()) fail(`${team.slug}: passing candidate has empty text`);
      }

      // Match data comes from the stored match, not from the dry run's own output.
      const matchData = buildMatchData(match, team, opponent, playerData);
      const names = perspectiveNames(nameIndex, match, team, playerData);
      const allowed = allowedNumbers(matchData);
      const seen = Object.fromEntries(COMMENT_TYPES.map((t) => [t, []]));
      for (const c of passing) {
        linesChecked += 1;
        for (const n of numbersIn(c.text)) seen[c.type]?.push(n.token);
        for (const problem of codeGateProblems(c, matchData, names)) fail(`${team.slug}: ${problem}: ${JSON.stringify(c.text)}`);
        for (const { name } of namesIn(c.text, nameIndex)) named.push(`${team.slug} [${c.type}] ${name}`);
        const opening = openingWords(c.text);
        if (openings.has(opening)) fail(`${team.slug}: opens with the same three words as ${openings.get(opening)}: ${JSON.stringify(c.text)}`);
        else openings.set(opening, `${team.slug}'s ${JSON.stringify(c.text)}`);
      }

      const byType = COMMENT_TYPES.map((t) => `${t} ${passing.filter((c) => c.type === t).length}`).join(', ');
      const numbers = COMMENT_TYPES.map((t) => `${t} [${seen[t].join(', ')}]`).join(' ');
      info(`${team.slug}: ${passing.length} published of ${p.passed ?? '?'} that passed every step, ${p.candidates.length} returned ` +
        `(${byType}); numbers ${numbers}; STAT numbers allowed {${[...allowed].sort((a, b) => a - b).join(', ')}}`);
      // Lines the first checker passed but a later step dropped: each one is a checker miss.
      const later = { code_gate: 'code gate', claim_check: 'claim check', groq: 'second checker', second_checker: 'second checker', unsure: 'unsure', variety: 'variety check', not_selected: 'selection' };
      for (const c of p.candidates.filter((x) => later[x.failed_by])) {
        info(`${team.slug}: ${later[c.failed_by]} dropped [${c.type}] ${JSON.stringify(c.text)} (${c.reason.replace(/^(code gate|variety): /, '')})`);
      }
      totals.push(`${team.slug} ${passing.length} published of ${p.candidates.length}`);
    }
  }
  info(`players named in published lines: ${named.length ? named.join('; ') : 'none'}`);

  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log(`FAIL check-p1: ${failures.length} problem(s); first: ${failures[0]}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS check-p1: match ${matchId} dry run (player_data ${match.player_data}) — ${totals.join(', ')}; ` +
    `${MIN_PASSING_COUNT}-${MAX_PUBLISHED_PER_PERSPECTIVE} published per side; ` +
    `every type and note valid; ${linesChecked} published lines: STAT numbers all in the match data, no numbers in HOT_TAKE or BANTER lines or notes, ` +
    `no banned terms, ${named.length} player names all with an event in the match (N1, N2), none under 18 outside STAT (N5), ` +
    'none in BANTER, no "our" before an opposition player, no banned tails, no other-match words in STAT or HOT_TAKE, ' +
    'no position words, no five-word copies of the generation prompt, no banned note words, no two lines opening with the same ' +
    `three words across both sides${from ? '' : '; nothing written to Supabase'}`);
}

main().catch((err) => {
  console.log(`FAIL check-p1: ${err.message}`);
  process.exitCode = 1;
});
