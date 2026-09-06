// The schema comes up with the server.
//
// The free-tier Postgres this runs on expires after 30 days, and the replacement is an
// empty database: on 2026-09-05 the old one was suspended for billing, a new one was
// created — and every request that touched a table hung on a host that no longer
// resolved. Nothing in the app said so, and the wizard reported "unexpected error".
// So the server now brings its own schema: on boot it runs the (idempotent) setup and
// every migration, logs what it did, and seeds the suggested trips into a database
// that has none. A database that is down at boot is logged loudly and retried in the
// background; the server still listens, /api/health reports the truth, and the first
// successful run afterwards leaves the schema complete.
const { pool } = require('./db');
const { setup } = require('../db/setup');
const { migrate } = require('../db/migrate');

const RETRY_MS = 60 * 1000;
let ready = false;

async function runOnce() {
  const lines = [];
  const log = (l) => lines.push(l);
  await setup(pool, log);
  await migrate(pool, log);
  ready = true;
  // the quiet path is one line; the eventful path shows every step
  const eventful = lines.filter((l) => l.startsWith('  + ') || l.startsWith('Seeding'));
  console.log(`db-bootstrap: schema ready${eventful.length ? '\n' + lines.join('\n') : ''}`);
}

function ensureSchema() {
  return runOnce().catch((err) => {
    console.error(`db-bootstrap: database not ready (${err.code || err.message}) — retrying in ${RETRY_MS / 1000}s`);
    setTimeout(ensureSchema, RETRY_MS).unref();
  });
}

module.exports = { ensureSchema, isReady: () => ready };
