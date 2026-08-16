// Free-tier database rotation: Render deletes free Postgres instances 30 days
// after creation, so shortly before each expiry an operator (a scheduled Claude
// session — see tools/db-rotation-runbook.md) dumps everything through this
// router, a fresh database is created, DATABASE_URL is re-pointed, and the dump
// is restored. These endpoints are the only write path into the database from
// outside Render, so they answer to a dedicated bearer token, not user JWTs.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { SCHEMA, TABLES } = require('../db/schema');

const router = express.Router();

const DUMP_FORMAT = 1;

function rotationAuth(req, res, next) {
  const token = process.env.ROTATION_TOKEN;
  if (!token) return res.status(503).json({ error: 'rotation disabled: ROTATION_TOKEN is not set' });
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad rotation token' });
  next();
}

async function tableCounts(q) {
  const counts = {};
  for (const t of TABLES) {
    const { rows } = await q.query(`SELECT count(*)::int AS n FROM ${t.name}`);
    counts[t.name] = rows[0].n;
  }
  return counts;
}

router.get('/api/rotation/status', rotationAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS now');
    res.json({ ok: true, now: rows[0].now, counts: await tableCounts(pool) });
  } catch (err) {
    // a brand-new database has no tables yet — that's a state, not an error
    if (err.code === '42P01') return res.json({ ok: true, empty: true, counts: null });
    console.error(err);
    res.status(500).json({ error: 'status failed' });
  }
});

// Everything, ordered and JSON-typed by Postgres itself (to_jsonb renders dates
// and numerics as strings — no driver-side Date/locale surprises in the dump).
router.get('/api/rotation/dump', rotationAuth, async (_req, res) => {
  try {
    const tables = {};
    for (const t of TABLES) {
      const orderBy = t.cols.includes('id') ? 'id' : t.cols.slice(0, 2).join(', ');
      const { rows } = await pool.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(x.*) ORDER BY ${orderBy}), '[]') AS data
         FROM ${t.name} x`
      );
      tables[t.name] = rows[0].data;
    }
    const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    res.json({ format: DUMP_FORMAT, dumped_at: new Date().toISOString(), counts, tables });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'dump failed' });
  }
});

// Rebuilds schema + data into the *empty* database DATABASE_URL currently points
// at. Refuses to touch a database that already has users or trips — a restore
// can only ever fill a fresh instance, never overwrite the live one.
router.post('/api/rotation/restore', rotationAuth, async (req, res) => {
  const dump = req.body;
  if (!dump || dump.format !== DUMP_FORMAT || !dump.tables) {
    return res.status(400).json({ error: `expected a format-${DUMP_FORMAT} dump` });
  }
  const client = await pool.connect();
  try {
    const { rows: reg } = await client.query(`SELECT to_regclass('public.users') AS t`);
    if (reg[0].t) {
      const { rows } = await client.query(
        'SELECT (SELECT count(*) FROM users)::int + (SELECT count(*) FROM trips)::int AS n');
      if (rows[0].n > 0) {
        return res.status(409).json({ error: 'refusing to restore into a non-empty database' });
      }
    }

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
    res.json({ ok: true, restored, counts: await tableCounts(client) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'restore failed', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
