// P1: the claim check (SPEC.md §3.1, Revision 21 idea 2). After the code gate, one call per side to a
// cheap model (CLAIM_MODEL in lib/ai-client.js) lists every factual claim in each line and its note.
// The model never sees the scores or counts, so it reports what a line says, not what the data says.
// Code then compares every claim with the match data. A line fails if any claim doesn't match, if
// any claim is unverifiable or has a value code can't compare, or if its extraction is missing or
// unreadable (fail closed). Club culture and opinions don't fail a line by themselves. Each line keeps
// its count of checked claims, which the selection (lib/select-lines.js) prefers low.
// Throws only when the model call itself fails outright. Called by run-pipeline.js; no CLI of its own.
// Off since Revision 24 (CLAIM_CHECK_ENABLED in lib/constants.js): run-pipeline.js then never calls
// it. The code and its tests stay, so it can be switched back on.

const { CLAIM_MODEL, complete, parseJsonReply } = require('./lib/ai-client');
const { CLAIM_CHECK_PROMPT_FILE, loadPrompt, fillTemplate, playersIn } = require('./lib/match-data');

const TEMPLATE = loadPrompt(CLAIM_CHECK_PROMPT_FILE);

const FACT_KINDS = Object.freeze([
  'goals_scored', 'goals_conceded', 'total_goals', 'winning_margin', 'saves', 'red_card', 'own_goal',
  'penalty_missed', 'penalty_saved', 'score', 'half_time_score', 'result', 'points', 'clean_sheet',
  'home_or_away', 'came_from_behind', 'date', 'matchday',
]);
const NOT_CHECKED = Object.freeze(['culture', 'opinion']);
const TEAMS = Object.freeze(['us', 'them', 'match']);
const PERIODS = Object.freeze(['full_time', 'first_half', 'second_half']);

// Player events by claim kind.
const PLAYER_EVENT = Object.freeze({
  goals_scored: 'goal', saves: 'saves', red_card: 'red_card', own_goal: 'own_goal',
  penalty_missed: 'pen_missed', penalty_saved: 'pen_saved',
});

// ---------------------------------------------------------------- reading values

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[‘’]/g, "'").trim();

// A whole number from 6 or "6"; undefined for anything else.
function wholeNumber(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return undefined;
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  const s = norm(v);
  if (['true', 'yes'].includes(s)) return true;
  if (['false', 'no'].includes(s)) return false;
  return undefined;
}

