// Match data sent to both prompts (SPEC.md §3.5), prompt templates and PROMPT_VERSION.
// Every field is stored in matches/teams/players/match_events or computed deterministically from
// stored fields.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TARGET_MIX } = require('./constants');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const GENERATION_PROMPT_FILE = 'generation-prompt.md';
const SAFETY_CHECKER_PROMPT_FILE = 'safety-checker-prompt.md';

const COMPETITION_NAMES = Object.freeze({ PL: 'Premier League' });

// Fixed English labels: Intl's en-GB output now abbreviates September as "Sept".
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Calendar date of an instant in Europe/London, as numbers.
function londonDate(isoTimestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(isoTimestamp));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// "Sat 19 Sep 2026"
function formatKickoffDate(isoTimestamp) {
  const { year, month, day } = londonDate(isoTimestamp);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]} ${year}`;
}

// "2026-09-19", the London calendar date, for log lines.
function londonIsoDate(isoTimestamp) {
  const { year, month, day } = londonDate(isoTimestamp);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Events sent to the prompts, in this order. Assists are stored but never sent (SPEC.md §3.5).
const PROMPT_EVENTS = ['goal', 'own_goal', 'red_card', 'pen_missed', 'pen_saved', 'saves'];

// FPL's full name: its "known as" name when it has one, otherwise first and second name.
function fullName(player) {
  return player.known_name || `${player.first_name} ${player.second_name}`;
}

// Under 18 on the kickoff date in Europe/London, compared as YYYY-MM-DD strings, so a 29 Feb
// birthday's 18th falls on 1 Mar in a non-leap year. No birth_date counts as under 18 (§3.3 N5).
function isUnder18(birthDate, kickoffAt) {
  if (!birthDate) return true;
  const eighteenth = `${Number(birthDate.slice(0, 4)) + 18}${birthDate.slice(4, 10)}`;
  return londonIsoDate(kickoffAt) < eighteenth;
}

// The players sent to the prompts (SPEC.md §3.5): everyone with an event other than an assist,
// the perspective team's players first, then by name. Each keeps its fpl_id for the code gate;
// buildMatchData drops it. Null when the match has no player data.
// playerData is { events: [{ fpl_id, team_id, event, count }], players: Map(fpl_id -> players row) }.
function listPlayers(match, perspectiveTeam, playerData) {
  if (!playerData) return null;
  const byId = new Map();
  for (const e of playerData.events) {
    if (!PROMPT_EVENTS.includes(e.event)) continue;
    if (e.team_id !== match.home_team_id && e.team_id !== match.away_team_id) {
      throw new Error(`match ${match.id}: event for player ${e.fpl_id} has team ${e.team_id}, neither side of the match`);
    }
    const player = playerData.players.get(e.fpl_id);
    if (!player) throw new Error(`match ${match.id}: event for player ${e.fpl_id}, who isn't in players`);
    const entry = byId.get(e.fpl_id) ?? { player, side: e.team_id === perspectiveTeam.id ? 'perspective' : 'opponent', counts: {} };
    entry.counts[e.event] = (entry.counts[e.event] ?? 0) + e.count;
    byId.set(e.fpl_id, entry);
  }

  const entries = [...byId.values()];
  const webNameCount = new Map();
  for (const { player } of entries) webNameCount.set(player.web_name, (webNameCount.get(player.web_name) ?? 0) + 1);

  return entries
    .map(({ player, side, counts }) => ({
      fpl_id: player.fpl_id,
      name: webNameCount.get(player.web_name) > 1 ? fullName(player) : player.web_name,
      side,
      events: Object.fromEntries(PROMPT_EVENTS.filter((ev) => counts[ev]).map((ev) => [ev, counts[ev]])),
      under_18: isUnder18(player.birth_date, match.kickoff_at),
    }))
    .sort((a, b) => {
      if (a.side !== b.side) return a.side === 'perspective' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : a.fpl_id - b.fpl_id;
    });
}

// The perspective team's notable moments, as lists of player names (SPEC.md §3.5).
function buildHooks(players) {
  const ours = players.filter((p) => p.side === 'perspective');
  const theirs = players.filter((p) => p.side === 'opponent');
  const names = (list, test) => list.filter((p) => test(p.events)).map((p) => p.name);
  return {
    brace: names(ours, (e) => e.goal === 2),
    hat_trick: names(ours, (e) => e.goal >= 3),
    own_goal_for_us: names(theirs, (e) => e.own_goal > 0),
    own_goal_against_us: names(ours, (e) => e.own_goal > 0),
    our_red_card: names(ours, (e) => e.red_card > 0),
    their_red_card: names(theirs, (e) => e.red_card > 0),
    pen_missed: names(ours, (e) => e.pen_missed > 0),
    pen_saved: names(ours, (e) => e.pen_saved > 0),
  };
}

