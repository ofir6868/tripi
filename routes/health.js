const express = require('express');
const { pool } = require('../lib/db');
const { isReady } = require('../lib/db-bootstrap');

const router = express.Router();

// Two depths. Plain /api/health says the app is up and answers from the process alone:
// an uptime monitor ringing it every minute must not keep the database awake, because
// the free Neon plan bills compute for every five minutes after any query, and a
// minute-by-minute SELECT 1 was enough to keep it running around the clock.
// /api/health?db=1 is the honest database check — it boots the schema (api/index.js
// waits for that on this query) and runs a query — for a person asking, not a pinger.
router.get('/api/health', async (req, res) => {
  if (req.query.db !== '1') return res.json({ ok: true });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true, schema: isReady() });
  } catch {
    res.status(500).json({ ok: false, db: false });
  }
});

module.exports = router;
