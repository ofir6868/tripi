// The whole app behind one function.
//
// Vercel has no always-on process to hand a port to: it routes a request into a function,
// runs it, and freezes the instance until the next one. vercel.json sends *every* path
// here — pages, assets and API alike — so the Express app keeps answering exactly the
// routes it answered on Render, in the same order, with nothing serving files behind its
// back. (The tempting alternative, letting Vercel serve public/ statically and rewriting
// only the misses, quietly steals '/' and robots.txt from routes/pages.js and routes/seo.js:
// a static file always wins over a rewrite, so the home page would arrive unstamped and
// without its SEO markup.)
const fs = require('fs');
const path = require('path');
const { app, boot } = require('../server');

// What may skip the wait. A file in public/ and the pages routes/pages.js sends straight
// from disk never touch the database, so they must not stand in line behind it: before
// this, a cold instance held /plan and every one of its scripts until the schema check
// had answered, and on 2026-11-03 that was 8–10 s for a plain .js file. Listed once per
// instance from the files themselves, so a new asset needs no edit here.
const PUBLIC = path.join(__dirname, '..', 'public');
// Beside the files: the pages that are built from code alone (routes/seo.js, the legal
// pages, the admin shells) and the two API answers that need no table. Each of these
// used to start the database boot on a cold instance, which kept the free Neon compute
// awake for anyone — mostly crawlers and uptime checks — who asked for them.
const { AUDIENCES, AI_PAGE } = require('../lib/seo');
const NO_DB = new Set([
  '/', '/plan', '/my', '/admin', '/admin/google', '/admin/connectors',
  '/terms', '/privacy', '/accessibility', '/credits', '/destinations', '/sitemap.xml',
  ...[...Object.values(AUDIENCES), AI_PAGE].map((a) => `/${a.slug}`),
  '/api/analytics/config',
]);
(function walk(dir, prefix) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) walk(path.join(dir, ent.name), `${prefix}${ent.name}/`);
    else NO_DB.add(`${prefix}${ent.name}`);
  }
})(PUBLIC, '/');
// the HTML files themselves are served through routes/pages.js, never as files
for (const p of [...NO_DB]) if (p.endsWith('.html')) NO_DB.delete(p);

const needsDb = (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  const [p, q = ''] = (req.url || '/').split('?');
  // the health check answers from the process alone unless it is asked about the
  // database (?db=1) — see routes/health.js
  if (p === '/api/health') return /(^|&)db=1(&|$)/.test(q);
  return !NO_DB.has(p);
};

module.exports = async (req, res) => {
  // One cold start, one boot — and only once a request needs the database. boot() starts
  // the work on its first call and hands every later caller the same promise, so the
  // instance waits for it once, not once per request. It never rejects — a database that
  // is down is logged and answered honestly by /api/health?db=1.
  if (needsDb(req)) await boot();
  app(req, res);
};
