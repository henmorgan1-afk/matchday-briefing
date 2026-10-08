// P2 check (SPEC.md §9). Prints PASS/FAIL check-p2 and exits 0/1. Never prints secrets.
//
// Usage:
//   node scripts/check-p2.js                 against the live domain
//   node scripts/check-p2.js --base <url>    against another copy, e.g. http://localhost:8080. The
//                                            live-domain checks (HTTPS, http:// and www. redirects)
//                                            only run against the live domain, and the result says so.
//
// Needs a one-off `npx playwright install chromium`. Reads Supabase with the publishable key only,
// so it sees exactly what the frontend can see.

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { chromium } = require('playwright');
const { getAnonClient, unwrap } = require('./lib/supabase-client');
const { COMMENT_TYPES } = require('./lib/constants');

const LIVE_ORIGIN = 'https://didyouseethatludicrousdisplaylastnight.co.uk';
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const ENV_FILE = path.join(__dirname, '..', '.env');
const PUBLIC_ENV = new Set(['SUPABASE_URL', 'SUPABASE_ANON_KEY']); // committed in frontend/config.js by design
const UNKNOWN_SLUG = 'not-a-real-team';
const SETTLE_MS = 20_000;
const TAG_LABELS = { STAT: 'STAT', BANTER: 'BANTER', HOT_TAKE: 'HOT TAKE' };

const failures = [];
const fail = (msg) => failures.push(msg);
const info = (msg) => console.log(`  ${msg}`);

function parseArgs(argv) {
  const i = argv.indexOf('--base');
  const base = (i >= 0 ? argv[i + 1] : LIVE_ORIGIN) || '';
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error('usage: node scripts/check-p2.js [--base <http(s) origin>]');
  return { base: base.replace(/\/+$/, '') };
}

function frontendFiles(dir = FRONTEND_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? frontendFiles(full) : [path.relative(FRONTEND_DIR, full).split(path.sep).join('/')];
  });
}

// Every .env value except the two public ones, by name. Values under 8 characters are skipped:
// they can't be keys and would match by accident.
function privateEnvValues() {
  const parsed = fs.existsSync(ENV_FILE) ? dotenv.parse(fs.readFileSync(ENV_FILE)) : {};
  return Object.entries(parsed).filter(([name, value]) => !PUBLIC_ENV.has(name) && value && value.length >= 8);
}

// ---------------------------------------------------------------- expected state, from Supabase

// What each team view should show, worked out independently of app.js's query. For every team, its
// live comments per finished match (`byMatch`), and its briefing (`latest`): the latest of those
// matches, with the opponent and whether the opponent has live comments for it (the opposition link).
async function expectedBriefings(anon, teams, allTeams) {
  const byId = new Map(allTeams.map((t) => [t.id, t]));
  const out = new Map();
  for (const team of teams) {
    const comments = unwrap(await anon.from('comments').select('id, match_id').eq('perspective_team_id', team.id).is('superseded_at', null), `read comments for ${team.slug}`);
    const matchIds = [...new Set(comments.map((c) => c.match_id))];
    const matches = matchIds.length
      ? unwrap(await anon.from('matches').select('id, kickoff_at, home_team_id, away_team_id').in('id', matchIds).eq('status', 'finished'), `read matches for ${team.slug}`)
      : [];
    matches.sort((a, b) => b.kickoff_at.localeCompare(a.kickoff_at) || b.id.localeCompare(a.id));
    const byMatch = new Map(matches.map((m) => [m.id, comments.filter((c) => c.match_id === m.id).map((c) => c.id)]));
    const latest = matches[0];
    let briefing = null;
    if (latest) {
      const opponent = byId.get(latest.home_team_id === team.id ? latest.away_team_id : latest.home_team_id);
      const { count, error } = await anon.from('comments').select('id', { count: 'exact', head: true })
        .eq('match_id', latest.id).eq('perspective_team_id', opponent.id).is('superseded_at', null);
      if (error) throw new Error(`count opponent comments for ${team.slug}: ${error.message}`);
      briefing = { matchId: latest.id, commentIds: byMatch.get(latest.id), opponent, opponentHasComments: count > 0 };
    }
    out.set(team.slug, { team, latest: briefing, byMatch });
  }
  return out;
}

// ---------------------------------------------------------------- HTTP checks

async function checkLiveDomain() {
  const home = `${LIVE_ORIGIN}/`;
  const res = await fetch(home);
  if (res.status !== 200 || res.url !== home) fail(`${home} returned ${res.status} at ${res.url}, expected 200 with no redirect`);
  for (const variant of ['http://didyouseethatludicrousdisplaylastnight.co.uk/', 'https://www.didyouseethatludicrousdisplaylastnight.co.uk/', 'http://www.didyouseethatludicrousdisplaylastnight.co.uk/']) {
    try {
      const r = await fetch(variant);
      if (!r.redirected || r.url !== home || r.status !== 200) fail(`${variant} ended at ${r.url} (${r.status}), expected a redirect to ${home}`);
    } catch (err) {
      fail(`${variant} could not be fetched: ${err.cause?.code || err.message}`);
    }
  }
  info(`live domain: ${home} is 200 over HTTPS; http:// and www. redirect checks run`);
}

