// Shared fixtures for the offline tests (SPEC.md Revision 21). Nothing here touches the network,
// Supabase or any model: every model call in the tests is a stub, and fetch throws if anything tries.

const { buildMatchData, listPlayers } = require('../scripts/lib/match-data');
const { buildNameIndex, nameContext } = require('../scripts/lib/code-gate');

// Any real network call fails the test that made it.
function blockNetwork() {
  globalThis.fetch = async (url) => { throw new Error(`offline test tried to fetch ${String(url).replace(/accounts\/[^/]+/, 'accounts/…')}`); };
}

const CHELSEA = Object.freeze({ id: '61', short_name: 'Chelsea', tla: 'CHE', slug: 'chelsea' });
const BOURNEMOUTH = Object.freeze({ id: '1044', short_name: 'Bournemouth', tla: 'BOU', slug: 'bournemouth' });

// 560595-style: Chelsea 5-1 Bournemouth (HT 2-0), matchday 6, Sat 10 Oct 2026.
function match560595(overrides = {}) {
  return {
    id: '999595', competition: 'PL', matchday: 6, home_team_id: '61', away_team_id: '1044',
    home_score: 5, away_score: 1, home_ht_score: 2, away_ht_score: 0,
    kickoff_at: '2026-10-10T14:00:00Z', status: 'finished', api_status: 'FINISHED',
    player_data: 'ok', home_generation_attempts: 0, away_generation_attempts: 0,
    ...overrides,
  };
}

const PLAYERS = Object.freeze([
  { fpl_id: 1, web_name: 'Henderson', first_name: 'Jordan', second_name: 'Henderson', known_name: null, birth_date: '1999-01-01' },
  { fpl_id: 2, web_name: 'João Pedro', first_name: 'João Pedro', second_name: 'Junqueira de Jesus', known_name: null, birth_date: '2001-09-26' },
  { fpl_id: 3, web_name: 'Martinez', first_name: 'Emiliano', second_name: 'Martínez', known_name: null, birth_date: '1992-09-02' },
  { fpl_id: 4, web_name: 'Rogers', first_name: 'Morgan', second_name: 'Rogers', known_name: null, birth_date: '2002-07-26' },
  { fpl_id: 5, web_name: 'Evanilson', first_name: 'Francisco', second_name: 'Evanilson', known_name: null, birth_date: '1999-10-06' },
  { fpl_id: 6, web_name: 'Petrović', first_name: 'Đorđe', second_name: 'Petrović', known_name: null, birth_date: '1999-10-08' },
]);

const EVENTS = Object.freeze([
  { match_id: '999595', fpl_id: 1, team_id: '61', event: 'goal', count: 2 },
  { match_id: '999595', fpl_id: 2, team_id: '61', event: 'goal', count: 2 },
  { match_id: '999595', fpl_id: 3, team_id: '61', event: 'saves', count: 3 },
  { match_id: '999595', fpl_id: 4, team_id: '61', event: 'goal', count: 1 },
  { match_id: '999595', fpl_id: 5, team_id: '1044', event: 'goal', count: 1 },
  { match_id: '999595', fpl_id: 6, team_id: '1044', event: 'saves', count: 1 },
]);

function playerData() {
  return { events: EVENTS.map((e) => ({ ...e })), players: new Map(PLAYERS.map((p) => [p.fpl_id, { ...p }])) };
}

// One side's match data and code-gate name context: 'home' is Chelsea, 'away' Bournemouth.
function side(which = 'home', match = match560595()) {
  const [team, opponent] = which === 'home' ? [CHELSEA, BOURNEMOUTH] : [BOURNEMOUTH, CHELSEA];
  const pd = playerData();
  return {
    matchData: buildMatchData(match, team, opponent, pd),
    names: nameContext(buildNameIndex(PLAYERS), listPlayers(match, team, pd)),
  };
}

// Eight lines for Chelsea that pass the code gate: 3 STAT, 1 BANTER, 4 HOT_TAKE.
function chelseaLines() {
  return [
    { type: 'STAT', text: 'Won 5-1 at home. Lovely stuff.', note: 'From the final score.' },
    { type: 'STAT', text: 'Henderson and João Pedro both scored twice. Greedy.', note: 'From who scored.' },
    { type: 'STAT', text: 'Six goals in the match. Mental.', note: 'From the final score.' },
    { type: 'BANTER', text: 'Cherries fans always bring the noise. Shame about the rest.', note: "General chat, not about this match. The Cherries is Bournemouth's nickname." },
    { type: 'HOT_TAKE', text: 'Our attack was unplayable. Pure joy.', note: 'Strong take. Not everyone will agree.' },
    { type: 'HOT_TAKE', text: "Bournemouth's defence was a sieve. No arguments.", note: 'Strong take. Not everyone will agree.' },
    { type: 'HOT_TAKE', text: 'Rogers looked like one of the best on the pitch.', note: 'Strong take on Rogers, who scored.' },
    { type: 'HOT_TAKE', text: 'That second half was a joy to behold.', note: 'Strong take. Not everyone will agree.' },
  ];
}

// A minimal in-memory Supabase: the query-builder calls run-pipeline.js and lib/player-data.js make.
function fakeSupabase(tables) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
  function from(table) {
    const state = { op: 'select', filters: [], range: null, values: null };
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      or: () => builder,
      eq: (col, v) => { state.filters.push((r) => String(r[col]) === String(v)); return builder; },
      in: (col, vs) => { state.filters.push((r) => vs.map(String).includes(String(r[col]))); return builder; },
      is: (col, v) => { state.filters.push((r) => (r[col] ?? null) === v); return builder; },
      range: (a, z) => { state.range = [a, z]; return builder; },
      update: (values) => { Object.assign(state, { op: 'update', values }); return builder; },
      insert: (rows) => { Object.assign(state, { op: 'insert', values: rows }); return builder; },
      then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
    };
    function run() {
      const rows = (db[table] ??= []);
      if (state.op === 'insert') {
        rows.push(...state.values.map((r, i) => ({ id: `new-${rows.length + i}`, superseded_at: null, ...r })));
        return { data: null, error: null };
      }
      let hit = rows.filter((r) => state.filters.every((f) => f(r)));
      if (state.op === 'update') {
        hit.forEach((r) => Object.assign(r, state.values));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      if (state.range) hit = hit.slice(state.range[0], state.range[1] + 1);
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    return builder;
  }
  return { from, db };
}

// Supabase holding the 560595-style match, its teams, players and events, and no comments.
function supabaseFor560595(matchOverrides = {}) {
  return fakeSupabase({
    matches: [match560595(matchOverrides)],
    teams: [CHELSEA, BOURNEMOUTH],
    players: PLAYERS,
    match_events: EVENTS,
    comments: [],
  });
}

const usage = (input = 1000, output = 500, neurons = 10) => ({ input_tokens: input, output_tokens: output, neurons });

// Verdict stubs for a checker reply: every rule "pass", or the given overrides.
function passVerdict() {
  return { rules: { E1: 'pass', E2: 'pass' }, result: 'pass', reason: '' };
}

module.exports = {
  blockNetwork, CHELSEA, BOURNEMOUTH, PLAYERS, EVENTS, match560595, playerData, side, chelseaLines,
  fakeSupabase, supabaseFor560595, usage, passVerdict,
};
