// TRIPI service worker: cache-first for static assets, network-first for pages/API
// so fresh deploys are picked up but the last-viewed trips keep working offline.
// Two caches: the precached shell (replaced wholesale on version bump) and a
// runtime cache that is trimmed to a cap so it can't grow forever.
const VERSION = 'v17';
const SHELL = 'tripi-shell-' + VERSION;
const RUNTIME = 'tripi-rt-' + VERSION;
const RUNTIME_MAX = 120; // entries; oldest-in goes first
const STATIC = [
  '/css/style.css', '/js/common.js', '/js/geo.js', '/js/home.js', '/js/trip.js',
  '/js/trip-modals.js', '/js/trip-calendar.js', '/js/plan.js', '/js/admin.js',
  '/js/countries.js', '/js/push.js', '/js/webmcp.js', '/js/webmcp-tools.js',
  '/js/analytics.js', '/js/install.js',
  '/icon.svg', '/manifest.json',
];

// the notification resolves its own flags, from the same country table the UI uses —
// the server ships Hebrew country names and never a flag glyph. If the import fails
// (first run offline), notifications still fire, just with the plain brand mark.
try { importScripts('/js/countries.js'); } catch { /* flags degrade, nothing else */ }

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

/* ---------------- push notifications ---------------- */
/* The icon is drawn here, per notification, rather than shipped as a static file:
   it's the brand compass with the flags of the countries this trip actually goes
   to, stacked into it. A push for Japan looks different from a push for Greece —
   which is the whole point, and it costs one OffscreenCanvas per delivery. */

const ICON_CACHE = new Map(); // country-code key → data URL, for this SW's lifetime

const INK = '#0a1512';
const AMBER = '#ffb45f';
const MINT = 'rgba(143, 216, 196, .92)';

// PNG bytes → data: URL. Notification icons can't take a Blob, and service workers
// have no URL.createObjectURL, so base64 is the only road out of the canvas.
async function canvasToDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000; // apply() blows the stack on a whole 192px icon at once
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:image/png;base64,' + btoa(bin);
}

// the compass from the splash screen, in canvas form (same 512-unit geometry)
function drawCompass(g, S, k) {
  const c = S / 2;
  const u = (v) => (v / 512) * S * k;            // a length in 512-space
  const p = (v) => c + ((v - 256) / 512) * S * k; // a coordinate in 512-space
  const poly = (pts, fill) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(p(x), p(y)) : g.moveTo(p(x), p(y))));
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };

  g.lineWidth = u(14);
  g.strokeStyle = 'rgba(245, 239, 227, .22)';
  g.beginPath();
  g.arc(c, c, u(150), 0, Math.PI * 2);
  g.stroke();

  poly([[116, 256], [256, 216], [396, 256], [256, 296]], MINT);

  const needle = g.createLinearGradient(p(216), p(116), p(296), p(396));
  needle.addColorStop(0, AMBER);
  needle.addColorStop(1, '#e8853a');
  poly([[256, 116], [296, 256], [256, 396], [216, 256]], needle);

  g.beginPath();
  g.arc(c, c, u(26), 0, Math.PI * 2);
  g.fillStyle = INK;
  g.fill();
  g.lineWidth = u(8);
  g.strokeStyle = AMBER;
  g.stroke();
}

async function flagBitmap(cc) {
  const res = await fetch(`https://flagcdn.com/w80/${cc}.png`, { mode: 'cors' });
  if (!res.ok) throw new Error('flag ' + res.status);
  return createImageBitmap(await res.blob());
}

// one flag → a single chip on the trailing edge; several → an overlapping stack,
// first country on top, the way a boarding pass wallet fans out
function chipLayout(n, S) {
  const r = S * (n === 1 ? 0.2 : n === 2 ? 0.165 : 0.15);
  const step = r * 1.55;
  const right = S - r - S * 0.03;
  const y = S - r - S * 0.04;
  return { r, y, xs: Array.from({ length: n }, (_, i) => right - i * step) };
}

// importScripts' top-level `const` is a lexical binding, not a property of the
// global object — `self.COUNTRIES` is always undefined, `typeof` is the real check
const hasCountries = () => typeof COUNTRIES !== 'undefined';

