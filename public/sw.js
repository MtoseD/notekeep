const CACHE = 'notekeep-shell-v3';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/db.js',
  '/js/vendor/Sortable.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Cache each file individually — if one request fails, the rest
      // should still get cached instead of the whole precache silently
      // aborting (which is what Cache.addAll does on any single failure).
      await Promise.all(SHELL_FILES.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (res.ok) await cache.put(url, res);
          else console.warn('[sw] precache skipped (bad status)', url, res.status);
        } catch (e) {
          console.warn('[sw] precache failed for', url, e);
        }
      }));
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// App shell: network-first. This is a fast-moving app, so always prefer the
// live version when online; only fall back to the cached copy when the
// network request fails (i.e. actually offline). API calls always hit the
// network directly and are never cached here.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // Navigating to the app with nothing cached for this exact URL
        // (e.g. a fresh cold-launch offline) — fall back to the cached
        // app shell root instead of failing outright.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/index.html') || await caches.match('/');
          if (shell) return shell;
        }
        throw new Error('offline and not cached');
      })
  );
});
