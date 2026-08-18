// NoteKeep - self-hosted notes synced to your own Nextcloud.
// Copyright (C) 2026 MtoseD
// SPDX-License-Identifier: AGPL-3.0-or-later
// Free software under the GNU AGPL v3 or later; see LICENSE. Comes with
// ABSOLUTELY NO WARRANTY. If you run a modified version for others over a
// network, AGPL section 13 requires you to offer them its source.

// Tied to BUILD_ID in app.js on purpose — bump both together, every time.
// This was a hand-maintained 'v5' for many deploys, and because fillShellCache
// skips files already present, a stylesheet cached when v5 was created was
// never replaced by the precache. Only the runtime handler could refresh it,
// and only when the network won its race, so a stale style.css could survive
// indefinitely against a correctly deployed server — which is exactly what
// happened: new markup from app.js, old rules from style.css, and a control
// rendering unstyled with no way to tell why.
const CACHE = 'notekeep-shell-2026-08-16.4';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/db.js',
  '/js/vendor/Sortable.min.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// How long a shell request may wait on the network before we fall back to the
// cached copy. This is the fix for "the PWA won't open when I'm away from
// home": the server is only reachable on the LAN/VPN, so from outside, DNS
// resolves but the TCP connection just hangs — fetch() does not reject for
// ~a minute, and navigator.onLine is still true because the phone does have
// internet. Without a deadline the app sits on a blank screen that whole time
// and reads as "broken". With one, a cold launch falls back to cache fast.
// A navigation gets a tighter budget than a sub-resource: it is the thing
// standing between a PWA tap and any pixels at all.
const NAV_TIMEOUT_MS = 1500;
const NET_TIMEOUT_MS = 3000;

// Fetch every shell file that isn't already in the cache. Runs on install, on
// activate, and on demand from the page (see the 'shell-check' message). If
// install ran on a flaky connection some files get skipped, and a
// half-populated cache is exactly what makes a later offline cold start fail —
// so this has to be retryable rather than a one-shot at install time.
async function fillShellCache(cache) {
  await Promise.all(SHELL_FILES.map(async (url) => {
    try {
      if (await cache.match(url)) return;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) await cache.put(url, res);
      else console.warn('[sw] precache skipped (bad status)', url, res.status);
    } catch (e) {
      console.warn('[sw] precache failed for', url, e);
    }
  }));
}

async function shellStatus() {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const url of SHELL_FILES) {
    if (!(await cache.match(url))) missing.push(url);
  }
  return { cache: CACHE, have: SHELL_FILES.length - missing.length, total: SHELL_FILES.length, missing };
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(fillShellCache)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Fill the new cache BEFORE dropping the old ones, so there is never a
    // moment with no usable shell — deleting first would leave the app unable
    // to cold start if the network died mid-activate.
    await caches.open(CACHE).then(fillShellCache);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// The page asks for this on every load: top up anything missing from the shell
// cache and report what we actually hold. Without it, a cache left incomplete
// by a bad install stays broken until sw.js itself changes — which is exactly
// the "it just never works offline" failure, and it is invisible from the UI.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'shell-check') return;
  event.waitUntil((async () => {
    try {
      await caches.open(CACHE).then(fillShellCache);
    } catch (e) { /* offline: report what we have */ }
    const status = await shellStatus();
    if (event.ports && event.ports[0]) event.ports[0].postMessage(status);
  })());
});

// App shell: network-first, but with a deadline. This is a fast-moving app, so
// a healthy network (LAN or VPN, well under NET_TIMEOUT_MS) still always wins
// and we never serve stale code from a working connection. Only a dead or
// crawling network falls back to cache. API calls bypass the worker entirely
// and are never cached here.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  // Start the request once and keep updating the cache from it even if we end
  // up answering from cache first — so a slow launch still refreshes the shell
  // for next time.
  const network = fetch(event.request).then((res) => {
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    }
    return res;
  });
  // Keep the worker alive for the background update, and make sure an eventual
  // network failure never surfaces as an unhandled rejection.
  event.waitUntil(network.catch(() => {}));

  event.respondWith((async () => {
    const cached = await caches.match(event.request);

    if (cached) {
      // Known-offline: don't spend even the timeout on a request that cannot
      // succeed. (This only catches "no network at all" — off the home network
      // with working cellular, onLine stays true and the deadline below is
      // what saves the launch.)
      if (self.navigator && self.navigator.onLine === false) return cached;
      const budget = event.request.mode === 'navigate' ? NAV_TIMEOUT_MS : NET_TIMEOUT_MS;
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), budget));
      const res = await Promise.race([network.catch(() => null), timeout]);
      return res || cached;
    }

    // Nothing cached for this exact URL — we have to wait for the network.
    try {
      return await network;
    } catch (e) {
      // A cold launch offline on a URL we never cached (e.g. start_url with a
      // query string): serve the app shell rather than failing outright.
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('/index.html') || await caches.match('/');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
