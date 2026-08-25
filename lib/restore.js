// Restore engine shared by the rotation endpoints and boot-time self-restore.
// Claude sessions that orchestrate the monthly rotation can't reach this app
// over HTTPS (their network policy), so the app restores itself: on boot with
// an empty database it fetches the encrypted escrow dump from GitHub, decrypts
// it with DB_BACKUP_KEY, and rebuilds everything. See tools/db-rotation-runbook.md.
//
// Format 2 dumps are schema-agnostic: the dump carries the live database's own
// DDL (sequences, tables, constraints, indexes — captured from the catalogs)
// plus every row of every table, so a migration added after this file shipped
// still survives a rotation untouched. Format 1 (fixed registry in
// db/schema.js) is still accepted for old escrow files.
const crypto = require('crypto');
const { SCHEMA, TABLES } = require('../db/schema');

const DUMP_FORMAT = 2;

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

// Base tables of the public schema, FK-topo-sorted so plain inserts satisfy
// references. Self-references and cycles fall back to appending (this schema
// has none).
async function liveTableOrder(q) {
  const { rows: tabs } = await q.query(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const { rows: fks } = await q.query(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
     FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace`);
  const names = tabs.map((r) => r.t);
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of fks) {
    if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  }
  const ordered = [];
  while (ordered.length < names.length) {
    const ready = names.filter((n) => !ordered.includes(n) &&
      [...deps.get(n)].every((p) => ordered.includes(p)));
    if (!ready.length) { ordered.push(...names.filter((n) => !ordered.includes(n))); break; }
    ordered.push(...ready);
  }
  return ordered;
}

// The live schema as replayable SQL: sequences, then tables (column types and
// defaults verbatim via format_type/pg_get_expr), then PK/unique/check
// constraints, then FKs, then the indexes that aren't constraint-backed, then
// sequence ownership so pg_get_serial_sequence keeps working after a restore.
// Views, triggers and functions aren't captured — this app has none.
async function captureDDL(q, tableOrder) {
  const ddl = [];
  const { rows: seqs } = await q.query(
    `SELECT sequencename AS s FROM pg_sequences WHERE schemaname='public'`);
  for (const { s } of seqs) ddl.push(`CREATE SEQUENCE IF NOT EXISTS ${s}`);

  const owned = [];
  for (const t of tableOrder) {
    const { rows: cols } = await q.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              pg_get_expr(d.adbin, d.adrelid) AS def, a.attnotnull AS notnull
       FROM pg_attribute a LEFT JOIN pg_attrdef d
         ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`, [`public.${t}`]);
    const lines = cols.map((c) =>
      `  ${c.name} ${c.type}${c.def ? ` DEFAULT ${c.def}` : ''}${c.notnull ? ' NOT NULL' : ''}`);
    ddl.push(`CREATE TABLE IF NOT EXISTS ${t} (\n${lines.join(',\n')}\n)`);
    for (const c of cols) {
      const m = /^nextval\('([^']+)'/.exec(c.def || '');
      if (m) owned.push(`ALTER SEQUENCE ${m[1].replace(/::regclass$/, '')} OWNED BY ${t}.${c.name}`);
    }
  }

  const { rows: cons } = await q.query(
    `SELECT conrelid::regclass::text AS tbl, conname, contype, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('p','u','c','f')
     ORDER BY CASE contype WHEN 'f' THEN 1 ELSE 0 END, conrelid::regclass::text, conname`);
  for (const c of cons) ddl.push(`ALTER TABLE ${c.tbl} ADD CONSTRAINT ${c.conname} ${c.def}`);

  const { rows: idx } = await q.query(
    `SELECT indexdef AS def FROM pg_indexes WHERE schemaname='public'
     AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace)
     ORDER BY indexname`);
  for (const i of idx) ddl.push(i.def.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS'));

  ddl.push(...owned);
  return ddl;
}

// A complete format-2 dump of whatever schema and data the database holds now.
async function buildDump(pool) {
  const tableOrder = await liveTableOrder(pool);
  const ddl = await captureDDL(pool, tableOrder);
  const sequences = {};
  const { rows: seqs } = await pool.query(
    `SELECT sequencename AS s, last_value AS v FROM pg_sequences WHERE schemaname='public'`);
  for (const { s, v } of seqs) sequences[s] = v === null ? null : String(v);
  const tables = {};
  for (const t of tableOrder) {
    const { rows: pk } = await pool.query(
      `SELECT a.attname AS c FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`, [`public.${t}`]);
    const orderBy = pk.length ? pk.map((r) => r.c).join(', ') : '1';
    const { rows } = await pool.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(x.*) ORDER BY ${orderBy}), '[]') AS data
       FROM ${t} x`);
    tables[t] = rows[0].data;
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return { format: DUMP_FORMAT, dumped_at: new Date().toISOString(), tableOrder, ddl, sequences, counts, tables };
}

// Rebuilds schema + data inside one transaction. Caller guarantees emptiness.
async function restoreDump(pool, dump) {
  if (!dump || !dump.tables || ![1, 2].includes(dump.format)) {
    throw new Error('expected a format-1 or format-2 dump');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const restored = {};
    if (dump.format === 2) {
      for (const stmt of dump.ddl) await client.query(stmt);
      for (const t of dump.tableOrder) {
        const rows = dump.tables[t] || [];
        for (const row of rows) {
          const cols = Object.keys(row);
          const values = cols.map((c) =>
            row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]);
          const params = cols.map((_, i) => `$${i + 1}`).join(', ');
          await client.query(
            `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${params})`, values);
        }
        restored[t] = rows.length;
      }
      for (const [s, v] of Object.entries(dump.sequences || {})) {
        if (v !== null) await client.query(`SELECT setval($1, $2::bigint, true)`, [s, v]);
      }
    } else {
      // format 1: the fixed registry this file shipped with
      await client.query(SCHEMA);
      for (const t of TABLES) {
        const rows = dump.tables[t.name] || [];
        for (const row of rows) {
          const values = t.cols.map((c) =>
            (t.jsonb || []).includes(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]);
          const params = t.cols.map((_, i) => `$${i + 1}`).join(', ');
          await client.query(
            `INSERT INTO ${t.name} (${t.cols.join(', ')}) VALUES (${params})`, values);
        }
        restored[t.name] = rows.length;
        if (t.serial) {
          await client.query(
            `SELECT setval(pg_get_serial_sequence('${t.name}', 'id'),
                           COALESCE((SELECT MAX(id) FROM ${t.name}), 0) + 1, false)`);
        }
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
    console.log(`boot-restore: restored ${JSON.stringify(restored)} (format ${dump.format}, dumped_at ${dump.dumped_at})`);
  } catch (err) {
    console.error('boot-restore failed (starting anyway):', err.message);
  }
}

module.exports = { DUMP_FORMAT, buildDump, restoreDump, isEmpty, bootRestore, decryptDump };
