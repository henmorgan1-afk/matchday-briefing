// Stage 0 spike (docs/better-lines-research.md): a read-only test of the
// Fantasy Premier League (FPL) public feed against the scores stored from football-data.org, which
// stays the source of scores. Fetches bootstrap-static/ and fixtures/?event=5 once each, with no
// retries. Reads Supabase with the publishable key, which RLS and the GRANTs limit to SELECT on
// teams and matches, so the script can't write even by mistake.
//
// Usage: node scripts/spike-fpl.js
// Exits 1 unless all 20 FPL teams map, or if any stored score disagrees with FPL's player stats.

const { getAnonClient, unwrap } = require('./lib/supabase-client');
const { formatKickoffDate, londonIsoDate } = require('./lib/match-data');

const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';
const FPL_EVENT = 5;
const USER_AGENT = 'matchday-briefing/0.1 (read-only data test for a non-commercial prototype; two requests per run)';
const REQUEST_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
// Stored matches are read this far either side of the gameweek, so a fixture whose teams match a
// stored match on another date is reported rather than silently unpaired.
const PAIR_WINDOW_DAYS = 7;

// Player stats printed per side, in this order.
const EVENT_STATS = [
  ['goals_scored', 'goals'],
  ['own_goals', 'own goals'],
  ['red_cards', 'red cards'],
  ['penalties_missed', 'pens missed'],
  ['penalties_saved', 'pens saved'],
  ['saves', 'saves'],
];

