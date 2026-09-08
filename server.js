require('./lib/env');

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy — without this, req.ip (which the rate
// limiters key on) would be the proxy's address, one shared bucket for everyone.
//
// The 1 is a hop count: Express believes exactly one proxy, Render's. tripmaker.co.il
// sits behind Cloudflare's proxy (orange cloud), which adds a second hop, so on that
// path req.ip here is a Cloudflare edge — every visitor sharing one bucket, and the
// login brute-force and share-code enumeration limits silently off. clientIp, right
// below, is what makes the orange cloud safe: when the hop that reached us is a genuine
// Cloudflare address it swaps in CF-Connecting-IP, and from any other peer (the
// onrender.com host stays directly reachable, and that header is trivial to forge there)
// it leaves req.ip alone. Do not raise the hop count instead: a trusted second hop is
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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
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
app.use(require('./routes/hotels'));
app.use(require('./routes/places'));
app.use(require('./routes/push'));
app.use(require('./routes/analytics'));
app.use(require('./routes/health'));
app.use(require('./routes/seo'));
app.use(require('./routes/pages'));

// trip reminder pushes (countdowns + morning briefs) — in-process, no-op without VAPID keys
require('./lib/reminders').start();
// in-app monthly escrow backup — no-op unless DB_BACKUP_KEY + ESCROW_GITHUB_TOKEN are set
require('./lib/rotation-backup').start();
// Cloudflare's published edge ranges, refreshed daily — see lib/client-ip.js
require('./lib/client-ip').start();

// Boot order after a database rotation (tools/db-rotation-runbook.md): first re-discover
// the live instance (DATABASE_URL may still name the deleted one), then bring the schema
// up and self-restore from the escrow if the instance is fresh, and only then listen.
const { ensureDatabase } = require('./lib/db');
ensureDatabase()
  .catch((err) => console.error(`db: could not resolve an instance at boot (${err.message}) — bootstrap will keep retrying`))
  .then(() => require('./lib/db-bootstrap').ensureSchema())
  .then(() => {
    app.listen(PORT, () => console.log(`TRIP MAKER running on http://localhost:${PORT}`));
  });
