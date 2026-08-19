// Hotel content for the trip's hotels view, behind one provider-agnostic seam.
//
// CONTENT ONLY — names, photos, guest ratings, indicative prices, review
// sentiment. No availability holds, no prebook/book, no payment. Nothing here
// can put us between a traveler and their reservation, and swapping providers
// can never break a real booking.
//
// A provider is an object of capabilities. Only `search` is required; a
// provider that can't price or can't describe simply omits those, and the UI
// renders without that part rather than erroring:
//
//   search(q)  → [ { id, name, address, lat, lon, photo, thumb,
//                    stars, rating, reviewCount, description, provider } ]
//   prices(q)  → { [id]: { amount, currency } }        // total for the range
//   details(q) → { id, name, address, stars, rating, reviewCount, images[],
//                  facilities[], checkin, checkout, pros[], cons[], categories[] }
//
// `distance` is added by this module, not by providers. Fields a provider
// can't supply are null, so changing provider changes how rich a card is,
// never whether the page works.
//
// The provider comes from HOTEL_CONTENT_PROVIDER (default 'osm'). One that is
// unconfigured, slow, or failing falls back to 'osm', which needs no key and is
// the only one guaranteed to answer: the hotel-name autocomplete predates hotel
// content by months and must never regress because a paid API had a bad day.
//
// Adding a provider is one entry in PROVIDERS:
//   agoda         Content API — images + descriptions, needs affiliate approval
//   travelpayouts per-brand data API, needs program approval
//   google        Places text search (IDs only) + Place Photos, needs billing
const path = require('path');
const fs = require('fs');

const TTL = 24 * 60 * 60 * 1000;          // hotel content barely moves
const PRICE_TTL = 3 * 60 * 60 * 1000;     // rates do — but not minute to minute
const DETAIL_TTL = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();
const priceCache = new Map();
const detailCache = new Map();

// Hebrew country name → ISO-3166 alpha-2, parsed out of the table the client
// already ships (public/js/countries.js) rather than copied: two lists would
// drift, and trips only ever store the Hebrew name ("יפן"), never a code.
const isoByHebrew = (() => {
  const map = new Map();
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'countries.js'), 'utf8');
    for (const m of src.matchAll(/\['([^']+)',\s*'([a-z]{2})'\]/g)) map.set(m[1], m[2].toUpperCase());
  } catch { /* no table — providers that need a country code just go without it */ }
  return map;
})();

const num = (v) => (Number.isFinite(+v) ? +v : null);
const LITEAPI_BASE = () => process.env.LITEAPI_BASE || 'https://api.liteapi.travel/v3.0';

