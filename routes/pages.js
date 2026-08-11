const express = require('express');
const path = require('path');
const { pool } = require('../lib/db');

const router = express.Router();

// pretty routes — /trip/:code gets Open Graph tags injected so WhatsApp/social previews
// show the trip cover, title and code
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
let tripHtmlCache = null;
router.get('/trip/:code', async (req, res) => {
  // cache the page only in production — in dev, re-read so edits show up without a restart
  if (!tripHtmlCache || process.env.NODE_ENV !== 'production') {
    tripHtmlCache = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'trip.html'), 'utf8');
  }
  let html = tripHtmlCache;
  try {
    const { rows } = await pool.query(
      'SELECT title, destination, description, cover_image, days, start_date, destinations, share_code, emoji, is_draft FROM trips WHERE share_code = $1',
      [req.params.code]
    );
    const t = rows[0];
    if (t) {
      const title = `${t.emoji || '🧭'} ${t.title} · TRIP MAKER`;
      const desc = `${t.destination} · ${t.days} ימים · קוד טיול ${t.share_code}` +
        (t.description ? ` — ${t.description.slice(0, 120)}` : '');
      if (t.is_draft) {
        // drafts aren't shared: no OG block (it would leak the not-yet-revealed code
        // to scrapers), just the plain title for the owner's browser tab
        html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
      } else {
        // absolute, self-describing URL: the share link is forwarded by people, not
        // crawled from a sitemap, so it has to name the host it was actually served from
        const origin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        const og = `
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="TRIP MAKER">
  <meta property="og:locale" content="he_IL">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  ${t.cover_image ? `<meta property="og:image" content="${escapeHtml(t.cover_image)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(t.destination)}">
  <meta name="twitter:image" content="${escapeHtml(t.cover_image)}">` : ''}
  <meta property="og:url" content="${escapeHtml(origin)}/trip/${escapeHtml(t.share_code)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="description" content="${escapeHtml(desc)}">`;
        // anchor on the tag shape, not on its text — a rebrand rewrote the title once
        // already, and a silent no-op here costs every WhatsApp preview the product has
        html = html
          .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>${og}`);
      }

      // trips longer than a week open in the calendar view — tell the page how many
      // days, which weekday day 1 falls on, and whether its cells carry an area
      // stripe, so the placeholder is the right shape before the trip is fetched
      if (t.days > 7) {
        const dow = t.start_date ? ` data-skl-dow="${new Date(t.start_date).getDay()}"` : '';
        const dests = Array.isArray(t.destinations) ? t.destinations.filter((d) => d && d.name) : [];
        const areas = dests.length > 1 ? ` data-skl-areas="${dests.length}"` : '';
        html = html.replace('<div id="days-container">', `<div id="days-container" data-skl-days="${t.days}"${dow}${areas}>`);
      }
    }
  } catch { /* serve the plain page on any error */ }
  res.type('html').send(html);
});
router.get('/plan', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'plan.html')));
router.get('/my', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'my.html')));
router.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

module.exports = router;
