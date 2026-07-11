/* Daily Notes service worker — installable PWA + light offline support.
 * Bump CACHE when shipping new static assets to force a refresh. */
const CACHE = 'daily-notes-v7';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache a clone of a successful GET response, then return the original.
async function putAndReturn(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return; // never intercept writes (PUT/POST/DELETE)
  const url = new URL(request.url);

  // App navigations: network-first so you get fresh UI, fall back to the shell.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).then((res) => putAndReturn(request, res))
        .catch(() => caches.match('/')),
    );
    return;
  }

  // API reads: network-first, fall back to the last-seen copy when offline.
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).then((res) => putAndReturn(request, res))
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Everything else (same-origin static + CDN libs): cache-first, then network.
  e.respondWith(
    caches.match(request).then((hit) => hit
      || fetch(request).then((res) => putAndReturn(request, res)).catch(() => hit)),
  );
});
