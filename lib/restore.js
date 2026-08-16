// Restore engine shared by the rotation endpoint and boot-time self-restore.
// Claude sessions that orchestrate the monthly rotation can't reach this app
// over HTTPS (their network policy), so the app restores itself: on boot with
// an empty database it fetches the encrypted escrow dump from GitHub, decrypts
// it with DB_BACKUP_KEY, and rebuilds everything. See tools/db-rotation-runbook.md.
const crypto = require('crypto');
const { SCHEMA, TABLES } = require('../db/schema');

const DUMP_FORMAT = 1;

const ESCROW_URL = process.env.RESTORE_SOURCE_URL ||
  'https://raw.githubusercontent.com/ofir6868/tripi/db-rotation-backups/backups/latest.json.enc';

// Counterpart of: openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:<key>
// ("Salted__" + 8-byte salt header; PBKDF2-HMAC-SHA256, openssl's default 10000
// iterations, 48 bytes = 32 key + 16 IV)
function decryptDump(buf, passphrase) {
  if (buf.subarray(0, 8).toString() !== 'Salted__') throw new Error('not an openssl salted file');
  const salt = buf.subarray(8, 16);
  const keyiv = crypto.pbkdf2Sync(passphrase, salt, 10000, 48, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyiv.subarray(0, 32), keyiv.subarray(32));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]);
}

async function isEmpty(q) {
  const { rows: reg } = await q.query(`SELECT to_regclass('public.users') AS t`);
  if (!reg[0].t) return true;
  const { rows } = await q.query(
    'SELECT (SELECT count(*) FROM users)::int + (SELECT count(*) FROM trips)::int AS n');
  return rows[0].n === 0;
}

// Rebuilds schema + data inside one transaction. Caller guarantees emptiness.
async function restoreDump(pool, dump) {
  if (!dump || dump.format !== DUMP_FORMAT || !dump.tables) {
    throw new Error(`expected a format-${DUMP_FORMAT} dump`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA);
    const restored = {};
    for (const t of TABLES) {
      const rows = dump.tables[t.name] || [];
      for (const row of rows) {
        const values = t.cols.map((c) =>
          (t.jsonb || []).includes(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]
        );
        const params = t.cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${t.name} (${t.cols.join(', ')}) VALUES (${params})`, values
        );
      }
      restored[t.name] = rows.length;
      if (t.serial) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${t.name}', 'id'),
                         COALESCE((SELECT MAX(id) FROM ${t.name}), 0) + 1, false)`
        );
      }
    }
    await client.query('COMMIT');
    return restored;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Boot hook: a populated database means a normal boot — do nothing. An empty
// one means this is a freshly rotated instance: pull the escrow and restore.
// Failures log and return; the app still starts (an empty tripi serves fine,
// and a later deploy can retry).
async function bootRestore(pool) {
  try {
    if (!(await isEmpty(pool))) return;
    if (!process.env.DB_BACKUP_KEY) {
      console.log('boot-restore: database is empty but DB_BACKUP_KEY is not set — skipping');
      return;
    }
    console.log(`boot-restore: database is empty, fetching escrow from ${ESCROW_URL}`);
    const res = await fetch(ESCROW_URL);
    if (!res.ok) {
      console.log(`boot-restore: escrow fetch returned ${res.status} — starting empty`);
      return;
    }
    const encrypted = Buffer.from(await res.arrayBuffer());
    const dump = JSON.parse(decryptDump(encrypted, process.env.DB_BACKUP_KEY).toString('utf8'));
    const restored = await restoreDump(pool, dump);
    console.log(`boot-restore: restored ${JSON.stringify(restored)} (dumped_at ${dump.dumped_at})`);
  } catch (err) {
    console.error('boot-restore failed (starting anyway):', err.message);
  }
}

module.exports = { DUMP_FORMAT, restoreDump, isEmpty, bootRestore, decryptDump };