function metersBetween(aLat, aLon, bLat, bLon) {
  if ([aLat, aLon, bLat, bLon].some((v) => !Number.isFinite(v))) return null;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

async function reqJson(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const liteKey = () => process.env.LITEAPI_KEY || null;
const liteHeaders = () => ({ 'X-API-Key': liteKey(), Accept: 'application/json' });
// our ids carry the provider so a cached trip can't mix sources: liteapi:lp3f05e
const bareId = (id) => String(id || '').replace(/^liteapi:/, '');

const PROVIDERS = {
  // Keyless baseline. Photon's reverse endpoint answers the "hotels within Nkm"
  // question in under a second; every public Overpass mirror times out from the
  // deployed host (measured 2026-08-19), which is why Overpass is only a local
  // fallback and why this provider never promises photos, prices or ratings.
  osm: {
    async search({ lat, lon, radius, limit }) {
      const km = Math.max(1, Math.round(radius / 1000));
      const json = await reqJson(
        `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&radius=${km}&limit=${Math.max(limit, 20)}&lang=en&osm_tag=tourism:hotel`,
        { headers: { 'user-agent': 'TRIPI trip planner/1.0', Accept: 'application/json' } },
        6000
      );
      return (json.features || []).map((f) => {
        const p = f.properties || {};
        const c = (f.geometry || {}).coordinates || [];
        return {
          id: p.osm_id != null ? `osm:${p.osm_id}` : null,
          name: p['name:he'] || p.name,
          address: [p.street, p.city].filter(Boolean).join(', ') || null,
          lat: num(c[1]), lon: num(c[0]),
          photo: null, thumb: null,
          stars: null, rating: null, reviewCount: null, description: null,
          provider: 'osm',
        };
      });
    },
  },

  // Last resort behind Photon. Unreachable from the deployed host (all three
  // public mirrors time out) but it answers locally and is the only OSM source
  // carrying star ratings, so it stays as the tail of the chain.
  overpass: {
    async search({ lat, lon, radius, limit }) {
      const query = `[out:json][timeout:25];node["tourism"="hotel"]["name"](around:${radius},${lat},${lon});out ${Math.max(limit * 4, 30)};`;
      for (const endpoint of [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
      ]) {
        try {
          const json = await reqJson(endpoint, {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'TRIPI trip planner/1.0 (github.com/tripmaker/tripmaker)',
              Accept: 'application/json',
            },
          }, 28000); // public mirrors regularly need 15-20s when they answer at all
          return (json.elements || []).map((el) => ({
            id: el.id != null ? `osm:${el.id}` : null,
            name: (el.tags || {})['name:he'] || (el.tags || {}).name,
            address: null,
            lat: num(el.lat ?? (el.center || {}).lat),
            lon: num(el.lon ?? (el.center || {}).lon),
            photo: null, thumb: null,
            stars: num((el.tags || {}).stars), rating: null, reviewCount: null, description: null,
            provider: 'overpass',
          }));
        } catch { /* next mirror */ }
      }
      return null;
    },
  },

  // LiteAPI (Nuitee). Sandbox keys need no credit card, allow 5 req/s, and
  // return real production content — verified 2026-08-20.
  liteapi: {
    async search({ lat, lon, radius, limit, country }) {
      if (!liteKey()) return null; // unconfigured, not broken — caller falls back

      const params = new URLSearchParams({
        latitude: String(lat), longitude: String(lon),
        radius: String(Math.max(radius, 1000)), // their floor
        limit: String(limit),
      });
      const cc = country && isoByHebrew.get(country);
      if (cc) params.set('countryCode', cc);

      const json = await reqJson(`${LITEAPI_BASE()}/data/hotels?${params}`, { headers: liteHeaders() }, 8000);
      return (json.data || []).map((h) => ({
        id: h.id != null ? `liteapi:${h.id}` : null,
        name: h.name,
        address: [h.address, h.city].filter(Boolean).join(', ') || null,
        lat: num(h.latitude), lon: num(h.longitude),
        photo: h.main_photo || null,
        thumb: h.thumbnail || h.main_photo || null,
        stars: num(h.stars), rating: num(h.rating), reviewCount: num(h.reviewCount),
        // their descriptions arrive as unspaced marketing copy
        // ("Luxurious AccommodationExquisite Dining") — not fit to print
        description: null,
        provider: 'liteapi',
      }));
    },

    // Cheapest offer per hotel for one date range. `price` from this endpoint is
    // the total for the range (measured: a 2-night range returns ~2x a 1-night
    // one), so the caller decides whether that reads as "per night".
    async prices({ ids, checkin, checkout, adults, currency, nationality }) {
      if (!liteKey() || !ids.length) return null;
      const json = await reqJson(`${LITEAPI_BASE()}/hotels/min-rates`, {
        method: 'POST',
        headers: { ...liteHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotelIds: ids.map(bareId),
          occupancies: [{ adults: Math.min(Math.max(adults || 2, 1), 8) }],
          checkin, checkout, currency, guestNationality: nationality,
          timeout: 10,
        }),
      }, 20000); // measured 5-7s against the sandbox; the cache absorbs it
      const out = {};
      for (const row of json.data || []) {
        if (row.hotelId == null || !Number.isFinite(+row.price)) continue;
        out[`liteapi:${row.hotelId}`] = { amount: +row.price, currency };
      }
      return out;
    },

    // Static detail plus what previous guests actually agreed on. Two calls,
    // both well under a second; the reviews one is allowed to fail on its own.
    async details({ id }) {
      if (!liteKey()) return null;
      const hid = bareId(id);
      const json = await reqJson(`${LITEAPI_BASE()}/data/hotel?hotelId=${encodeURIComponent(hid)}`,
        { headers: liteHeaders() }, 8000);
      const h = (json && (json.data || json)) || null;
      if (!h || !h.name) return null;

      let sentiment = null;
      try {
        const rev = await reqJson(
          `${LITEAPI_BASE()}/data/reviews?hotelId=${encodeURIComponent(hid)}&limit=1&getSentiment=true&timeout=6`,
          { headers: liteHeaders() }, 9000);
        sentiment = rev && rev.sentimentAnalysis;
      } catch { /* the sheet is worth showing without it */ }

      const times = h.checkinCheckoutTimes || {};
      return {
        id: `liteapi:${h.id}`,
        name: h.name,
        address: [h.address, h.city].filter(Boolean).join(', ') || null,
        stars: num(h.starRating) ?? num(h.stars),
        rating: num(h.rating),
        reviewCount: num(h.reviewCount),
        images: (h.hotelImages || []).map((im) => im && (im.url || im.urlHd)).filter(Boolean).slice(0, 8),
        facilities: (h.hotelFacilities || []).filter((f) => typeof f === 'string').slice(0, 12),
        checkin: times.checkin_start || null,
        checkout: times.checkout || null,
        pros: ((sentiment && sentiment.pros) || []).slice(0, 4),
        cons: ((sentiment && sentiment.cons) || []).slice(0, 3),
        categories: ((sentiment && sentiment.categories) || [])
          .filter((c) => c && c.name && Number.isFinite(+c.rating))
          .map((c) => ({ name: c.name, rating: +c.rating }))
          .slice(0, 5),
        provider: 'liteapi',
      };
    },
  },
};

