// A photo for a stop in the itinerary — only when we know it is a photo of that place.
//
// The rule that shapes everything below: a wrong photo is worse than no photo. The
// itinerary's whole credibility problem is places that look real and aren't, and a card
// showing a stranger's restaurant, or the Wikipedia article a fuzzy search happened to
// rank first, is that same problem wearing a picture. (Measured 2026-08-20 on real stops:
// loose Wikipedia matching paired a Hiroshima food market with the atomic bombing
// article.) So nothing here searches by name. Every source is reached through an
// identity the stop already carries, and a stop with no identity keeps its emoji tile.
//
// Two roads, free one first (PLAYBOOK §2):
//
//   OSM → Wikidata → Commons   A stop verified against the map carries its OSM element
//     (osm_type/osm_id, migration 25). The element's own `wikidata` tag names the exact
//     entity, and that entity's P18 is its representative image, chosen by people for
//     exactly that job. A `wikimedia_commons` tag naming a File is used the same way.
//     `brand:wikidata` is deliberately not: that is the chain's logo, not this branch.
//     Keyless and free; Commons asks for attribution, which travels with the answer.
//
//   Google                     A stop picked in the place picker carries a Google
//     place_id. Its photo is the paid road — lib/place-photos.js, budgeted on the same
//     meter as the recommendation cards (lib/google-skus.js), and cached per place so a
//     place the recs already bought costs nothing here.
//
// Every answer, including "nothing", is cached per place identity for 30 days, so a trip
// viewed a hundred times asks once.
const { cacheGet, cacheSet, once } = require('./api-budget');
const { googlePhoto } = require('./place-photos');

// ---- is this element really the stop? ----
// An OSM id on a stop means the verifier accepted the match, and the verifier is
// deliberately lenient: it asks "does a place by roughly this name exist here", which is
// the right question for a pin. A photo asks more. Measured 2026-09-16 on 71 stops of four
// real trips that had a photo: the chain was faithful every time, but the element was not
// always the stop — "traditional dinner" stored as Haneda Airport, a snooker game stored as
// the city of Hanoi, "The National Museum of Modern Art" matched to the one in Saitama,
// "Osaka Bay" to a Grand Prince hotel. On a pin those pass unseen; as a picture they are the
// first thing on the card. Three checks close that, before any picture is fetched:

// 1. A settlement is where a stop is, never what it is. Villages, quarters and islands stay:
//    those are real destinations ("Cat Cat Village", "Alfama").
const SETTLEMENT = new Set(['city', 'town', 'municipality', 'county', 'state', 'region', 'province', 'country', 'borough', 'suburb']);
// 2. Nobody's stop is the airport or the station — a travel leg is excluded upstream, so an
//    element like that on a stop is a placeholder the model reached for.
function wrongKind(tags) {
  if (tags.boundary === 'administrative' || SETTLEMENT.has(tags.place)) return 'settlement';
  if (tags.aeroway || tags.public_transport || ['station', 'halt'].includes(tags.railway)
    || ['bus_station', 'ferry_terminal'].includes(tags.amenity)) return 'transport';
  return null;
}

// 3. The names agree, both ways. Forward: the words that identify the stop's place are in
//    one of the element's names. Backward: that name adds no words of its own — "Saitama",
//    "Grand Prince Hotel", "Zoo" — which is what a neighbouring or same-type place looks like.
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’ʼ-]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);
// joining words and honorifics that vary between languages without changing the place
const FILLER = new Set(['the', 'of', 'and', 'at', 'in', 'on', 'de', 'di', 'da', 'do', 'du', 'des', 'del', 'della', 'degli', 'la', 'le', 'il', 'el', 'saint', 'san', 'santa', 'sankt', 'st']);
// type words: they cannot identify a place on their own, so the forward check does not
// lean on them — but the backward check still counts them, since "Ueno Zoo" is not "Ueno Park"
const TYPE = new Set(['temple', 'shrine', 'museum', 'market', 'markets', 'park', 'garden', 'gardens', 'tower', 'hall',
  'palace', 'bridge', 'castle', 'center', 'centre', 'national', 'old', 'town', 'street', 'square', 'beach', 'bay',
  'island', 'lake', 'river', 'church', 'cathedral', 'district', 'area', 'quarter', 'village', 'city', 'plaza', 'road']);