async function buildIcon(countries) {
  const ccs = (Array.isArray(countries) ? countries : [])
    .map((name) => (hasCountries() ? COUNTRIES.ccByName(name) : null))
    .filter(Boolean)
    .slice(0, 3);
  const key = ccs.join(',') || '-';
  if (ICON_CACHE.has(key)) return ICON_CACHE.get(key);
  if (typeof OffscreenCanvas === 'undefined') return '/icon.svg';

  try {
    const S = 192;
    const canvas = new OffscreenCanvas(S, S);
    const g = canvas.getContext('2d');

    const bg = g.createRadialGradient(S * 0.5, S * 0.36, S * 0.05, S * 0.5, S * 0.5, S * 0.62);
    bg.addColorStop(0, '#17332c');
    bg.addColorStop(1, INK);
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    g.fillStyle = bg;
    g.fill();

    g.lineWidth = 5;
    g.strokeStyle = 'rgba(255, 180, 95, .85)';
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2);
    g.stroke();

    // flags sit low and trailing, so the compass shifts up a touch to keep clear
    drawCompass(g, S, ccs.length ? 0.72 : 0.86);

    if (ccs.length) {
      const bmps = await Promise.all(ccs.map((cc) => flagBitmap(cc).catch(() => null)));
      const ok = bmps.filter(Boolean);
      const { r, y, xs } = chipLayout(ok.length, S);
      // paint back-to-front so the first country ends up on top of the stack
      for (let i = ok.length - 1; i >= 0; i--) {
        const bmp = ok[i];
        const x = xs[i];
        g.save();
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.closePath();
        g.fillStyle = INK;
        g.fill();
        g.clip();
        const scale = Math.max((r * 2) / bmp.width, (r * 2) / bmp.height);
        g.drawImage(bmp, x - (bmp.width * scale) / 2, y - (bmp.height * scale) / 2,
          bmp.width * scale, bmp.height * scale);
        g.restore();
        g.lineWidth = S * 0.026;
        g.strokeStyle = INK;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = S * 0.009;
        g.strokeStyle = 'rgba(255, 180, 95, .8)';
        g.beginPath();
        g.arc(x, y, r + S * 0.016, 0, Math.PI * 2);
        g.stroke();
        bmp.close?.();
      }
    }

    const url = await canvasToDataUrl(canvas);
    ICON_CACHE.set(key, url);
    return url;
  } catch {
    return '/icon.svg';
  }
}

// the status-bar glyph: Android masks it to a single colour, so it's a flat
// silhouette — the compass needle alone, which stays legible at 24px
async function buildBadge() {
  if (ICON_CACHE.has('#badge')) return ICON_CACHE.get('#badge');
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const S = 96;
    const canvas = new OffscreenCanvas(S, S);
    const g = canvas.getContext('2d');
    const c = S / 2;
    const p = (v) => c + ((v - 256) / 512) * S * 0.92;
    g.lineWidth = (16 / 512) * S * 0.92;
    g.strokeStyle = '#fff';
    g.beginPath();
    g.arc(c, c, (150 / 512) * S * 0.92, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    [[256, 116], [296, 256], [256, 396], [216, 256]].forEach(([x, y], i) =>
      (i ? g.lineTo(p(x), p(y)) : g.moveTo(p(x), p(y))));
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    const url = await canvasToDataUrl(canvas);
    ICON_CACHE.set('#badge', url);
    return url;
  } catch {
    return undefined;
  }
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* malformed payload — show the default */ }
  const title = d.title || 'TRIP MAKER';

  e.waitUntil((async () => {
    const [icon, badge] = await Promise.all([buildIcon(d.countries), buildBadge()]);
    // flag emoji render natively on phones but degrade to bare letters ("JP") on
    // Windows — same per-platform rule the pages follow, so the glyphs are only
    // appended where they'll actually look like flags
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const flags = mobile && hasCountries()
      ? (d.countries || []).map((n) => COUNTRIES.ccByName(n)).filter(Boolean)
        .map((cc) => COUNTRIES.flagEmoji(cc)).join('')
      : '';

    await self.registration.showNotification(flags ? `${title} ${flags}` : title, {
      body: d.body || '',
      icon,
      badge,
      image: d.cover || undefined, // the trip cover, expanded-view hero on Android
      dir: 'rtl',
      lang: 'he',
      tag: d.tag || 'tripmaker',
      renotify: true,           // a later ping on the same trip replaces, but still buzzes
      vibrate: [28, 40, 28],
      timestamp: Date.now(),
      data: { url: d.url || '/' },
      actions: [
        { action: 'open', title: 'לצפייה במסלול' },
        { action: 'dismiss', title: 'אחר כך' },
      ],
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // an already-open tab on this trip is focused rather than duplicated
    const open = clientList.find((c) => new URL(c.url).pathname === url);
    if (open) return open.focus();
    const any = clientList.find((c) => 'focus' in c && 'navigate' in c);
    if (any) { await any.navigate(url); return any.focus(); }
    return self.clients.openWindow(url);
  })());
});

// browsers rotate a subscription on their own schedule; without this the user
// silently stops receiving anything and never finds out
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const old = e.oldSubscription || await self.registration.pushManager.getSubscription();
      const key = old && old.options && old.options.applicationServerKey;
      if (!key) return;
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: key,
      });
      await fetch('/api/push/resubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old: old.endpoint, subscription: fresh.toJSON() }),
      });
    } catch { /* the next page load re-subscribes anyway */ }
  })());
});
