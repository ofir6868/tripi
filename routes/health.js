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
  overpassKumi: 'https://overpass.kumi.systems/api/status',
  overpassCoffee: 'https://overpass.private.coffee/api/status',
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

// the same question one level up: what does the verifier itself make of a query the
// laptop resolves? Raw Photon answer (the exact URL lib/places builds) beside the
// verdict, so a network problem and a scoring problem can't be mistaken for each other
router.get('/api/health/geocode', async (req, res) => {
  if (req.query.probe !== PROBE_TOKEN) return res.status(404).json({ error: 'not found' });
  const q = String(req.query.q || 'Dekel Beach, Eilat, Israel').slice(0, 120);
  const out = { q };
  const at = Date.now();
  try {
    const r = await fetch('https://photon.komoot.io/api/?limit=8&lang=en&q=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'tripi-places/1' },
    });
    out.raw = { status: r.status, ms: Date.now() - at };
    const j = await r.json().catch(() => null);
    out.raw.features = (j && j.features || []).slice(0, 3).map((f) => ({
      name: f.properties && f.properties.name,
      city: f.properties && (f.properties.city || f.properties.county),
      country: f.properties && f.properties.country,
      coords: f.geometry && f.geometry.coordinates,
    }));
  } catch (e) { out.raw = { error: describe(e), ms: Date.now() - at }; }
  const at2 = Date.now();
  try {
    out.verify = await require('../lib/places').verifyPlace(q);
    out.verify.ms = Date.now() - at2;
  } catch (e) { out.verify = { error: describe(e) }; }
  res.json(out);
});

module.exports = router;