function namesAgree(placeQuery, names) {
  const parts = String(placeQuery || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || !names.length) return false;
  const context = new Set(parts.slice(1).flatMap(toks));
  const nameTokens = toks(parts[0]).filter((t) => !FILLER.has(t) && !context.has(t));
  if (!nameTokens.length) return false;
  const queryJoined = toks(parts.join(' ')).join('');
  const queryTokens = new Set(toks(parts.join(' ')));
  const distinct = nameTokens.filter((t) => !TYPE.has(t));

  return names.some((name) => {
    const ts = toks(name);
    const joined = ts.join('');
    const found = (t) => ts.includes(t) || (t.length >= 3 && joined.includes(t)) || ts.some((x) => x.length >= 4 && t.includes(x));
    const forward = distinct.length
      ? distinct.every(found) || distinct.some((t) => t.length >= 5 && found(t))
      : nameTokens.every(found);
    if (!forward) return false;
    const extra = ts.filter((t) => t.length > 2 && !FILLER.has(t) && !queryTokens.has(t) && !queryJoined.includes(t));
    return extra.length === 0;
  });
}

const SCOPE = 'stop_photo.v2'; // v1 answered without the checks above — never serve it
// Wikimedia and OSM are someone else's servers, and this file is now asked from two
// directions at once: the itinerary's own stops (routes/photos.js, which paced itself at
// four) and every recommendation card (routes/ai.js), where a six-day block of free-day
// picks can ask for eighteen places in one breath. So the pacing lives here instead of in
// one caller: four lookups in flight across the whole process, cache hits never queueing.
const CONCURRENCY = 4;
let running = 0;
const waiting = [];
function paced(fn) {
  if (running < CONCURRENCY) {
    running++;
    return fn().finally(release);
  }
  return new Promise((resolve, reject) => {
    waiting.push(() => fn().then(resolve, reject).finally(release));
  });
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}
const UA = { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; stop photos)', Accept: 'application/json' };
const THUMB = 320; // the tile is 64px; this covers a 3x screen and the sheet's header
const OSM_KIND = { n: 'node', w: 'way', r: 'relation', node: 'node', way: 'way', relation: 'relation' };

// { ok, data } — a failed request is never an answer about the place (never cached)
async function getJson(url, timeoutMs = 6000) {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, status: err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// File name → a thumbnail URL and the attribution Commons asks for. null = no such file
// (or not a picture); { error } = Commons did not answer, which says nothing.
async function commonsFile(fileName) {
  const title = `File:${String(fileName).replace(/^File:/i, '').trim()}`;
  const r = await getJson('https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + `&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=${THUMB}&titles=${encodeURIComponent(title)}`);
  if (!r.ok) return { error: r.status };
  const page = r.data && r.data.query && r.data.query.pages && r.data.query.pages[0];
  const info = page && !page.missing && page.imageinfo && page.imageinfo[0];
  if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime || '')) return null;
  const meta = info.extmetadata || {};
  const artist = stripHtml(meta.Artist && meta.Artist.value).slice(0, 80);
  const license = stripHtml(meta.LicenseShortName && meta.LicenseShortName.value);
  const url = info.thumburl || info.url;
  return {
    url,
    // the sheet shows it wide: Commons serves a fixed ladder of thumbnail widths, 960 is
    // on it, and a file smaller than that has no such thumb — the page falls back to `url`
    large: /\/\d+px-/.test(url) && (info.width || 0) > 960 ? url.replace(/\/\d+px-/, '/960px-') : url,
    credit: ['Wikimedia Commons', artist, license].filter(Boolean).join(' · '),
    link: info.descriptionurl || null,
    source: 'commons',
  };
}

// The element's tags: the two that can name a picture, the names it goes by, and whether
// it is the kind of thing a stop can be. { error } when OSM is quiet.
async function osmElement(osmType, osmId) {
  const type = OSM_KIND[String(osmType || '').toLowerCase()];
  if (!type || !/^\d+$/.test(String(osmId))) return null;
  const r = await getJson(`https://api.openstreetmap.org/api/0.6/${type}/${osmId}.json`);
  if (!r.ok) return { error: r.status };
  const el = r.data && Array.isArray(r.data.elements) ? r.data.elements[0] : null;
  const tags = (el && el.tags) || {};
  const names = ['name', 'name:en', 'int_name', 'alt_name', 'official_name', 'official_name:en', 'old_name']
    .flatMap((k) => String(tags[k] || '').split(';')).map((s) => s.trim()).filter(Boolean);
  return {
    wikidata: /^Q\d+$/.test(tags.wikidata || '') ? tags.wikidata : null,
    commons: tags.wikimedia_commons || null,
    names,
    wrongKind: wrongKind(tags),
  };
}

