// Restore the trip data from the monthly escrow backup.
//
// Render deletes a free Postgres 30 days after it's created. A scheduled rotation
// dumps the database to an encrypted file on GitHub before that happens
// (ofir6868/tripi, branch db-rotation-backups, backups/latest.json.enc), and this is
// the other half: on boot the app fetches that file, decrypts it with DB_BACKUP_KEY,
// and rebuilds the tables. The app has open egress, so it can reach GitHub even though
// the scheduled session that wrote the backup cannot reach the app.
//
// It runs only into a database that holds no real data — no users, and no trips beyond
// the demo ones the seed creates. That guard is what makes it safe to leave on: a
// populated database is a normal boot and is never touched. Setting RESTORE_FROM_ESCROW=1
// forces it over demo/seed data for a one-time recovery (it still refuses to clobber a
// database that has real user accounts unless the same flag says so).
const crypto = require('crypto');

// the demo trips db/setup.js seeds — a database holding only these (and no users) is
// "as good as empty" and safe to replace with a recovered backup
const SEED_CODES = new Set(['284917', '731502', '590346', '417829', '863054', '925471', '308156', '652093']);

// FK-safe order; the dump may omit a table (an older backup predates one) — skipped then
const TABLE_ORDER = [
  'users', 'trips', 'trip_participants', 'trip_items', 'trip_budgets',
  'trip_hotels', 'trip_stop_votes', 'trip_expenses', 'push_subscriptions', 'push_log',
];

// the escrow location. RESTORE_SOURCE_URL overrides outright; otherwise it is built from
// the same ESCROW_REPO/ESCROW_BRANCH that lib/rotation-backup.js writes to, so the reader
// and writer always agree. Default repo is where the working backup lives today.
const ESCROW_URL = process.env.RESTORE_SOURCE_URL ||
  `https://raw.githubusercontent.com/${process.env.ESCROW_REPO || 'ofir6868/tripi'}/${process.env.ESCROW_BRANCH || 'db-rotation-backups'}/backups/latest.json.enc`;

// Counterpart of: openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:<key>
// "Salted__" + 8-byte salt, then PBKDF2-HMAC-SHA256 (openssl's default 10000 iters)
// to 48 bytes = 32-byte key + 16-byte IV.
function decryptDump(buf, passphrase) {
  if (buf.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('not an openssl salted file');
  const salt = buf.subarray(8, 16);
  const keyiv = crypto.pbkdf2Sync(passphrase, salt, 10000, 48, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyiv.subarray(0, 32), keyiv.subarray(32));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]);
}

async function columnTypes(client, table) {
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table]
  );
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

// pg would render a JS array/object for a json/jsonb column as a Postgres array literal —
// those columns go over the wire as text
const outbound = (v, type) => (v != null && (type === 'json' || type === 'jsonb') ? JSON.stringify(v) : v);

// no users, and every trip is one of the demo seeds — nothing real to lose
async function onlySeedData(client) {
  const { rows: u } = await client.query('SELECT count(*)::int AS n FROM users');
  if (u[0].n > 0) return false;
  const { rows: t } = await client.query('SELECT share_code FROM trips');
  return t.every((r) => SEED_CODES.has(r.share_code));
}

// Insert every table the dump carries, in FK order, matching columns by name against
// the live schema (so a backup taken before a later column simply leaves it at default,
// and a column dropped since is ignored). One transaction: all or nothing.
async function applyDump(pool, dump, log = console.log) {
  if (!dump || !dump.tables) throw new Error('escrow is not a recognizable dump');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLE_ORDER.join(', ')} RESTART IDENTITY CASCADE`);
    const restored = {};
    for (const table of TABLE_ORDER) {
      const rows = dump.tables[table];
      if (!Array.isArray(rows) || !rows.length) { restored[table] = 0; continue; }
      const types = await columnTypes(client, table);
      const cols = Object.keys(rows[0]).filter((c) => types.has(c));
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const vals = [];
        const tuples = chunk.map((r) => {
          const base = vals.length;
          cols.forEach((c) => vals.push(outbound(r[c], types.get(c))));
          return `(${cols.map((_, k) => `$${base + k + 1}`).join(',')})`;
        });
        await client.query(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${tuples.join(',')}`, vals
        );
      }
      restored[table] = rows.length;
      // continue the serial after the highest restored id — only tables that have one
      // (the join tables key on composite columns, and pg_get_serial_sequence errors on
      // a column that doesn't exist rather than returning null)
      if (types.has('id')) {
        const { rows: seq } = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [table]);
        if (seq[0].seq) {
          await client.query(
            `SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`, [seq[0].seq]
          );
        }
      }
    }
    await client.query('COMMIT');
    log(`db-restore: restored ${Object.entries(restored).map(([t, n]) => `${t}: ${n}`).join(', ')}${dump.dumped_at ? ` (dumped ${dump.dumped_at})` : ''}`);
    return restored;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Boot hook. Returns true when it restored, false when it deliberately did nothing.
// Never throws — a recovery that can't run must not stop the server from starting.
async function restoreFromEscrow(pool, log = console.log) {
  try {
    if (!process.env.DB_BACKUP_KEY) {
      log('db-restore: DB_BACKUP_KEY is not set — cannot decrypt the escrow, skipping');
      return false;
    }
    const force = process.env.RESTORE_FROM_ESCROW === '1';
    const client = await pool.connect();
    let go;
    try { go = force || await onlySeedData(client); } finally { client.release(); }
    if (!go) { log('db-restore: the database already holds real data — leaving it untouched'); return false; }

    log(`db-restore: fetching escrow from ${ESCROW_URL}`);
    const res = await fetch(ESCROW_URL);
    if (!res.ok) { log(`db-restore: escrow fetch returned ${res.status} — not restoring`); return false; }
    const encrypted = Buffer.from(await res.arrayBuffer());
    let dump;
    try {
      dump = JSON.parse(decryptDump(encrypted, process.env.DB_BACKUP_KEY).toString('utf8'));
    } catch (err) {
      // a wrong key fails here — say so plainly, it's the one thing an operator can fix
      log(`db-restore: could not decrypt the escrow (${err.message}) — is DB_BACKUP_KEY correct? not restoring`);
      return false;
    }
    await applyDump(pool, dump, log);
    return true;
  } catch (err) {
    console.error('db-restore failed (starting anyway):', err.message);
    return false;
  }
}

module.exports = { restoreFromEscrow, applyDump, decryptDump, onlySeedData, TABLE_ORDER, ESCROW_URL };
