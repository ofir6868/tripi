// Hotels near coordinates, their cheapest offer, and their detail sheet. The
// sourcing, caching and provider fallback all live in lib/hotel-content.js —
// these routes only validate input and shape the reply, so switching providers
// (osm → liteapi → agoda …) never touches HTTP handling.
//
// Feeds the hotel-name autocomplete in the hotels modal (which reads name/stars)
// and the itinerary's night cards (photo, rating, distance, price, sheet).
// Fields the active provider can't supply come back null or absent.
const express = require('express');
const { searchNear, minPrices, hotelDetails } = require('../lib/hotel-content');

const router = express.Router();

const CURRENCY = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/api/hotels', async (req, res) => {
  // 3 decimals (~110m): stops on the same block still share a cache entry, but
  // the anchor stays honest. At 2 decimals the anchor drifted up to ~800m and
  // the nearest hotel to a day's last stop fell out of its own list.
  const lat = Math.round(parseFloat(req.query.lat) * 1000) / 1000;
  const lon = Math.round(parseFloat(req.query.lon) * 1000) / 1000;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'bad coords' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
  const radius = Math.min(Math.max(parseInt(req.query.radius, 10) || 7000, 1000), 20000);
  const country = typeof req.query.country === 'string' ? req.query.country.slice(0, 40) : null;

  // an empty list is a valid answer the modal already handles (it offers a
  // free search instead), so upstream trouble never becomes a 500 here
  res.json(await searchNear({ lat, lon, radius, limit, country }));
});

// Cheapest offer per hotel for one date range. Answers {} rather than an error
// when the provider can't price — the cards then simply carry no price line.
router.get('/api/hotels/prices', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const { checkin, checkout } = req.query;
  if (!ids.length || !ISO_DATE.test(checkin || '') || !ISO_DATE.test(checkout || '')) {
    return res.status(400).json({ error: 'ids, checkin and checkout are required' });
  }
  if (checkout <= checkin) return res.status(400).json({ error: 'checkout must follow checkin' });

  const currency = CURRENCY.test(req.query.currency || '') ? req.query.currency : 'ILS';
  const adults = Math.min(Math.max(parseInt(req.query.adults, 10) || 2, 1), 8);
  res.json(await minPrices({ ids, checkin, checkout, adults, currency }));
});

router.get('/api/hotels/detail', async (req, res) => {
  const id = String(req.query.id || '').slice(0, 64);
  if (!id) return res.status(400).json({ error: 'id is required' });
  const data = await hotelDetails(id);
  if (!data) return res.status(404).json({ error: 'no details for this hotel' });
  res.json(data);
});

module.exports = router;
