// "מה עושים עכשיו כאן?" — the in-trip screen (public/js/trip-nearby.js).
//
// A traveller standing somewhere on day 4 has two questions the itinerary does not
// answer: what is worth doing around here right now, and where do we eat. Both are a
// question about *places near a point*, and the source we trust for that is the one this
// codebase already pays for and already budgets: Google Places (New). It is the only
// source here that knows how good a place is — a rating and how many people gave it —
// and that is what "the most recommended" means. OSM knows a place exists; it does not
// know which of the forty cafés on the street people actually go back to.
//
// The rules are lib/api-budget.js's, unchanged:
//   · every answer is cached by a grid cell, not by the traveller's exact position, so
//     two people at the same square — or one person walking across it — share it;
//   · a monthly ceiling per SKU (lib/google-skus.js) is the real guarantee, and a spent
//     month — or a spent day on the console's own quota, which Google enforces with a 429
//     our meter then honours until midnight Pacific — answers 503, which the page shows
//     as "not available right now" with the navigation links still working;
//   · only the participants of the trip can ask (they are the ones travelling), and a
//     per-user limiter counts only the requests that reach Google.
//
// One call carries everything the card shows, details included — rating, hours, the
// short description, a few reviews — so opening a card's details fetches nothing. The
// photos are the exception, because they bill per picture: the page asks for each one
// through /api/nearby/photo only when it scrolls into view.
const express = require('express');
const crypto = require('crypto');
const { authRequired, JWT_SECRET } = require('../lib/auth');
const { tripWithEditAuth } = require('../lib/trips');
const { meter, cacheGet, cacheSet, once, TTL_DAYS: CACHE_CEILING_DAYS } = require('../lib/api-budget');
const { budget: photoBudget } = require('../lib/place-photos');
const { rateLimiter } = require('../lib/rate-limit');
const KINDS = require('../public/js/nearby-kinds');

const router = express.Router();
const KEY = () => process.env.GOOGLE_PLACES_API_KEY || '';

const nearbyBudget = meter('nearby_search');
const kosherBudget = meter('nearby_kosher');

// The scope names carry the field mask's shape: what is cached is what that mask bought,
// so a change to FIELDS or to shape() bumps the suffix (same rule as lib/places.js).
const SCOPE = 'nearby.v1';
const KOSHER_SCOPE = 'nearby_kosher.v1';
// Fourteen days, not the thirty the terms allow: a list of "what is good here" can wait
// a fortnight, but hours and a closed-for-renovation status are part of the card.
const TTL_DAYS = 14;

const FIELDS = [
  'id', 'displayName', 'primaryType', 'primaryTypeDisplayName', 'types', 'businessStatus',
  'rating', 'userRatingCount', 'priceLevel', 'location', 'shortFormattedAddress',
  'regularOpeningHours', 'utcOffsetMinutes', 'websiteUri', 'internationalPhoneNumber',
  'googleMapsUri', 'photos', 'editorialSummary', 'reviews',
];
const MASK = FIELDS.map((f) => 'places.' + f).join(',');

// What "things to do" are. Only long-standing Table A types: one unknown type and Google
// refuses the whole request.
const SIGHT_TYPES = ['tourist_attraction', 'museum', 'art_gallery', 'historical_landmark', 'park', 'national_park', 'zoo', 'aquarium', 'amusement_park'];

// The grid a request is answered on, per kind: how far a traveller walks before the
// answer should change. Sights are a few kilometres' question, lunch is a few streets'.
// The search is centred on the cell, so everyone in it gets the same — cacheable — list,
// and the page measures distances from where the traveller actually is.
const KIND = {
  sights: { cell: 0.02, radius: 4000 },
  food: { cell: 0.01, radius: 1500 },
  kosher: { cell: 0.03, radius: 10000, within: 25000 }, // kosher kitchens are sparse: wider, and a hard cut after
};

// Counts only the requests that reach Google — a traveller re-opening the screen in the
// same square is a cache hit and costs nothing. Thirty fresh squares in ten minutes is
// not someone walking.
const lookupLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 30, error: 'יותר מדי חיפושים — נסו שוב בעוד כמה דקות' });
const photoLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 150, error: 'יותר מדי תמונות' });

const PRICE = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
const isHebrew = (code) => /^(he|iw)\b/i.test(String(code || ''));

