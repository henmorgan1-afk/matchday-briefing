// Ludicrous Display frontend (SPEC.md §4): ?team= routing, rendering and localStorage recents.
// Reads Supabase's REST API with plain fetch and the publishable key from config.js; it never calls
// football-data.org. Comment text and notes are model output, so they are only ever set with
// textContent, never innerHTML.
//
// Thumbs buttons toggle on the page only. Writing them to `feedback` (with a deviceId) is P4.

(() => {
  'use strict';

  const RECENT_KEY = 'recentTeams';
  const RECENT_LIMIT = 5;
  const DATA_CACHE = 'matchday-data-v1'; // the same cache sw.js falls back to offline
  const TYPE_LABELS = { STAT: 'STAT', BANTER: 'BANTER', HOT_TAKE: 'HOT TAKE' };
  const COMPETITION_NAMES = { PL: 'Premier League' };
  // Fixed English labels, as in scripts/lib/match-data.js: Intl's en-GB output abbreviates September as "Sept".
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Stroke icons for the thumbs buttons: Lucide's thumbs-up and thumbs-down (ISC licence), 24×24.
  const THUMB_PATHS = {
    up: ['M7 10v12', 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z'],
    down: ['M17 14V2', 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z'],
  };

  const main = document.getElementById('main');
  const toastEl = document.getElementById('toast');
  const installEl = document.getElementById('install');
  const bookmarkButton = document.getElementById('bookmark-button');
  const installButton = document.getElementById('install-button');
  const tipDialog = document.getElementById('tip-dialog');
  const tipTitle = document.getElementById('tip-dialog-title');
  const tipText = document.getElementById('tip-dialog-text');
  const footerIphone = document.getElementById('footer-iphone');

  // iPhone Safari only applies :active (the team tiles' pressed colour) when a touchstart listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // ---------------------------------------------------------------- data

  async function rest(pathAndQuery) {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = self.MATCHDAY_CONFIG;
    const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
    // Until sw.js controls the page (a tester's very first visit), it can't see these reads, so the
    // page saves and falls back to them itself. After that, sw.js does both.
    const controlled = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
    let res;
    try {
      res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY } });
    } catch (err) {
      const cached = controlled ? null : await fromDataCache(url);
      if (!cached) throw err;
      return cached.json();
    }
    if (!res.ok) throw new Error(`Supabase returned ${res.status} for ${pathAndQuery.split('?')[0]}`);
    if (!controlled) saveToDataCache(url, res.clone());
    return res.json();
  }

  async function fromDataCache(url) {
    try {
      return ('caches' in self) ? (await caches.match(url, { cacheName: DATA_CACHE, ignoreVary: true })) || null : null;
    } catch {
      return null;
    }
  }

  function saveToDataCache(url, response) {
    if (!('caches' in self)) return;
    caches.open(DATA_CACHE).then((cache) => cache.put(url, response)).catch(() => {});
  }

  // Every team, so a recent or linked team that has left the league still resolves; the picker
  // shows only in_current_season rows.
  const TEAMS_QUERY = 'teams?select=id,short_name,tla,slug,in_current_season&order=short_name.asc,id.asc';

  // The team's most recent finished match that has live comments for its perspective (or, with
  // matchId, that one match), with those comments as `own`. !inner drops matches with none.
  // `opponent` holds at most one live comment from the other side, which is all the opposition link
  // needs to know. Both embeds are aliased: PostgREST only applies the filters reliably that way.
  // Comments of one attempt share created_at, so they're ordered by type, descending from the enum
  // order (HOT_TAKE, BANTER, STAT), then created_at, then id.
  function briefingQuery(teamId, matchId) {
    const id = encodeURIComponent(teamId);
    return 'matches?select=id,competition,matchday,kickoff_at,home_team_id,away_team_id,'
      + 'home_score,away_score,home_ht_score,away_ht_score,own:comments!inner(id,type,text,note),opponent:comments(id)'
      + `&status=eq.finished&or=(home_team_id.eq.${id},away_team_id.eq.${id})`
      + (matchId ? `&id=eq.${encodeURIComponent(matchId)}` : '')
      + `&own.perspective_team_id=eq.${id}&own.superseded_at=is.null`
      + '&own.order=type.desc,created_at.asc,id.asc'
      + `&opponent.perspective_team_id=neq.${id}&opponent.superseded_at=is.null&opponent.limit=1`
      + '&order=kickoff_at.desc,id.desc&limit=1';
  }

  // ---------------------------------------------------------------- recents

  function readRecents() {
    try {
      const value = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(value) ? value.filter((slug) => typeof slug === 'string') : [];
    } catch {
      return [];
    }
  }

  function addRecent(slug) {
    const next = [slug, ...readRecents().filter((s) => s !== slug)].slice(0, RECENT_LIMIT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Storage can be full or blocked; recents are a convenience, so carry on without them.
    }
  }

  // ---------------------------------------------------------------- helpers

  // Builds an element. `text` is set with textContent; every other prop is an attribute,
  // a dataset entry or an on<event> listener.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.flat().filter(Boolean));
    return node;
  }

  function thumbIcon(reaction) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of THUMB_PATHS[reaction]) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function teamHref(slug) {
    return `?team=${encodeURIComponent(slug)}`;
  }

  function londonDate(iso) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date(iso));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  // "Sat 20 Sep", plus the year when it isn't this year (e.g. during the close season).
  function dateLabel(iso) {
    const { year, month, day } = londonDate(iso);
    const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    const thisYear = londonDate(new Date().toISOString()).year;
    return `${weekday} ${day} ${MONTHS[month - 1]}${year === thisYear ? '' : ` ${year}`}`;
  }

  let toastTimer;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  async function copyLine(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast("Couldn't copy. Select the line and copy it instead.");
    }
  }

  // Team views get the compact masthead. So do loading and error pages opened with ?team=, so a team
  // link doesn't flash the full masthead first.
  function render(state, title, nodes) {
    document.title = title ? `${title} · Ludicrous Display` : 'Ludicrous Display';
    main.replaceChildren(...nodes.filter(Boolean));
    const teamUrl = Boolean(new URLSearchParams(location.search).get('team'));
    const compact = state === 'team' || state === 'no-briefing' || ((state === 'loading' || state === 'error') && teamUrl);
    document.body.dataset.masthead = compact ? 'compact' : 'full';
    document.body.dataset.state = state;
    updateInstall();
  }

  // ---------------------------------------------------------------- install (Revisions 14 and 15)

  // Bookmark + Install web app, under the team list. A page can't make a bookmark, so Bookmark opens a
  // tip in a pop-up card. Install web app replays beforeinstallprompt (Chrome, Edge, Samsung Internet)
  // when the browser has fired it, and otherwise opens a tip too. Neither shows on team pages or in
  // the installed app.
  //
  // In tip text, {x} marks a symbol (⋮, ☆, ⌘), which goes in a .tip-sym span: IBM Plex Mono hasn't
  // got them, so they're drawn larger in the system font.
  const DESKTOP_INSTALL_TIP = "Look for the install icon at the right of the address bar, or in your browser's menu. Not there? Chrome and Edge support it.";
  const TIPS = {
    bookmark: {
      title: 'Bookmark this page',
      text: {
        android: 'Tap {⋮} at the top right, then the {☆} star.',
        ios: 'Tap Share, then "Add Bookmark".',
        mac: 'Press {⌘}+D.',
        desktop: 'Press Ctrl+D.',
      },
    },
    install: {
      title: 'Install the web app',
      text: {
        android: 'Tap {⋮} at the top right, then "Install app".',
        ios: 'Tap Share, then "Add to Home Screen".',
        mac: DESKTOP_INSTALL_TIP,
        desktop: DESKTOP_INSTALL_TIP,
      },
    },
  };

  let installPrompt = null;
  let installDone = false; // accepted or appinstalled, on this page load

  const runningInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  // iOS before Mac, because iPhone user agents also say "Mac OS X", and iPadOS Safari reports a Mac
  // user agent; only the iPad has touch points.
  function device() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
    return 'desktop';
  }

  function updateInstall() {
    const listPage = document.body.dataset.state === 'home' || document.body.dataset.state === 'unknown-team';
    installEl.hidden = !listPage || runningInstalled() || installDone;
    // The footer's iPhone line would only repeat what the buttons offer.
    footerIphone.hidden = !installEl.hidden;
  }

  // Every tap opens the card afresh with that button's tip. Focus goes to "Got it" (autofocus) and,
  // when the card closes, back to the button that opened it.
  let tipOpener = null;

  function openTip(kind, opener) {
    const tip = TIPS[kind];
    tipTitle.textContent = tip.title;
    tipText.replaceChildren(...tip.text[device()].split(/\{(.)\}/)
      .map((part, i) => (i % 2 ? el('span', { class: 'tip-sym', text: part }) : part))
      .filter(Boolean));
    tipOpener = opener;
    if (!tipDialog.open) tipDialog.showModal();
  }

  // "Got it", Escape and Android's back gesture close it natively or through here; so does a tap on
  // the dimmed backdrop, the only place a click's target is the dialog itself.
  document.getElementById('tip-dialog-close').addEventListener('click', () => tipDialog.close());
  tipDialog.addEventListener('click', (event) => {
    if (event.target === tipDialog) tipDialog.close();
  });
  tipDialog.addEventListener('close', () => {
    if (tipOpener && tipOpener.isConnected) tipOpener.focus();
    tipOpener = null;
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installDone = true;
    updateInstall();
  });

  bookmarkButton.addEventListener('click', () => openTip('bookmark', bookmarkButton));

  // The saved event can only be used once, so it's cleared before prompting. After a dismissal the
  // buttons stay, and later taps get the tip.
  installButton.addEventListener('click', async () => {
    const event = installPrompt;
    if (!event) {
      openTip('install', installButton);
      return;
    }
    installPrompt = null;
    let outcome = null;
    try {
      await event.prompt();
      ({ outcome } = await event.userChoice);
    } catch (err) {
      console.warn('Install prompt failed:', err);
      openTip('install', installButton);
    }
    if (outcome === 'accepted') {
      installDone = true;
      updateInstall();
    }
  });

  function offlineNotice() {
    return navigator.onLine ? null : el('p', { class: 'notice notice--offline', text: "You're offline. This is the last version saved on this device." });
  }

  // ---------------------------------------------------------------- views

  // layout: 'pills' (Recent) or 'columns' (every team, each with its three-letter code).
  function teamList(teams, label, layout) {
    return el('ul', { class: `team-list team-list--${layout}`, 'aria-label': label },
      teams.map((team) => el('li', {}, el('a', { class: 'team-link', href: teamHref(team.slug), dataset: { slug: team.slug } },
        layout === 'columns' && team.tla && el('span', { class: 'team-link__code', 'aria-hidden': 'true', text: team.tla }),
        el('span', { class: 'team-link__name', text: team.short_name })))));
  }

  function renderHome(teams, unknownSlug) {
    const bySlug = new Map(teams.map((t) => [t.slug, t]));
    const recents = readRecents().map((slug) => bySlug.get(slug)).filter(Boolean);
    const current = teams.filter((t) => t.in_current_season);

    render(unknownSlug ? 'unknown-team' : 'home', null, [
      unknownSlug && el('p', { class: 'notice notice--unknown', role: 'alert', text: "We don't know that team" }),
      offlineNotice(),
      el('p', { class: 'intro', text: 'Pick a team for a few lines to say about their last match: the score, a bit of chat and some strong opinions.' }),
      recents.length > 0 && el('section', { class: 'picker picker--recent', 'aria-labelledby': 'recent-heading' },
        el('h2', { id: 'recent-heading', text: 'Recent' }),
        teamList(recents, 'Recent teams', 'pills')),
      el('section', { class: 'picker', id: 'picker', 'aria-labelledby': 'picker-heading' },
        el('h2', { id: 'picker-heading', text: 'Premier League teams' }),
        current.length > 0
          ? teamList(current, 'Premier League teams', 'columns')
          : el('p', { class: 'status', text: 'No teams yet. Check back soon.' })),
    ]);
  }

  // pinned: the page was opened for this match via ?match= (an opposition link), so it may not be
  // the team's latest; the date label says "Match:" rather than "Last match:".
  function renderTeam(team, match, teamsById, pinned) {
    const backLink = el('a', { class: 'back-link', href: './', text: '← All teams' });
    const heading = el('h1', { class: 'team-name', text: team.short_name });

    if (!match) {
      render('no-briefing', team.short_name, [
        backLink, heading, offlineNotice(),
        el('p', { class: 'empty', text: `No briefing yet for ${team.short_name} — check back after their next match` }),
      ]);
      return;
    }

    const name = (id) => (teamsById.get(id) || { short_name: 'Unknown team' }).short_name;
    const meta = [
      match.home_ht_score != null && match.away_ht_score != null && `Half time ${match.home_ht_score}–${match.away_ht_score}`,
      match.matchday != null && `Matchday ${match.matchday}`,
      COMPETITION_NAMES[match.competition] || match.competition,
    ].filter(Boolean).join(' · ');

    const dateLabelEl = el('p', { class: 'match__label', text: `${pinned ? 'Match' : 'Last match'}: ${dateLabel(match.kickoff_at)}` });
    // One row per team, home first; the page's own team is picked out in the accent colour.
    const scoreRow = (teamId, goals) => el('p', { class: `match__row${teamId === team.id ? ' match__row--own' : ''}` },
      el('span', { class: 'match__team', text: name(teamId) }),
      el('span', { class: 'match__goals', text: String(goals) }));
    const matchCard = el('section', { class: 'match', 'aria-label': 'Match' },
      scoreRow(match.home_team_id, match.home_score),
      scoreRow(match.away_team_id, match.away_score),
      el('p', { class: 'match__meta', text: meta }));

    // Only when the other side has live comments for this same match.
    const opponent = teamsById.get(match.home_team_id === team.id ? match.away_team_id : match.home_team_id);
    const opponentLink = opponent && match.opponent.length > 0 && el('a', {
      class: 'opponent-link',
      href: `${teamHref(opponent.slug)}&match=${encodeURIComponent(match.id)}`,
      text: `See what ${opponent.short_name} fans are saying →`,
    });

    render('team', team.short_name, [
      backLink, dateLabelEl, heading, offlineNotice(), matchCard, opponentLink,
      el('ol', { class: 'cards', 'aria-label': 'Talking points' }, match.own.map(commentCard)),
    ]);
  }

  function commentCard(comment) {
    const label = TYPE_LABELS[comment.type] || comment.type;
    const typeClass = `tag--${String(comment.type).toLowerCase().replace(/[^a-z]+/g, '-')}`;

    const thumbs = ['up', 'down'].map((reaction) => el('button', {
      type: 'button',
      class: `thumb thumb--${reaction}`,
      'aria-label': reaction === 'up' ? 'Thumbs up' : 'Thumbs down',
      'aria-pressed': 'false',
      dataset: { reaction },
    }, thumbIcon(reaction)));
    for (const button of thumbs) {
      button.addEventListener('click', () => {
        const pressed = button.getAttribute('aria-pressed') !== 'true';
        for (const b of thumbs) b.setAttribute('aria-pressed', String(b === button && pressed));
      });
    }

    return el('li', { class: 'card', dataset: { commentId: comment.id, type: comment.type } },
      el('span', { class: `tag ${typeClass}`, text: label }),
      el('p', { class: 'card__text', text: comment.text }),
      el('p', { class: 'card__note', text: comment.note }),
      el('div', { class: 'card__actions' },
        el('button', { type: 'button', class: 'copy', onclick: () => copyLine(comment.text), text: 'Copy line' }),
        el('span', { class: 'thumbs', role: 'group', 'aria-label': 'Rate this line' }, thumbs)));
  }

  function renderError() {
    render('error', null, [
      el('p', { class: 'notice notice--error', role: 'alert', text: "Couldn't load this page. Check your connection and try again." }),
      el('button', { type: 'button', class: 'retry', onclick: start, text: 'Try again' }),
    ]);
  }

  // ---------------------------------------------------------------- routing

  async function start() {
    render('loading', null, [el('p', { class: 'status', text: 'Loading…' })]);
    const params = new URLSearchParams(location.search);
    const slug = params.get('team');
    // ?match= pins the view to one match (opposition links use it). An id that isn't a number, or
    // isn't a finished match of this team with live comments for it, falls back to the latest briefing.
    const matchParam = params.get('match');
    const matchId = matchParam && /^\d{1,12}$/.test(matchParam) ? matchParam : null;
    try {
      if (!self.MATCHDAY_CONFIG) throw new Error('config.js did not load');
      const teams = await rest(TEAMS_QUERY);
      const team = slug ? teams.find((t) => t.slug === slug) : null;
      if (!team) {
        renderHome(teams, slug || null);
        return;
      }
      // Opening a team through an opposition link (any URL with ?match=) leaves Recent alone.
      if (!params.has('match')) addRecent(team.slug);
      const [pinned] = matchId ? await rest(briefingQuery(team.id, matchId)) : [];
      const [match] = pinned ? [pinned] : await rest(briefingQuery(team.id));
      renderTeam(team, match || null, new Map(teams.map((t) => [t.id, t])), Boolean(pinned));
    } catch (err) {
      console.error('Ludicrous Display:', err);
      renderError();
    }
  }

  start();
})();
