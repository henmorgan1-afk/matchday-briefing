// Reads stored FPL player data (SPEC.md §2.3, §3.5) for match-data.js and the code gate. Used by
// run-pipeline.js and check-p1.js, so a dry run and its check see the same players.

const { unwrap, readAll } = require('./supabase-client');
const { listPlayers } = require('./match-data');
const { buildNameIndex, nameContext } = require('./code-gate');

const PLAYER_COLUMNS = 'fpl_id, web_name, first_name, second_name, known_name, birth_date';

// A match's events and their players, as buildMatchData's playerData, or null unless the match's
// player_data is 'ok'.
async function readPlayerData(supabase, match) {
  if (match.player_data !== 'ok') return null;
  const events = unwrap(
    await supabase.from('match_events').select('fpl_id, team_id, event, count').eq('match_id', match.id),
    `read match_events for match ${match.id}`,
  );
  const ids = [...new Set(events.map((e) => e.fpl_id))];
  const rows = ids.length
    ? unwrap(await supabase.from('players').select(PLAYER_COLUMNS).in('fpl_id', ids), `read players for match ${match.id}`)
    : [];
  return { events, players: new Map(rows.map((p) => [p.fpl_id, p])) };
}

// The code gate's index of every stored player's names.
async function readNameIndex(supabase) {
  return buildNameIndex(await readAll(() => supabase.from('players').select(PLAYER_COLUMNS).order('fpl_id'), 'read players'));
}

// The code gate's name context for one perspective.
function perspectiveNames(nameIndex, match, perspectiveTeam, playerData) {
  return nameContext(nameIndex, listPlayers(match, perspectiveTeam, playerData));
}

module.exports = { readPlayerData, readNameIndex, perspectiveNames };
