// Manual half of the free-tier rotation (tools/db-rotation-runbook.md): produce a backup
// or restore one from a machine that can reach the app — the app's own scheduled backup
// (lib/rotation-backup.js) and boot-time self-restore (lib/db-restore.js) are the automatic
// halves. These answer to a dedicated bearer token, ROTATION_TOKEN, never a user JWT.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { buildDump } = require('../lib/rotation-backup');
const { applyDump, onlySeedData, TABLE_ORDER } = require('../lib/db-restore');

const router = express.Router();

function rotationAuth(req, res, next) {
  const token = process.env.ROTATION_TOKEN;
  if (!token) return res.status(503).json({ error: 'rotation disabled: ROTATION_TOKEN is not set' });
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad rotation token' });
  next();
}

async function counts() {
  const out = {};
  for (const t of TABLE_ORDER) {
    try { out[t] = (await pool.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n; }
    catch (err) { if (err.code !== '42P01') throw err; } // table absent = a brand-new database
  }
  return out;
}

router.get('/api/rotation/status', rotationAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS now');
    res.json({ ok: true, now: rows[0].now, counts: await counts() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'status failed' });
  }
});

// the whole database, in the same shape lib/rotation-backup.js escrows and db-restore reads
router.get('/api/rotation/dump', rotationAuth, async (_req, res) => {
  try {
    res.json(await buildDump());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'dump failed' });
  }
});

// Fill an empty (or seed-only) database from a dump. Refuses one that already holds real
// accounts unless force=1 — a restore is for a freshly rotated instance, not a live one.
router.post('/api/rotation/restore', rotationAuth, async (req, res) => {
  const client = await pool.connect();
  let seedOnly;
  try { seedOnly = await onlySeedData(client); } finally { client.release(); }
  if (!seedOnly && req.query.force !== '1') {
    return res.status(409).json({ error: 'refusing to restore over a database with real data (pass ?force=1 to override)' });
  }
  try {
    const restored = await applyDump(pool, req.body);
    res.json({ ok: true, restored, counts: await counts() });
  } catch (err) {
    console.error(err);
    res.status(/recognizable dump/.test(err.message) ? 400 : 500).json({ error: 'restore failed', detail: err.message });
  }
});

module.exports = router;