// Wikidata entity → its P18 image file name (or null) and its English label and aliases,
// in one request
async function wikidataEntity(qid) {
  const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|labels|aliases&languages=en&ids=${encodeURIComponent(qid)}`);
  if (!r.ok) return { error: r.status };
  const e = r.data && r.data.entities && r.data.entities[qid];
  if (!e || e.missing !== undefined) return { file: null, names: [] };
  const claims = (e.claims && e.claims.P18) || [];
  // a preferred-rank image first, if the entity marks one
  const best = claims.find((c) => c.rank === 'preferred') || claims.find((c) => c.rank !== 'deprecated');
  const v = best && best.mainsnak && best.mainsnak.datavalue && best.mainsnak.datavalue.value;
  const names = [e.labels && e.labels.en && e.labels.en.value, ...((e.aliases && e.aliases.en) || []).map((a) => a.value)].filter(Boolean);
  return { file: typeof v === 'string' ? v : null, names };
}

// OSM element + the stop's own place_query → { url, credit, link, source } | null | { error }
async function freePhoto(osmType, osmId, placeQuery) {
  const el = await osmElement(osmType, osmId);
  if (!el || el.error) return el;
  if (el.wrongKind) return null;
  let names = el.names;
  let file = null;
  if (el.wikidata) {
    const w = await wikidataEntity(el.wikidata);
    if (w.error) return w;
    names = names.concat(w.names);
    file = w.file;
  }
  // checked before any picture is fetched: a mismatched element costs one or two lookups
  if (!namesAgree(placeQuery, names)) return null;
  if (el.commons && /^File:/i.test(el.commons)) {
    const f = await commonsFile(el.commons);
    if (f) return f; // a Category: tag or a missing file falls through to Wikidata
  }
  return file ? commonsFile(file) : null;
}

// One stop → its photo or null. Never throws; a source that could not be reached is not
// remembered, so the next look asks again.
// `spend`: false asks only for what is free or already paid for — the OSM road in full,
// and Google's answer only when it is already in the cache. The backfill in
// routes/day-recs.js uses it; a photo nobody is waiting for must not buy anything.
async function stopPhoto({ osmType = null, osmId = null, googlePlaceId = null, placeQuery = null, spend = true } = {}) {
  // the verdict depends on the stop's own place_query as much as on the element, so both
  // are the key: two stops pinned to one element under different names are two questions
  const key = osmId
    ? `osm:${OSM_KIND[String(osmType || '').toLowerCase()] || osmType}/${osmId}|${norm(placeQuery)}`
    : (googlePlaceId ? `g:${googlePlaceId}` : null);
  if (!key) return null;
  const hit = await cacheGet(SCOPE, key);
  if (hit.hit) return hit.value;

  return once(SCOPE + key, () => paced(async () => {
    const again = await cacheGet(SCOPE, key);
    if (again.hit) return again.value;

    let unreachable = false;
    if (osmId && placeQuery) {
      const free = await freePhoto(osmType, osmId, placeQuery).catch(() => ({ error: 'exception' }));
      if (free && !free.error) { await cacheSet(SCOPE, key, free); return free; }
      if (free && free.error) unreachable = true;
    }
    // Google's road only for a stop with no OSM element: its place_id came from the picker
    // (the traveller chose it) or from a Google match that already passed the verifier's
    // name check — and an element we just judged not to be the stop must not get a picture
    // by the back door
    if (googlePlaceId && !osmId) {
      // the recs' own width, so a place they already bought is a cache hit, not a purchase
      const g = await googlePhoto(googlePlaceId, { width: 900, cachedOnly: !spend }).catch(() => null);
      if (g) {
        const out = { url: g.url, large: g.url, credit: g.credit, link: null, source: 'google' };
        await cacheSet(SCOPE, key, out);
        return out;
      }
      // null from Google is also "spent this month", or a lookup we declined to make —
      // not a fact about the place, so it is never written down as one
      unreachable = true;
    }
    if (!unreachable) await cacheSet(SCOPE, key, null);
    return null;
  }));
}

module.exports = { stopPhoto, _test: { freePhoto, commonsFile, wikidataEntity, osmElement, namesAgree, wrongKind } };
