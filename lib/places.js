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

require('./env'); // the Google second opinion reads GOOGLE_PLACES_API_KEY — standalone runs (audit, tests) need it loaded too
const { monthlyMeter, cacheGet, cacheSet } = require('./api-budget');

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
// Photon's single-letter element kinds, and the long forms the OSM API wants back
const OSM_TYPES = { n: 'node', w: 'way', r: 'relation', node: 'node', way: 'way', relation: 'relation' };
// macau/macao: the trips write "Macau", Google's English addresses say "Macao" —
// without the alias every real Macau stop fails the context check (audit 2026-08-24)
const COUNTRY_ALIAS = { usa: ['united', 'states'], us: ['united', 'states'], uk: ['united', 'kingdom'], uae: ['emirates'], macau: ['macao'], macao: ['macau'] };
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

// containment must start at a word boundary: "senso" opens "Sensō-ji" and counts,
// but "keiji" buried mid-word in "Gankei-ji" is a different temple wearing a
// coincidental suffix — Google's fuzzy search surfaces exactly these
const atBoundary = (tokens, joined, t) => {
  let offset = 0;
  for (const tok of tokens) {
    if (joined.startsWith(t, offset)) return true;
    offset += tok.length;
  }
  return false;
};
const tokenIn = (t, candTokens, candJoined) =>
  candTokens.includes(t) ||
  (t.length >= 4 && atBoundary(candTokens, candJoined, t)) ||
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
    // two-letter tokens are articles and fillers ("Ta", "tou", "de") — counting them
    // as identity sinks real matches under their own decoration
    return { nameTokens, distinctive: nameTokens.filter((t) => t.length > 2 && !GENERIC.has(t) && !contextTokens.includes(t)) };
  }).filter((a) => a.nameTokens.length);
  return { parts, contextTokens, innerTokens, alts };
}

// the one name-matching rule, shared by the OSM scorer and the Google scorer so the
// two opinions can never mean different things by "this is that place"
function matchAlts(parsed, candTokens, candJoined) {
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
    // the canonical-core rule: registries answer a decorated query with the bare
    // name — "Jojoen" for "Yakiniku Jojoen", "Karamanlidika" for "Ta Karamanlidika
    // tou Fani". Every candidate token must appear INSIDE the queried name (exact,
    // or as a whole long substring of it — never the reverse, which once let
    // "HappyBridal" ride in on the "Happy" of "Shuba Happy"), anchored by a LONG
    // distinctive hit — a short anchor ("Sky") would wave through every same-type
    // venue in the city.
    const altJoined = alt.nameTokens.join('');
    const inName = (c) => alt.nameTokens.includes(c) || (c.length >= 4 && atBoundary(alt.nameTokens, altJoined, c));
    if (!passing && candTokens.length
      && need.some((t) => t.length >= 5 && tokenIn(t, candTokens, candJoined))
      && candTokens.every(inName)) {
      passing = true;
      if (s < 0.75) score = Math.max(score, 0.75); // a core match is a strong match
    }
  }
  return { score, passing };
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
  const { score, passing } = matchAlts(parsed, candTokens, candJoined);
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
    // Photon names the OSM element it matched, and that pair is the free key to
    // everything else OSM knows about the place — opening_hours above all
    // (lib/opening-hours.js). It costs nothing here: the geocoder call already paid
    // for it, exactly as the coordinates below it did.
    // Photon writes the element kind as a single letter ("N" / "W" / "R"); the OSM API
    // addresses it by the full word. Normalised here, at the one place it enters the
    // system, so nothing downstream has to know both spellings exist.
    osm_type: OSM_TYPES[String(p.osm_type || '').toLowerCase()] || null,
    osm_id: p.osm_id != null ? String(p.osm_id) : null,
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
  await acquire();
  // the timer starts only once a slot is held: it times the HTTP call, not the queue.
  // Started before acquire(), an audit-sized run aborts every query still waiting in
  // line — which is how the 2026-08-24 audit skipped 749/971 stops on a healthy Photon.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

