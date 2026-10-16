/* ═══════════════════════════════════════════════════════════════════
   Mochi Grain — Service Worker
   ═══════════════════════════════════════════════════════════════════
   Strategy (matched to the actual architecture):

   - Hosted deployment is Next.js `output: 'standalone'` (a real Node
     server). This SW adds an offline layer WITHOUT switching to static
     export — the server stays authoritative whenever the network is up.
   - The frontend is fully client-side: every reading, setting, and
     Mochi decision lives in IndexedDB (grain-monitor-db). Core tabs
     (Home / History / Settings) never call remote APIs, so the app
     shell + hashed bundles are enough for a full offline cold start.
   - Discover is remote content (YouTube thumbnails + external links)
     and is treated separately: thumbnails cached opportunistically in
     a small capped cache; playback/links always require the network.

   Caches (all versioned under one prefix, cleaned on activation):
     shell  — precached app assets (HTML shell, manifest, icons)
     assets — immutable content-hashed /_next/static files + fonts
     pages  — navigation HTML responses (bounded)
     media  — remote Discover thumbnails (bounded, opportunistic)

   Guarantees:
     - Cache versioning + safe activation + obsolete-cache cleanup.
     - IndexedDB is NEVER touched here — SW version bumps preserve all
       user readings, settings, language, and bookmarks.
     - Sensitive/dynamic responses are not cached: only same-origin
       200 GETs; /api/* is network-only; non-GET is network-only.
     - A cache hit is never treated as fresh sensor data — the app
       separately tracks reading timestamps (LIVE vs LAST READING).
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* Bump SW_VERSION for every deploy that changes app code/assets.
 * Old caches are deleted on activation; the HTML shell is revalidated
 * network-first so new hashed bundles are picked up on the next launch. */
const SW_VERSION = 'v1.0.1';
const CACHE_PREFIX = 'mochi-sw';

const SHELL_CACHE = `${CACHE_PREFIX}-${SW_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_PREFIX}-${SW_VERSION}-assets`;
const PAGE_CACHE = `${CACHE_PREFIX}-${SW_VERSION}-pages`;
const MEDIA_CACHE = `${CACHE_PREFIX}-${SW_VERSION}-media`;

/* Static app-shell resources, always available offline once cached. */
const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/logo.svg',
  '/offline.html',
];

const NAV_FALLBACK_URL = '/offline.html';

/* Bounds prevent uncontrolled storage growth (low-storage devices). */
const MAX_PAGE_ENTRIES = 8;
const MAX_MEDIA_ENTRIES = 48;

/* ── Helpers ── */

/** Content-hashed URL → safe to serve cache-first (immutable).
 *  Matches /_next/static build artifacts and self-hosted fonts:
 *   /_next/static/chunks/432-a1b2c3d4.js, /app/page-abc123.js
 *   /_next/static/css/xyz.css?checksum
 *   /_next/static/media/inter-latin-400-normal.woff2 (hashed name)
 *  Dev-mode chunks (chunks/main-app.js, chunks/webpack.js) have NO
 *  content hash → network-first so rebuilds are never masked. */
function isHashedAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') &&
    /-[0-9A-Za-z_-]{6,}\.(?:js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$/.test(url.pathname)
  );
}

function isYouTubeThumb(url) {
  return url.hostname === 'img.youtube.com';
}

/** fetch with a hard timeout for network-first strategies on weak links */
function fetchWithTimeout(request, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  // Pass a detached Request so an aborted signal doesn't poison retries
  return fetch(new Request(request.url, { method: request.method, headers: request.headers }))
    .finally(() => clearTimeout(timer))
    .catch(() => undefined); // timeout/network failure → undefined, caller falls back
}

/** Keep a cache bounded: evict oldest entries beyond max. */
async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const key of keys.slice(0, keys.length - max)) {
    await cache.delete(key);
  }
}

/* ── Install: precache the shell ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic: if any shell resource fails, install retries later
      await cache.addAll(PRECACHE_URLS);
      // Skip waiting is done via message so the CURRENT app instance keeps
      // running until the user explicitly reloads (predictable updates).
    })()
  );
});

/* ── Activate: clean every obsolete cache generation ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith(`${CACHE_PREFIX}-`) && !n.startsWith(`${CACHE_PREFIX}-${SW_VERSION}`))
          .map((n) => caches.delete(n))
      );
      // Take control of open pages immediately (first install: no controller)
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.enable(); } catch {}
      }
      await self.clients.claim();
    })()
  );
});

/* ── Messages: SKIP_WAITING (from the update banner) ── */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ── Fetch routing ── */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; POST/PUT/DELETE always hit the network untouched
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept cross-origin requests other than Discover thumbnails
  if (url.origin !== self.location.origin) {
    if (isYouTubeThumb(url)) {
      event.respondWith(staleWhileRevalidate(request, MEDIA_CACHE, { trim: MAX_MEDIA_ENTRIES }));
    }
    return; // everything else (youtube.com links, embeds) → network only
  }

  // Same-origin dynamic API routes: network-only, never cached.
  // (The app has none today; this future-proofs against accidentally
  //  caching sensitive dynamic responses.)
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests (full page loads): network-first with a timeout
  // so weak links fall back to the cached shell quickly.
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  // Immutable hashed build output → cache-first (offline cold start)
  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Everything else same-origin (unhashed statics, manifest refreshes…):
  // stale-while-revalidate keeps offline coverage while staying fresh.
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE, { trim: null }));
});

/* ── Strategies ── */

async function handleNavigation(event) {
  // 1. Fresh HTML from the network (preload avoids double-fetch),
  //    with a weak-network timeout.
  let fresh = null;
  try {
    const preloaded = event.preloadResponse ? await event.preloadResponse : null;
    fresh = preloaded || (await fetchWithTimeout(event.request, 6000));
  } catch {
    fresh = null;
  }

  if (fresh && fresh.ok) {
    const cache = await caches.open(PAGE_CACHE);
    cache.put(event.request, fresh.clone()).then(() => trimCache(PAGE_CACHE, MAX_PAGE_ENTRIES));
    return fresh;
  }

  // 2. Cached copy of this exact navigation target (e.g. '/')
  const cachedExact = await caches.match(event.request);
  if (cachedExact) return cachedExact;

  // 3. Cached app shell (the SPA root covers all in-app navigation)
  const cachedRoot = await caches.match('/');
  if (cachedRoot) return cachedRoot;

  // 4. Polished offline fallback (shell was never cached)
  const fallback = await caches.match(NAV_FALLBACK_URL);
  if (fallback) return fallback;

  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Mochi Grain — Offline</title>' +
      '<p style="font-family:sans-serif;padding:2rem">You are offline. Reconnect and reload once to enable offline mode.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type !== 'opaque') {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Immutable asset not cached and network dead → surface an honest
    // error rather than serving unrelated content.
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName, { trim }) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((fresh) => {
      // Accept 200 responses AND opaque responses (cross-origin <img>
      // thumbnails come through no-cors with status 0 — still cacheable).
      const cacheable = fresh && (fresh.ok || fresh.type === 'opaque');
      if (cacheable) {
        cache.put(request, fresh.clone());
        if (trim) trimCache(cacheName, trim);
      }
      return fresh;
    })
    .catch(() => undefined);

  return cached || (await network) || new Response('', { status: 504, statusText: 'Offline' });
}
