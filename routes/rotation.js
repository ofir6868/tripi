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
const { buildDump, restoreDump, isEmpty } = require('../lib/restore');

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
  const { rows: tabs } = await q.query(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const counts = {};
  for (const { t } of tabs) {
    const { rows } = await q.query(`SELECT count(*)::int AS n FROM ${t}`);
    counts[t] = rows[0].n;
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

// Everything the database holds — schema (live DDL) and data alike, so the
// dump stays correct across migrations this code has never heard of.
router.get('/api/rotation/dump', rotationAuth, async (_req, res) => {
  try {
    res.json(await buildDump(pool));
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
