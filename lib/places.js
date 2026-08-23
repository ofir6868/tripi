// Does a place_query name a real, findable place? Geocoded against Photon — the same
// keyless OSM search the app's place-picker uses — and matched by name. One definition,
// shared by the build pipeline (which repairs or drops what fails) and by
// tools/ai-eval/places-audit.js (which measures it), so the audit's numbers and the
// pipeline's behavior can never mean different things.
//
// verifyPlace(query) → { verdict, best, activityLike, genericName }
//   ok        a candidate carrying this name exists in the right area
//   mismatch  the area answered, but nothing there carries this name
//   none      no geocoder results for any query variant
//   skipped   network trouble — NOT evidence about the place; callers fail open
//
// "mismatch"/"none" are evidence of — not proof of — an invented place: a real hole-in-
// the-wall restaurant can be missing from OSM. The audit run of 2026-08-16 put the
// split at roughly half truly invented, a quarter activity-style non-places, a quarter
// real places the matcher missed.

// venue words that carry no identity: "Kyoto City Park" matching "some park in Kyoto"
// proves nothing, so these never count as the tokens that identify a place
const GENERIC = new Set([
  'temple', 'shrine', 'museum', 'market', 'park', 'garden', 'gardens', 'tower', 'hall',
  'palace', 'bridge', 'station', 'castle', 'center', 'centre', 'cultural', 'culture',
  'national', 'old', 'town', 'street', 'square', 'beach', 'bay', 'island', 'islands',
  'lake', 'mount', 'mountain', 'river', 'valley', 'falls', 'waterfall', 'gate', 'port',
  'harbor', 'harbour', 'cathedral', 'church', 'monastery', 'fort', 'fortress', 'grand',
  'observatory', 'aquarium', 'zoo', 'village', 'quarter', 'house', 'memorial', 'monument',
  'plaza', 'promenade', 'viewpoint', 'city', 'district', 'area', 'royal', 'big', 'little',
  // eatery/venue types: "Oshiyaga Sky Restaurant" must not verify off sky+restaurant
  // while the actual name token missed — the type words prove nothing about identity
  'restaurant', 'cafe', 'bar', 'bistro', 'grill', 'diner', 'tavern', 'taverna', 'pub',
  'hotel', 'hostel', 'resort', 'spa', 'club', 'lounge', 'bakery', 'brewery',
]);
// locality filler ("Chuo City", "Nara Prefecture") that shouldn't gate the area check
const CONTEXT_FILLER = new Set(['city', 'prefecture', 'province', 'district', 'ward', 'state']);
const COUNTRY_ALIAS = { usa: ['united', 'states'], us: ['united', 'states'], uk: ['united', 'kingdom'], uae: ['emirates'] };
// wording that describes an activity rather than a place — a report hint, not a verdict
const ACTIVITY_RE = /\b(tour|dinner|lunch|breakfast|shopping|walk|experience|show|cruise|class|tasting|transfer|free time|nightlife)\b/i;

// fold case, diacritics and hyphens so "Sensō-ji" ≈ "Sensoji" ≈ "Senso Ji"
const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’ʼ-]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);

const tokenIn = (t, candTokens, candJoined) =>
  candTokens.includes(t) ||
  (t.length >= 4 && candJoined.includes(t)) ||
  candTokens.some((c) => c.length >= 4 && t.includes(c));

// a name like "Wat Saket (Golden Mount)" or "MAXXI - National Museum of ..." is
// several names in a trenchcoat — match each alone before judging the place missing
function altNames(name) {
  const alts = [name];
  const paren = name.match(/^([^(]*)\(([^)]*)\)/);
  if (paren) alts.push(paren[1], paren[2]);
  alts.push(...name.split(/\s[-–—]\s/));
  return [...new Set(alts.map((a) => a.trim()).filter(Boolean))];
}

