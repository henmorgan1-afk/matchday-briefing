// Free line previews: builds the generation prompt for a finished match and checks hand-written lines
// against the code gate, without calling the Anthropic API. Claude Code writes the lines itself
// (CLAUDE.md, "Previewing lines for free"). Reads from Supabase; never writes to it.
//
// Usage:
//   node scripts/preview-lines.js --list
//       The 15 most recent finished matches: id, date, home v away, score, player_data.
//   node scripts/preview-lines.js --match <id>
//       Builds both sides' match data as run-pipeline.js does, fills the generation prompt for each,
//       and saves them as review/preview-<id>-home.md and review/preview-<id>-away.md.
//   node scripts/preview-lines.js --match <id> --check <file>
//       Reads { "<team short name>": [{ "type", "text", "note" }] } and runs every line through the
//       code gate for its side, then the first-three-words variety check across both sides.
//
// Never import lib/claude-client.js, generate-comments.js or safety-check.js here: this tool must
// make no model calls.

const fs = require('fs');
const path = require('path');
const { getServiceClient } = require('./lib/supabase-client');
const { GENERATION_PROMPT_FILE, buildMatchData, fillTemplate, loadPrompt, matchDataJson } = require('./lib/match-data');
const { codeGateProblems, openingWords } = require('./lib/code-gate');
const { readPlayerData, readNameIndex, perspectiveNames } = require('./lib/player-data');
const { COMMENT_TYPES } = require('./lib/constants');

const USAGE = 'usage: node scripts/preview-lines.js --list | --match <id> [--check <file>]';
const SIDES = ['home', 'away'];
const LIST_LIMIT = 15;
const REVIEW_DIR = path.join(__dirname, '..', 'review');