async function checkManifestAndWorker(base) {
  const manifestUrl = `${base}/manifest.webmanifest`;
  const res = await fetch(manifestUrl);
  if (res.status !== 200) { fail(`manifest.webmanifest returned ${res.status}`); return; }
  let manifest;
  try { manifest = await res.json(); } catch { fail('manifest.webmanifest is not valid JSON'); return; }
  if (!manifest.name) fail('manifest has no name');
  if (!manifest.start_url) fail('manifest has no start_url');
  if (manifest.display !== 'standalone') fail(`manifest display is ${JSON.stringify(manifest.display)}, expected "standalone"`);
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  for (const size of ['192x192', '512x512']) {
    if (!icons.some((icon) => String(icon.sizes).split(/\s+/).includes(size))) fail(`manifest has no ${size} icon`);
  }
  // Every icon loads, and its real pixel size is the one its "sizes" claims.
  for (const icon of icons) {
    const r = await fetch(new URL(icon.src, manifestUrl));
    if (r.status !== 200) { fail(`manifest icon ${icon.src} returned ${r.status}`); continue; }
    const actual = pngSize(Buffer.from(await r.arrayBuffer()));
    if (!actual) fail(`manifest icon ${icon.src} is not a PNG`);
    else if (actual !== icon.sizes) fail(`manifest icon ${icon.src} is ${actual}, but its sizes says ${icon.sizes}`);
  }
  const maskable = icons.filter((icon) => String(icon.purpose).split(/\s+/).includes('maskable'));
  if (maskable.length !== 1) fail(`manifest has ${maskable.length} maskable icons, expected 1`);
  const linked = await checkPageIcons(base);
  const sw = await fetch(`${base}/sw.js`);
  const type = sw.headers.get('content-type') || '';
  if (sw.status !== 200 || !/javascript/i.test(type)) fail(`sw.js returned ${sw.status} with content type "${type}", expected 200 and JavaScript`);
  info(`manifest: name "${manifest.name}", display ${manifest.display}, ${icons.length} icons at their stated sizes (${maskable.length} maskable); ` +
    `page icons ${linked.join(', ')}; sw.js ${sw.status} ${type.split(';')[0]}`);
}

// "WxH" from a PNG's IHDR chunk, or null if the bytes aren't a PNG.
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

// The favicon and apple-touch-icon links in index.html (Revision 12): each file loads, and each PNG
// is the size it should be.
const PAGE_ICONS = { 'favicon.svg': null, 'favicon-32.png': '32x32', 'apple-touch-icon.png': '180x180' };

async function checkPageIcons(base) {
  const html = await (await fetch(`${base}/`)).text();
  const hrefs = [...html.matchAll(/<link\s[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/g)]
    .map(([tag]) => (tag.match(/href="([^"]+)"/) || [])[1]).filter(Boolean);
  const found = [];
  for (const [name, size] of Object.entries(PAGE_ICONS)) {
    const href = hrefs.find((h) => h.split('/').pop() === name);
    if (!href) { fail(`index.html has no icon link to ${name}`); continue; }
    const r = await fetch(new URL(href, `${base}/`));
    if (r.status !== 200) { fail(`${href} returned ${r.status}`); continue; }
    const body = Buffer.from(await r.arrayBuffer());
    if (size && pngSize(body) !== size) fail(`${href} is ${pngSize(body) || 'not a PNG'}, expected ${size}`);
    found.push(href);
  }
  return found;
}

async function checkSecrets(base, files) {
  const secrets = privateEnvValues();
  if (!secrets.length) { fail('no private values found in .env to scan for'); return; }
  for (const rel of files) {
    const local = fs.readFileSync(path.join(FRONTEND_DIR, rel)).toString('latin1');
    const res = await fetch(`${base}/${rel}`);
    if (res.status !== 200) fail(`deployed ${rel} returned ${res.status}`);
    const deployed = Buffer.from(await res.arrayBuffer()).toString('latin1');
    for (const [name, value] of secrets) {
      if (deployed.includes(value)) fail(`the value of ${name} appears in deployed ${rel}`);
      if (local.includes(value)) fail(`the value of ${name} appears in frontend/${rel}`);
    }
  }
  info(`secrets: ${secrets.length} private .env values (${secrets.map(([n]) => n).join(', ')}) absent from ${files.length} frontend files, local and served`);
}

// ---------------------------------------------------------------- browser checks

async function visit(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== 'loading', null, { timeout: SETTLE_MS });
  const state = await page.evaluate(() => document.body.dataset.state);
  const mainText = (await page.locator('#main').innerText()).trim();
  return { page, state, errors, mainText };
}

function commonPageProblems(label, { state, errors, mainText }) {
  if (state === 'error') fail(`${label} rendered the error state`);
  if (!mainText) fail(`${label} rendered a blank page`);
  for (const e of errors) fail(`${label} logged a console error: ${e}`);
}

async function cardsOn(page) {
  return page.$$eval('.cards > .card', (cards) => cards.map((card) => ({
    id: card.dataset.commentId,
    type: card.dataset.type,
    tag: card.querySelector('.tag')?.textContent ?? '',
    text: card.querySelector('.card__text')?.textContent ?? '',
    note: card.querySelector('.card__note')?.textContent ?? '',
    copy: Boolean(card.querySelector('button.copy')),
    thumbs: card.querySelectorAll('button.thumb').length,
  })));
}

async function checkHome(context, base, currentTeams) {
  const v = await visit(context, `${base}/`);
  commonPageProblems('homepage', v);
  if (v.state !== 'home') fail(`homepage state is "${v.state}", expected "home"`);
  const slugs = await v.page.$$eval('#picker .team-link', (links) => links.map((a) => a.dataset.slug));
  const expected = currentTeams.map((t) => t.slug);
  if (slugs.length !== expected.length) fail(`homepage picker has ${slugs.length} entries, expected ${expected.length} (one per current-season team)`);
  const missing = expected.filter((s) => !slugs.includes(s));
  const extra = slugs.filter((s) => !expected.includes(s));
  if (missing.length) fail(`homepage picker is missing ${missing.join(', ')}`);
  if (extra.length) fail(`homepage picker has teams not in the current season: ${extra.join(', ')}`);

  const worker = await v.page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then((reg) => (reg.active ? reg.active.scriptURL : null)),
    new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]));
  if (!worker) fail('sw.js did not register and activate on the homepage');
  await v.page.close();
  info(`homepage: ${slugs.length} picker entries for ${expected.length} current-season teams; service worker ${worker ? 'active' : 'NOT active'}`);
}

// Cards are shown HOT_TAKE first, then BANTER, then STAT.
const CARD_ORDER = ['HOT_TAKE', 'BANTER', 'STAT'];

