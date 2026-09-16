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

const SCOPE = 'stop_photo';
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

// The element's tags — only the two that can name a picture. { error } when OSM is quiet.
async function osmPictureTags(osmType, osmId) {
  const type = OSM_KIND[String(osmType || '').toLowerCase()];
  if (!type || !/^\d+$/.test(String(osmId))) return null;
  const r = await getJson(`https://api.openstreetmap.org/api/0.6/${type}/${osmId}.json`);
  if (!r.ok) return { error: r.status };
  const el = r.data && Array.isArray(r.data.elements) ? r.data.elements[0] : null;
  const tags = (el && el.tags) || {};
  return { wikidata: /^Q\d+$/.test(tags.wikidata || '') ? tags.wikidata : null, commons: tags.wikimedia_commons || null };
}

// Wikidata entity → the file name of its P18 image, or null
async function wikidataImage(qid) {
  const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P18&entity=${encodeURIComponent(qid)}`);
  if (!r.ok) return { error: r.status };
  const claims = (r.data && r.data.claims && r.data.claims.P18) || [];
  // a preferred-rank image first, if the entity marks one
  const best = claims.find((c) => c.rank === 'preferred') || claims.find((c) => c.rank !== 'deprecated');
  const v = best && best.mainsnak && best.mainsnak.datavalue && best.mainsnak.datavalue.value;
  return typeof v === 'string' ? v : null;
}

// OSM element → { url, credit, link, source } | null | { error }
async function freePhoto(osmType, osmId) {
  const tags = await osmPictureTags(osmType, osmId);
  if (!tags || tags.error) return tags;
  if (tags.commons && /^File:/i.test(tags.commons)) {
    const f = await commonsFile(tags.commons);
    if (f) return f; // a Category: tag or a missing file falls through to Wikidata
  }
  if (!tags.wikidata) return null;
  const file = await wikidataImage(tags.wikidata);
  if (!file || file.error) return file;
  return commonsFile(file);
}

// One stop → its photo or null. Never throws; a source that could not be reached is not
// remembered, so the next look asks again.
async function stopPhoto({ osmType = null, osmId = null, googlePlaceId = null } = {}) {
  const key = osmId ? `osm:${OSM_KIND[String(osmType || '').toLowerCase()] || osmType}/${osmId}` : (googlePlaceId ? `g:${googlePlaceId}` : null);
  if (!key) return null;
  const hit = await cacheGet(SCOPE, key);
  if (hit.hit) return hit.value;

  return once(SCOPE + key, async () => {
    const again = await cacheGet(SCOPE, key);
    if (again.hit) return again.value;

    let unreachable = false;
    if (osmId) {
      const free = await freePhoto(osmType, osmId).catch(() => ({ error: 'exception' }));
      if (free && !free.error) { await cacheSet(SCOPE, key, free); return free; }
      if (free && free.error) unreachable = true;
    }
    if (googlePlaceId) {
      // the recs' own width, so a place they already bought is a cache hit, not a purchase
      const g = await googlePhoto(googlePlaceId, { width: 900 }).catch(() => null);
      if (g) {
        const out = { url: g.url, large: g.url, credit: g.credit, link: null, source: 'google' };
        await cacheSet(SCOPE, key, out);
        return out;
      }
      // null from Google is also "spent this month" — not a fact about the place
      unreachable = true;
    }
    if (!unreachable) await cacheSet(SCOPE, key, null);
    return null;
  });
}

module.exports = { stopPhoto, _test: { freePhoto, commonsFile, wikidataImage, osmPictureTags } };