const wantedName = () => (process.env.HOTEL_CONTENT_PROVIDER || 'osm').toLowerCase();

// Closest first: the whole reason to show hotels inside an itinerary is which
// ones sit near that day's stops, and it is the one ranking no OTA can compute.
function finish(rows, lat, lon, limit) {
  const seen = new Set();
  return rows
    .filter((h) => h && h.name && !seen.has(h.name) && seen.add(h.name))
    .map((h) => ({ ...h, distance: metersBetween(lat, lon, h.lat, h.lon) }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, limit);
}

// Hotels near a point, from the configured provider, with 'osm' as the floor.
// Never throws: an empty array is a valid answer the UI already handles.
async function searchNear({ lat, lon, radius = 7000, limit = 8, country = null } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  for (const name of [...new Set([wantedName(), 'osm', 'overpass'])]) {
    const provider = PROVIDERS[name];
    if (!provider || !provider.search) continue;

    const key = `${name}:${lat},${lon},${radius},${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.data;

    let rows = null;
    try {
      rows = await provider.search({ lat, lon, radius, limit, country });
    } catch { /* try the next link in the chain */ }
    if (!rows || !rows.length) continue;

    const data = finish(rows, lat, lon, limit);
    cache.set(key, { at: Date.now(), data });
    return data;
  }
  return [];
}

// Cheapest offer per hotel id for one date range. {} when the active provider
// can't price — the caller then renders cards with no price line at all.
async function minPrices({ ids = [], checkin, checkout, adults = 2, currency = 'ILS', nationality } = {}) {
  const provider = PROVIDERS[wantedName()];
  if (!provider || !provider.prices || !ids.length || !checkin || !checkout) return {};

  const nat = nationality || process.env.HOTEL_GUEST_NATIONALITY || 'IL'; // Israeli-first product
  const key = `${wantedName()}:${[...ids].sort().join(',')}:${checkin}:${checkout}:${adults}:${currency}:${nat}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL) return hit.data;

  let data = null;
  try {
    data = await provider.prices({ ids, checkin, checkout, adults, currency, nationality: nat });
  } catch { /* a night card without prices is still a useful night card */ }
  if (!data) return {};
  priceCache.set(key, { at: Date.now(), data });
  return data;
}

// Everything worth knowing before picking a bed. null when unsupported.
async function hotelDetails(id) {
  const provider = PROVIDERS[wantedName()];
  if (!provider || !provider.details || !id) return null;

  const key = `${wantedName()}:${id}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.data;

  let data = null;
  try {
    data = await provider.details({ id });
  } catch { /* the card already carries enough to choose by */ }
  if (!data) return null;
  detailCache.set(key, { at: Date.now(), data });
  return data;
}

// What the server would use right now — for the probe tool and diagnostics.
function activeProvider() {
  const requested = wantedName();
  const capabilities = (n) => Object.keys(PROVIDERS[n] || {});
  if (!PROVIDERS[requested]) {
    return { name: 'osm', requested, ready: true, capabilities: capabilities('osm'), note: 'unknown provider — using osm' };
  }
  if (requested === 'liteapi' && !liteKey()) {
    return { name: 'osm', requested, ready: false, capabilities: capabilities('osm'), note: 'LITEAPI_KEY missing — using osm' };
  }
  return { name: requested, requested, ready: true, capabilities: capabilities(requested), note: null };
}

module.exports = { searchNear, minPrices, hotelDetails, activeProvider, PROVIDERS };
