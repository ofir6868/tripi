const express = require('express');
const { pool } = require('../lib/db');
const { isReady } = require('../lib/db-bootstrap');

const router = express.Router();

router.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, schema: isReady() });
  } catch {
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
