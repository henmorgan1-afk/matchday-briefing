// P0: upserts teams and matches from football-data.org into Supabase,
// applying STATUS_MAP (SPEC.md §2.2), the slug rule (§2.1) and score corrections (§3.6).
//
// Usage: node scripts/fetch-matches.js

const { getServiceClient, unwrap } = require('./lib/supabase-client');
const { FootballDataClient, isoDate } = require('./lib/football-data-client');
const { assignSlug } = require('./lib/slug');
const { COMPETITION_CODE, STATUS_MAP, mapStatus, FETCH_DAYS_BACK, FETCH_DAYS_AHEAD } = require('./lib/constants');

const SCORE_FIELDS = ['home_score', 'away_score', 'home_ht_score', 'away_ht_score'];

function formatScore(row) {
  const ft = `${row.home_score ?? '?'}-${row.away_score ?? '?'}`;
  const ht = row.home_ht_score == null && row.away_ht_score == null ? '' : ` (HT ${row.home_ht_score ?? '?'}-${row.away_ht_score ?? '?'})`;
  return ft + ht;
}

async function upsertTeams(supabase, apiTeams, nowIso) {
  const existing = unwrap(await supabase.from('teams').select('id, slug'), 'read teams');
  const slugById = new Map(existing.map((t) => [t.id, t.slug]));
  const takenSlugs = new Map(existing.map((t) => [t.slug, t.id]));

  const rows = [];
  const inserted = [];
  for (const t of apiTeams) {
    const row = {
      id: String(t.id),
      name: t.name,
      short_name: t.shortName,
      tla: t.tla,
      in_current_season: true,
      updated_at: nowIso,
    };
    if (slugById.has(row.id)) {
      row.slug = slugById.get(row.id); // never changed once assigned
    } else {
      row.slug = assignSlug(row, takenSlugs);
      takenSlugs.set(row.slug, row.id);
      inserted.push(`${row.short_name} -> ${row.slug}`);
    }
    rows.push(row);
  }

  unwrap(await supabase.from('teams').upsert(rows, { onConflict: 'id' }), 'upsert teams');

  const currentIds = rows.map((r) => r.id);
  const dropped = unwrap(
    await supabase
      .from('teams')
      .update({ in_current_season: false, updated_at: nowIso })
      .eq('in_current_season', true)
      .not('id', 'in', `(${currentIds.join(',')})`)
      .select('id, short_name'),
    'mark teams no longer in current season',
  );

  return { count: rows.length, inserted, dropped: dropped.map((t) => t.short_name) };
}

function toMatchRow(m, nowIso) {
  const apiStatus = m.status;
  return {
    id: String(m.id),
    competition: m.competition?.code ?? COMPETITION_CODE,
    matchday: m.matchday ?? null,
    home_team_id: String(m.homeTeam.id),
    away_team_id: String(m.awayTeam.id),
    home_score: m.score?.fullTime?.home ?? null,
    away_score: m.score?.fullTime?.away ?? null,
    home_ht_score: m.score?.halfTime?.home ?? null,
    away_ht_score: m.score?.halfTime?.away ?? null,
    kickoff_at: m.utcDate,
    status: mapStatus(apiStatus),
    api_status: apiStatus,
    data_fetched_at: nowIso,
  };
}

async function applyScoreCorrection(supabase, oldRow, newRow, nowIso) {
  // §3.6: scores are already updated by the upsert; supersede live comments and reset attempts.
  unwrap(
    await supabase.from('comments').update({ superseded_at: nowIso }).eq('match_id', newRow.id).is('superseded_at', null),
    `supersede comments for match ${newRow.id}`,
  );
  unwrap(
    await supabase.from('matches').update({ home_generation_attempts: 0, away_generation_attempts: 0 }).eq('id', newRow.id),
    `reset generation attempts for match ${newRow.id}`,
  );
  console.warn(`SCORE CORRECTED: ${newRow.id} ${formatScore(oldRow)} -> ${formatScore(newRow)}`);
}

async function upsertMatches(supabase, apiMatches, nowIso) {
  const rows = apiMatches.map((m) => toMatchRow(m, nowIso));
  if (rows.length === 0) return { count: 0, byStatus: {}, corrections: [], unmapped: [] };

  const existing = unwrap(
    await supabase.from('matches').select(`id, status, ${SCORE_FIELDS.join(', ')}`).in('id', rows.map((r) => r.id)),
    'read existing matches',
  );
  const existingById = new Map(existing.map((r) => [r.id, r]));

  const corrections = [];
  for (const row of rows) {
    const old = existingById.get(row.id);
    if (old && old.status === 'finished' && SCORE_FIELDS.some((f) => old[f] !== row[f])) {
      corrections.push({ old, row });
    }
  }

  const unmapped = [];
  for (const row of rows) {
    if (row.status === 'other') {
      const known = Object.prototype.hasOwnProperty.call(STATUS_MAP, row.api_status);
      console.warn(`STATUS -> other: match ${row.id} has API status ${row.api_status}${known ? '' : ' (not in STATUS_MAP)'}`);
      if (!known) unmapped.push(row.api_status);
    }
  }

  // Generation-attempt columns are left out, so inserts take their defaults and updates leave them alone.
  unwrap(await supabase.from('matches').upsert(rows, { onConflict: 'id' }), 'upsert matches');

  for (const { old, row } of corrections) await applyScoreCorrection(supabase, old, row, nowIso);

  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return { count: rows.length, byStatus, corrections: corrections.map((c) => c.row.id), unmapped };
}

async function fetchMatches({ supabase = getServiceClient(), api = new FootballDataClient(), now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const dateFrom = isoDate(-FETCH_DAYS_BACK, now);
  const dateTo = isoDate(FETCH_DAYS_AHEAD, now);

  const teamsResponse = await api.getCompetitionTeams(COMPETITION_CODE);
  const teams = await upsertTeams(supabase, teamsResponse.teams, nowIso);

  const matchesResponse = await api.getCompetitionMatches(COMPETITION_CODE, { dateFrom, dateTo });
  const matches = await upsertMatches(supabase, matchesResponse.matches, nowIso);

  return { dateFrom, dateTo, teams, matches };
}

async function main() {
  const result = await fetchMatches();
  const { teams, matches } = result;
  console.log(`teams: ${teams.count} current-season rows upserted` +
    (teams.inserted.length ? `; new: ${teams.inserted.join(', ')}` : '') +
    (teams.dropped.length ? `; no longer current: ${teams.dropped.join(', ')}` : ''));
  const statusSummary = Object.entries(matches.byStatus).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
  console.log(`matches: ${matches.count} upserted for ${result.dateFrom}..${result.dateTo} (${statusSummary})`);
  console.log(`score corrections: ${matches.corrections.length ? matches.corrections.join(', ') : 'none'}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`fetch-matches failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { fetchMatches, toMatchRow };