// playerData is null unless the match's player_data is 'ok'; then players and hooks are null too.
function buildMatchData(match, perspectiveTeam, opponentTeam, playerData = null) {
  let side;
  if (match.home_team_id === perspectiveTeam.id && match.away_team_id === opponentTeam.id) side = 'home';
  else if (match.away_team_id === perspectiveTeam.id && match.home_team_id === opponentTeam.id) side = 'away';
  else throw new Error(`match ${match.id}: teams ${perspectiveTeam.id}/${opponentTeam.id} don't match its home/away ids`);

  if (match.home_score == null || match.away_score == null) {
    throw new Error(`match ${match.id} has no full-time score`);
  }
  const ours = side === 'home' ? match.home_score : match.away_score;
  const theirs = side === 'home' ? match.away_score : match.home_score;
  const result = ours > theirs ? 'won' : ours === theirs ? 'drew' : 'lost';

  const hasHalfTime = match.home_ht_score != null && match.away_ht_score != null;
  const htOurs = hasHalfTime ? (side === 'home' ? match.home_ht_score : match.away_ht_score) : null;
  const htTheirs = hasHalfTime ? (side === 'home' ? match.away_ht_score : match.home_ht_score) : null;
  const halfTimeState = !hasHalfTime ? null : htOurs > htTheirs ? 'leading' : htOurs === htTheirs ? 'level' : 'trailing';
  const players = listPlayers(match, perspectiveTeam, playerData);

  return {
    competition: COMPETITION_NAMES[match.competition] ?? match.competition,
    matchday: match.matchday ?? null,
    kickoff_date: formatKickoffDate(match.kickoff_at),
    perspective_team: perspectiveTeam.short_name,
    opponent: opponentTeam.short_name,
    perspective_side: side,
    full_time: { perspective: ours, opponent: theirs },
    half_time: hasHalfTime ? { perspective: htOurs, opponent: htTheirs } : null,
    result,
    points_earned: result === 'won' ? 3 : result === 'drew' ? 1 : 0,
    clean_sheet: theirs === 0,
    total_goals: ours + theirs,
    winning_margin: Math.abs(ours - theirs),
    half_time_state: halfTimeState,
    half_time_comeback: hasHalfTime ? halfTimeState === 'trailing' && result !== 'lost' : null,
    players: players && players.map(({ fpl_id, ...rest }) => rest),
    hooks: players && buildHooks(players),
  };
}

// The {{match_data_json}} value. One serialisation for both prompts, so the generator and the
// checker always see byte-identical facts.
function matchDataJson(matchData) {
  return JSON.stringify(matchData, null, 2);
}

// Prompts are read with line endings normalised to LF, so a Windows checkout (core.autocrlf)
// and the Linux Actions runner send identical text and compute the same PROMPT_VERSION.
function loadPrompt(file) {
  return fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8').replace(/\r\n?/g, '\n');
}

// Fills every {{name}} placeholder; fails on a missing value rather than sending a raw placeholder.
function fillTemplate(template, values) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (placeholder, name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`no value for template placeholder ${placeholder}`);
    return values[name];
  });
}

// First 8 hex characters of SHA-256 over both prompts and TARGET_MIX, NUL-separated.
function computePromptVersion() {
  const hash = crypto.createHash('sha256');
  hash.update(loadPrompt(GENERATION_PROMPT_FILE));
  hash.update('\0');
  hash.update(loadPrompt(SAFETY_CHECKER_PROMPT_FILE));
  hash.update('\0');
  hash.update(JSON.stringify(TARGET_MIX));
  return hash.digest('hex').slice(0, 8);
}

const PROMPT_VERSION = computePromptVersion();

module.exports = {
  GENERATION_PROMPT_FILE,
  SAFETY_CHECKER_PROMPT_FILE,
  PROMPT_VERSION,
  buildMatchData,
  listPlayers,
  fullName,
  isUnder18,
  matchDataJson,
  formatKickoffDate,
  londonIsoDate,
  loadPrompt,
  fillTemplate,
};
