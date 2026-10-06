// Fantasy Premier League public feed (SPEC.md §2.3): its two requests, the team mapping, fixture
// pairing, the score cross-check, and turning a fixture's stats into match_events rows.
// Requests are never retried within a run; the next hourly run is the retry. Everything except
// the two requests is pure, so it can be tested on saved responses.

const { FPL_TEAM_ALIASES } = require('./constants');
const { londonIsoDate } = require('./match-data');

const BASE_URL = 'https://fantasy.premierleague.com/api';
const USER_AGENT = 'matchday-briefing/0.1 (+https://didyouseethatludicrousdisplaylastnight.co.uk)';
const REQUEST_TIMEOUT_MS = 30_000;
const TEAM_COUNT = 20;

// FPL stat identifier -> match_events.event. Every other identifier (bonus, bps, yellow_cards,
// defensive_contribution and anything FPL adds later) is ignored.
const STAT_EVENTS = Object.freeze({
  goals_scored: 'goal',
  own_goals: 'own_goal',
  assists: 'assist',
  red_cards: 'red_card',
  penalties_missed: 'pen_missed',
  penalties_saved: 'pen_saved',
  saves: 'saves',
});

async function fplGet(path) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FPL ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Teams and players. Requested every run, because teams are mapped every run.
const getBootstrap = () => fplGet('bootstrap-static/');

// Every fixture of the season with its per-player stats. One request covers matches waiting in
// any gameweek, including postponed matches FPL has moved (Revision 9).
const getFixtures = () => fplGet('fixtures/');

// Maps FPL's 20 teams onto current-season teams rows: by three-letter code (FPL short_name = our tla),
// then through FPL_TEAM_ALIASES. No name matching. Returns { mapping, problems }: mapping is
// our team id -> { fplTeamId, fplTeamCode, fplShortName, by }, and any problem means the mapping
// must not be used.
function mapFplTeams(fplTeams, ourTeams, aliases = FPL_TEAM_ALIASES) {
  const current = ourTeams.filter((t) => t.in_current_season);
  const byTla = new Map(current.map((t) => [t.tla.toUpperCase(), t]));
  const mapping = new Map();
  const problems = [];
  if (fplTeams.length !== TEAM_COUNT) problems.push(`FPL lists ${fplTeams.length} teams, expected ${TEAM_COUNT}`);

  for (const f of fplTeams) {
    const code = String(f.short_name).toUpperCase();
    let team = byTla.get(code);
    let by = 'code';
    if (!team && aliases[code]) {
      team = byTla.get(aliases[code].toUpperCase());
      by = 'alias';
    }
    if (!team) {
      const alias = aliases[code] ? ` or alias ${aliases[code]}` : '';
      problems.push(`FPL team ${f.id} ${code} ("${f.name}") matches no current-season tla by code${alias}`);
      continue;
    }
    if (mapping.has(team.id)) {
      problems.push(`FPL teams ${mapping.get(team.id).fplTeamId} and ${f.id} both map to ${team.tla}`);
      continue;
    }
    mapping.set(team.id, { fplTeamId: f.id, fplTeamCode: f.code, fplShortName: code, by });
  }

  const unmapped = current.filter((t) => !mapping.has(t.id));
  if (unmapped.length) problems.push(`no FPL team maps to ${unmapped.map((t) => t.tla).join(', ')}`);
  return { mapping, problems };
}

// The FPL fixture with the match's home team, away team and kickoff date (Europe/London), or null.
function pairFixture(match, fixtures, mapping) {
  const home = mapping.get(match.home_team_id);
  const away = mapping.get(match.away_team_id);
  if (!home || !away) return null;
  const date = londonIsoDate(match.kickoff_at);
  return fixtures.find((f) => f.team_h === home.fplTeamId && f.team_a === away.fplTeamId
    && f.kickoff_time && londonIsoDate(f.kickoff_time) === date) ?? null;
}

// Each side's score from FPL's player stats: its players' goals plus the other side's own goals.
// Null if the fixture lacks either stat, so the score can't be worked out.
function scoreFromStats(fixture) {
  const stat = (identifier) => (fixture.stats ?? []).find((s) => s.identifier === identifier);
  const goals = stat('goals_scored');
  const ownGoals = stat('own_goals');
  if (!goals || !ownGoals) return null;
  const sum = (entries) => (entries ?? []).reduce((n, e) => n + e.value, 0);
  return { home: sum(goals.h) + sum(ownGoals.a), away: sum(goals.a) + sum(ownGoals.h) };
}

// match_events rows for a match from its fixture's stats. team_id is the side the stat was listed
// under, never the player's current team.
function eventsFromFixture(fixture, match) {
  const rows = new Map();
  for (const stat of fixture.stats ?? []) {
    const event = STAT_EVENTS[stat.identifier];
    if (!event) continue;
    for (const [side, teamId] of [['h', match.home_team_id], ['a', match.away_team_id]]) {
      for (const { element, value } of stat[side] ?? []) {
        if (!(value > 0)) continue;
        const key = `${element}:${event}`;
        const row = rows.get(key) ?? { match_id: match.id, fpl_id: element, team_id: teamId, event, count: 0 };
        row.count += value;
        rows.set(key, row);
      }
    }
  }
  return [...rows.values()];
}

// What to do with one finished match whose player_data is 'pending' (SPEC.md §2.3 step 4):
//   { result: 'waiting', reason }                 stays pending, and is listed
//   { result: 'ok', fixture, events }             cross-check passed: store the events
//   { result: 'mismatch', fixture, fplScore }     cross-check failed: store none
// knownPlayerIds holds every FPL player id that is, or will be, in the players table.
function planPendingMatch(match, fixtures, mapping, knownPlayerIds) {
  const fixture = pairFixture(match, fixtures, mapping);
  if (!fixture) return { result: 'waiting', reason: 'no FPL fixture pairs with it (same home team, away team and kickoff date)' };
  if (fixture.finished_provisional !== true) return { result: 'waiting', reason: `FPL fixture ${fixture.id} isn't at full time yet (finished_provisional false)` };

  const fplScore = scoreFromStats(fixture);
  if (!fplScore || fplScore.home !== match.home_score || fplScore.away !== match.away_score) {
    return { result: 'mismatch', fixture, fplScore };
  }
  const events = eventsFromFixture(fixture, match);
  const unknown = [...new Set(events.map((e) => e.fpl_id).filter((id) => !knownPlayerIds.has(id)))];
  if (unknown.length) {
    return { result: 'waiting', reason: `FPL fixture ${fixture.id} lists player${unknown.length > 1 ? 's' : ''} ${unknown.map((id) => `#${id}`).join(', ')}, not in bootstrap-static or players` };
  }
  return { result: 'ok', fixture, events };
}

// players rows from bootstrap-static's elements. FPL's empty known_name or birth_date is stored as null.
function playerRows(elements, nowIso) {
  return elements.map((e) => ({
    fpl_id: e.id,
    web_name: e.web_name,
    first_name: e.first_name,
    second_name: e.second_name,
    known_name: e.known_name || null,
    birth_date: e.birth_date || null,
    updated_at: nowIso,
  }));
}

module.exports = {
  USER_AGENT,
  STAT_EVENTS,
  getBootstrap,
  getFixtures,
  mapFplTeams,
  pairFixture,
  scoreFromStats,
  eventsFromFixture,
  planPendingMatch,
  playerRows,
};
