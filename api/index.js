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
const NO_DB = new Set(['/', '/plan', '/my']);
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
  const p = (req.url || '/').split('?')[0];
  return !NO_DB.has(p);
};

module.exports = async (req, res) => {
  // One cold start, one boot. `boot` is created when this module is first required and
  // resolves once the database is resolved and the schema is up; awaiting it here means
  // every request the instance serves waits for that work once, not once each. It never
  // rejects — a database that is down is logged and answered honestly by /api/health.
  if (needsDb(req)) await boot;
  app(req, res);
};