// ---------- the second opinion ----------
// Google Places text search, consulted only after OSM failed to vouch for a place:
// the hole-in-the-wall eatery OSM has never heard of is exactly what Google knows
// best, and during a Photon outage it is the only witness left standing. The same
// name matcher judges Google's answer — Google fuzzy-matches as happily as Photon,
// and "Vanora, Chalkida" must not come back as some random Chalkida shop. Needs
// GOOGLE_PLACES_API_KEY; without it (or on any error, or when the quota runs dry)
// the answer is null and the OSM verdict stands. The field mask keeps the call in
// the cheapest tier that still returns a name to match and a country to check.
let google429s = 0;
// The rescue is the only part of verification that costs money — Photon is keyless and
// free — so it is the only part that is budgeted and remembered across deploys.
//
// The scope carries the field mask's shape: what is cached is what that mask bought, so
// changing the mask must not serve answers shaped by the old one. Bump the suffix with
// the mask, and with any change to scoreGooglePlace that would judge the same answer
// differently — a cache that outlives a matcher change is a cache that hides it.
const SEARCH_SCOPE = 'place_search.v1';
const searchBudget = monthlyMeter('place_search', 4000, 'PLACE_SEARCH_MONTHLY_LIMIT');

async function googleSearch(q, timeoutMs) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  // an answer we already hold, including a remembered "Google found nothing" — the
  // places that reach the rescue are exactly the ones that reach it again on the next
  // build, so this is where the repeat spending was
  const hit = await cacheGet(SEARCH_SCOPE, q);
  if (hit.hit) return hit.value;

  // budget before the limiter, so a spent month costs no waiting either. A refusal here
  // is indistinguishable to the caller from a missing key or an error: null, the OSM
  // verdict stands, and nothing about a place is decided by our billing.
  if (!(await searchBudget.claim())) return null;

  // same limiter as Photon: Google's per-minute quota is a scarce resource too, and
  // an unpaced rescue during a Photon outage fires every pending query at once —
  // the 2026-08-24 audit burned the quota exactly that way
  await acquire();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'en', maxResultCount: 5 }),
    });
    if (!res.ok) {
      // an exhausted quota is routine per call but news per run: silent 429s are how
      // an entire audit shipped without its second opinion and nothing said so
      if (res.status === 429) { if (google429s++ % 50 === 0) console.warn(`google places 429 — quota exhausted (×${google429s} this process)`); }
      else console.warn('google places', res.status, (await res.text().catch(() => '')).slice(0, 150));
      return null; // never cached: we were billed, but a 429 or a 500 is not an answer
    }
    const places = (await res.json()).places || [];
    // an empty array is a real answer — "Google looked and there is nothing" is the
    // evidence that hardens a 'skipped' verdict into 'mismatch', and it costs the same
    // to ask for as a full one, so it is worth remembering too
    await cacheSet(SEARCH_SCOPE, q, places);
    return places;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}

function scoreGooglePlace(p, parsed) {
  const name = p.displayName && p.displayName.text;
  if (!name) return null;
  const candTokens = toks(name);
  const locTokens = toks(p.formattedAddress || '');
  const locJoined = locTokens.join('');
  const country = (p.addressComponents || []).find((c) => (c.types || []).includes('country'));
  const { score, passing } = matchAlts(parsed, candTokens, candTokens.join(''));
  return {
    name,
    where: p.formattedAddress || '',
    cc: country && country.shortText ? String(country.shortText).toLowerCase() : null,
    score,
    passing,
    contextOk: !parsed.contextTokens.length || parsed.contextTokens.some((t) => tokenIn(t, locTokens, locJoined)),
    contextFull: !parsed.innerTokens.length || parsed.innerTokens.some((t) => tokenIn(t, locTokens, locJoined)),
    lat: p.location ? p.location.latitude : null,
    lon: p.location ? p.location.longitude : null,
    place_id: p.id || null,
  };
}

