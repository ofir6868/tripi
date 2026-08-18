require('./env');

const { Pool } = require('pg');

function makePool(url) {
  return new Pool({
    connectionString: url,
    ssl: url && url.includes('render.com')
      ? { rejectUnauthorized: false }
      : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false),
  });
}

// The exported pool delegates to a swappable target: the monthly free-tier
// rotation (tools/db-rotation-runbook.md) replaces the database instance, and
// with RENDER_API_KEY set the app re-discovers the live instance at boot even
// while DATABASE_URL still points at the deleted one.
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
  // Discovery must survive renames (tripi-db has already become tripmaker-db
  // once): prefer the known name prefixes, else fall back to the workspace's
  // single Postgres instance.
  const all = list.map((it) => it.postgres || it).filter((p) => p.status !== 'unavailable');
  const inst = all.find((p) => /^(tripi|tripmaker)-db/.test(p.name || '')) ||
    (all.length === 1 ? all[0] : null);
  if (!inst) throw new Error('could not identify the database instance via Render API');
  const info = await (await fetch(`https://api.render.com/v1/postgres/${inst.id}/connection-info`, { headers })).json();
  if (!info.externalConnectionString) throw new Error('connection-info had no externalConnectionString');
  return info.externalConnectionString;
}

// Called once at boot, before the server starts listening.
async function ensureDatabase() {
  try {
    await pool.query('SELECT 1');
    return;
  } catch (err) {
    if (!process.env.RENDER_API_KEY) throw err;
    console.log(`database unreachable (${err.message}) — resolving current instance via Render API`);
  }
  const url = await resolveDatabaseUrl();
  target.end().catch(() => {});
  target = makePool(url);
  await pool.query('SELECT 1');
  console.log('database resolved via Render API — connected to the current tripi-db instance');
}

module.exports = { pool, ensureDatabase };
