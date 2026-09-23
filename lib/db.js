require('./env');

const { Pool } = require('pg');

// A serverless instance serves one request at a time and is frozen between them, so pg's
// default of ten sockets there is ten connections held open per instance — against a free
// database that allows a couple of dozen in total, across however many instances the
// platform keeps warm. A small pool, given up quickly once idle, is what that host can
// afford. An always-on server keeps the defaults: there the pool is the concurrency.
//
// Small is not ONE. The first cut on Vercel set max: 1, and on 2026-09-23 the site froze:
// a route that checks a client out (`pool.connect()`, to run a transaction) and then asks
// the pool for another query — through tripWithEditAuth, isAdmin, the quota meter, a plain
// pool.query beside the transaction — waits for a connection that only it is holding. It
// waits forever; so does every request that lands on that instance after it, page loads
// included, until the platform kills them all at 300 seconds. The planning chat's first
// load is exactly such a route, and it took the rest of the site down with it.
//
// Three is the smallest count that leaves such a route room to wait on itself (the held
// client, its side query, and one more for the writes a response leaves running behind
// it — day-recs, push fan-out). And a wait for a connection now has a clock: when the pool
// is still starved after twenty seconds the query fails loudly and the route answers 500,
// which is a line in the log with the route's name on it instead of a frozen instance.
// Twenty rather than ten: within a quarter hour of the first deploy a cold start's very
// first handshake with the free Render instance ran past ten seconds once (it retried and
// came up) — a clock that fires on a slow handshake is a second outage, not a fix.
const SERVERLESS = !!process.env.VERCEL;

function makePool(url) {
  return new Pool({
    connectionString: url,
    ...(SERVERLESS ? { max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 20_000 } : {}),
    ssl: url && url.includes('render.com')
      ? { rejectUnauthorized: false }
      : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
  });
}

// The exported pool delegates to a swappable target. The monthly free-tier rotation
// (tools/db-rotation-runbook.md) replaces the database instance every 30 days; with
// RENDER_API_KEY set the app re-discovers the live instance at boot even while
// DATABASE_URL still points at the deleted one, so a rotation needs no env change.
let target = makePool(process.env.DATABASE_URL);

const pool = {
  query: (...args) => target.query(...args),
  connect: (...args) => target.connect(...args),
  end: (...args) => target.end(...args),
  on: (...args) => target.on(...args),
};

async function resolveDatabaseUrl() {
  const headers = { Authorization: `Bearer ${process.env.RENDER_API_KEY}` };
  const list = await (await fetch('https://api.render.com/v1/postgres?limit=20', { headers })).json();
  // Discovery must survive renames (tripi-db has already become tripmaker-db once):
  // prefer the known name prefixes, else fall back to the workspace's single instance.
  const all = (Array.isArray(list) ? list : []).map((it) => it.postgres || it).filter((p) => p && p.status !== 'unavailable');
  const inst = all.find((p) => /^(tripi|tripmaker)-db/.test(p.name || '')) || (all.length === 1 ? all[0] : null);
  if (!inst) throw new Error('could not identify the database instance via Render API');
  const info = await (await fetch(`https://api.render.com/v1/postgres/${inst.id}/connection-info`, { headers })).json();
  if (!info.externalConnectionString) throw new Error('connection-info had no externalConnectionString');
  return info.externalConnectionString;
}

// Called once at boot, before the server starts listening. A reachable database is a
// normal boot — nothing happens. An unreachable one with RENDER_API_KEY set means a
// rotation swapped the instance under us: find the current one and reconnect.
async function ensureDatabase() {
  try {
    await pool.query('SELECT 1');
    return;
  } catch (err) {
    if (!process.env.RENDER_API_KEY) throw err;
    console.log(`database unreachable (${err.message}) — resolving the current instance via Render API`);
  }
  const url = await resolveDatabaseUrl();
  target.end().catch(() => {});
  target = makePool(url);
  await pool.query('SELECT 1');
  console.log('database resolved via Render API — connected to the current instance');
}

module.exports = { pool, ensureDatabase };
