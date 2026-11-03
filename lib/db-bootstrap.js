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
const crypto = require('crypto');
const { pool } = require('./db');
const { setup, SCHEMA } = require('../db/setup');
const { migrate } = require('../db/migrate');
const { importFrom } = require('./db-import');
const { restoreFromEscrow } = require('./db-restore');

const RETRY_MS = 60 * 1000;
let ready = false;

// Once per deploy, not once per cold start.
//
// On an always-on host "every boot" meant once per deploy. On Vercel it means every cold
// start — and a function instance goes cold within minutes, several boot side by side,
// and every request an instance takes (the page, each of its thirty scripts, /sw.js)
// waits in api/index.js until this has finished. The full run is ~80 statements in a
// row against the free database, and each ALTER TABLE … IF NOT EXISTS still takes the
// table's exclusive lock. Measured on 2026-11-03: a visitor from a Google result waited
// 8–10 s for /js/destinations.js and /api/me while their instance replayed every
// migration — the "very slow in places" the owner felt.
//
// So a successful full run leaves a stamp in the database: the deployed commit, plus the
// one input outside the code that changes what a run does (ADMIN_EMAILS). A cold start
// that finds its own stamp is done after one indexed read. Everything else still gets the
// full run: a new deploy (the first instance of each commit runs it), a freshly rotated
// database (no stamp table at all — so restore-from-escrow and the seed still happen), an
// import, and any host without a commit id (local, where boots are rare anyway). The
// sweeps that were relying on "every boot" (migration 27's local push endpoints, invite
// tokens, admin promotion) now run on every deploy and on the daily cron
// (routes/cron.js calls runFull), which on this project is still close to continuous.
const COMMIT = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || '';
const STAMP = COMMIT
  ? crypto.createHash('sha256').update(`${COMMIT}|${process.env.ADMIN_EMAILS || ''}`).digest('hex').slice(0, 32)
  : '';

async function alreadyStamped() {
  if (!STAMP || process.env.IMPORT_FROM_DATABASE_URL) return false;
  try {
    const { rows } = await pool.query(`SELECT value FROM schema_stamp WHERE key = 'boot'`);
    return rows[0]?.value === STAMP;
  } catch {
    return false; // no table yet: a new or rotated database — run everything
  }
}

async function stamp() {
  if (!STAMP) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_stamp (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(
    `INSERT INTO schema_stamp (key, value) VALUES ('boot', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, at = now()`, [STAMP]);
}

async function runOnce() {
  if (await alreadyStamped()) {
    ready = true;
    return;
  }
  await runFull();
}

async function runFull() {
  const lines = [];
  const log = (l) => lines.push(l);
  // schema + migrations first, always, so the tables exist with their full column set
  // before anything reads or fills them
  await pool.query(SCHEMA);
  await migrate(pool, log);
  // recovery: a freshly rotated instance (empty, or holding only the demo seed) rebuilds
  // itself from the monthly escrow backup — see lib/db-restore.js. On a database with real
  // data this is a logged no-op, so it is safe to leave on.
  const restored = await restoreFromEscrow(pool, log);
  // no backup to restore (first ever boot, or no key): seed the demo trips as before.
  // setup() re-runs the schema (idempotent) and only seeds when there are no public trips.
  if (!restored) await setup(pool, log);
  // one-time copy from an old LIVE database instead of the escrow file — see lib/db-import.js
  if (process.env.IMPORT_FROM_DATABASE_URL) await importFrom(process.env.IMPORT_FROM_DATABASE_URL, pool, log);
  await stamp();
  ready = true;
  // the quiet path is one line; the eventful path shows every step
  const eventful = lines.filter((l) => l.startsWith('  + ') || l.startsWith('Seeding') || l.startsWith('db-import') || l.startsWith('db-restore'));
  console.log(`db-bootstrap: schema ready${eventful.length ? '\n' + lines.join('\n') : ''}`);
}

function ensureSchema() {
  return runOnce().catch((err) => {
    console.error(`db-bootstrap: database not ready (${err.code || err.message}) — retrying in ${RETRY_MS / 1000}s`);
    setTimeout(ensureSchema, RETRY_MS).unref();
  });
}

module.exports = { ensureSchema, runFull, isReady: () => ready };