// The shared assertions for a rendered briefing. want: { matchId, commentIds, opponent,
// opponentHasComments }. datePrefix is "Last match" for a team's latest briefing and "Match" for a
// view pinned with ?match=.
async function checkBriefingView(v, label, want, datePrefix) {
  if (v.state !== 'team') {
    fail(`${label} ended in state "${v.state}", expected match ${want.matchId}'s briefing`);
    return [];
  }
  const cards = await cardsOn(v.page);
  if (!cards.length) fail(`${label} rendered the team view with no comment cards`);
  const dateText = await v.page.locator('.match__label').innerText().catch(() => '');
  if (!dateText.toLowerCase().startsWith(`${datePrefix}: `.toLowerCase())) fail(`${label} has date label "${dateText}", expected "${datePrefix}: <date>"`);
  for (const c of cards) {
    if (!COMMENT_TYPES.includes(c.type) || c.tag !== TAG_LABELS[c.type]) fail(`${label} card ${c.id} has type "${c.type}" with tag "${c.tag}"`);
    if (!c.text.trim() || !c.note.trim()) fail(`${label} card ${c.id} has an empty text or note`);
    if (!c.copy || c.thumbs !== 2) fail(`${label} card ${c.id} is missing its copy button or thumbs`);
  }
  const order = cards.map((c) => CARD_ORDER.indexOf(c.type));
  if (order.some((n, i) => i > 0 && n < order[i - 1])) fail(`${label} cards aren't in HOT_TAKE, BANTER, STAT order`);
  const shown = cards.map((c) => c.id).sort().join();
  if (shown !== [...want.commentIds].sort().join()) fail(`${label} shows ${cards.length} cards, expected the ${want.commentIds.length} live comments of match ${want.matchId}`);

  // The opposition link: present, pointing at the same match, only when the opponent has live comments for it.
  const links = await v.page.$$eval('.opponent-link', (as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent })));
  const href = `?team=${encodeURIComponent(want.opponent.slug)}&match=${encodeURIComponent(want.matchId)}`;
  if (want.opponentHasComments) {
    if (links.length !== 1) {
      fail(`${label} has ${links.length} opposition links, expected 1 to ${href}`);
    } else {
      if (links[0].href !== href) fail(`${label} opposition link goes to "${links[0].href}", expected "${href}"`);
      if (!links[0].text.includes(want.opponent.short_name)) fail(`${label} opposition link text "${links[0].text}" doesn't name ${want.opponent.short_name}`);
    }
  } else if (links.length) {
    fail(`${label} has an opposition link, but ${want.opponent.short_name} has no live comments for match ${want.matchId}`);
  }
  return cards;
}

async function checkTeamPages(context, base, currentTeams, expected) {
  let withBriefing = 0;
  let noBriefing = 0;
  let links = 0;
  let interactionsChecked = false;
  for (const team of currentTeams) {
    const label = `?team=${team.slug}`;
    const v = await visit(context, `${base}/?team=${encodeURIComponent(team.slug)}`);
    commonPageProblems(label, v);
    const want = expected.get(team.slug).latest;

    if (v.state === 'no-briefing') {
      noBriefing += 1;
      if (!v.mainText.includes('No briefing yet')) fail(`${label} is in the no-briefing state without the "No briefing yet" message`);
      if (want) fail(`${label} says "No briefing yet" but match ${want.matchId} has ${want.commentIds.length} live comments for it`);
      if (await v.page.locator('.opponent-link').count()) fail(`${label} has an opposition link with no briefing`);
    } else if (v.state === 'team' && !want) {
      fail(`${label} shows a briefing but Supabase has no live comments for it`);
    } else if (v.state === 'team') {
      withBriefing += 1;
      if (want.opponentHasComments) links += 1;
      const cards = await checkBriefingView(v, label, want, 'Last match');
      if (!interactionsChecked && cards.length) {
        await checkCardInteractions(v.page, label, cards[0], v.errors);
        interactionsChecked = true;
      }
    } else {
      fail(`${label} ended in state "${v.state}", expected a briefing or "No briefing yet"`);
    }
    await v.page.close();
  }
  info(`team pages: ${currentTeams.length} loaded; ${withBriefing} with a briefing (${links} with an opposition link), ${noBriefing} "No briefing yet"`);
  return withBriefing;
}

const readRecents = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('recentTeams') || '[]'));

// The opposition link and ?match=, in a fresh browser so Recent starts empty.
async function checkMatchParam(browser, base, currentTeams, expected) {
  const from = currentTeams.find((t) => expected.get(t.slug).latest?.opponentHasComments);
  if (!from) {
    info('opposition link and ?match=: NOT checked (no briefing has an opponent with live comments)');
    return;
  }
  const a = expected.get(from.slug).latest;
  const opponent = expected.get(a.opponent.slug);
  const context = await browser.newContext();
  try {
    // 1. Follow the link: the opponent's lines for the same match, with a link back, and Recent untouched.
    const v = await visit(context, `${base}/?team=${encodeURIComponent(from.slug)}`);
    commonPageProblems(`?team=${from.slug}`, v);
    const recentBefore = await readRecents(v.page);
    if (recentBefore.join() !== from.slug) fail(`opening ?team=${from.slug} left Recent as [${recentBefore}], expected [${from.slug}]`);
    if (await v.page.locator('.opponent-link').count() !== 1) {
      fail(`?team=${from.slug} has no opposition link to follow`);
      return;
    }
    await Promise.all([v.page.waitForURL(/[?&]match=/), v.page.locator('.opponent-link').click()]);
    await v.page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== 'loading', null, { timeout: SETTLE_MS });
    const label = `?team=${a.opponent.slug}&match=${a.matchId} (via the link)`;
    const followed = {
      ...v,
      state: await v.page.evaluate(() => document.body.dataset.state),
      mainText: (await v.page.locator('#main').innerText()).trim(),
    };
    commonPageProblems(label, followed);
    const theirs = { matchId: a.matchId, commentIds: (opponent && opponent.byMatch.get(a.matchId)) || [], opponent: from, opponentHasComments: true };
    await checkBriefingView(followed, label, theirs, 'Match');
    const recentAfter = await readRecents(v.page);
    if (recentAfter.join() !== from.slug) fail(`following the opposition link changed Recent to [${recentAfter}], expected [${from.slug}]`);
    await v.page.close();

    // 2. Unknown or unusable match ids fall back to the team's latest briefing.
    // A real finished match with live comments that this team didn't play (an older match of its own
    // would rightly be shown, not fall back).
    const ownMatches = expected.get(from.slug).byMatch;
    const otherMatch = [...expected.values()].map((e) => e.latest && e.latest.matchId).find((id) => id && !ownMatches.has(id));
    const fallbacks = ['not-a-number', '999999999', '-1', otherMatch].filter(Boolean);
    for (const bad of fallbacks) {
      const url = `?team=${from.slug}&match=${encodeURIComponent(bad)}`;
      const f = await visit(context, `${base}/${url}`);
      commonPageProblems(url, f);
      await checkBriefingView(f, url, a, 'Last match');
      await f.page.close();
    }
    const noBriefingTeam = currentTeams.find((t) => !expected.get(t.slug).latest);
    if (noBriefingTeam) {
      const url = `?team=${noBriefingTeam.slug}&match=${a.matchId}`;
      const f = await visit(context, `${base}/${url}`);
      commonPageProblems(url, f);
      if (f.state !== 'no-briefing') fail(`${url} ended in state "${f.state}", expected "No briefing yet"`);
      await f.page.close();
    }

    // 3. None of those ?match= pages added anything to Recent.
    const probe = await context.newPage();
    await probe.goto(`${base}/`);
    const recentEnd = await readRecents(probe);
    if (recentEnd.join() !== from.slug) fail(`?match= pages changed Recent to [${recentEnd}], expected [${from.slug}]`);
    await probe.close();
    info(`opposition link: ?team=${from.slug} links to ?team=${a.opponent.slug}&match=${a.matchId}, which shows that side's ${theirs.commentIds.length} lines with a link back; ` +
      `Recent unchanged; ${fallbacks.length} unusable match ids fall back to the latest briefing` + (otherMatch ? ` (including another team's match, ${otherMatch})` : ''));
  } finally {
    await context.close();
  }
}

