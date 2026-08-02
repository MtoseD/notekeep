const CACHE = 'notekeep-shell-v4';
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
const NET_TIMEOUT_MS = 3000;

// Fetch every shell file that isn't already in the cache. Used on install and
// again on activate: if install ran on a flaky connection some files get
// skipped, and a half-populated cache is exactly what makes a later offline
// cold start fail.
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

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(fillShellCache)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    // Second chance to complete the shell if install hit a bad network.
    await caches.open(CACHE).then(fillShellCache);
    await self.clients.claim();
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
      // We have something to show, so the network only gets NET_TIMEOUT_MS.
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NET_TIMEOUT_MS));
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
