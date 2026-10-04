// P0 check (SPEC.md §9). Prints PASS/FAIL check-p0 and exits 0/1. Never prints secrets.
//
// Usage: node scripts/check-p0.js   (run after node scripts/fetch-matches.js)

const { getServiceClient, getAnonClient, unwrap } = require('./lib/supabase-client');
const { FootballDataClient, isoDate } = require('./lib/football-data-client');
const { SLUG_PATTERN } = require('./lib/slug');
const { COMPETITION_CODE, STATUS_MAP, mapStatus, FETCH_DAYS_BACK } = require('./lib/constants');

const CHECK_DAYS = 7;
const DAY_MS = 86_400_000;

const failures = [];
const fail = (msg) => failures.push(msg);
const info = (msg) => console.log(`  ${msg}`);

async function checkFinishedMatches(supabase, api, now) {
  // §9 asks about the last 7 days; the pipeline's whole 14-day look-back is checked too,
  // so the assertion still has something to test during an international break.
  const res = await api.getCompetitionMatches(COMPETITION_CODE, { dateFrom: isoDate(-FETCH_DAYS_BACK, now), dateTo: isoDate(0, now) });
  const sevenDaysAgo = now.getTime() - CHECK_DAYS * DAY_MS;
  const finished = res.matches.filter((m) => m.status === 'FINISHED');
  const finishedLast7 = finished.filter((m) => new Date(m.utcDate).getTime() >= sevenDaysAgo);

  const ids = finished.map((m) => String(m.id));
  const rows = ids.length
    ? unwrap(await supabase.from('matches').select('id, status, home_score, away_score, home_ht_score, away_ht_score').in('id', ids), 'read matches')
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const m of finished) {
    const row = byId.get(String(m.id));
    const label = `match ${m.id} (${m.utcDate.slice(0, 10)} ${m.homeTeam.tla} v ${m.awayTeam.tla})`;
    if (!row) { fail(`${label} is FINISHED in the API but has no matches row`); continue; }
    if (row.status !== 'finished') fail(`${label} is FINISHED in the API but stored as '${row.status}'`);
    if (row.home_score == null || row.away_score == null) { fail(`${label} has a null full-time score`); continue; }
    const ft = m.score.fullTime;
    const ht = m.score.halfTime ?? {};
    if (row.home_score !== ft.home || row.away_score !== ft.away) {
      fail(`${label} stored FT ${row.home_score}-${row.away_score} but API says ${ft.home}-${ft.away}`);
    }
    if (row.home_ht_score !== (ht.home ?? null) || row.away_ht_score !== (ht.away ?? null)) {
      fail(`${label} stored HT ${row.home_ht_score}-${row.away_ht_score} but API says ${ht.home}-${ht.away}`);
    }
  }

  info(`finished matches (API) in last ${CHECK_DAYS} days: ${finishedLast7.length}` +
    (finishedLast7.length === 0 ? ' (none to test: no PL matches finished in that window)' : ''));
  info(`finished matches (API) in last ${FETCH_DAYS_BACK} days: ${finished.length}, all checked for a stored 'finished' row with matching FT/HT scores`);

  const apiStatusesLast7 = res.matches
    .filter((m) => new Date(m.utcDate).getTime() >= sevenDaysAgo)
    .map((m) => m.status);
  return { finishedCount: finished.length, finishedLast7: finishedLast7.length, apiStatusesLast7 };
}

async function checkTeams(supabase) {
  const teams = unwrap(await supabase.from('teams').select('id, short_name, slug, in_current_season'), 'read teams');
  const current = teams.filter((t) => t.in_current_season);
  if (current.length !== 20) fail(`teams has ${current.length} rows with in_current_season = true, expected 20`);

  const seen = new Map();
  for (const t of teams) {
    if (!t.slug) fail(`team ${t.id} (${t.short_name}) has an empty slug`);
    else if (!SLUG_PATTERN.test(t.slug)) fail(`team ${t.id} (${t.short_name}) slug "${t.slug}" doesn't match the §2.1 pattern`);
    if (seen.has(t.slug)) fail(`slug "${t.slug}" is shared by teams ${seen.get(t.slug)} and ${t.id}`);
    seen.set(t.slug, t.id);
  }
  info(`teams: ${current.length} current-season of ${teams.length} total; slugs: ${current.map((t) => t.slug).sort().join(', ')}`);
  return current.length;
}

