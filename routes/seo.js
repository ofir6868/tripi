const express = require('express');
const { pool } = require('../lib/db');
const seo = require('../lib/seo');
const legal = require('../lib/legal');
const { stampAssets } = require('../lib/asset-version');

// Crawlable marketing pages. Everything here is plain server-rendered HTML: the
// product's pages draw themselves in JavaScript, so these are the only URLs on the
// site where a crawler finds Hebrew text about destinations. See lib/seo.js.
const router = express.Router();

const DAY = 60 * 60 * 24;
// these pages are cached for a day, which makes stamping their asset URLs matter more
// than anywhere else: a day-old page must not ask for a day-old stylesheet
//
// Vercel-CDN-Cache-Control lets Vercel's own edge keep the page too, so a crawler walking
// the destination pages is answered there instead of waking a function — and, for
// /destinations/:slug, the database. Vercel drops that cache on every deploy, so a new
// commit's asset stamps are never served from an old copy.
const edge = (res) => res.set('Vercel-CDN-Cache-Control', `max-age=${DAY}`);
const send = (res, html) => edge(res).set('Cache-Control', `public, max-age=${DAY}`).type('html').send(stampAssets(html));

router.get('/sitemap.xml', (_req, res) => {
  edge(res).set('Cache-Control', `public, max-age=${DAY}`).type('application/xml').send(seo.renderSitemap());
});

router.get('/terms', (_req, res) => send(res, legal.renderTerms()));
router.get('/privacy', (_req, res) => send(res, legal.renderPrivacy()));
router.get('/accessibility', (_req, res) => send(res, legal.renderAccessibility()));
router.get('/credits', (_req, res) => send(res, legal.renderCredits()));

router.get('/destinations', (_req, res) => send(res, seo.renderHub()));

router.get('/destinations/:slug', async (req, res, next) => {
  const d = seo.BY_SLUG.get(req.params.slug);
  if (!d) return next();
  // public trips for this place give the page something a guide can't: real
  // itineraries. Best-effort — the page reads fine without the database.
  let trips = [];
  try {
    const { rows } = await pool.query(
      `SELECT title, destination, country, description, cover_image, days, share_code, emoji
       FROM trips WHERE is_public = true AND NOT is_draft AND (destination ILIKE $1 OR country ILIKE $1)
       ORDER BY likes DESC, id LIMIT 4`,
      [`%${d.dest}%`]
    );
    trips = rows;
  } catch { /* render without trips */ }
  send(res, seo.renderDestination(d, trips));
});

for (const a of [...Object.values(seo.AUDIENCES), seo.AI_PAGE]) {
  router.get(`/${a.slug}`, (_req, res) => send(res, seo.renderAudience(a)));
}

module.exports = router;
