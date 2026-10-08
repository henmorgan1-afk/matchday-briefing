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

// The install area (Revision 13). Headless Chromium never fires beforeinstallprompt itself, so the
// check dispatches a fake one, with a prompt() that counts its calls and a userChoice of "accepted".
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

const installShown = async (page) => ({
  button: await page.locator('#install-button').isVisible(),
  hint: await page.locator('#install-hint').isVisible(),
});

// Returns whether app.js called preventDefault() on it.
const fakeInstallPrompt = (page) => page.evaluate(() => {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  window.installPromptCalls = 0;
  event.prompt = () => { window.installPromptCalls += 1; return Promise.resolve(); };
  event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

async function checkInstall(browser, base, teamSlug) {
  // The served HTML hides the area itself, so nothing flashes before app.js runs.
  const html = await (await fetch(`${base}/`)).text();
  for (const id of ['install', 'install-button', 'install-hint']) {
    const tag = (html.match(new RegExp(`<[a-z]+\\s[^>]*id="${id}"[^>]*>`)) || [])[0];
    if (!tag || !/\shidden(?=[\s>])/.test(tag)) fail(`install: index.html's #${id} ${tag ? 'has no hidden attribute' : 'is missing'}`);
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    // 1. Home page: hidden on load, shown by the event, and one tap prompts once and hides it.
    const home = await visit(context, `${base}/`);
    commonPageProblems('install (home)', home);
    const onLoad = await installShown(home.page);
    if (onLoad.button || onLoad.hint) fail(`install: on load the home page shows the ${onLoad.button ? 'button' : 'iPhone line'}, expected neither`);
    if (!await fakeInstallPrompt(home.page)) fail('install: app.js did not call preventDefault() on beforeinstallprompt');
    const afterEvent = await installShown(home.page);
    if (!afterEvent.button) fail('install: the "Add to home screen" button did not appear after beforeinstallprompt');
    if (afterEvent.hint) fail('install: the iPhone line shows on a non-iPhone browser');
    const label = (await home.page.locator('#install-button').innerText().catch(() => '')).trim();
    if (!/^add to home screen$/i.test(label)) fail(`install: the button reads "${label}", expected "Add to home screen"`);
    if (await home.page.locator('#install-button').evaluate((b) => b.tagName !== 'BUTTON' || b.type !== 'button')) fail('install: the install control is not a <button type="button">');
    if (afterEvent.button) {
      await home.page.locator('#install-button').click();
      await home.page.locator('#install-button').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      const calls = await home.page.evaluate(() => window.installPromptCalls);
      if (calls !== 1) fail(`install: tapping the button called prompt() ${calls} times, expected 1`);
      if (await home.page.locator('#install-button').isVisible()) fail('install: the button is still visible after the prompt was answered');
    }
    await home.page.close();

    // 2. A team page never shows it.
    const team = await visit(context, `${base}/?team=${encodeURIComponent(teamSlug)}`);
    commonPageProblems(`install (?team=${teamSlug})`, team);
    await fakeInstallPrompt(team.page);
    const onTeam = await installShown(team.page);
    if (onTeam.button || onTeam.hint) fail(`install: ?team=${teamSlug} shows the install ${onTeam.button ? 'button' : 'iPhone line'} after beforeinstallprompt`);
    await team.page.close();
  } finally {
    await context.close();
  }

  // 3. iPhone: the line instead of the button, on the home page only, and neither in the installed app.
  const iphone = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const home = await visit(iphone, `${base}/`);
    commonPageProblems('install (iPhone home)', home);
    const shown = await installShown(home.page);
    if (!shown.hint) fail('install: the iPhone line is not visible on the home page with an iPhone user agent');
    if (shown.button) fail('install: the button shows with an iPhone user agent');
    const hint = (await home.page.locator('#install-hint').innerText().catch(() => '')).trim();
    if (hint !== 'On iPhone: tap the Share button, then "Add to Home Screen".') fail(`install: the iPhone line reads "${hint}"`);
    await home.page.close();

    const team = await visit(iphone, `${base}/?team=${encodeURIComponent(teamSlug)}`);
    if ((await installShown(team.page)).hint) fail(`install: ?team=${teamSlug} shows the iPhone line`);
    await team.page.close();
  } finally {
    await iphone.close();
  }

  // 4. Running installed (navigator.standalone on iPhone, display-mode: standalone elsewhere): nothing shows.
  const standalone = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 390, height: 844 } });
  try {
    await standalone.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
      const realMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => (/display-mode:\s*standalone/.test(query)
        ? { ...realMatchMedia(query), matches: true, media: query }
        : realMatchMedia(query));
    });
    const home = await visit(standalone, `${base}/`);
    await fakeInstallPrompt(home.page);
    const shown = await installShown(home.page);
    if (shown.button || shown.hint) fail(`install: the installed app shows the install ${shown.button ? 'button' : 'iPhone line'}`);
    await home.page.close();
  } finally {
    await standalone.close();
  }
  info(`install: hidden on load; the button appears after beforeinstallprompt, one tap calls prompt() once and hides it; not on ?team=${teamSlug}; ` +
    'an iPhone user agent gets the Share line instead; nothing shows when running installed');
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
    `${currentTeams.length - withBriefing} "No briefing yet") with no console errors; opposition link and ?match= fallbacks work; unknown slug handled; install button and iPhone line shown only where they should be; manifest and sw.js valid; ` +
    `no secrets in ${files.length} frontend files; ` +
    (isLive ? 'live domain serves HTTPS and redirects http:// and www.' : `live-domain checks NOT run (base ${base})`));
}

main().catch((err) => {
  console.log(`FAIL check-p2: ${err.message}`);
  process.exit(1);
});