function parseQuery(q) {
  const parts = String(q).split(',').map((p) => p.trim()).filter(Boolean);
  const expand = (ts) => ts.flatMap((t) => (COUNTRY_ALIAS[t] ? [t, ...COUNTRY_ALIAS[t]] : [t]));
  const ctxParts = parts.slice(1).map((p) => toks(p).filter((t) => !CONTEXT_FILLER.has(t)));
  const contextTokens = expand(ctxParts.flat());
  // the context parts before the last name the specific place (city, neighborhood);
  // the last is usually the country — evidence so weak that "…, Tokyo, Japan" once
  // matched a same-name park in Osaka on "Japan" alone. Tracked separately so a
  // candidate matching the city can be preferred over one matching only the country.
  const innerTokens = ctxParts.length >= 2 ? expand(ctxParts.slice(0, -1).flat()) : [];
  const alts = altNames(parts[0] || '').map((name) => {
    const nameTokens = toks(name);
    return { nameTokens, distinctive: nameTokens.filter((t) => !GENERIC.has(t) && !contextTokens.includes(t)) };
  }).filter((a) => a.nameTokens.length);
  return { parts, contextTokens, innerTokens, alts };
}

function scoreCandidate(f, parsed) {
  const p = f.properties || {};
  if (!p.name) return null;
  const candTokens = toks(p.name);
  const candJoined = candTokens.join('');
  const locTokens = [p.country, p.state, p.city, p.district, p.county, p.locality].flatMap(toks);
  const contextOk = !parsed.contextTokens.length ||
    parsed.contextTokens.some((t) => tokenIn(t, locTokens, locTokens.join('')));
  // did the SPECIFIC part of the context (the city, not the country) also answer?
  const contextFull = !parsed.innerTokens.length ||
    parsed.innerTokens.some((t) => tokenIn(t, locTokens, locTokens.join('')));
  let score = 0, passing = false;
  for (const alt of parsed.alts) {
    // no distinctive words ("Tokyo Tower") → every name word must appear. With 1-2
    // distinctive words, all of them must — at two, letting one common word carry it
    // passed "Shuba Happy" on "Happy Owl Cafe". From three on, half is enough
    // ("Meiji" carries Meiji Jingu Main Shrine).
    const need = alt.distinctive.length ? alt.distinctive : alt.nameTokens;
    const hit = need.filter((t) => tokenIn(t, candTokens, candJoined)).length;
    const s = need.length ? hit / need.length : 0;
    if (s > score) score = s;
    if (need.length <= 2 || !alt.distinctive.length ? s === 1 : s >= 0.5) passing = true;
  }
  return {
    name: p.name,
    where: [p.city || p.district, p.country].filter(Boolean).join(', '),
    // the country this candidate actually sits in — what tells a Paris stop on a
    // Japan trip apart from a Tokyo one, since both are perfectly real places
    cc: p.countrycode ? String(p.countrycode).toLowerCase() : null,
    score,
    passing,
    contextOk,
    contextFull,
    lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
    lon: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
  };
}

// ---------- the HTTP side ----------
// One module-wide limiter across every concurrent build and audit: the public Photon
// instance is the scarce resource, not this server. Each slot is held a beat after the
// response so total throughput stays polite.
const MAX_IN_FLIGHT = 3;
const SLOT_COOLDOWN_MS = 200;
let inFlight = 0;
const waiters = [];
const acquire = () => {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return Promise.resolve(); }
  return new Promise((r) => waiters.push(r));
};
const release = () => setTimeout(() => {
  const next = waiters.shift();
  if (next) next(); else inFlight--;
}, SLOT_COOLDOWN_MS);

