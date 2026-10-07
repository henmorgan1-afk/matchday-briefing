// Service worker (SPEC.md §1, "PWA layer").
//
// App shell: cache-first, from a cache named after CACHE_VERSION. .github/workflows/pages.yml stamps
// CACHE_VERSION with the commit SHA on every deploy, so each deploy installs fresh copies and the old
// shell cache is deleted on activation. Leave the line below exactly as it is: the deploy step
// matches it.
//
// Briefing data (Supabase REST reads): network-first, falling back to the last cached response, so
// an offline tester still sees the last briefing they loaded. Writes are never cached or queued.

const CACHE_VERSION = 'dev';

const SHELL_CACHE = `matchday-shell-${CACHE_VERSION}`;
const DATA_CACHE = 'matchday-data-v1'; // app.js writes here too, before this worker controls the page
const SHELL_FILES = [
  'index.html',
  'config.js',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.svg',
  'icons/favicon-32.png',
  'fonts/oswald-latin-500-normal.woff2',
  'fonts/oswald-latin-600-normal.woff2',
  'fonts/oswald-latin-700-normal.woff2',
  'fonts/source-serif-4-latin-400-normal.woff2',
  'fonts/source-serif-4-latin-600-normal.woff2',
  'fonts/source-serif-4-latin-400-italic.woff2',
  'fonts/source-serif-4-latin-600-italic.woff2',
  'fonts/source-serif-4-latin-ext-400-normal.woff2',
  'fonts/source-serif-4-latin-ext-600-normal.woff2',
  'fonts/source-serif-4-latin-ext-400-italic.woff2',
  'fonts/source-serif-4-latin-ext-600-italic.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' bypasses the HTTP cache, so a new version never precaches an old file.
    await cache.addAll(SHELL_FILES.map((file) => new Request(file, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('matchday-shell-') && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Every page is index.html; app.js reads ?team= itself.
    if (request.mode === 'navigate') event.respondWith(cacheFirst(new URL('index.html', self.registration.scope).href, request));
    else event.respondWith(cacheFirst(request, request));
    return;
  }
  if (url.pathname.startsWith('/rest/v1/')) event.respondWith(networkFirst(request));
});

async function cacheFirst(cacheKey, request) {
  const cached = await caches.match(cacheKey, { cacheName: SHELL_CACHE });
  return cached || fetch(request);
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}
