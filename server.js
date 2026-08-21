require('./lib/env');

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy — without this, req.ip (which the rate
// limiters key on) would be the proxy's address, one shared bucket for everyone.
//
// The 1 is a hop count, so it is only correct while Render's proxy is the ONLY
// one in front of us. tripmaker.co.il is on Cloudflare DNS deliberately unproxied
// (grey cloud) to keep it that way. Turning the orange cloud on adds a second hop
// and req.ip silently becomes a Cloudflare edge address — every visitor sharing
// one bucket, which disables the login brute-force and share-code enumeration
// limits without any error to notice. If that switch is ever flipped, the client
// IP has to come from CF-Connecting-IP, believed only when the hop that reached
// us is genuinely Cloudflare's (the onrender.com host stays directly reachable,
// and that header is trivial to forge there).
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routers mount at the root and keep their full paths internally, so every route
// reads exactly as it did when this was one file. This mount order reproduces the
// original registration order — keep it that way. The ordering that actually bites
// is inside routes/trips.js, where /api/trips/suggested, /search and /code/:code
// must stay ahead of /api/trips/:id or the bare :id param swallows them.
app.use(require('./routes/auth'));
app.use(require('./routes/trips'));
app.use(require('./routes/admin'));
app.use(require('./routes/ai'));
app.use(require('./routes/hotels'));
app.use(require('./routes/push'));
app.use(require('./routes/analytics'));
app.use(require('./routes/health'));
app.use(require('./routes/pages'));

// trip reminder pushes (countdowns + morning briefs) — in-process, no-op without VAPID keys
require('./lib/reminders').start();

app.listen(PORT, () => console.log(`TRIP MAKER running on http://localhost:${PORT}`));