// { us, them } from {"us": 1, "them": 5}; undefined otherwise.
function scorePair(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const us = wholeNumber(v.us);
  const them = wholeNumber(v.them);
  return us === undefined || them === undefined ? undefined : { us, them };
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// A date claim matches when every word of it names the match's weekday, day, month or year
// ("Saturday", "10 Oct", "October 10th 2026"). undefined when a word is none of those.
function dateMatches(value, kickoffDate) {
  const [weekday, day, month, year] = kickoffDate.toLowerCase().split(' ');
  const words = String(value ?? '').toLowerCase().replace(/[,.]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  for (const w of words) {
    const digits = w.match(/^(\d+)(?:st|nd|rd|th)?$/);
    if (digits) {
      if (Number(digits[1]) !== Number(day) && digits[1] !== year) return false;
      continue;
    }
    const prefix = w.slice(0, 3);
    if (WEEKDAYS.includes(prefix)) { if (prefix !== weekday) return false; continue; }
    if (MONTHS.includes(prefix)) { if (prefix !== month) return false; continue; }
    if (['the', 'of', 'on'].includes(w)) continue;
    return undefined;
  }
  return true;
}

// ---------------------------------------------------------------- facts from the match data

// { us, them } goals for a period, or undefined when that half isn't known.
function goalsIn(md, period) {
  const pair = period === 'first_half' ? md.first_half_goals : period === 'second_half' ? md.second_half_goals : md.full_time;
  return pair ? { us: pair.perspective, them: pair.opponent } : undefined;
}

// The listed player a claim names: an exact match, ignoring accents and case, or failing that the
// name without an initial or the last word ("Becker" for "A.Becker"), if only one player has it.
function findPlayer(md, name) {
  const players = playersIn(md);
  const want = fold(name);
  const exact = players.filter((p) => fold(p.name) === want);
  if (exact.length === 1) return exact[0];
  const loose = players.filter((p) => {
    const n = fold(p.name);
    const bare = n.replace(/^\p{L}\.\s*/u, '').replace(/\s*\.\p{L}$/u, '');
    return bare === want || n.split(/\s+/).pop() === want;
  });
  return loose.length === 1 ? loose[0] : undefined;
}

// A team's total of one event across its listed players.
function teamEventTotal(md, team, event) {
  const list = team === 'us' ? md.players.our_players : md.players.their_players;
  return list.reduce((sum, p) => sum + (p.events[event] ?? 0), 0);
}

const otherTeam = (t) => (t === 'us' ? 'them' : 'us');
const RESULT_FLIP = { won: 'lost', lost: 'won', drew: 'drew' };

// ---------------------------------------------------------------- comparing one claim

// Compares one claim with one perspective's match data. Returns { ok: true } when it matches, or
// { ok: false, problem } when it doesn't, or code can't compare it.
function compareClaim(claim, md) {
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) return { ok: false, problem: `unreadable claim ${JSON.stringify(claim)}` };
  const kind = norm(claim.kind);
  const quote = typeof claim.quote === 'string' && claim.quote ? ` ("${claim.quote}")` : '';
  const bad = (why) => ({ ok: false, problem: `${kind || 'claim'}${quote}: ${why}` });
  if (kind === 'unverifiable') return bad("the match data can't show it");
  if (!FACT_KINDS.includes(kind)) return bad(`unknown kind ${JSON.stringify(claim.kind)}`);

  const team = norm(claim.team) || null;
  if (team !== null && !TEAMS.includes(team)) return bad(`unknown team ${JSON.stringify(claim.team)}`);
  const period = claim.period == null || claim.period === '' ? null : norm(claim.period);
  if (period !== null && !PERIODS.includes(period)) return bad(`unknown period ${JSON.stringify(claim.period)}`);
  const value = claim.value;
  const said = JSON.stringify(value);
  const differ = (actual) => bad(`says ${said}, the match data says ${JSON.stringify(actual)}`);
  const needTeam = () => (team === 'us' || team === 'them' ? null : bad(`needs team "us" or "them", got ${JSON.stringify(claim.team)}`));
  // A count of goals or events: a whole number must equal the data; null, for a count the line gives
  // no number for ("his saves"), means at least one.
  const count = (actual) => {
    if (value === null || value === undefined) return actual >= 1 ? { ok: true } : bad(`says there were some, the match data says ${actual}`);
    const n = wholeNumber(value);
    if (n === undefined) return bad(`value ${said} isn't a whole number`);
    return n === actual ? { ok: true } : differ(actual);
  };

  // A player's own events: compared with that player's counts, full time only.
  const playerName = typeof claim.player === 'string' && claim.player.trim() ? claim.player.trim() : null;
  if (playerName) {
    if (!md.players) return bad(`names ${playerName}, but this match has no player data`);
    const player = findPlayer(md, playerName);
    if (!player) return bad(`names ${JSON.stringify(playerName)}, who isn't a listed player`);
    const playerTeam = player.side === 'perspective' ? 'us' : 'them';
    if (team && team !== 'match' && team !== playerTeam) return bad(`puts ${player.name} on ${team === 'us' ? md.perspective_team : md.opponent}, but ${player.name} plays for ${player.team}`);
    const event = PLAYER_EVENT[kind];
    if (!event) return bad(`a ${kind} claim about one player can't be compared`);
    if (period && period !== 'full_time') return bad(`${player.name}'s goals by half aren't known`);
    return count(player.events[event] ?? 0);
  }

  switch (kind) {
    case 'goals_scored':
    case 'goals_conceded':
    case 'total_goals': {
      const goals = goalsIn(md, period ?? 'full_time');
      if (!goals) return bad(`goals in the ${period.replace('_', ' ')} aren't known`);
      if (kind === 'total_goals' || team === 'match') return count(goals.us + goals.them);
      const missing = needTeam();
      if (missing) return missing;
      return count(kind === 'goals_scored' ? goals[team] : goals[otherTeam(team)]);
    }
    case 'winning_margin': {
      const goals = goalsIn(md, period ?? 'full_time');
      if (!goals) return bad(`goals in the ${period.replace('_', ' ')} aren't known`);
      const n = wholeNumber(value);
      if (n === undefined) return bad(`value ${said} isn't a whole number`);
      const actual = team === 'us' || team === 'them' ? goals[team] - goals[otherTeam(team)] : Math.abs(goals.us - goals.them);
      return n === actual ? { ok: true } : differ(actual);
    }
    case 'score':
    case 'half_time_score': {
      const goals = goalsIn(md, kind === 'half_time_score' ? 'first_half' : period ?? 'full_time');
      if (!goals) return bad('the half-time score isn\'t known');
      const pair = scorePair(value);
      if (!pair) return bad(`value ${said} isn't {"us": n, "them": n}`);
      return pair.us === goals.us && pair.them === goals.them ? { ok: true } : differ(goals);
    }
    case 'result': {
      const missing = needTeam();
      if (missing && team !== 'match') return missing;
      const v = norm(value);
      const wanted = { win: 'won', won: 'won', draw: 'drew', drew: 'drew', drawn: 'drew', loss: 'lost', lose: 'lost', lost: 'lost' }[v];
      if (!wanted) return bad(`value ${said} isn't "won", "drew" or "lost"`);
      if (team === 'match') return wanted === 'drew' ? (md.result === 'drew' ? { ok: true } : differ(md.result)) : bad('a win or loss needs a team');
      const actual = team === 'us' ? md.result : RESULT_FLIP[md.result];
      return wanted === actual ? { ok: true } : differ(actual);
    }
    case 'points': {
      const missing = needTeam();
      if (missing) return missing;
      const n = wholeNumber(value);
      if (n === undefined) return bad(`value ${said} isn't a whole number`);
      const actual = { won: 3, drew: 1, lost: 0 }[team === 'us' ? md.result : RESULT_FLIP[md.result]];
      return n === actual ? { ok: true } : differ(actual);
    }
    case 'clean_sheet': {
      const missing = needTeam();
      if (missing) return missing;
      const b = bool(value);
      if (b === undefined) return bad(`value ${said} isn't true or false`);
      const conceded = team === 'us' ? md.full_time.opponent : md.full_time.perspective;
      return b === (conceded === 0) ? { ok: true } : differ(conceded === 0);
    }
    case 'came_from_behind': {
      const missing = needTeam();
      if (missing) return missing;
      const b = bool(value);
      if (b === undefined) return bad(`value ${said} isn't true or false`);
      if (!md.half_time) return bad("the half-time score isn't known");
      const actual = team === 'us'
        ? md.half_time_comeback
        : md.half_time_state === 'leading' && md.result !== 'won';
      return b === actual ? { ok: true } : differ(actual);
    }
    case 'home_or_away': {
      const missing = needTeam();
      if (missing) return missing;
      const v = norm(value);
      if (v !== 'home' && v !== 'away') return bad(`value ${said} isn't "home" or "away"`);
      const ours = md.perspective_side;
      const actual = team === 'us' ? ours : ours === 'home' ? 'away' : 'home';
      return v === actual ? { ok: true } : differ(actual);
    }
    case 'date': {
      const m = dateMatches(value, md.kickoff_date);
      if (m === undefined) return bad(`value ${said} can't be compared with ${md.kickoff_date}`);
      return m ? { ok: true } : differ(md.kickoff_date);
    }
    case 'matchday': {
      if (md.matchday == null) return bad("the matchday isn't known");
      const n = wholeNumber(value);
      if (n === undefined) return bad(`value ${said} isn't a whole number`);
      return n === md.matchday ? { ok: true } : differ(md.matchday);
    }
    default: {
      // saves, red_card, own_goal, penalty_missed, penalty_saved for a whole team.
      if (!md.players) return bad('this match has no player data');
      const missing = needTeam();
      if (missing) return missing;
      if (period && period !== 'full_time') return bad('events by half aren\'t known');
      return count(teamEventTotal(md, team, PLAYER_EVENT[kind]));
    }
  }
}

// One line's extraction compared with the match data: { result, reason, checked, problems }.
// `checked` is how many factual claims matched; culture and opinions aren't counted.
function compareLine(extraction, md, type) {
  const claims = extraction?.claims;
  if (!extraction || typeof extraction !== 'object' || !Array.isArray(claims)) {
    return { result: 'fail', reason: `claim check: no readable claim list for this line (${String(JSON.stringify(extraction)).slice(0, 80)})`, checked: 0, problems: [] };
  }
  const problems = [];
  let checked = 0;
  for (const claim of claims) {
    if (claim && typeof claim === 'object' && NOT_CHECKED.includes(norm(claim.kind))) continue;
    const r = compareClaim(claim, md);
    if (r.ok) checked += 1;
    else problems.push(r.problem);
  }
  if (problems.length) return { result: 'fail', reason: `claim check: ${problems.join('; ')}`, checked, problems };
  // A STAT line states facts by definition, so finding none means the extraction missed them.
  if (type === 'STAT' && checked === 0) {
    return { result: 'fail', reason: 'claim check: no factual claim found in a STAT line, so nothing could be checked', checked, problems };
  }
  return { result: 'pass', reason: '', checked, problems };
}

// ---------------------------------------------------------------- the model call

// The players the claim model may see: names and teams only, no counts.
function playersList(md) {
  const players = playersIn(md);
  if (!players.length) return md.players ? '- (no player is listed)' : '- (none: no player may be named)';
  return players.map((p) => `- ${p.name} (${p.team})`).join('\n');
}

function claimPrompt(md, candidates) {
  const comments = Object.fromEntries(candidates.map((c, i) => [String(i + 1), { type: c.type, text: c.text, note: c.note }]));
  return fillTemplate(TEMPLATE, {
    perspective_team_name: md.perspective_team,
    opponent_team_name: md.opponent,
    players_list: playersList(md),
    comments_json: JSON.stringify(comments, null, 2),
  });
}

// The reply's extractions by line number: an object keyed "1", "2"..., or one object wrapped around it.
function extractionsByNumber(parsed) {
  const byNumber = new Map();
  const read = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      const m = String(k).trim().match(/^(?:line|comment|#)?\s*(\d+)$/i);
      if (m && !byNumber.has(Number(m[1]))) byNumber.set(Number(m[1]), Array.isArray(v) ? { claims: v } : v);
    }
  };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    read(parsed);
    if (byNumber.size === 0) {
      const inner = Object.values(parsed).filter((v) => v && typeof v === 'object' && !Array.isArray(v));
      if (inner.length === 1) read(inner[0]);
    }
  }
  return byNumber;
}

