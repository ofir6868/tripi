require('./lib/env');

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy — without this, req.ip (which the rate
// limiters key on) would be the proxy's address, one shared bucket for everyone
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
app.use(require('./routes/health'));
app.use(require('./routes/pages'));

app.listen(PORT, () => console.log(`TRIPI running on http://localhost:${PORT}`));