// Copy puts the line on the clipboard; a thumbs tap toggles on the page (feedback writes are P4).
async function checkCardInteractions(page, label, card, errors) {
  const errorsBefore = errors.length;
  const el = page.locator(`.card[data-comment-id="${card.id}"]`);
  await el.locator('button.copy').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (copied !== card.text) fail(`${label}: the copy button put something other than the line on the clipboard`);
  const up = el.locator('button.thumb--up');
  const down = el.locator('button.thumb--down');
  await up.click();
  const afterUp = [await up.getAttribute('aria-pressed'), await down.getAttribute('aria-pressed')].join();
  await down.click();
  const afterDown = [await up.getAttribute('aria-pressed'), await down.getAttribute('aria-pressed')].join();
  if (afterUp !== 'true,false' || afterDown !== 'false,true') fail(`${label}: thumbs didn't toggle (after up: ${afterUp}; after down: ${afterDown})`);
  for (const e of errors.slice(errorsBefore)) fail(`${label} logged a console error during copy/thumbs: ${e}`);
  info(`card actions: copy and thumbs work on ${label}`);
}

async function checkUnknownTeam(context, base, currentTeams) {
  const v = await visit(context, `${base}/?team=${UNKNOWN_SLUG}`);
  commonPageProblems(`?team=${UNKNOWN_SLUG}`, v);
  if (v.state !== 'unknown-team') fail(`?team=${UNKNOWN_SLUG} state is "${v.state}", expected "unknown-team"`);
  if (!v.mainText.includes("We don't know that team")) fail(`?team=${UNKNOWN_SLUG} doesn't say "We don't know that team"`);
  const pickerCount = await v.page.locator('#picker .team-link').count();
  if (pickerCount !== currentTeams.length) fail(`?team=${UNKNOWN_SLUG} shows ${pickerCount} picker entries, expected ${currentTeams.length}`);
  await v.page.close();
  info(`unknown slug: "We don't know that team" above a ${pickerCount}-team picker`);
}

// Beyond §9, for §7's "reopen the last briefing with the network off". A fresh browser opens a team
// link once (as a tester following a link would), then reloads it with the network off.
async function checkOffline(browser, base, slug, expectedIds) {
  const context = await browser.newContext();
  try {
    const v = await visit(context, `${base}/?team=${encodeURIComponent(slug)}`);
    await v.page.evaluate(() => navigator.serviceWorker.ready);
    await v.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: SETTLE_MS });
    await context.setOffline(true);

    // The offline emulation must reach the service worker's own fetches too, or this proves nothing:
    // a read that was never cached has to fail.
    const probeFailed = await v.page.evaluate(async () => {
      const { SUPABASE_URL, SUPABASE_ANON_KEY } = self.MATCHDAY_CONFIG;
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/teams?select=id&limit=1&offset=${Date.now()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
        return false;
      } catch {
        return true;
      }
    });
    if (!probeFailed) fail('offline: an uncached Supabase read still succeeded, so the offline test is not testing the cache');

    await v.page.reload({ waitUntil: 'load' });
    await v.page.waitForFunction(() => document.body.dataset.state && document.body.dataset.state !== 'loading', null, { timeout: SETTLE_MS });
    const state = await v.page.evaluate(() => document.body.dataset.state);
    const ids = (await cardsOn(v.page)).map((c) => c.id).sort();
    const offlineNotice = await v.page.locator('.notice--offline').count();
    if (state !== 'team') fail(`offline: ?team=${slug} reloaded into state "${state}", expected the cached briefing`);
    else if (ids.join() !== [...expectedIds].sort().join()) fail(`offline: ?team=${slug} shows ${ids.length} cards, expected the ${expectedIds.length} it showed online`);
    if (!offlineNotice) fail(`offline: ?team=${slug} has no offline notice`);
    info(`offline: ?team=${slug} reloaded with the network off shows the same ${ids.length} cards from the cache`);
  } finally {
    await context.close();
  }
}

