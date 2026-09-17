// A photo for a place from Google Places Photos, when we hold a verified place_id and a
// key — a real photo of the actual place. Every result is cached by place, so the same
// spot is never paid for twice, and a monthly cap keeps Google usage inside its free
// allowance; past the cap this answers null and the caller does without.
//
// There used to be a second road out of here: placePhoto(), which fell back to searching
// Wikipedia BY NAME for anything with no place_id. It is gone. Loose name matching is how
// a Hiroshima food market came to be illustrated with the atomic bombing, which is the
// whole reason lib/stop-photos.js reaches a picture only through an identity the place
// already carries — and both the itinerary's stops and the recommendation cards now go
// through that one file. (The fallback had also been broken since it was written: its
// arguments were passed to fetchJson in the wrong order, so every call threw and every
// answer was null. A road nobody can walk is not a fallback — PLAYBOOK §2.)
//
// What bills (lib/google-skus.js): a photo is two requests. The first, Place Details with
// `fields=photos`, only names the photo — it sits in the "Essentials (IDs Only)" SKU,
// which is free without limit. The second, the photo media request, is the billed one:
// "Place Details Photos", 1,000 free a month, $7 per 1,000 after. So the budget is claimed
// on the second request, and the first is counted on its own meter purely so the GetPlace
// quota on the admin page adds up. This file used to claim on the first — which charged a
// place with no photo at all against the month, and left the billed request uncounted.
//
// "Cached by place" and "a monthly cap" both used to mean a `Map` and a `let` in this
// file, and on the free Render instance neither survived a deploy: the cap counted back
// from zero and every place was bought again. Both now live in Postgres
// (lib/api-budget.js). The ordering that makes that worth anything is cache first, claim
// second — a place we already hold must never spend a unit of the month's budget.
const { meter, cacheGet, cacheSet, once } = require('./api-budget');

const SCOPE = 'place_photo';
const REF_SCOPE = 'place_photo_ref';
const GKEY = () => process.env.GOOGLE_PLACES_API_KEY || '';
const budget = meter('place_photo'); // the billed media request
const refMeter = meter('place_photo_ref'); // the free lookup that names the photo

// { ok, data } rather than data-or-null, because the two failures mean opposite things
// once the cache outlives the process: Google answering "this place has no photos" is
// worth remembering for 30 days, while a timeout or a 500 says nothing about the place
// and must never be written down as if it did. (Same rule as a `skipped` verdict in
// lib/places.js — a network blip is not evidence.) `refused` is the budget saying no.
async function fetchJson(doFetch, url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, headers });
    if (!res) return { ok: false, refused: true, data: null };
    if (!res.ok) return { ok: false, data: null };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// Which photo Google holds for a place — its resource name and author, or null when it
// has none. Free to ask, but it still spends GetPlace quota, so the answer is kept: a
// month whose photo budget is spent must not ask again on every card that wants one.
async function photoRef(placeId, timeoutMs, headers) {
  const hit = await cacheGet(REF_SCOPE, placeId);
  if (hit.hit) return { ok: true, ref: hit.value };
  const details = await fetchJson(refMeter.fetch, `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=photos`, timeoutMs, headers);
  if (!details.ok) return { ok: false };
  const photo = details.data && Array.isArray(details.data.photos) ? details.data.photos[0] : null;
  const author = photo && (photo.authorAttributions || [])[0];
  const ref = photo && photo.name ? { name: photo.name, author: author && author.displayName ? author.displayName : null } : null;
  await cacheSet(REF_SCOPE, placeId, ref);
  return { ok: true, ref };
}

// Google Places (New): place_id → the place's first photo, resolved to a hosted image URL.
async function googlePhoto(placeId, { timeoutMs = 4000, width = 800 } = {}) {
  if (!placeId || !GKEY()) return null;
  // the width is part of the key because it is part of what was bought — a cached 900px
  // URL is not the answer to a request for a different size
  const key = `${placeId}@${width}`;

  const hit = await cacheGet(SCOPE, key);
  if (hit.hit) return hit.value;

  // one lookup per place even when a whole page of cards names it at once
  return once(SCOPE + key, async () => {
    const again = await cacheGet(SCOPE, key);
    if (again.hit) return again.value;

    const headers = { 'X-Goog-Api-Key': GKEY(), Accept: 'application/json' };
    const found = await photoRef(placeId, timeoutMs, headers);
    if (!found.ok) return null; // never cached — a blip is not a verdict about the place
    if (!found.ref) { await cacheSet(SCOPE, key, null); return null; } // Google has no photo: free, and remembered

    const media = await fetchJson(budget.fetch,
      `https://places.googleapis.com/v1/${found.ref.name}/media?maxWidthPx=${width}&skipHttpRedirect=true`, timeoutMs, headers
    );
    // spent, refused or a blip: nothing cached, so the next month (or the next try) asks again
    if (!media.ok) return null;

    // Google's terms require showing the photographer's attribution alongside the image
    const out = media.data && media.data.photoUri
      ? { url: media.data.photoUri, credit: found.ref.author ? `Google · ${found.ref.author}` : 'Google' }
      : null;
    await cacheSet(SCOPE, key, out);
    return out;
  });
}

module.exports = { googlePhoto, budget };
