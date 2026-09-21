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
const { app, boot } = require('../server');

module.exports = async (req, res) => {
  // One cold start, one boot. `boot` is created when this module is first required and
  // resolves once the database is resolved and the schema is up; awaiting it here means
  // every request the instance serves waits for that work once, not once each. It never
  // rejects — a database that is down is logged and answered honestly by /api/health.
  await boot;
  app(req, res);
};
