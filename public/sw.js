// TRIPI service worker: cache-first for static assets, network-first for pages/API
// so fresh deploys are picked up but the last-viewed trips keep working offline.
// Two caches: the precached shell (replaced wholesale on version bump) and a
// runtime cache that is trimmed to a cap so it can't grow forever.
const VERSION = 'v10';
const SHELL = 'tripi-shell-' + VERSION;
const RUNTIME = 'tripi-rt-' + VERSION;
const RUNTIME_MAX = 120; // entries; oldest-in goes first
const STATIC = [
  '/css/style.css', '/js/common.js', '/js/geo.js', '/js/home.js', '/js/trip.js',
  '/js/trip-modals.js', '/js/trip-calendar.js', '/js/plan.js', '/js/admin.js',
  '/icon.svg', '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// keep the runtime cache bounded — Cache API keys() returns insertion order,
// so dropping from the front evicts the oldest entries. Error responses are
// never cached: a stored 500 would keep resurfacing as the offline fallback.
async function putRuntime(request, response) {
  if (!response.ok) return;
  const cache = await caches.open(RUNTIME);
  await cache.put(request, response);
  const keys = await cache.keys();
  if (keys.length > RUNTIME_MAX) {
    await Promise.all(keys.slice(0, keys.length - RUNTIME_MAX).map((k) => cache.delete(k)));
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // external requests (fonts, images, APIs) — network with cache fallback for fonts/images
  if (url.origin !== location.origin) {
    if (url.hostname.includes('fonts.g') || url.hostname.includes('unsplash')) {
      e.respondWith(
        caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          e.waitUntil(putRuntime(e.request, res.clone()));
          return res;
        }))
      );
    }
    return;
  }

  // same-origin: network-first, fall back to cache (keeps last-viewed pages/trips offline)
  e.respondWith(
    fetch(e.request).then((res) => {
      e.waitUntil(putRuntime(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
