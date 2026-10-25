require('./lib/env');

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// The host terminates TLS at its own proxy — without this, req.ip (which the rate
// limiters key on) would be the proxy's address, one shared bucket for everyone.
//
// The 1 is a hop count: Express believes exactly one proxy, the platform's (Vercel's
// edge today, Render's before it — both hand us the connecting address). tripmaker.co.il
// sits behind Cloudflare's proxy (orange cloud), which adds a second hop, so on that
// path req.ip here is a Cloudflare edge — every visitor sharing one bucket, and the
// login brute-force and share-code enumeration limits silently off. clientIp, right
// below, is what makes the orange cloud safe: when the hop that reached us is a genuine
// Cloudflare address it swaps in CF-Connecting-IP, and from any other peer (the
// platform's own .vercel.app host stays directly reachable, and that header is trivial to
// forge there) it leaves req.ip alone. Do not raise the hop count instead: a trusted second hop is
// exactly what lets a direct caller pick their own address with a forged header.
app.set('trust proxy', 1);
app.use(require('./lib/client-ip').clientIp);

// First in the chain, before anything can answer with a page: fold www., the bare http
// scheme and the onrender.com host into the one origin we want indexed. See
// lib/canonical-origin.js for what the duplicates cost us in Search Console.
app.use(require('./lib/canonical-origin').canonicalOrigin);

// 100kb (the default) is not enough for a long AI-built trip saved in one POST — a
// hundred stops with notes, a place query and a place id each — and a body over the
// limit answers as an HTML 413 the client can only call "unexpected"
// the rotation restore body is a whole-database dump, far over the 2mb page limit — give
// just that route its own ceiling, mounted before the global parser sees it
app.use('/api/rotation', express.json({ limit: '25mb' }));
app.use(require('./routes/rotation'));

app.use(express.json({ limit: '2mb' }));
// CSS and JS must revalidate on every load, and the header has to say so out loud.
// express.static's default is `max-age=0` + ETag, which a browser revalidates — but
// Cloudflare's "Browser Cache TTL" setting overrides a plain max-age and hands
// visitors its own (hours-long) expiry, while HTML is not in its cached-extension
// list. The result is the one failure that looks like a bug in the code: a page
// that arrives fresh, styled by a stylesheet from the previous deploy — new markup
// with no rules for it, so a new control renders as a bare browser button.
// `no-cache` is not "don't store": it stores and revalidates, so this stays a 304
// per asset, and Cloudflare does not override it.
// index: false — the pages are served by routes/pages.js, which stamps their asset
// URLs with the deploy's version (lib/asset-version). A directory index here would
// hand out an unstamped index.html and quietly reopen the problem for the home page.
const IMG_DIR = path.join(__dirname, 'public', 'img') + path.sep;
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.(css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    // The opposite rule for the fonts, and for the same reason the stylesheet needs
    // no-cache: what is in a font file never changes. A face is addressed by the
    // subset it carries (public/fonts/README.md), so replacing one means a new
    // filename, not new bytes under the old one — which is exactly the promise
    // `immutable` makes. Without this they inherit express.static's max-age=0 and
    // cost a revalidation round trip on every single page load, in front of text.
    else if (/\.woff2$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // public/img is the same bargain: everything in it is written by a tool
    // (tools/fetch-hero.js), addressed by what it contains, and replaced by adding a
    // new filename rather than new bytes under an old one. The hero photo is the
    // home page's LCP element, so this is the one directory where a revalidation
    // round trip would be felt directly.
    else if (filePath.startsWith(IMG_DIR)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// Routers mount at the root and keep their full paths internally, so every route
// reads exactly as it did when this was one file. This mount order reproduces the
// original registration order — keep it that way. The ordering that actually bites
// is inside routes/trips.js, where /api/trips/suggested, /search and /code/:code
// must stay ahead of /api/trips/:id or the bare :id param swallows them.
app.use(require('./routes/auth'));
app.use(require('./routes/trips'));
app.use(require('./routes/admin'));
app.use(require('./routes/ai'));
app.use(require('./routes/plan'));
app.use(require('./routes/day-recs'));
app.use(require('./routes/checklist'));
app.use(require('./routes/hotels'));
app.use(require('./routes/places'));
app.use(require('./routes/hours'));
app.use(require('./routes/photos'));
app.use(require('./routes/push'));
app.use(require('./routes/analytics'));
app.use(require('./routes/health'));
app.use(require('./routes/seo'));
app.use(require('./routes/cron'));
app.use(require('./routes/pages'));

// Boot order after a database rotation (tools/db-rotation-runbook.md): first re-discover
// the live instance (DATABASE_URL may still name the deleted one), then bring the schema
// up. Nothing here is allowed to reject: a database that is down must not stop the app
// from answering — /api/health reports the truth and db-bootstrap keeps retrying.
const { ensureDatabase } = require('./lib/db');
const boot = ensureDatabase()
  .catch((err) => console.error(`db: could not resolve an instance at boot (${err.message}) — bootstrap will keep retrying`))
  .then(() => require('./lib/db-bootstrap').ensureSchema())
  .catch((err) => console.error(`db-bootstrap: could not bring the schema up (${err.message})`));

// The jobs that need a clock. Every one of them is a timer in this process, which is a
// bargain that only holds on a host that keeps the process alive between requests.
function startBackgroundJobs() {
  // trip reminder pushes (countdowns + morning briefs) — in-process, no-op without VAPID keys
  require('./lib/reminders').start();
  // in-app monthly escrow backup — no-op unless DB_BACKUP_KEY + ESCROW_GITHUB_TOKEN are set
  require('./lib/rotation-backup').start();
  // Cloudflare's published edge ranges, refreshed daily — see lib/client-ip.js
  require('./lib/client-ip').start();
  // drop paid-API answers older than the 30 days Google's terms allow us to keep them
  require('./lib/api-budget').sweep();
  // the opening-hours probe and audit, run from the host that actually has to reach the
  // sources — a free web service has no shell to run tools/ from. No-op unless BOOT_PROBE
  // is set; see lib/boot-probe.js.
  require('./lib/boot-probe').start();
  // one-off: fill osm_type/osm_id on stops verified before migration 25 existed. No-op
  // unless BACKFILL_OSM is set; Photon only, and reversible in one UPDATE.
  require('./lib/osm-backfill').start();
}

// Two hosts, two shapes, one app.
//
// Run directly — `node server.js`, locally or on any always-on host — and this is a
// server: it starts the timers above and listens on a port. Required as a module it is
// just the app, which is how Vercel takes it (api/index.js is the one function every
// request is routed into). A function instance is frozen between requests and there may
// be several of them, so a setInterval there would fire late, never, or twice over in
// parallel; on that host the schedule arrives from outside instead, as the daily call to
// /api/cron/tick in vercel.json. The Cloudflare range refresh is the one job with no
// replacement there, and needs none: lib/client-ip.js ships the published list baked in
// and only loses the freshest edge ranges, which costs coarser rate-limit buckets for
// those edges and never a hole.
if (require.main === module) {
  startBackgroundJobs();
  boot.then(() => {
    app.listen(PORT, () => console.log(`TRIP MAKER running on http://localhost:${PORT}`));
  });
}

module.exports = { app, boot };