// null = network trouble (≠ an empty result, which is a real answer)
async function photonSearch(q, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  await acquire();
  try {
    const res = await fetch('https://photon.komoot.io/api/?limit=8&lang=en&q=' + encodeURIComponent(q), {
      signal: ctrl.signal,
      headers: { 'user-agent': 'tripmaker-places/1' },
    });
    if (!res.ok) return null;
    return (await res.json()).features || [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}

// a Photon outage must cost a build seconds, not minutes: a few all-variants-failed
// lookups in a row trip a breaker and everything inside the window comes back 'skipped'
const BREAKER_AFTER_FAILS = 3;
// 8s, not a minute: on 2026-08-19 Photon went quiet for about twenty minutes and every
// build inside that window shipped unverified and unpinned. A short breaker still
// spares a build the timeouts of a dead geocoder, but lets the retry below find it the
// moment it comes back instead of writing the whole trip off.
const BREAKER_MS = 8000;
let consecutiveFails = 0;
let breakerUntil = 0;

const cache = new Map(); // query → result; popular places repeat across trips
const CACHE_MAX = 5000;

async function verifyPlace(query, { timeoutMs = 4000 } = {}) {
  if (cache.has(query)) return cache.get(query);
  const parsed = parseQuery(query);
  const flags = {
    activityLike: ACTIVITY_RE.test(parsed.parts[0] || ''),
    genericName: !parsed.alts.some((a) => a.distinctive.length),
  };
  if (!parsed.alts.length) return { verdict: 'none', best: null, ...flags };
  if (Date.now() < breakerUntil) return { verdict: 'skipped', best: null, ...flags };

  // the full query first; then the bare name with just the city, then just the
  // country — Photon chokes on middle locality parts and on decorated names
  const name = parsed.parts[0];
  const short = altNames(name).find((a) => a !== name) || name;
  const variants = [...new Set([
    query,
    parsed.parts.length >= 3 ? `${short}, ${parsed.parts[1]}` : null,
    parsed.parts.length >= 2 ? `${short}, ${parsed.parts[parsed.parts.length - 1]}` : null,
  ].filter(Boolean))];

  let sawAnswer = false;
  let best = null;
  for (const v of variants) {
    const feats = await photonSearch(v, timeoutMs);
    if (feats === null) continue;
    sawAnswer = true;
    for (const f of feats) {
      const s = scoreCandidate(f, parsed);
      if (!s) continue;
      // a candidate in the named city beats one that matched only the country —
      // contextFull with inner tokens implies contextOk, so the tiers stay ordered
      const rank = (c) => (c.contextOk ? 2 : 0) + (c.contextFull ? 1 : 0);
      const better = !best || rank(s) > rank(best) ||
        (rank(s) === rank(best) && s.score > best.score);
      if (better) best = s;
    }
    // keep trying variants while only a country-level match answered: the shorter
    // queries are exactly where the right-city candidate tends to surface
    if (best && best.passing && best.contextOk && best.contextFull) break;
  }

  if (!sawAnswer) {
    if (++consecutiveFails >= BREAKER_AFTER_FAILS) breakerUntil = Date.now() + BREAKER_MS;
    return { verdict: 'skipped', best: null, ...flags }; // never cached — it says nothing about the place
  }
  consecutiveFails = 0;

  const out = {
    // the verdict judges existence, so country-level context still earns 'ok' — a
    // right-name-wrong-city candidate is a real place with a bad pin, and distance
    // (day spread, replacement circles) is the caller's check, not this one's
    verdict: best && best.passing && best.contextOk ? 'ok' : best ? 'mismatch' : 'none',
    // lat/lon are the matched candidate's — meaningful when the verdict is ok, and
    // free either way: the geocoder call already paid for them
    best: best ? { name: best.name, where: best.where, cc: best.cc, score: +best.score.toFixed(2), lat: best.lat, lon: best.lon } : null,
    ...flags,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(query, out);
  return out;
}

// verify many queries concurrently (the limiter above paces the actual HTTP)
async function verifyPlaces(queries, opts = {}) {
  const out = new Map();
  let done = 0;
  await Promise.all(queries.map(async (q) => {
    out.set(q, await verifyPlace(q, opts));
    done++;
    if (opts.onProgress) opts.onProgress(done, queries.length);
  }));
  return out;
}

module.exports = { verifyPlace, verifyPlaces };