// "the most recommended" as a number: the rating, pulled toward an ordinary 4.0 until
// enough people have rated (a 5.0 from six reviews is not better than a 4.6 from six
// thousand), then a nudge for every review written in Hebrew among the ones Google picked
// — Google leads with reviews in the reader's language, so one showing up means
// Israelis actually went and bothered to write about it.
function score(p, prior) {
  const r = p.rating || 0;
  const n = p.count || 0;
  const bayes = n ? (n / (n + prior)) * r + (prior / (n + prior)) * 4.0 : 3.5;
  return +(bayes + 0.04 * Math.log10(n + 1) + 0.08 * Math.min(p.he, 3)).toFixed(4);
}

// Google's place → the card the page draws. Everything the details panel needs is here.
function shape(g, { fromKosherSearch = false } = {}) {
  const reviews = Array.isArray(g.reviews) ? g.reviews : [];
  const he = reviews.filter((r) => isHebrew((r.originalText || r.text || {}).languageCode)).length;
  const name = (g.displayName && g.displayName.text) || '';
  const summary = (g.editorialSummary && g.editorialSummary.text) || '';

  // kosher: the place's own words count at once; diners' words count once if Google
  // matched the place to "kosher" in the first place, twice otherwise
  let kosher = null;
  if (KINDS.mentionsKosher(name)) kosher = 'name';
  else if (KINDS.mentionsKosher(summary)) kosher = 'summary';
  else {
    const said = reviews.filter((r) => KINDS.mentionsKosher((r.text || {}).text) || KINDS.mentionsKosher((r.originalText || {}).text)).length;
    if (said >= (fromKosherSearch ? 1 : 2)) kosher = 'reviews';
  }

  const hours = g.regularOpeningHours || null;
  const photos = (Array.isArray(g.photos) ? g.photos : []).slice(0, 3).map((ph) => ({
    ref: ph.name,
    credit: ((ph.authorAttributions || [])[0] || {}).displayName || null,
  })).filter((ph) => ph.ref);

  return {
    id: g.id,
    name,
    type: (g.primaryTypeDisplayName && g.primaryTypeDisplayName.text) || '',
    ptype: g.primaryType || '',
    types: Array.isArray(g.types) ? g.types.slice(0, 12) : [],
    status: g.businessStatus || 'OPERATIONAL',
    rating: typeof g.rating === 'number' ? g.rating : null,
    count: g.userRatingCount || 0,
    price: g.priceLevel in PRICE ? PRICE[g.priceLevel] : null,
    lat: g.location ? g.location.latitude : null,
    lon: g.location ? g.location.longitude : null,
    address: g.shortFormattedAddress || '',
    summary,
    hours: hours ? { lines: hours.weekdayDescriptions || [], periods: hours.periods || [] } : null,
    utc: typeof g.utcOffsetMinutes === 'number' ? g.utcOffsetMinutes : null,
    website: g.websiteUri || null,
    phone: g.internationalPhoneNumber || null,
    maps: g.googleMapsUri || null,
    photos,
    he,
    reviews: reviews.slice(0, 3).map((r) => ({
      text: String((r.text || r.originalText || {}).text || '').slice(0, 420),
      rating: r.rating || null,
      when: r.relativePublishTimeDescription || '',
      he: isHebrew((r.originalText || r.text || {}).languageCode),
    })).filter((r) => r.text),
    kosher,
  };
}

// A photo link the page can put in an <img> (which carries no Bearer token): signed, so
// /api/nearby/photo only ever buys a picture this route handed out — not whatever photo
// name someone pastes into a loop.
const sign = (ref) => crypto.createHmac('sha256', JWT_SECRET).update('nearby-photo:' + ref).digest('base64url').slice(0, 22);
const photoUrl = (ref, w) => `/api/nearby/photo?r=${encodeURIComponent(ref)}&w=${w}&s=${sign(ref)}`;

const distM = (a, b, c, d) => {
  const R = 6371000, rad = Math.PI / 180;
  const x = Math.sin(((c - a) * rad) / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

async function postJson(budgetMeter, url, body, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await budgetMeter.fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': MASK },
      body: JSON.stringify(body),
    });
    if (!res) return { refused: true }; // the month (or today's pace) said no
    if (!res.ok) {
      console.error('nearby: google', res.status, (await res.text().catch(() => '')).slice(0, 240));
      return { failed: true };
    }
    return { places: (await res.json()).places || [] };
  } catch (err) {
    console.error('nearby: google', err.name === 'AbortError' ? 'timeout' : err.message);
    return { failed: true };
  } finally {
    clearTimeout(timer);
  }
}