// The install area (Revision 14): Bookmark + Install web app, whose tips open in a pop-up <dialog>
// (Revision 15). Headless Chromium never fires beforeinstallprompt itself, so the check dispatches a
// fake one, with a prompt() that counts its calls and a userChoice with the outcome under test.
const INSTALL_UAS = {
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
const BOOKMARK_TITLE = 'Bookmark this page';
const INSTALL_TITLE = 'Install the web app';
const BOOKMARK_TIPS = {
  android: 'Tap ⋮ at the top right, then the ☆ star.',
  iphone: 'Tap Share, then "Add Bookmark".',
  windows: 'Press Ctrl+D.',
  mac: 'Press ⌘+D.',
};
const INSTALL_TIPS = {
  android: 'Tap ⋮ at the top right, then "Install app".',
  iphone: 'Tap Share, then "Add to Home Screen".',
  windows: "Look for the install icon at the right of the address bar, or in your browser's menu. Not there? Chrome and Edge support it.",
  mac: "Look for the install icon at the right of the address bar, or in your browser's menu. Not there? Chrome and Edge support it.",
};
const REASSURANCE = 'Free · No app store · Remove any time';

// Phones get touch, so a Mac user agent with no touch points is a Mac and not an iPad. Every page
// counts showModal() calls in window.tipDialogOpens, so "never opened" can be checked, not just
// "closed now".
async function installContext(browser, device, width = 390) {
  const context = await browser.newContext({
    userAgent: INSTALL_UAS[device],
    viewport: { width, height: 844 },
    ...(device === 'android' || device === 'iphone' ? { hasTouch: true, isMobile: true } : {}),
  });
  await context.addInitScript(() => {
    const showModal = HTMLDialogElement.prototype.showModal;
    window.tipDialogOpens = 0;
    HTMLDialogElement.prototype.showModal = function countedShowModal() {
      window.tipDialogOpens += 1;
      return showModal.call(this);
    };
  });
  return context;
}

const installState = (page) => page.evaluate(() => {
  const visible = (el) => Boolean(el && el.checkVisibility());
  const dialog = document.getElementById('tip-dialog');
  return {
    area: visible(document.getElementById('install')),
    bookmark: visible(document.getElementById('bookmark-button')),
    install: visible(document.getElementById('install-button')),
    reassure: visible(document.querySelector('#install .install__reassure')),
    dialog: Boolean(dialog && dialog.open),
    opens: window.tipDialogOpens,
    footer: visible(document.getElementById('footer-iphone')),
  };
});

// Every install-step wait gives up after 3 s with a failure naming the element and what it expected,
// so a broken page fails fast rather than on Playwright's 30 s default, which stops the whole run.
const INSTALL_WAIT_MS = 3_000;
const WAITED = `gave up after ${INSTALL_WAIT_MS / 1000} s waiting`;

async function tap(page, id, label) {
  try {
    await page.locator(`#${id}`).click({ timeout: INSTALL_WAIT_MS });
    return true;
  } catch {
    fail(`install: ${label}: ${WAITED} to tap #${id} (expected it visible and enabled)`);
    return false;
  }
}

// Waits for fn(arg) to be true in the page. On timeout it fails with `what`, plus what `found()`
// reports, and returns false.
async function waitInPage(page, label, what, fn, arg, found) {
  try {
    await page.waitForFunction(fn, arg, { timeout: INSTALL_WAIT_MS });
    return true;
  } catch {
    fail(`install: ${label}: ${WAITED} for ${what}${found ? `; found ${await found()}` : ''}`);
    return false;
  }
}

const dialogNow = (page) => page.evaluate(() => {
  const dialog = document.getElementById('tip-dialog');
  if (!dialog) return 'no #tip-dialog';
  if (!dialog.open) return '#tip-dialog closed';
  const text = (id) => JSON.stringify(document.getElementById(id)?.textContent ?? null);
  return `#tip-dialog open with heading ${text('tip-dialog-title')} and text ${text('tip-dialog-text')}`;
});

const focusedId = (page) => page.evaluate(() => (document.activeElement && document.activeElement.id) || document.activeElement?.tagName || 'nothing');

// Taps a button, then waits for the tip dialog to be open, modal and visible with this heading and
// text, and checks that focus is on "Got it".
async function expectDialog(page, label, id, title, text) {
  if (!await tap(page, id, label)) return false;
  const opened = await waitInPage(page, label, `#tip-dialog to open with heading "${title}" and text "${text}"`, ([t, x]) => {
    const dialog = document.getElementById('tip-dialog');
    return Boolean(dialog && dialog.open && dialog.matches(':modal') && dialog.checkVisibility()
      && document.getElementById('tip-dialog-title')?.textContent === t
      && document.getElementById('tip-dialog-text')?.textContent === x);
  }, [title, text], () => dialogNow(page));
  if (!opened) return false;
  const focused = await focusedId(page);
  if (focused !== 'tip-dialog-close') fail(`install: ${label}: with the dialog open, focus is on ${focused}, expected "Got it" (#tip-dialog-close)`);
  return true;
}

// Waits for the dialog to close after `how`, then checks focus went back to the button that opened it.
async function expectClosed(page, label, how, openerId) {
  const closed = await waitInPage(page, label, `#tip-dialog to close after ${how}`,
    () => !document.getElementById('tip-dialog').open, null, () => dialogNow(page));
  if (!closed) return false;
  const focused = await focusedId(page);
  if (focused !== openerId) fail(`install: ${label}: after ${how} closed the dialog, focus is on ${focused}, expected #${openerId}`);
  return true;
}

// With the dialog open: the card is inside the viewport with at least 16px each side, no text is wider
// than its box, and the heading, the text, each .tip-sym and "Got it" stay inside the card, with the
// text clear of "Got it". The 22px symbols' glyph boxes are taller than a 17px line, so a symbol on
// the last line reaches a pixel or two below the paragraph's own box; that's allowed, as long as it
// stays in the card and clear of the button. Returns a summary.
async function cardFits(page, label) {
  await animationsDone(page, label);
  const m = await page.evaluate(() => {
    const dialog = document.getElementById('tip-dialog');
    const card = dialog.getBoundingClientRect();
    const close = document.getElementById('tip-dialog-close').getBoundingClientRect();
    const inCard = (b) => b.left >= card.left && b.right <= card.right && b.top >= card.top && b.bottom <= card.bottom;
    const parts = [
      ...['tip-dialog-title', 'tip-dialog-text', 'tip-dialog-close'].map((id) => ({ name: `#${id}`, el: document.getElementById(id) })),
      ...[...dialog.querySelectorAll('.tip-sym')].map((el) => ({ name: `the ${el.textContent} symbol`, el })),
    ].map(({ name, el }) => {
      const b = el.getBoundingClientRect();
      return { name, wide: el.scrollWidth > el.clientWidth + 1, outside: !inCard(b), intoButton: el.id !== 'tip-dialog-close' && b.bottom > close.top };
    });
    return { left: card.left, right: window.innerWidth - card.right, top: card.top, bottom: window.innerHeight - card.bottom, width: card.width, scrolls: dialog.scrollHeight > dialog.clientHeight + 1, parts };
  });
  if (m.left < 16 || m.right < 16) fail(`install: ${label}: the tip card is ${m.left.toFixed(1)}px from the left and ${m.right.toFixed(1)}px from the right, expected at least 16px each side`);
  if (m.top < 0 || m.bottom < 0) fail(`install: ${label}: the tip card runs off the top or bottom of the viewport`);
  if (m.scrolls) fail(`install: ${label}: the tip card's content is taller than the card`);
  for (const p of m.parts) {
    if (p.wide) fail(`install: ${label}: ${p.name}'s text is wider than its box`);
    if (p.outside) fail(`install: ${label}: ${p.name} sticks out of the tip card`);
    if (p.intoButton) fail(`install: ${label}: ${p.name} reaches into "Got it"`);
  }
  return `${label}: ${Math.round(m.width)}px wide, ${Math.round(m.left)}px each side`;
}

// The open animation is 150 ms; measurements wait for it, so the card isn't caught mid-scale.
const animationsDone = (page, label) => waitInPage(page, label, 'the open animation to finish',
  () => document.getAnimations().every((a) => a.playState === 'finished'), null,
  () => page.evaluate(() => `${document.getAnimations().length} animations running`));

// Returns whether app.js called preventDefault() on it.
const fakeInstallPrompt = (page, outcome) => page.evaluate((result) => {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  window.installPromptCalls = 0;
  event.prompt = () => { window.installPromptCalls += 1; return Promise.resolve(); };
  event.userChoice = Promise.resolve({ outcome: result, platform: 'web' });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}, outcome);

const promptCalls = (page) => page.evaluate(() => window.installPromptCalls);

async function withInstallPage(browser, device, url, label, fn, width) {
  const context = await installContext(browser, device, width);
  try {
    const v = await visit(context, url);
    await fn(v.page);
    commonPageProblems(label, v); // after the taps, so errors they cause count too
  } finally {
    await context.close();
  }
}

async function checkInstall(browser, base, teamSlug) {
  const started = Date.now();
  // The served HTML hides the area itself, so nothing flashes before app.js runs, and the dialog
  // isn't open.
  const html = await (await fetch(`${base}/`)).text();
  const tagOf = (id) => (html.match(new RegExp(`<[a-z]+\\s[^>]*id="${id}"[^>]*>`)) || [])[0];
  const installTag = tagOf('install');
  if (!installTag || !/\shidden(?=[\s>])/.test(installTag)) fail(`install: index.html's #install ${installTag ? 'has no hidden attribute' : 'is missing'}`);
  const dialogTag = tagOf('tip-dialog');
  if (!dialogTag || !/^<dialog\s/.test(dialogTag) || /\sopen(?=[\s>=])/.test(dialogTag)) fail(`install: index.html's #tip-dialog ${dialogTag ? `is ${dialogTag}, expected a <dialog> without open` : 'is missing'}`);
  const home = `${base}/`;

  // 1. Android home page on load: both buttons and the reassurance line, no tip line (gone in
  //    Revision 15), the dialog closed and built as specified, and no footer iPhone line.
  await withInstallPage(browser, 'android', home, 'install (Android home)', async (page) => {
    const s = await installState(page);
    for (const [key, name] of [['area', 'install area'], ['bookmark', 'Bookmark button'], ['install', 'Install web app button'], ['reassure', 'reassurance line']]) {
      if (!s[key]) fail(`install: the ${name} is not visible on load (Android home page)`);
    }
    if (s.dialog || s.opens !== 0) fail('install: #tip-dialog is open on load, expected it closed');
    if (s.footer) fail("install: the footer's iPhone line shows alongside the install area");
    const parts = await page.evaluate(() => {
      const dialog = document.getElementById('tip-dialog');
      const close = document.getElementById('tip-dialog-close');
      const heading = dialog && document.getElementById(dialog.getAttribute('aria-labelledby'));
      return {
        tipLine: Boolean(document.getElementById('install-tip') || document.querySelector('.install__tip')),
        dialog: Boolean(dialog),
        labelledByH2InDialog: Boolean(heading && heading.tagName === 'H2' && dialog.contains(heading)),
        paragraph: Boolean(dialog && dialog.contains(document.getElementById('tip-dialog-text'))),
        close: close ? { inDialog: dialog.contains(close), button: close.tagName === 'BUTTON' && close.type === 'button', autofocus: close.autofocus, label: close.textContent.trim() } : null,
      };
    });
    if (parts.tipLine) fail('install: the Revision 14 tip line (#install-tip / .install__tip) is still in the page');
    if (!parts.dialog) fail('install: there is no #tip-dialog');
    else {
      if (!parts.labelledByH2InDialog) fail("install: #tip-dialog's aria-labelledby doesn't point at an <h2> inside it");
      if (!parts.paragraph) fail('install: #tip-dialog has no #tip-dialog-text paragraph');
      const c = parts.close;
      if (!c || !c.inDialog || !c.button || !c.autofocus || c.label !== 'Got it') fail(`install: #tip-dialog-close is ${JSON.stringify(c)}, expected a <button type="button" autofocus> reading "Got it" inside the dialog`);
    }
    const controls = await page.evaluate(() => ['bookmark-button', 'install-button'].map((id) => {
      const b = document.getElementById(id);
      return { id, label: b.textContent.trim(), button: b.tagName === 'BUTTON' && b.type === 'button' };
    }));
    const want = { 'bookmark-button': 'Bookmark', 'install-button': 'Install web app' };
    for (const c of controls) {
      if (c.label !== want[c.id]) fail(`install: #${c.id} reads "${c.label}", expected "${want[c.id]}"`);
      if (!c.button) fail(`install: #${c.id} is not a <button type="button">`);
    }
    const reassure = await page.evaluate(() => {
      const line = document.querySelector('#install .install__reassure');
      return line ? line.textContent.trim() : null;
    });
    if (reassure !== REASSURANCE) fail(`install: the reassurance line (#install .install__reassure) reads ${JSON.stringify(reassure)}, expected "${REASSURANCE}"`);
  });

  // 2. Each device's tips, with no saved event. Every way of closing gets used on every device:
  //    Bookmark, "Got it", Bookmark again (a second tap reopens it), Escape, then Install web app and a
  //    click on the backdrop, 5px in from the viewport's top left. Focus goes back to the opener each time.
  for (const device of Object.keys(INSTALL_UAS)) {
    await withInstallPage(browser, device, home, `install (${device} tips)`, async (page) => {
      if (!(await installState(page)).area) {
        fail(`install: the install area is not visible on the home page with a ${device} user agent`);
        return;
      }
      const bookmark = [BOOKMARK_TITLE, BOOKMARK_TIPS[device]];
      if (await expectDialog(page, `Bookmark on ${device}`, 'bookmark-button', ...bookmark)
        && await tap(page, 'tip-dialog-close', `"Got it" on ${device}`)) {
        await expectClosed(page, `"Got it" on ${device}`, '"Got it"', 'bookmark-button');
      }
      if (await expectDialog(page, `second Bookmark tap on ${device}`, 'bookmark-button', ...bookmark)) {
        await page.keyboard.press('Escape');
        await expectClosed(page, `Escape on ${device}`, 'Escape', 'bookmark-button');
      }
      if (await expectDialog(page, `Install web app on ${device} with no saved event`, 'install-button', INSTALL_TITLE, INSTALL_TIPS[device])) {
        await page.mouse.click(5, 5);
        await expectClosed(page, `backdrop click on ${device}`, 'a click on the backdrop', 'install-button');
      }
    });
  }

  // 3. A saved event, accepted: prompt() once and no dialog, then the area hides and the footer line
  //    comes back.
  await withInstallPage(browser, 'android', home, 'install (accepted)', async (page) => {
    if (!await fakeInstallPrompt(page, 'accepted')) fail('install: app.js did not call preventDefault() on beforeinstallprompt');
    if (await tap(page, 'install-button', 'accepted prompt')) {
      await waitInPage(page, 'accepted prompt', '#install to be hidden after the prompt was accepted',
        () => !document.getElementById('install').checkVisibility(), null, () => Promise.resolve('#install still visible'));
    }
    const calls = await promptCalls(page);
    if (calls !== 1) fail(`install: Install web app with a saved event called prompt() ${calls} times, expected 1`);
    const s = await installState(page);
    if (s.dialog || s.opens !== 0) fail(`install: Install web app with a saved event opened #tip-dialog (${s.opens} times), expected prompt() only`);
    if (!s.footer) fail("install: the footer's iPhone line (#footer-iphone) didn't come back after the install area hid");
  });

  // 4. A saved event, dismissed: no dialog, the buttons stay, and the next tap opens the dialog
  //    rather than calling prompt() again.
  await withInstallPage(browser, 'android', home, 'install (dismissed)', async (page) => {
    await fakeInstallPrompt(page, 'dismissed');
    if (await tap(page, 'install-button', 'dismissed prompt')) {
      await waitInPage(page, 'dismissed prompt', 'tapping #install-button to call prompt() once',
        () => window.installPromptCalls === 1, null, async () => `${await promptCalls(page)} calls`);
    }
    await page.waitForTimeout(200); // let app.js read userChoice
    const s = await installState(page);
    if (!s.bookmark || !s.install) fail('install: dismissed prompt: #bookmark-button and #install-button hid, expected both to stay visible');
    if (s.dialog || s.opens !== 0) fail('install: dismissed prompt: #tip-dialog opened alongside the browser prompt, expected it closed');
    await expectDialog(page, 'next tap after a dismissal', 'install-button', INSTALL_TITLE, INSTALL_TIPS.android);
    const calls = await promptCalls(page);
    if (calls !== 1) fail(`install: after a dismissal, prompt() was called ${calls} times in all, expected 1`);
  });

  // 5. appinstalled hides the area.
  await withInstallPage(browser, 'android', home, 'install (appinstalled)', async (page) => {
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    if ((await installState(page)).area) fail('install: the install area is still visible after appinstalled');
  });

  // 6. Where it shows: the unknown-team page has the team list, so it gets the area; a team page
  //    doesn't, even with a saved event, and keeps the footer's iPhone line.
  await withInstallPage(browser, 'android', `${base}/?team=${UNKNOWN_SLUG}`, `install (?team=${UNKNOWN_SLUG})`, async (page) => {
    if (!(await installState(page)).area) fail(`install: ?team=${UNKNOWN_SLUG} has no install area under its team list`);
  });
  const teamUrl = `${base}/?team=${encodeURIComponent(teamSlug)}`;
  await withInstallPage(browser, 'android', teamUrl, `install (?team=${teamSlug})`, async (page) => {
    await fakeInstallPrompt(page, 'accepted');
    const s = await installState(page);
    if (s.area) fail(`install: ?team=${teamSlug} shows the install area`);
    if (s.dialog || s.opens !== 0) fail(`install: ?team=${teamSlug} opened #tip-dialog`);
  });
  await withInstallPage(browser, 'iphone', teamUrl, `install (iPhone ?team=${teamSlug})`, async (page) => {
    const s = await installState(page);
    if (s.area) fail(`install: ?team=${teamSlug} shows the install area with an iPhone user agent`);
    if (s.dialog || s.opens !== 0) fail(`install: ?team=${teamSlug} opened #tip-dialog with an iPhone user agent`);
    if (!s.footer) fail(`install: ?team=${teamSlug} with an iPhone user agent hides the footer's iPhone line`);
  });

  // 7. Running installed (display-mode: standalone, or navigator.standalone on iPhone): no area.
  for (const device of ['android', 'iphone']) {
    const context = await installContext(browser, device);
    try {
      await context.addInitScript((stubStandalone) => {
        if (stubStandalone) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
        else {
          const realMatchMedia = window.matchMedia.bind(window);
          window.matchMedia = (query) => (/display-mode:\s*standalone/.test(query)
            ? { ...realMatchMedia(query), matches: true, media: query }
            : realMatchMedia(query));
        }
      }, device === 'iphone');
      const v = await visit(context, home);
      await fakeInstallPrompt(v.page, 'accepted');
      const s = await installState(v.page);
      if (s.area) fail(`install: the installed app (${device === 'iphone' ? 'navigator.standalone' : 'display-mode: standalone'}) shows the install area`);
      if (s.dialog || s.opens !== 0) fail(`install: the installed app (${device}) opened #tip-dialog`);
      if (!s.footer) fail(`install: the installed app (${device}) hides the footer's iPhone line`);
      commonPageProblems(`install (${device} installed)`, v);
    } finally {
      await context.close();
    }
  }

  // 8. At 360px and 390px: each label on one line, the two buttons side by side on one row, and the
  //    tip card inside the viewport.
  const sizes = [];
  const cards = [];
  for (const width of [360, 390]) {
    await withInstallPage(browser, 'android', home, `install (${width}px)`, async (page) => {
      await waitInPage(page, `${width}px`, 'document.fonts to finish loading (the label widths depend on Oswald)',
        () => document.fonts.status === 'loaded', null, () => page.evaluate(() => `document.fonts.status "${document.fonts.status}"`));
      const m = await page.evaluate(() => {
        const box = (id) => {
          const b = document.getElementById(id);
          const r = b.getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height, overflows: b.scrollWidth > b.clientWidth };
        };
        return { bookmark: box('bookmark-button'), install: box('install-button'), scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      for (const [name, b] of [['Bookmark', m.bookmark], ['Install web app', m.install]]) {
        if (b.height >= 56) fail(`install: at ${width}px the ${name} button is ${b.height}px tall, so its label wraps`);
        if (b.overflows) fail(`install: at ${width}px the ${name} label is wider than its button`);
      }
      if (Math.abs(m.bookmark.top - m.install.top) > 1 || m.bookmark.right > m.install.left) fail(`install: at ${width}px the two buttons aren't side by side on one row`);
      if (m.scroll > 0) fail(`install: at ${width}px the home page scrolls sideways by ${m.scroll}px`);
      sizes.push(`${width}px: ${Math.round(m.bookmark.width)}+${Math.round(m.install.width)}px wide, ${Math.round(m.install.height)}px tall`);

      // Both Android tips' cards fit the viewport with 16px or more each side, and nothing overflows.
      for (const [id, title, text] of [['bookmark-button', BOOKMARK_TITLE, BOOKMARK_TIPS.android], ['install-button', INSTALL_TITLE, INSTALL_TIPS.android]]) {
        if (!await expectDialog(page, `${width}px card`, id, title, text)) continue;
        cards.push(await cardFits(page, `${width}px, ${title}`));
        await page.keyboard.press('Escape');
        await expectClosed(page, `${width}px card`, 'Escape', id);
      }
    }, width);
  }
  // The longest tip, desktop install, in a 360px-wide desktop window.
  await withInstallPage(browser, 'windows', home, 'install (360px desktop card)', async (page) => {
    if (await expectDialog(page, '360px desktop card', 'install-button', INSTALL_TITLE, INSTALL_TIPS.windows)) {
      cards.push(await cardFits(page, '360px, desktop install'));
    }
  }, 360);

  info(`install: Bookmark + Install web app and the reassurance line show on load (footer iPhone line hidden, no tip line, dialog closed); ` +
    `the Bookmark and Install tip dialogs are right for ${Object.keys(INSTALL_UAS).join(', ')}, focus "Got it", reopen on a second tap, and close with "Got it", Escape and the backdrop, returning focus; ` +
    `a saved event prompts once with no dialog, hides the area when accepted and falls back to the dialog after a dismissal; appinstalled hides it; shown on ?team=${UNKNOWN_SLUG}, not on ?team=${teamSlug} or when installed (no dialog either); ` +
    `one row of single-line buttons (${sizes.join('; ')}); cards fit (${cards.join('; ')}); step took ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- main

async function main() {
  const { base } = parseArgs(process.argv.slice(2));
  const isLive = base === LIVE_ORIGIN;
  console.log(`check-p2 (${base})`);

  const anon = getAnonClient();
  const allTeams = unwrap(await anon.from('teams').select('id, short_name, slug, in_current_season').order('short_name'), 'read teams');
  const currentTeams = allTeams.filter((t) => t.in_current_season);
  const expected = await expectedBriefings(anon, currentTeams, allTeams);
  const files = frontendFiles();

  if (isLive) await checkLiveDomain();
  else info(`live domain: NOT checked (base is ${base}, not ${LIVE_ORIGIN})`);
  await checkManifestAndWorker(base);
  await checkSecrets(base, files);

  const browser = await chromium.launch({ headless: true });
  let withBriefing = 0;
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await checkHome(context, base, currentTeams);
    withBriefing = await checkTeamPages(context, base, currentTeams, expected);
    await checkUnknownTeam(context, base, currentTeams);
    await context.close();

    await checkMatchParam(browser, base, currentTeams, expected);
    await checkInstall(browser, base, currentTeams[0].slug);

    const offlineTeam = currentTeams.find((t) => expected.get(t.slug).latest);
    if (offlineTeam) await checkOffline(browser, base, offlineTeam.slug, expected.get(offlineTeam.slug).latest.commentIds);
    else info('offline: NOT checked (no team has a briefing yet)');
  } finally {
    await browser.close();
  }

  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log(`FAIL check-p2: ${failures.length} problem(s); first: ${failures[0]}`);
    process.exit(1);
  }
  console.log(`PASS check-p2: ${currentTeams.length} picker entries; ${currentTeams.length} team pages render (${withBriefing} briefings, ` +
    `${currentTeams.length - withBriefing} "No briefing yet") with no console errors; opposition link and ?match= fallbacks work; unknown slug handled; Bookmark + Install web app shown only where they should be, with the right tip pop-ups; manifest and sw.js valid; ` +
    `no secrets in ${files.length} frontend files; ` +
    (isLive ? 'live domain serves HTTPS and redirects http:// and www.' : `live-domain checks NOT run (base ${base})`));
}

main().catch((err) => {
  console.log(`FAIL check-p2: ${err.message}`);
  process.exit(1);
});
