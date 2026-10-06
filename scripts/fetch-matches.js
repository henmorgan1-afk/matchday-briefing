// P0: upserts teams and matches from football-data.org into Supabase,
// applying STATUS_MAP (SPEC.md §2.2), the slug rule (§2.1) and score corrections (§3.6),
// then runs the FPL step (§2.3): team mapping, players, and events for finished matches.
//
// Usage: node scripts/fetch-matches.js
// Exits non-zero if either source fails. An FPL failure leaves football-data.org's writes in place.

const { getServiceClient, unwrap } = require('./lib/supabase-client');
const { FootballDataClient, isoDate } = require('./lib/football-data-client');
const fplClient = require('./lib/fpl-client');
const { londonIsoDate } = require('./lib/match-data');
const { assignSlug } = require('./lib/slug');
const {
  COMPETITION_CODE, STATUS_MAP, mapStatus, FETCH_DAYS_BACK, FETCH_DAYS_AHEAD, FPL_WAIT_HOURS,
} = require('./lib/constants');

const HOUR_MS = 3_600_000;
const PLAYER_UPSERT_CHUNK = 500;

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
  // Revision 9: the old events no longer fit the new score. Clearing them sends the match back to
  // 'pending', so this run's FPL step refetches them and the generation gate holds the match until then.
  unwrap(await supabase.from('match_events').delete().eq('match_id', newRow.id), `delete match_events for match ${newRow.id}`);
  unwrap(
    await supabase.from('matches').update({
      home_generation_attempts: 0,
      away_generation_attempts: 0,
      player_data: 'pending',
      fpl_fixture_id: null,
      fpl_data_at: null,
    }).eq('id', newRow.id),
    `reset generation attempts and player data for match ${newRow.id}`,
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

  // Generation-attempt and FPL columns are left out, so inserts take their defaults and updates
  // leave them alone.
  unwrap(await supabase.from('matches').upsert(rows, { onConflict: 'id' }), 'upsert matches');

  // §2.3 step 3: when a match is first stored as finished. Set in its own update, never in the
  // upsert, so it can't be overwritten later.
  const newlyFinished = rows.filter((r) => r.status === 'finished' && existingById.get(r.id)?.status !== 'finished').map((r) => r.id);
  if (newlyFinished.length) {
    unwrap(
      await supabase.from('matches').update({ finished_seen_at: nowIso }).in('id', newlyFinished).is('finished_seen_at', null),
      'set finished_seen_at',
    );
  }

  for (const { old, row } of corrections) await applyScoreCorrection(supabase, old, row, nowIso);

  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return { count: rows.length, byStatus, corrections: corrections.map((c) => c.row.id), unmapped };
}

// ---------------------------------------------------------------- FPL step (SPEC.md §2.3)

function matchLabel(match, teamsById) {
  const tla = (id) => teamsById.get(id)?.tla ?? id;
  return `${match.id} ${londonIsoDate(match.kickoff_at)} ${tla(match.home_team_id)} v ${tla(match.away_team_id)}`;
}

