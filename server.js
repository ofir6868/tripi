require('./lib/env');

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy — without this, req.ip (which the rate
// limiters key on) would be the proxy's address, one shared bucket for everyone
app.set('trust proxy', 1);

// The rotation restore body is a whole-database dump, far over express.json()'s
// 100kb default — its router mounts ahead of the global parser with its own limit.
app.use('/api/rotation', express.json({ limit: '20mb' }));
app.use(require('./routes/rotation'));

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

// Boot order matters after a database rotation: first re-discover the live
// instance if DATABASE_URL points at a deleted one (needs RENDER_API_KEY),
// then self-restore from the escrow dump if the instance is brand-new/empty,
// and only then serve traffic. See tools/db-rotation-runbook.md.
const { ensureDatabase } = require('./lib/db');
const { bootRestore } = require('./lib/restore');

(async () => {
  try {
    await ensureDatabase();
    console.log('rotation: restore engine v2 ready'); // beacon: lets operators confirm via logs that this build carries the rotation machinery
    await bootRestore(require('./lib/db').pool);
  } catch (err) {
    console.error('boot: database unavailable, serving anyway:', err.message);
  }
  app.listen(PORT, () => console.log(`TRIPI running on http://localhost:${PORT}`));
})();
