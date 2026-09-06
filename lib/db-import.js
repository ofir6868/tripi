// One-shot import from another database, for the day the free-tier Postgres expires.
//
// Set IMPORT_FROM_DATABASE_URL to the OLD database's connection string and deploy.
// On boot, after the schema and migrations are in place, the server copies every
// table across — users, trips, stops, participants, hotels, budgets, expenses, votes,
// push subscriptions — with the same ids, and resets the sequences so new rows
// continue where the old ones stopped. It runs only into a database that has no
// users yet (the seed trips alone don't count), so a second boot with the variable
// still set is a logged no-op and can never overwrite real data. Remove the variable
// afterwards. Columns are matched by name, so a source that predates a migration
// simply leaves the new column at its default.
const { Pool } = require('pg');

// parents before children — the target is truncated with CASCADE, then filled in this order
const TABLES = [
  'users', 'trips', 'trip_participants', 'trip_items', 'trip_budgets', 'trip_hotels',
  'trip_expenses', 'trip_stop_votes', 'push_subscriptions', 'push_log',
];
const BATCH = 500;

// name → data type, in table order
async function columnsOf(db, table) {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

// pg hands a jsonb column back as a parsed value and would send a JS array back out
// as a Postgres array literal — json columns go over the wire as text, explicitly
const outbound = (value, type) => (value != null && (type === 'json' || type === 'jsonb') ? JSON.stringify(value) : value);

async function importFrom(sourceUrl, target, log = console.log) {
  const { rows: [{ n }] } = await target.query('SELECT count(*)::int AS n FROM users');
  if (n > 0) { log(`db-import: skipped — the database already holds ${n} users`); return false; }

  const source = new Pool({
    connectionString: sourceUrl,
    ssl: sourceUrl.includes('render.com') ? { rejectUnauthorized: false } : false,
    max: 2,
  });
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    // the seed trips and anything created in the last hour give way to the real history
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const counts = {};
    for (const table of TABLES) {
      const srcCols = await columnsOf(source, table);
      if (!srcCols.size) { counts[table] = 'absent'; continue; }
      const dstCols = await columnsOf(client, table);
      const cols = [...srcCols.keys()].filter((c) => dstCols.has(c));
      const { rows } = await source.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`);
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const vals = [];
        const tuples = chunk.map((r) => {
          const base = vals.length;
          cols.forEach((c) => vals.push(outbound(r[c], dstCols.get(c))));
          return `(${cols.map((_, k) => `$${base + k + 1}`).join(',')})`;
        });
        await client.query(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${tuples.join(',')}`, vals
        );
      }
      counts[table] = rows.length;
      // serial ids: continue after the highest imported one
      if (cols.includes('id')) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT max(id) FROM "${table}"), 0) + 1, false)`, [table]
        );
      }
    }
    await client.query('COMMIT');
    log(`db-import: done — ${Object.entries(counts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await source.end().catch(() => {});
  }
}

module.exports = { importFrom, TABLES };