// One result per candidate, in order, from the claim model's reply.
function readClaimResults(text, stopReason, md, candidates) {
  const every = (reason) => candidates.map(() => ({ result: 'fail', reason, checked: 0, claims: undefined }));
  if (stopReason === 'refusal') return every('claim check: the model declined to answer (stop_reason refusal)');
  let parsed;
  try {
    parsed = parseJsonReply(text);
  } catch (err) {
    return every(`claim check: unparseable reply (stop_reason ${stopReason}): ${err.message}`);
  }
  const byNumber = extractionsByNumber(parsed);
  return candidates.map((c, i) => {
    if (!byNumber.has(i + 1)) return { result: 'fail', reason: `claim check: no claim list for line ${i + 1} (stop_reason ${stopReason})`, checked: 0, claims: undefined };
    const extraction = byNumber.get(i + 1);
    return { ...compareLine(extraction, md, c.type), claims: extraction?.claims };
  });
}

// Returns { results, stopReason, usage, problem, rawText }: results line up with `candidates`. problem
// (with the raw reply, for review) is set when any line had no readable claim list.
async function claimCheck(md, candidates, { completeFn = complete } = {}) {
  const { text, stopReason, usage } = await completeFn(claimPrompt(md, candidates), { model: CLAIM_MODEL });
  const results = readClaimResults(text, stopReason, md, candidates);
  const unread = results.map((r, i) => (r.claims === undefined ? i + 1 : null)).filter((n) => n !== null);
  const problem = unread.length ? `no readable claim list for line${unread.length > 1 ? 's' : ''} ${unread.join(', ')}: ${results[unread[0] - 1].reason}` : null;
  return { results, stopReason, usage, problem, rawText: problem ? text : undefined };
}

module.exports = { claimCheck, compareClaim, compareLine, readClaimResults, claimPrompt, FACT_KINDS };
