// Shop Floor service worker.
// Strategy: the app shell (HTML + JS) is NETWORK-FIRST with a cache fallback, and static
// assets are cache-first. Cache-first on the shell meant a phone kept serving the build
// it opened with and showed a fixed bug as still broken for a launch or two — on a shop
// floor that reads as "the app is wrong", so correctness of code beats a faster cold
// start. Offline still works: the fallback is the last good copy.
// API calls are network-only and never cached — stale job data on a shop floor is worse
// than no data. Writes that fail offline are queued in IndexedDB by the app, not here.

const VERSION = 'shopfloor-v6';
const SHELL = [
  './',
  './index.html',
  './board.html',
  './reports.html',
  './plan.html',
  './pm.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// The barcode decoder used on iPhone and desktop. Precached because a phone that
// cannot reach the network still needs to scan a traveler.
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL).then(() => c.add(ZXING_URL).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;            // writes go straight to network
  if (url.pathname.indexOf('/api/') === 0) return;   // never cache API reads

  // The decoder is the one cross-origin asset we serve from cache.
  if (e.request.url === ZXING_URL) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Code: always ask the network first, fall back to the last good copy.
  const isCode = e.request.mode === 'navigate'
    || /\.(html|js|webmanifest)$/.test(url.pathname)
    || url.pathname.endsWith('/');

  if (isCode) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

// Lets the page trigger an immediate update after a deploy.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