// one kind, one cell → the shaped list, from the cache or from Google
async function lookup(kind, cuisine, clat, clon, userKey) {
  const k = KIND[kind];
  const scope = kind === 'kosher' ? KOSHER_SCOPE : SCOPE;
  const key = `${kind}|${cuisine || ''}|${clat.toFixed(3)},${clon.toFixed(3)}`;
  const hit = await cacheGet(scope, key, { ttlDays: TTL_DAYS });
  if (hit.hit) return { places: hit.value || [] };
  if (lookupLimit.blocked(userKey)) return { limited: true };

  return once(scope + key, async () => {
    const again = await cacheGet(scope, key, { ttlDays: TTL_DAYS });
    if (again.hit) return { places: again.value || [] };
    lookupLimit.hit(userKey);

    const center = { latitude: clat, longitude: clon };
    let out;
    if (kind === 'kosher') {
      out = await postJson(kosherBudget, 'https://places.googleapis.com/v1/places:searchText', {
        textQuery: 'kosher restaurant', languageCode: 'he', maxResultCount: 20,
        locationBias: { circle: { center, radius: k.radius } },
      });
    } else {
      const c = cuisine && KINDS.byKey.get(cuisine);
      const body = {
        includedTypes: kind === 'sights' ? SIGHT_TYPES : c ? c.types : ['restaurant'],
        maxResultCount: 20, rankPreference: 'POPULARITY', languageCode: 'he',
        locationRestriction: { circle: { center, radius: k.radius } },
      };
      // the general list is "where to eat well", and a chain counter is rarely the answer;
      // asking for burgers by name is the one place it might be
      if (kind === 'food' && !c) body.excludedPrimaryTypes = ['fast_food_restaurant'];
      out = await postJson(nearbyBudget, 'https://places.googleapis.com/v1/places:searchNearby', body);
    }
    if (!out.places) return out; // refused or failed: never cached, the next ask tries again

    let places = out.places
      .map((g) => shape(g, { fromKosherSearch: kind === 'kosher' }))
      .filter((p) => p.id && p.name && p.lat != null && p.status !== 'CLOSED_PERMANENTLY');
    if (kind === 'kosher') places = places.filter((p) => p.kosher && distM(clat, clon, p.lat, p.lon) <= k.within);
    // an empty list is a real answer about this square, and costs the same to ask for
    await cacheSet(scope, key, places);
    return { places };
  });
}

// When Google will not answer — the console's daily quota is spent (a 429 our meter
// then honours until midnight Pacific), the month is paced out, or Google failed — the
// screen used to go blank with "try tomorrow". On 2026-11-02 a traveller in Japan got
// exactly that three hours into Google's day, and Google's midnight is 17:00 there. What
// we already bought is still a good answer: this square's list even past the fortnight
// (Google's terms allow thirty days, the same ceiling the cache sweep keeps), else the
// list of a neighbouring square — the next cell over is a few streets away, well inside
// the radius each list was searched on. Nothing here reaches Google.
const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
async function fromCache(kind, cuisine, clat, clon) {
  const scope = kind === 'kosher' ? KOSHER_SCOPE : SCOPE;
  const cell = KIND[kind].cell;
  const keyAt = (a, o) => `${kind}|${cuisine || ''}|${a.toFixed(3)},${o.toFixed(3)}`;
  const hits = await Promise.all(RING.map(([dy, dx]) =>
    cacheGet(scope, keyAt(clat + dy * cell, clon + dx * cell), { ttlDays: CACHE_CEILING_DAYS })));
  const found = hits.find((h) => h.hit && Array.isArray(h.value) && h.value.length);
  return found ? found.value : null;
}

