// P1 check (SPEC.md §9). Runs `run-pipeline.js --match <id> --dry-run` against a finished match and
// asserts the passing candidates are fit to write. Prints PASS/FAIL check-p1 and exits 0/1. Never
// prints secrets. The dry run makes model calls (2 generation + up to 16 safety checks).
// The number and banned-term rules are the pipeline's own code gate (lib/code-gate.js), re-applied here
// to the stored match, so a passing line that slips past the gate still fails the check.
//
// Usage: node scripts/check-p1.js --match <id>

const path = require('path');
const { spawnSync } = require('child_process');
const { getServiceClient, unwrap } = require('./lib/supabase-client');
const { buildMatchData } = require('./lib/match-data');
const { numbersIn, allowedNumbers, codeGateProblems } = require('./lib/code-gate');
const { COMMENT_TYPES, MIN_PASSING_COUNT } = require('./lib/constants');

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
  if (!matchId || !/^\d+$/.test(matchId)) throw new Error('usage: node scripts/check-p1.js --match <finished match id>');
  return { matchId };
}

async function main() {
  const { matchId } = parseArgs(process.argv.slice(2));
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

  let output = null;
  if (run.status !== 0) {
    fail(`run-pipeline.js --dry-run exited with status ${run.status}`);
  }
  try {
    output = JSON.parse(run.stdout);
  } catch (err) {
    fail(`dry-run stdout isn't JSON: ${err.message}`);
  }

  const totals = [];
  let linesChecked = 0;
  if (output) {
    info(`match ${output.match_id}: ${output.match} ${output.score}; prompt_version ${output.prompt_version}; ` +
      `calls: ${output.calls.generation} generation, ${output.calls.safety_check} safety-check`);

    for (const side of ['home', 'away']) {
      const teamId = side === 'home' ? match.home_team_id : match.away_team_id;
      const team = teams.get(teamId);
      const opponent = teams.get(side === 'home' ? match.away_team_id : match.home_team_id);
      const p = output.perspectives.find((x) => x.team_id === teamId);
      if (!p) { fail(`no ${side} perspective (${team.slug}) in the dry-run output`); continue; }
      if (p.error) { fail(`${team.slug}: ${p.error}`); continue; }

      const passing = p.candidates.filter((c) => c.result === 'pass');
      const unique = new Set(passing.map((c) => dedupeKey(c.text)));
      if (unique.size < MIN_PASSING_COUNT) fail(`${team.slug}: ${unique.size} distinct passing candidates, need at least ${MIN_PASSING_COUNT}`);

      for (const c of passing) {
        if (!COMMENT_TYPES.includes(c.type)) fail(`${team.slug}: passing candidate has invalid type ${JSON.stringify(c.type)}: ${JSON.stringify(c.text)}`);
        if (typeof c.note !== 'string' || !c.note.trim()) fail(`${team.slug}: passing candidate has an empty note: ${JSON.stringify(c.text)}`);
        if (typeof c.text !== 'string' || !c.text.trim()) fail(`${team.slug}: passing candidate has empty text`);
      }

      // Match data comes from the stored match, not from the dry run's own output.
      const matchData = buildMatchData(match, team, opponent);
      const allowed = allowedNumbers(matchData);
      const seen = Object.fromEntries(COMMENT_TYPES.map((t) => [t, []]));
      for (const c of passing) {
        linesChecked += 1;
        for (const n of numbersIn(c.text)) seen[c.type]?.push(n.token);
        for (const problem of codeGateProblems(c, matchData)) fail(`${team.slug}: ${problem}: ${JSON.stringify(c.text)}`);
      }

      const byType = COMMENT_TYPES.map((t) => `${t} ${passing.filter((c) => c.type === t).length}`).join(', ');
      const numbers = COMMENT_TYPES.map((t) => `${t} [${seen[t].join(', ')}]`).join(' ');
      info(`${team.slug}: ${passing.length}/${p.candidates.length} passed (${byType}); numbers ${numbers} ` +
        `vs allowed {${[...allowed].sort((a, b) => a - b).join(', ')}}`);
      // Lines the model checker passed but the pipeline's code gate dropped: each one is a checker miss.
      for (const c of p.candidates.filter((x) => x.failed_by === 'code_gate')) {
        info(`${team.slug}: code gate dropped [${c.type}] ${JSON.stringify(c.text)} (${c.reason.replace(/^code gate: /, '')})`);
      }
      totals.push(`${team.slug} ${passing.length}/${p.candidates.length}`);
    }
  }
  info(`Supabase before/after: ${after.comments} comments rows, attempts ${after.home_generation_attempts}/${after.away_generation_attempts}`);

  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log(`FAIL check-p1: ${failures.length} problem(s); first: ${failures[0]}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS check-p1: match ${matchId} dry run — ${totals.join(', ')} passing; every type and note valid; ` +
    `${linesChecked} passing lines: STAT/HOT_TAKE numbers all in the match data, no numbers in BANTER, no banned terms; ` +
    'nothing written to Supabase');
}

main().catch((err) => {
  console.log(`FAIL check-p1: ${err.message}`);
  process.exitCode = 1;
});
