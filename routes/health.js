const express = require('express');
const dns = require('dns').promises;
const { pool } = require('../lib/db');

const router = express.Router();

router.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// TEMPORARY (2026-08-19): the keyless OSM services answer a laptop and not the
// deployed service, and every caller swallows the reason. This reports it — DNS
// answers, status codes, and the undici cause chain — plus the egress IP the
// blocklist would be keyed on. Gated by a fixed token so it isn't a free outbound
// fetch for anyone who finds it. Delete once the cause is known.
const PROBE_TOKEN = 'osm-egress-2026-08-19';
const TARGETS = {
  photon: 'https://photon.komoot.io/api/?q=eilat&limit=1',
  overpass: 'https://overpass-api.de/api/status',
  openMeteo: 'https://geocoding-api.open-meteo.com/v1/search?name=eilat&count=1',
  ipify: 'https://api.ipify.org/?format=json',
};

const describe = (err) => {
  const chain = [];
  for (let e = err; e; e = e.cause) chain.push(`${e.name || ''}: ${e.message || e}${e.code ? ' [' + e.code + ']' : ''}`);
  return chain.join(' <- ');
};

router.get('/api/health/net', async (req, res) => {
  if (req.query.probe !== PROBE_TOKEN) return res.status(404).json({ error: 'not found' });
  const out = {};
  for (const [name, url] of Object.entries(TARGETS)) {
    const host = new URL(url).hostname;
    const at = Date.now();
    const entry = {};
    try {
      entry.dns = {
        A: (await dns.resolve4(host).catch((e) => e.code)),
        AAAA: (await dns.resolve6(host).catch((e) => e.code)),
      };
    } catch (e) { entry.dns = describe(e); }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'tripi-places/1' } });
      clearTimeout(timer);
      entry.status = r.status;
      entry.server = r.headers.get('server');
      entry.retryAfter = r.headers.get('retry-after');
      entry.body = (await r.text()).slice(0, 200);
    } catch (e) {
      entry.error = describe(e);
    }
    entry.ms = Date.now() - at;
    out[name] = entry;
  }
  res.json({ node: process.version, out });
});

module.exports = router;
