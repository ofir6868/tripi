// A photo for a place. Google Places Photos first, when we hold a verified place_id and
// a key — real photos of the actual place — with Wikipedia's page image as the free,
// keyless fallback for everything else. Every result is cached by place (fetched once,
// ever), so the same spot is never paid for twice, and a monthly cap keeps Google usage
// inside its free allowance; past the cap it falls back to Wikipedia rather than bill.
//
// Google pricing note (2026): a request that asks for the `photos` field is billed at
// Google's "Enterprise + Atmosphere" tier — the most expensive one — with a free
// allowance of 1,000 such calls per month. PLACE_PHOTO_MONTHLY_LIMIT (default 900) keeps
// us just under it, so with the per-place cache the feature is effectively free. Raise it
// only with a billing budget in mind ($40 per 1,000 Place Details calls beyond the free
// tier, plus the Place Photo media fetch).
const CACHE_MAX = 5000;
const wikiCache = new Map();   // "lang:query" → { url, credit } | null
const googleCache = new Map(); // place_id → { url, credit } | null

function remember(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

const GKEY = () => process.env.GOOGLE_PLACES_API_KEY || '';
// stay inside Google's free "photos" allowance by default; overflow falls back to Wikipedia
const MONTHLY_LIMIT = Math.max(0, +(process.env.PLACE_PHOTO_MONTHLY_LIMIT || 900));
let capMonth = '';
let capUsed = 0;
function underCap() {
  const m = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (m !== capMonth) { capMonth = m; capUsed = 0; }
  return capUsed < MONTHLY_LIMIT;
}

async function fetchJson(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Google Places (New): place_id → the place's first photo, resolved to a hosted image URL.
// Two calls — Place Details for the photo reference, then Place Photo media for the URL —
// counted together as one metered lookup. Cached by place_id (including misses).
async function googlePhoto(placeId, { timeoutMs = 4000, width = 800 } = {}) {
  if (googleCache.has(placeId)) return googleCache.get(placeId);
  const headers = { 'X-Goog-Api-Key': GKEY(), Accept: 'application/json' };
  capUsed++; // count the attempt, not just successes — the Details call bills either way
  const details = await fetchJson(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=photos`, timeoutMs, headers
  );
  const photo = details && Array.isArray(details.photos) ? details.photos[0] : null;
  if (!photo || !photo.name) { remember(googleCache, placeId, null); return null; }
  const media = await fetchJson(
    `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=${width}&skipHttpRedirect=true`, timeoutMs, headers
  );
  const author = (photo.authorAttributions || [])[0];
  // Google's terms require showing the photographer's attribution alongside the image
  const out = media && media.photoUri
    ? { url: media.photoUri, credit: author && author.displayName ? `Google · ${author.displayName}` : 'Google' }
    : null;
  remember(googleCache, placeId, out);
  return out;
}

// Wikipedia's page image for the article its search ranks first — free and keyless.
async function wikiPhoto(query, { timeoutMs = 3500, lang = 'en', width = 900 } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const key = `${lang}:${q.toLowerCase()}`;
  if (wikiCache.has(key)) return wikiCache.get(key);
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*`
    + `&generator=search&gsrlimit=1&gsrnamespace=0&gsrsearch=${encodeURIComponent(q)}`
    + `&prop=pageimages&piprop=thumbnail&pithumbsize=${width}`;
  const data = await fetchJson(url, timeoutMs, { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; place photos)', Accept: 'application/json' });
  if (!data) return null; // never cached — a network blip says nothing about the place
  const page = data.query && Array.isArray(data.query.pages) ? data.query.pages[0] : null;
  const src = page && page.thumbnail && page.thumbnail.source;
  const out = src ? { url: src, credit: `ויקיפדיה · ${page.title}` } : null;
  remember(wikiCache, key, out);
  return out;
}

// { url, credit } or null. Prefer a real Google photo when we hold the place's verified
// id, a key is configured, and we're inside the monthly cap; otherwise Wikipedia.
async function placePhoto(query, { placeId = null, lang = 'en', width = 900, timeoutMs } = {}) {
  if (placeId && GKEY() && underCap()) {
    const g = await googlePhoto(placeId, { width, timeoutMs }).catch(() => null);
    if (g) return g;
  }
  return wikiPhoto(query, { lang, width, timeoutMs });
}

module.exports = { placePhoto, googlePhoto, wikiPhoto };