async function checkStatuses(supabase, apiStatusesLast7, now) {
  const from = new Date(now.getTime() - CHECK_DAYS * DAY_MS).toISOString();
  const rows = unwrap(
    await supabase.from('matches').select('id, status, api_status').gte('kickoff_at', from).lte('kickoff_at', now.toISOString()),
    'read recent matches',
  );
  for (const r of rows) {
    if (r.status !== mapStatus(r.api_status)) fail(`match ${r.id}: api_status ${r.api_status} stored as '${r.status}', STATUS_MAP gives '${mapStatus(r.api_status)}'`);
  }

  const seen = [...new Set([...apiStatusesLast7, ...rows.map((r) => r.api_status)])].sort();
  const unknown = seen.filter((s) => !Object.prototype.hasOwnProperty.call(STATUS_MAP, s));
  const toOther = seen.filter((s) => mapStatus(s) === 'other');
  for (const s of unknown) fail(`API status ${s} is not in STATUS_MAP (fell through to 'other')`);
  info(`api_status values seen in last ${CHECK_DAYS} days: ${seen.length ? seen.join(', ') : 'none'}`);
  info(`statuses mapped to 'other': ${toOther.length ? toOther.join(', ') : 'none'}`);
}

async function reportNullability(supabase) {
  const rows = unwrap(await supabase.from('matches').select('status, matchday, home_ht_score, away_ht_score'), 'read matches');
  const finished = rows.filter((r) => r.status === 'finished');
  const htPresent = finished.filter((r) => r.home_ht_score != null && r.away_ht_score != null).length;
  const mdPresent = rows.filter((r) => r.matchday != null).length;
  const htVerdict = finished.length === 0 ? 'UNKNOWN (no finished matches stored)' : htPresent === finished.length ? 'YES, non-null' : htPresent === 0 ? 'NO, all null' : 'PARTIAL';
  const mdVerdict = rows.length === 0 ? 'UNKNOWN (no matches stored)' : mdPresent === rows.length ? 'YES, non-null' : mdPresent === 0 ? 'NO, all null' : 'PARTIAL';
  console.log(`  half-time scores returned: ${htVerdict} — ${htPresent}/${finished.length} finished matches`);
  console.log(`  matchday returned:         ${mdVerdict} — ${mdPresent}/${rows.length} matches`);
  if (finished.length === 0) fail('no finished matches stored, so half-time availability is unconfirmed');
  return { htVerdict, mdVerdict };
}

// The GRANTs + RLS in supabase/schema.sql, exercised with the publishable key the frontend uses.
async function checkAnonAccess(anon) {
  const teams = await anon.from('teams').select('id').eq('in_current_season', true);
  if (teams.error) fail(`anon cannot read teams: ${teams.error.message}`);
  else if (teams.data.length !== 20) fail(`anon read ${teams.data.length} current-season teams, expected 20`);

  for (const table of ['matches', 'comments']) {
    const r = await anon.from(table).select('id').limit(1);
    if (r.error) fail(`anon cannot read ${table}: ${r.error.message}`);
  }
  for (const table of ['feedback', 'sessions']) {
    const r = await anon.from(table).select('id').limit(1);
    if (r.error?.code !== '42501') fail(`anon read of ${table} was not refused; it should be insert-only (${r.error ? r.error.message : 'no error'})`);
  }

  // Write probes target an id that doesn't exist, so they can't damage data even if a grant
  // is wrong. A missing GRANT gives Postgres error 42501 before RLS is reached; anything else fails.
  const PROBE_ID = 'check-p0-probe';
  const deniedOrFail = (r, what) => {
    if (r.error?.code !== '42501') fail(`anon ${what} was not refused with "permission denied" (${r.error ? r.error.message : 'no error'})`);
  };
  const ins = await anon.from('teams').insert({ id: PROBE_ID, name: 'x', short_name: 'x', tla: 'XXX', slug: PROBE_ID, in_current_season: false, updated_at: new Date().toISOString() });
  deniedOrFail(ins, 'INSERT into teams');
  if (!ins.error) await getServiceClient().from('teams').delete().eq('id', PROBE_ID);
  deniedOrFail(await anon.from('matches').update({ home_score: 0 }).eq('id', PROBE_ID), 'UPDATE on matches');
  deniedOrFail(await anon.from('teams').delete().eq('id', PROBE_ID), 'DELETE on teams');

  info('anon (publishable key): reads teams/matches/comments; cannot read feedback/sessions; cannot insert/update/delete teams or matches');
}

async function main() {
  const now = new Date();
  const supabase = getServiceClient();
  const anon = getAnonClient();
  const api = new FootballDataClient();

  console.log('check-p0');
  const { finishedCount, apiStatusesLast7 } = await checkFinishedMatches(supabase, api, now);
  const teamCount = await checkTeams(supabase);
  await checkStatuses(supabase, apiStatusesLast7, now);
  const { htVerdict, mdVerdict } = await reportNullability(supabase);
  await checkAnonAccess(anon);

  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log(`FAIL check-p0: ${failures.length} problem(s); first: ${failures[0]}`);
    process.exit(1);
  }
  console.log(`PASS check-p0: ${teamCount} current-season teams with unique valid slugs; ${finishedCount} finished matches stored with matching scores; ` +
    `all statuses map through STATUS_MAP; anon grants match RLS; half-time ${htVerdict.split(',')[0].toLowerCase()}, matchday ${mdVerdict.split(',')[0].toLowerCase()}`);
}

main().catch((err) => {
  console.log(`FAIL check-p0: ${err.message}`);
  process.exit(1);
});
