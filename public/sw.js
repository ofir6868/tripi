// TRIPI service worker: cache-first for static assets, network-first for pages/API
// so fresh deploys are picked up but the last-viewed trips keep working offline.
const CACHE = 'tripi-v6';
const STATIC = ['/css/style.css', '/js/common.js', '/js/geo.js', '/js/home.js', '/js/trip.js', '/js/trip-modals.js', '/js/plan.js', '/icon.svg', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // external requests (fonts, images, APIs) — network with cache fallback for fonts/images
  if (url.origin !== location.origin) {
    if (url.hostname.includes('fonts.g') || url.hostname.includes('unsplash')) {
      e.respondWith(
        caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }))
      );
    }
    return;
  }

  // same-origin: network-first, fall back to cache (keeps last-viewed pages/trips offline)
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