// GET ?kind=sights|food|kosher&lat=&lon=[&cuisine=burgers]
router.get('/api/trips/code/:code/nearby', authRequired, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const kind = String(req.query.kind || 'sights');
    if (!KIND[kind]) return res.status(400).json({ error: 'סוג לא מוכר' });
    const cuisine = kind === 'food' && req.query.cuisine ? String(req.query.cuisine) : null;
    if (cuisine && !KINDS.byKey.has(cuisine)) return res.status(400).json({ error: 'סוג אוכל לא מוכר' });
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return res.status(400).json({ error: 'מיקום לא תקין' });
    }
    if (!KEY()) return res.status(503).json({ error: 'ההמלצות באזור לא זמינות כרגע', reason: 'off' });

    const cell = KIND[kind].cell;
    const clat = Math.round(lat / cell) * cell;
    const clon = Math.round(lon / cell) * cell;
    let out = await lookup(kind, cuisine, clat, clon, 'u' + req.user.id);
    if (out.limited) return res.status(429).json({ error: 'יותר מדי חיפושים — נסו שוב בעוד כמה דקות' });
    let stale = false;
    if (out.refused || out.failed) {
      const kept = await fromCache(kind, cuisine, clat, clon);
      if (kept) { out = { places: kept }; stale = true; }
    }
    // `until` is when Google's gate opens again, so the page can say the hour in the
    // traveller's own clock — "tomorrow" was wrong for anyone east of California
    if (out.refused) {
      const until = (kind === 'kosher' ? kosherBudget : nearbyBudget).reopensAt();
      return res.status(503).json({ error: 'ההמלצות באזור לא זמינות כרגע', reason: 'budget', until: until.toISOString() });
    }
    // 503, not 502, for a Google that did not answer: Cloudflare sits in front of the site
    // and replaces an origin's 502 (and 504) with its own error page, so the message here
    // never reached the traveller — they saw "the server did not answer (502)" and a
    // retry button that bought another refusal (2026-11-01). A 503 passes through as is.
    if (out.failed) return res.status(503).json({ error: 'גוגל לא ענה — נסו שוב בעוד רגע', reason: 'failed' });

    const prior = kind === 'sights' ? 80 : 40;
    const places = out.places
      .map((p) => ({
        ...p,
        score: score(p, prior),
        photos: p.photos.map((ph) => ({ thumb: photoUrl(ph.ref, 400), large: photoUrl(ph.ref, 900), credit: ph.credit })),
      }))
      .sort((a, b) => b.score - a.score);
    res.json({ kind, cuisine, center: { lat: clat, lon: clon }, places, stale });
  } catch (err) {
    console.error('nearby failed', err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// GET ?r=<photo resource name>&w=400|900&s=<signature> → 302 to the hosted image.
// Bills as Place Details Photos — the same SKU, and so the same meter, as the
// recommendation cards' photos (lib/place-photos.js). A spent month is a 404 and the page
// draws its emoji tile instead.
router.get('/api/nearby/photo', async (req, res) => {
  const ref = String(req.query.r || '');
  const w = parseInt(req.query.w, 10) === 900 ? 900 : 400;
  const sig = String(req.query.s || '');
  if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(ref) || ref.length > 600) return res.status(400).end();
  const want = Buffer.from(sign(ref));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(403).end();
  if (!KEY()) return res.status(404).end();

  const key = `ref:${ref}@${w}`;
  const go = (url) => { res.set('Cache-Control', 'private, max-age=86400'); res.redirect(302, url); };
  try {
    const hit = await cacheGet('place_photo', key, { ttlDays: TTL_DAYS });
    if (hit.hit) return hit.value ? go(hit.value) : res.status(404).end();
    if (photoLimit.blocked(req.ip)) return res.status(429).end();

    const url = await once('nearby-photo' + key, async () => {
      const again = await cacheGet('place_photo', key, { ttlDays: TTL_DAYS });
      if (again.hit) return again.value;
      photoLimit.hit(req.ip);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await photoBudget.fetch(`https://places.googleapis.com/v1/${ref}/media?maxWidthPx=${w}&skipHttpRedirect=true`, {
          signal: ctrl.signal, headers: { 'X-Goog-Api-Key': KEY(), Accept: 'application/json' },
        });
        if (!r || !r.ok) return null; // spent, refused or stale name: not cached, never a verdict
        const data = await r.json();
        if (!data.photoUri) return null;
        await cacheSet('place_photo', key, data.photoUri);
        return data.photoUri;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    return url ? go(url) : res.status(404).end();
  } catch (err) {
    console.error('nearby photo failed', err.message);
    return res.status(404).end();
  }
});

module.exports = router;
// for tools/nearby-check.js: the reading of a Google answer, with no network behind it
module.exports.shape = shape;
module.exports.score = score;
module.exports.fromCache = fromCache;
module.exports.cellKey = (kind, cuisine, clat, clon) => `${kind}|${cuisine || ''}|${clat.toFixed(3)},${clon.toFixed(3)}`;
