// Match data sent to both prompts (SPEC.md §3.5), prompt templates and PROMPT_VERSION.
// Every field is stored in matches/teams or computed deterministically from stored fields.

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

function buildMatchData(match, perspectiveTeam, opponentTeam) {
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
  matchDataJson,
  formatKickoffDate,
  londonIsoDate,
  loadPrompt,
  fillTemplate,
};