// null = Google never answered (no key / error / quota); otherwise { answered, best }
// with best only when a candidate passed the same name + context bar OSM answers face
async function googleRescue(query, parsed, timeoutMs) {
  const places = await googleSearch(query, Math.max(timeoutMs, 5000));
  if (places === null) return null;
  let best = null;
  const rank = (c) => (c.contextOk ? 2 : 0) + (c.contextFull ? 1 : 0);
  for (const p of places) {
    const s = scoreGooglePlace(p, parsed);
    if (!s) continue;
    if (!best || rank(s) > rank(best) || (rank(s) === rank(best) && s.score > best.score)) best = s;
  }
  const good = best && best.passing && best.contextOk;
  return {
    answered: true,
    best: good ? {
      name: best.name, where: best.where, cc: best.cc, score: +best.score.toFixed(2),
      lat: best.lat, lon: best.lon, place_id: best.place_id, source: 'google',
      osm_type: null, osm_id: null, // Google's answer carries no OSM identity
    } : null,
  };
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

// allowGoogle:false keeps a call on the keyless road — Photon decides, and the paid
// second opinion is never consulted. The backfill (lib/osm-backfill.js) runs that way:
// it wants the OSM element id and nothing else, and Google's answer carries none, so
// paying for it would buy a thousand lookups of something it cannot supply.
async function verifyPlace(query, { timeoutMs = 4000, allowGoogle = true } = {}) {
  // a Photon-only verdict is not the same answer as a full one, so it must not be
  // served from — or written into — the cache the full path shares
  if (allowGoogle && cache.has(query)) return cache.get(query);
  const parsed = parseQuery(query);
  const flags = {
    activityLike: ACTIVITY_RE.test(parsed.parts[0] || ''),
    genericName: !parsed.alts.some((a) => a.distinctive.length),
  };
  if (!parsed.alts.length) return { verdict: 'none', best: null, ...flags };

  let sawAnswer = false;
  let best = null;
  // an open breaker skips the Photon pass, not the whole verdict — Google below
  // still gets its say, which is what keeps builds verified through an OSM outage
  if (Date.now() >= breakerUntil) {
    // the full query first; then the bare name with just the city, then just the
    // country — Photon chokes on middle locality parts and on decorated names
    const name = parsed.parts[0];
    const short = altNames(name).find((a) => a !== name) || name;
    const variants = [...new Set([
      query,
      parsed.parts.length >= 3 ? `${short}, ${parsed.parts[1]}` : null,
      parsed.parts.length >= 2 ? `${short}, ${parsed.parts[parsed.parts.length - 1]}` : null,
    ].filter(Boolean))];

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
    if (sawAnswer) consecutiveFails = 0;
    else if (++consecutiveFails >= BREAKER_AFTER_FAILS) breakerUntil = Date.now() + BREAKER_MS;
  }

  // the verdict judges existence, so country-level context still earns 'ok' — a
  // right-name-wrong-city candidate is a real place with a bad pin, and distance
  // (day spread, replacement circles) is the caller's check, not this one's
  let verdict = best && best.passing && best.contextOk ? 'ok' : best ? 'mismatch' : sawAnswer ? 'none' : 'skipped';
  // lat/lon are the matched candidate's — meaningful when the verdict is ok, and
  // free either way: the geocoder call already paid for them
  let chosen = best ? {
    name: best.name, where: best.where, cc: best.cc, score: +best.score.toFixed(2),
    lat: best.lat, lon: best.lon, place_id: null,
    osm_type: best.osm_type || null, osm_id: best.osm_id || null,
  } : null;

  // OSM wouldn't vouch — Google gets the second opinion. A pass upgrades to 'ok'
  // (with the place_id that makes maps links deterministic); a Google that answered
  // and found nothing during an OSM outage is real evidence, so 'skipped' hardens to
  // 'mismatch' instead of failing open.
  if (verdict !== 'ok' && allowGoogle) {
    const g = await googleRescue(query, parsed, timeoutMs);
    if (g && g.best) {
      verdict = 'ok';
      chosen = g.best;
    } else if (g && verdict === 'skipped') {
      verdict = 'mismatch';
    }
  }

  const out = { verdict, best: chosen, ...flags };
  if (!allowGoogle) return out; // a half-answer never enters the shared cache
  if (verdict === 'skipped') return out; // never cached — it says nothing about the place
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
