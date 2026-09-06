// A photo for a place, free and keyless: Wikipedia's page image for the article its
// search ranks first. Good for landmarks, museums, parks and neighbourhoods; a small
// restaurant usually has no article, and then there is honestly no photo — the client
// falls back to the destination's own picture. A miss is cached like a hit, and any
// network trouble answers null in time: a photo is never worth holding the reply for.
const CACHE_MAX = 2000;
const cache = new Map();

function remember(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; place photos)', Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// { url, credit } or null. `query` is the place as the geocoder knows it ("Colosseum,
// Rome, Italy"); the language of the wiki is the language of the query.
async function placePhoto(query, { timeoutMs = 3500, lang = 'en', width = 900 } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const key = `${lang}:${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*`
    + `&generator=search&gsrlimit=1&gsrnamespace=0&gsrsearch=${encodeURIComponent(q)}`
    + `&prop=pageimages&piprop=thumbnail&pithumbsize=${width}`;
  const data = await fetchJson(url, timeoutMs);
  if (!data) return null; // never cached — says nothing about the place
  const page = data.query && Array.isArray(data.query.pages) ? data.query.pages[0] : null;
  const src = page && page.thumbnail && page.thumbnail.source;
  const out = src ? { url: src, credit: `ויקיפדיה · ${page.title}` } : null;
  remember(key, out);
  return out;
}

module.exports = { placePhoto };