// "1h 05m", or "3d 04h" from two days on.
function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, '0')}h`;
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// How long since the match was first stored as finished. Matches finished before Revision 9 have
// no finished_seen_at, so there's nothing to measure from.
function sinceFinished(match, now) {
  return match.finished_seen_at ? formatDuration(now.getTime() - Date.parse(match.finished_seen_at)) : null;
}

// Writes fpl_team_id and fpl_team_code, touching only rows whose values change; every team FPL
// doesn't list gets null in both. Returns how many rows changed.
async function writeTeamMapping(supabase, teams, mapping) {
  let changed = 0;
  for (const t of teams) {
    const m = mapping.get(t.id);
    const next = { fpl_team_id: m?.fplTeamId ?? null, fpl_team_code: m?.fplTeamCode ?? null };
    if (t.fpl_team_id === next.fpl_team_id && t.fpl_team_code === next.fpl_team_code) continue;
    unwrap(await supabase.from('teams').update(next).eq('id', t.id), `write FPL ids for team ${t.id}`);
    changed += 1;
  }
  return changed;
}

async function upsertPlayers(supabase, rows) {
  for (let i = 0; i < rows.length; i += PLAYER_UPSERT_CHUNK) {
    unwrap(await supabase.from('players').upsert(rows.slice(i, i + PLAYER_UPSERT_CHUNK), { onConflict: 'fpl_id' }), 'upsert players');
  }
}

// FPL player ids that are, or after this run will be, in players: everyone in bootstrap-static,
// plus anyone a pending match's stats name who is missing from it but was stored by an earlier run.
async function knownPlayerIds(supabase, bootstrapRows, pending, fixtures, mapping) {
  const known = new Set(bootstrapRows.map((r) => r.fpl_id));
  const missing = new Set();
  for (const m of pending) {
    const fixture = fplClient.pairFixture(m, fixtures, mapping);
    if (!fixture?.finished_provisional) continue;
    for (const e of fplClient.eventsFromFixture(fixture, m)) if (!known.has(e.fpl_id)) missing.add(e.fpl_id);
  }
  if (missing.size) {
    const stored = unwrap(await supabase.from('players').select('fpl_id').in('fpl_id', [...missing]), 'read players missing from bootstrap-static');
    for (const { fpl_id: id } of stored) known.add(id);
  }
  return known;
}

// Events are replaced first and player_data is set last, and only while it's still 'pending', so a
// failed write leaves the match pending and the next run tries again.
async function storeOk(supabase, match, plan, nowIso) {
  unwrap(await supabase.from('match_events').delete().eq('match_id', match.id), `clear match_events for match ${match.id}`);
  if (plan.events.length) unwrap(await supabase.from('match_events').insert(plan.events), `insert match_events for match ${match.id}`);
  unwrap(
    await supabase.from('matches').update({ player_data: 'ok', fpl_fixture_id: plan.fixture.id, fpl_data_at: nowIso })
      .eq('id', match.id).eq('player_data', 'pending'),
    `set player_data ok on match ${match.id}`,
  );
}

async function storeMismatch(supabase, match, plan, nowIso) {
  unwrap(
    await supabase.from('matches').update({ player_data: 'mismatch', fpl_fixture_id: plan.fixture.id, fpl_data_at: nowIso })
      .eq('id', match.id).eq('player_data', 'pending'),
    `set player_data mismatch on match ${match.id}`,
  );
}

// Maps teams, upserts players, and stores events for every finished match waiting on FPL. It never
// throws for FPL's sake: a failed request, a failed mapping or a failed write comes back as `error`,
// with every match not yet settled listed as waiting, so the caller can print it and skip generation.
async function syncFpl(supabase, fpl, now) {
  const nowIso = now.toISOString();
  const teams = unwrap(await supabase.from('teams').select('id, tla, in_current_season, fpl_team_id, fpl_team_code'), 'read teams');
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const pending = unwrap(
    await supabase.from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, kickoff_at, finished_seen_at')
      .eq('status', 'finished').eq('player_data', 'pending').order('kickoff_at').order('id'),
    'read finished matches waiting for FPL',
  );

  const result = { error: null, mapped: null, teamsChanged: 0, players: 0, fixturesRequested: false, checked: [], waiting: [], unavailable: [] };
  const settled = new Set();
  const entry = (m, extra) => ({ id: m.id, label: matchLabel(m, teamsById), waited: sinceFinished(m, now), ...extra });

  try {
    const bootstrap = await fpl.getBootstrap();
    const { mapping, problems } = fplClient.mapFplTeams(bootstrap.teams, teams);
    if (problems.length) throw new Error(`team mapping failed, nothing written: ${problems.join('; ')}`);
    const by = [...mapping.values()].map((m) => m.by);
    result.mapped = { total: mapping.size, byCode: by.filter((b) => b === 'code').length, byAlias: by.filter((b) => b === 'alias').length };
    result.teamsChanged = await writeTeamMapping(supabase, teams, mapping);

    const players = fplClient.playerRows(bootstrap.elements, nowIso);
    await upsertPlayers(supabase, players);
    result.players = players.length;

    if (pending.length) {
      const fixtures = await fpl.getFixtures();
      result.fixturesRequested = true;
      const known = await knownPlayerIds(supabase, players, pending, fixtures, mapping);
      for (const m of pending) {
        const plan = fplClient.planPendingMatch(m, fixtures, mapping, known);
        if (plan.result === 'ok') {
          await storeOk(supabase, m, plan, nowIso);
          result.checked.push(entry(m, { result: 'ok', fixtureId: plan.fixture.id, events: plan.events.length }));
        } else if (plan.result === 'mismatch') {
          await storeMismatch(supabase, m, plan, nowIso);
          const fplScore = plan.fplScore ? `FPL players give ${plan.fplScore.home}-${plan.fplScore.away}` : "FPL's fixture lacks goals_scored or own_goals";
          console.warn(`FPL MISMATCH: ${m.id} stored ${m.home_score}-${m.away_score}, ${fplScore}`);
          result.checked.push(entry(m, { result: 'mismatch', fixtureId: plan.fixture.id, detail: fplScore }));
        } else {
          result.waiting.push(entry(m, { reason: plan.reason }));
        }
        settled.add(m.id);
      }

      // The safety-net cap (FPL_WAIT_HOURS, off while null): a match that has waited too long gets
      // team-level lines.
      if (FPL_WAIT_HOURS != null) {
        const cutoff = now.getTime() - FPL_WAIT_HOURS * HOUR_MS;
        for (const w of [...result.waiting]) {
          const m = pending.find((p) => p.id === w.id);
          if (!m.finished_seen_at || Date.parse(m.finished_seen_at) > cutoff) continue;
          unwrap(
            await supabase.from('matches').update({ player_data: 'unavailable' }).eq('id', m.id).eq('player_data', 'pending'),
            `set player_data unavailable on match ${m.id}`,
          );
          result.waiting.splice(result.waiting.indexOf(w), 1);
          result.unavailable.push(w);
        }
      }
    }
  } catch (err) {
    result.error = err.message;
    for (const m of pending) if (!settled.has(m.id)) result.waiting.push(entry(m, { reason: 'FPL step failed this run' }));
  }
  return result;
}

// ---------------------------------------------------------------- run

async function fetchMatches({ supabase = getServiceClient(), api = new FootballDataClient(), fpl = fplClient, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const dateFrom = isoDate(-FETCH_DAYS_BACK, now);
  const dateTo = isoDate(FETCH_DAYS_AHEAD, now);

  const teamsResponse = await api.getCompetitionTeams(COMPETITION_CODE);
  const teams = await upsertTeams(supabase, teamsResponse.teams, nowIso);

  const matchesResponse = await api.getCompetitionMatches(COMPETITION_CODE, { dateFrom, dateTo });
  const matches = await upsertMatches(supabase, matchesResponse.matches, nowIso);

  const fplResult = await syncFpl(supabase, fpl, now);

  return { dateFrom, dateTo, teams, matches, fpl: fplResult };
}

// SPEC.md §2.3 step 6. Every finished match still waiting is listed on every run, with why.
function logFplSummary(fpl) {
  if (fpl.mapped) {
    console.log(`fpl: ${fpl.mapped.total}/20 teams mapped (${fpl.mapped.byCode} by code, ${fpl.mapped.byAlias} by alias)` +
      `${fpl.teamsChanged ? `, ${fpl.teamsChanged} teams rows updated` : ''}; ${fpl.players} players upserted; ` +
      `fixtures ${fpl.fixturesRequested ? 'requested' : 'not requested (no finished match waiting)'}`);
  }
  for (const c of fpl.checked) {
    const delay = c.waited ? `${c.waited} after it was stored as finished` : 'finished before Revision 9';
    const what = c.result === 'ok' ? `ok, ${c.events} events stored` : `MISMATCH, no events stored (${c.detail})`;
    console.log(`fpl data: ${c.label}: ${what}; FPL fixture ${c.fixtureId}; delay ${delay}`);
  }
  for (const u of fpl.unavailable) {
    console.log(`fpl unavailable: ${u.label}: waited ${u.waited}, over FPL_WAIT_HOURS (${FPL_WAIT_HOURS}); gets team-level lines (${u.reason})`);
  }
  for (const w of fpl.waiting) {
    console.log(`fpl waiting: ${w.label}: ${w.waited ? `pending ${w.waited}` : 'pending (finished before Revision 9)'}; ${w.reason}`);
  }
  if (!fpl.waiting.length) console.log('fpl waiting: none');
  if (fpl.error) console.log(`FPL STEP FAILED: ${fpl.error}`);
}

function logFetchSummary(result) {
  const { teams, matches } = result;
  console.log(`teams: ${teams.count} current-season rows upserted` +
    (teams.inserted.length ? `; new: ${teams.inserted.join(', ')}` : '') +
    (teams.dropped.length ? `; no longer current: ${teams.dropped.join(', ')}` : ''));
  const statusSummary = Object.entries(matches.byStatus).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
  console.log(`matches: ${matches.count} upserted for ${result.dateFrom}..${result.dateTo} (${statusSummary})`);
  console.log(`score corrections: ${matches.corrections.length ? matches.corrections.join(', ') : 'none'}`);
  logFplSummary(result.fpl);
}

async function main() {
  const result = await fetchMatches();
  logFetchSummary(result);
  if (result.fpl.error) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`fetch-matches failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { fetchMatches, logFetchSummary, toMatchRow, syncFpl, formatDuration };