async function fplGet(path) {
  const res = await fetch(`${FPL_BASE_URL}/${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FPL ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Lower-case, accents stripped, "&" as "and", apostrophes dropped ("Nott'm" -> "nottm"), other
// punctuation as spaces, and the words "FC" and "AFC" removed.
function normaliseName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((w) => w && w !== 'fc' && w !== 'afc').join(' ');
}

// True when `short` is `long` with letters left out, keeping the first: "nottm" of "nottingham".
function abbreviates(short, long) {
  if (short[0] !== long[0]) return false;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i += 1;
  return i === short.length;
}

// Same number of words, each equal to or an abbreviation of the stored name's word.
function abbreviatesName(fplName, ourName) {
  const a = fplName.split(' ');
  const b = ourName.split(' ');
  return a.length === b.length && a.every((w, i) => abbreviates(w, b[i]));
}

// Rules are tried in order. A rule maps an FPL team only when exactly one unmapped current-season
// team satisfies it, so no rule can map two FPL teams to one of ours.
const MAPPING_RULES = [
  ['code', (fpl, ours) => fpl.short_name.toUpperCase() === ours.tla.toUpperCase()],
  ['name', (fpl, ours) => [ours.name, ours.short_name].some((n) => normaliseName(n) === normaliseName(fpl.name))],
  ['abbreviation', (fpl, ours) => [ours.name, ours.short_name].some((n) => abbreviatesName(normaliseName(fpl.name), normaliseName(n)))],
];

function mapTeams(fplTeams, ourTeams) {
  const current = ourTeams.filter((t) => t.in_current_season);
  const mapping = new Map(); // FPL team id -> { team, by }
  const used = new Set();
  for (const [by, test] of MAPPING_RULES) {
    for (const fpl of fplTeams) {
      if (mapping.has(fpl.id)) continue;
      const candidates = current.filter((t) => !used.has(t.id) && test(fpl, t));
      if (candidates.length !== 1) continue;
      mapping.set(fpl.id, { team: candidates[0], by });
      used.add(candidates[0].id);
    }
  }
  return { mapping, unusedOurs: current.filter((t) => !used.has(t.id)) };
}

function printTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(`  ${r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()}`);
}

function printWrapped(label, items) {
  const lines = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (next.length > 96 && line) { lines.push(`${line},`); line = item; } else line = next;
  }
  if (line) lines.push(line);
  console.log(`  ${label} (${items.length}):`);
  for (const l of lines) console.log(`    ${l}`);
}

// { h: [{ value, element }], a: [...] } for one stat identifier, or null if the feed lacks it.
function statOf(fixture, identifier) {
  return fixture.stats.find((s) => s.identifier === identifier) ?? null;
}

const sumValues = (entries) => entries.reduce((n, e) => n + e.value, 0);

// Under 18 until the 18th birthday, compared as YYYY-MM-DD strings. A 29 Feb birthday's 18th
// then falls on 1 Mar in a non-leap year.
function isUnder18(birthDate, matchDate) {
  const eighteenth = `${Number(birthDate.slice(0, 4)) + 18}${birthDate.slice(4)}`;
  return matchDate < eighteenth;
}

function ageOn(birthDate, matchDate) {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [my, mm, md] = matchDate.split('-').map(Number);
  return my - by - (mm < bm || (mm === bm && md < bd) ? 1 : 0);
}

async function main() {
  console.log(`Fetching FPL bootstrap-static/ and fixtures/?event=${FPL_EVENT} (User-Agent: "${USER_AGENT}")`);
  const bootstrap = await fplGet('bootstrap-static/');
  const fixtures = await fplGet(`fixtures/?event=${FPL_EVENT}`);
  console.log(`  ${bootstrap.teams.length} teams, ${bootstrap.elements.length} players, ${fixtures.length} fixtures in gameweek ${FPL_EVENT}`);

  const supabase = getAnonClient();
  const ourTeams = unwrap(await supabase.from('teams').select('id, name, short_name, tla, slug, in_current_season'), 'read teams');
  const ourTeamById = new Map(ourTeams.map((t) => [t.id, t]));
  const fplTeamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const playerById = new Map(bootstrap.elements.map((p) => [p.id, p]));

  // 2. Team mapping.
  console.log(`\n== 2. Team mapping: FPL -> teams (code first, then normalised name, then abbreviation)`);
  const { mapping, unusedOurs } = mapTeams(bootstrap.teams, ourTeams);
  const rows = [['FPL id', 'code', 'FPL name', 'short', '->', 'our id', 'tla', 'our name', 'slug', 'by']];
  for (const fpl of bootstrap.teams) {
    const m = mapping.get(fpl.id);
    rows.push([fpl.id, fpl.code, fpl.name, fpl.short_name, '->',
      ...(m ? [m.team.id, m.team.tla, m.team.name, m.team.slug, m.by] : ['UNMAPPED', '', '', '', ''])]);
  }
  printTable(rows);
  const byCounts = MAPPING_RULES.map(([by]) => `${[...mapping.values()].filter((m) => m.by === by).length} by ${by}`);
  console.log(`  mapped ${mapping.size} of ${bootstrap.teams.length} FPL teams (${byCounts.join(', ')})`);
  if (mapping.size !== 20 || bootstrap.teams.length !== 20) {
    if (unusedOurs.length) console.log(`  our current-season teams left unmapped: ${unusedOurs.map((t) => `${t.tla} ${t.name}`).join('; ')}`);
    console.log(`\nFAIL spike-fpl: ${mapping.size} of ${bootstrap.teams.length} FPL teams mapped; all 20 must map`);
    process.exitCode = 1;
    return;
  }

  // 3. Pair fixtures with stored matches by home team, away team and London kickoff date.
  console.log(`\n== 3. Pairing FPL fixtures with stored matches (home, away, kickoff date in Europe/London)`);
  const kickoffs = fixtures.map((f) => Date.parse(f.kickoff_time)).filter(Number.isFinite);
  const stored = kickoffs.length ? unwrap(
    await supabase.from('matches')
      .select('id, matchday, home_team_id, away_team_id, home_score, away_score, kickoff_at, status')
      .gte('kickoff_at', new Date(Math.min(...kickoffs) - PAIR_WINDOW_DAYS * DAY_MS).toISOString())
      .lte('kickoff_at', new Date(Math.max(...kickoffs) + PAIR_WINDOW_DAYS * DAY_MS).toISOString()),
    'read matches',
  ) : [];

  const paired = fixtures.map((f) => {
    const home = mapping.get(f.team_h).team;
    const away = mapping.get(f.team_a).team;
    const date = f.kickoff_time ? londonIsoDate(f.kickoff_time) : null;
    const sameTeams = stored.filter((m) => m.home_team_id === home.id && m.away_team_id === away.id);
    const match = sameTeams.find((m) => date && londonIsoDate(m.kickoff_at) === date) ?? null;
    const otherDate = match ? null : sameTeams[0] ?? null;
    return { f, home, away, date, match, otherDate };
  });
  for (const { f, home, away, match, otherDate } of paired) {
    const when = f.kickoff_time ? formatKickoffDate(f.kickoff_time) : 'no kickoff time';
    let to;
    if (match) to = `match ${match.id} (matchday ${match.matchday}, ${match.status}, stored ${match.home_score ?? '?'}-${match.away_score ?? '?'})`;
    else if (otherDate) to = `NOT PAIRED: stored match ${otherDate.id} has these teams but kicks off ${formatKickoffDate(otherDate.kickoff_at)}`;
    else to = 'no stored match';
    console.log(`  FPL fixture ${String(f.id).padStart(3)}  ${when}  ${home.short_name} v ${away.short_name}`.padEnd(66) + ` -> ${to}`);
  }

  // 4 and 5. Player events per side, then the score cross-check.
  console.log(`\n== 4-5. Player events by side (from the fixture's h/a stats) and the score cross-check`);
  const finished = paired.filter((p) => p.f.finished === true);
  for (const p of paired.filter((x) => x.f.finished !== true)) {
    console.log(`  FPL fixture ${p.f.id} ${p.home.short_name} v ${p.away.short_name}: finished = ${p.f.finished}, skipped`);
  }
  const results = { pass: 0, mismatch: 0, unchecked: 0 };
  for (const p of finished) {
    const { f, home, away, match } = p;
    console.log(`\n  FPL fixture ${f.id} · ${formatKickoffDate(f.kickoff_time)} · ${home.short_name} ${f.team_h_score}-${f.team_a_score} ${away.short_name} (FPL score)` +
      (match ? ` · match ${match.id}` : ' · no stored match'));
    for (const [side, team, fplTeamId] of [['h', home, f.team_h], ['a', away, f.team_a]]) {
      console.log(`    ${team.short_name} (${side === 'h' ? 'home' : 'away'})`);
      for (const [identifier, label] of EVENT_STATS) {
        const stat = statOf(f, identifier);
        const entries = stat ? stat[side] : null;
        const text = !stat ? '(not in feed)' : !entries.length ? '-' : entries.map((e) => {
          const player = playerById.get(e.element);
          const name = player ? player.web_name : `#${e.element} (not in bootstrap)`;
          const now = player && player.team !== fplTeamId ? ` [now ${fplTeamById.get(player.team)?.short_name ?? player.team}]` : '';
          return `${name} ${e.value}${now}`;
        }).join(', ');
        console.log(`      ${`${label}:`.padEnd(13)} ${text}`);
      }
    }

    const goals = statOf(f, 'goals_scored');
    const ownGoals = statOf(f, 'own_goals');
    const homeFromPlayers = sumValues(goals?.h ?? []) + sumValues(ownGoals?.a ?? []);
    const awayFromPlayers = sumValues(goals?.a ?? []) + sumValues(ownGoals?.h ?? []);
    const working = `home ${sumValues(goals?.h ?? [])} goals + ${sumValues(ownGoals?.a ?? [])} away own goals = ${homeFromPlayers}; ` +
      `away ${sumValues(goals?.a ?? [])} goals + ${sumValues(ownGoals?.h ?? [])} home own goals = ${awayFromPlayers}`;
    if (!goals || !ownGoals) {
      results.mismatch += 1;
      console.log(`    cross-check: MISMATCH (feed has no ${!goals ? 'goals_scored' : 'own_goals'} stat)`);
    } else if (!match) {
      results.unchecked += 1;
      const agrees = homeFromPlayers === f.team_h_score && awayFromPlayers === f.team_a_score;
      console.log(`    cross-check: NOT CHECKED, no stored match. ${working}; against FPL's own score: ${agrees ? 'agrees' : 'DISAGREES'}`);
    } else if (homeFromPlayers === match.home_score && awayFromPlayers === match.away_score) {
      results.pass += 1;
      console.log(`    cross-check: PASS. ${working}; stored ${match.home_score}-${match.away_score}`);
    } else {
      results.mismatch += 1;
      console.log(`    cross-check: MISMATCH. ${working}; stored ${match.home_score ?? 'null'}-${match.away_score ?? 'null'}`);
    }
  }

  // 6. Under-18s on match day, across every stat (bps lists nearly everyone who played).
  console.log(`\n== 6. Players in any stat of a finished fixture who were under 18 on match day`);
  const appearances = new Map(); // player id -> [{ fixture, side, identifiers }]
  for (const { f, home, away } of finished) {
    for (const stat of f.stats) {
      for (const [side, team] of [['h', home], ['a', away]]) {
        for (const e of stat[side] ?? []) {
          const list = appearances.get(e.element) ?? [];
          let entry = list.find((x) => x.f === f);
          if (!entry) { entry = { f, team, side, identifiers: [] }; list.push(entry); }
          entry.identifiers.push(stat.identifier);
          appearances.set(e.element, list);
        }
      }
    }
  }
  const under18 = [];
  const noBirthDate = [];
  const notInBootstrap = [];
  for (const [id, list] of appearances) {
    const player = playerById.get(id);
    if (!player) { notInBootstrap.push(`#${id}`); continue; }
    if (!player.birth_date) { noBirthDate.push(player.web_name); continue; }
    for (const { f, team, side, identifiers } of list) {
      const matchDate = londonIsoDate(f.kickoff_time);
      if (isUnder18(player.birth_date, matchDate)) {
        under18.push(`${player.web_name} (born ${player.birth_date}, aged ${ageOn(player.birth_date, matchDate)}), ` +
          `${team.short_name} ${side === 'h' ? 'home' : 'away'}, FPL fixture ${f.id} on ${formatKickoffDate(f.kickoff_time)}, in: ${identifiers.join(', ')}`);
      }
    }
  }
  console.log(`  ${appearances.size} distinct players appear in the stats of ${finished.length} finished fixtures`);
  if (under18.length) for (const line of under18) console.log(`  UNDER 18: ${line}`);
  else console.log('  none under 18');
  console.log(`  no birth_date in the feed, so age unknown: ${noBirthDate.length ? noBirthDate.join(', ') : 'none'}`);
  console.log(`  in the stats but not in bootstrap-static: ${notInBootstrap.length ? notInBootstrap.join(', ') : 'none'}`);

  // 7. Every field name seen, in first-seen order.
  console.log(`\n== 7. Field names seen`);
  const keysOf = (objects) => [...new Set(objects.flatMap((o) => Object.keys(o)))];
  const allStats = fixtures.flatMap((f) => f.stats ?? []);
  printWrapped('on a fixture', keysOf(fixtures));
  printWrapped('stat identifiers', [...new Set(allStats.map((s) => s.identifier))]);
  printWrapped('on a stat object', keysOf(allStats));
  printWrapped('on a stat entry', keysOf(allStats.flatMap((s) => [...(s.h ?? []), ...(s.a ?? [])])));
  printWrapped('on a player (bootstrap-static elements)', keysOf(bootstrap.elements));

  const summary = `${mapping.size}/20 teams mapped; ${finished.length} finished fixtures: ${results.pass} PASS, ` +
    `${results.mismatch} MISMATCH, ${results.unchecked} not checked (no stored match); ${under18.length} under-18 appearances`;
  if (results.mismatch) {
    console.log(`\nFAIL spike-fpl: ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`\nspike-fpl: ${summary}`);
  }
}

main().catch((err) => {
  console.error(`FAIL spike-fpl: ${err.message}`);
  process.exitCode = 1;
});