function parseArgs(argv) {
  const opts = { list: false, matchId: null, checkFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--list') opts.list = true;
    else if (argv[i] === '--match') opts.matchId = argv[++i] ?? '';
    else if (argv[i] === '--check') opts.checkFile = argv[++i] ?? '';
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  if (opts.list === (opts.matchId !== null)) throw new Error('give either --list or --match <id>');
  if (opts.matchId !== null && !/^\d+$/.test(opts.matchId)) {
    throw new Error(`--match expects a numeric football-data.org match id, got "${opts.matchId}"`);
  }
  if (opts.checkFile !== null && !opts.checkFile) throw new Error('--check expects a file path');
  return opts;
}

// supabase-js returns { data, error }; a read error stops the run.
function rows({ data, error }, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
  return data;
}

async function readTeams(supabase) {
  const teams = rows(await supabase.from('teams').select('id, short_name, tla, slug'), 'read teams');
  return new Map(teams.map((t) => [t.id, t]));
}

const score = (m) => `${m.home_score ?? '?'}-${m.away_score ?? '?'}` +
  (m.home_ht_score == null ? '' : ` (HT ${m.home_ht_score}-${m.away_ht_score})`);

// The London kickoff date, as the prompt shows it ("Sat 19 Sep 2026").
const kickoffDate = (m, teams) => buildMatchData(m, teams.get(m.home_team_id), teams.get(m.away_team_id)).kickoff_date;

async function list(supabase) {
  const matches = rows(
    await supabase.from('matches').select('*').eq('status', 'finished')
      .order('kickoff_at', { ascending: false }).order('id', { ascending: false }).limit(LIST_LIMIT),
    'read finished matches',
  );
  const teams = await readTeams(supabase);
  console.log(`${matches.length} most recent finished matches, newest first:`);
  for (const m of matches) {
    const home = teams.get(m.home_team_id).short_name;
    const away = teams.get(m.away_team_id).short_name;
    console.log(`  ${m.id}  ${kickoffDate(m, teams)}  ${home} v ${away}  ${score(m)}  player_data ${m.player_data}`);
  }
}

// Both sides' match data and code-gate name context, built exactly as run-pipeline.js builds them.
async function readSides(supabase, matchId) {
  const [match] = rows(await supabase.from('matches').select('*').eq('id', matchId), `read match ${matchId}`);
  if (!match) throw new Error(`match ${matchId} is not in Supabase`);
  if (match.status !== 'finished') throw new Error(`match ${matchId} is '${match.status}', not finished`);
  const teams = await readTeams(supabase);
  const playerData = await readPlayerData(supabase, match);
  const nameIndex = await readNameIndex(supabase);
  const sides = SIDES.map((side) => {
    const [own, other] = side === 'home' ? [match.home_team_id, match.away_team_id] : [match.away_team_id, match.home_team_id];
    const team = teams.get(own);
    const opponent = teams.get(other);
    return {
      side,
      team,
      matchData: buildMatchData(match, team, opponent, playerData),
      names: perspectiveNames(nameIndex, match, team, playerData),
    };
  });
  const label = `${match.id} ${kickoffDate(match, teams)} ${sides[0].team.short_name} v ${sides[1].team.short_name} ${score(match)}`;
  return { match, sides, label };
}

function warnPlayerData(match) {
  if (match.player_data !== 'ok') {
    console.log(`WARNING: player_data is '${match.player_data}', not 'ok', so the match data has no players and no line may name anyone`);
  }
}

async function writePrompts(supabase, matchId) {
  const { match, sides, label } = await readSides(supabase, matchId);
  const template = loadPrompt(GENERATION_PROMPT_FILE);
  console.log(`match ${label}, player_data ${match.player_data}`);
  warnPlayerData(match);
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  for (const { side, team, matchData } of sides) {
    // The same values generate-comments.js fills in.
    const prompt = fillTemplate(template, {
      perspective_team_name: matchData.perspective_team,
      match_data_json: matchDataJson(matchData),
    });
    const file = path.join(REVIEW_DIR, `preview-${match.id}-${side}.md`);
    fs.writeFileSync(file, prompt);
    console.log(`${side} (${team.short_name}) prompt saved to ${path.relative(process.cwd(), file)}`);
  }
}

// Format problems, as generate-comments.js would reject the item before any check.
function formatProblems(line) {
  if (line === null || typeof line !== 'object' || Array.isArray(line)) return ['not a { type, text, note } object'];
  const problems = [];
  if (!COMMENT_TYPES.includes(line.type)) problems.push(`invalid type ${JSON.stringify(line.type)}`);
  if (typeof line.text !== 'string' || !line.text.trim()) problems.push('empty text');
  if (typeof line.note !== 'string' || !line.note.trim()) problems.push('empty note');
  return problems;
}

async function checkLines(supabase, matchId, file) {
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${file} should be an object keyed by team short name`);
  }
  const { match, sides, label } = await readSides(supabase, matchId);
  const known = sides.map((s) => s.team.short_name);
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) throw new Error(`${file}: "${key}" is neither side of this match (${known.join(', ')})`);
  }

  console.log(`match ${label}, player_data ${match.player_data}`);
  warnPlayerData(match);

  // Variety runs across both sides in order, home first, over the lines that passed the code gate,
  // as the dry run does.
  const openings = new Map(); // first three words -> the line that has them
  const counts = [];
  for (const { team, matchData, names } of sides) {
    const lines = input[team.short_name] ?? [];
    if (!Array.isArray(lines)) throw new Error(`${file}: "${team.short_name}" should be a list of lines`);
    console.log(`\n${team.short_name} (${lines.length} line${lines.length === 1 ? '' : 's'})`);
    let passed = 0;
    lines.forEach((line, i) => {
      let problems = formatProblems(line);
      if (!problems.length) problems = codeGateProblems({ type: line.type, text: line.text.trim(), note: line.note.trim() }, matchData, names);
      if (!problems.length) {
        const opening = openingWords(line.text);
        if (openings.has(opening)) problems.push(`opens with the same three words as ${openings.get(opening)}, ${JSON.stringify(opening)}`);
        else openings.set(opening, `${team.short_name} line ${i + 1}`);
      }
      const type = line?.type ?? '?';
      const text = JSON.stringify(line?.text ?? line);
      if (problems.length) {
        console.log(`  ${i + 1}. [${type}] ${text}\n     FAIL: ${problems.join('; ')}`);
      } else {
        passed += 1;
        console.log(`  ${i + 1}. [${type}] ${text}\n     pass`);
      }
    });
    counts.push(`${team.short_name} ${passed}/${lines.length} pass`);
  }
  console.log(`\n${counts.join(', ')}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`preview-lines: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const supabase = getServiceClient();
  if (opts.list) await list(supabase);
  else if (opts.checkFile !== null) await checkLines(supabase, opts.matchId, opts.checkFile);
  else await writePrompts(supabase, opts.matchId);
}

main().catch((err) => {
  console.error(`preview-lines failed: ${err.message}`);
  process.exitCode = 1;
});
