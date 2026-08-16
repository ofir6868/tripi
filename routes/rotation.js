// Free-tier database rotation: Render deletes free Postgres instances 30 days
// after creation, so the data moves to a fresh instance every month — see
// tools/db-rotation-runbook.md. The heavy lifting (schema rebuild, ordered
// inserts, sequence fixup, boot-time self-restore) lives in lib/restore.js;
// these endpoints expose dump/restore for manual operation from a machine that
// can reach the app (scheduled Claude sessions cannot — their egress policy
// blocks this host, which is why boot-time self-restore exists). They answer
// to a dedicated bearer token, not user JWTs.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { TABLES } = require('../db/schema');
const { DUMP_FORMAT, restoreDump, isEmpty } = require('../lib/restore');

const router = express.Router();

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

// Fills the *empty* database DATABASE_URL currently points at. Refuses one that
// already has users or trips — a restore can only ever fill a fresh instance.
router.post('/api/rotation/restore', rotationAuth, async (req, res) => {
  try {
    if (!(await isEmpty(pool))) {
      return res.status(409).json({ error: 'refusing to restore into a non-empty database' });
    }
    const restored = await restoreDump(pool, req.body);
    res.json({ ok: true, restored, counts: await tableCounts(pool) });
  } catch (err) {
    console.error(err);
    const code = /expected a format/.test(err.message) ? 400 : 500;
    res.status(code).json({ error: 'restore failed', detail: err.message });
  }
});

module.exports = router;
