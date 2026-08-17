#!/usr/bin/env node
// Measures how many places in AI-built trips actually exist, by geocoding every
// trip_items.place_query against Photon (keyless OSM search — the same source the
// app's own place-picker uses). This is the hallucinated-places yardstick: run it
// before and after prompt/pipeline changes to see if the rate moves.
//
//   node tools/ai-eval/places-audit.js                # all AI-built trips (id > 8)
//   node tools/ai-eval/places-audit.js --trips 41,81  # specific trips
//   node tools/ai-eval/places-audit.js --include-seeds
//
// Reads the DB via DATABASE_URL (SELECT only). Verdict per place:
//   ok        a candidate with a matching name in the right area
//   mismatch  the area returned results, but nothing carrying this name
//   none      the geocoder found nothing at all for any query variant
// "mismatch"/"none" mean *not found in OSM*, which is evidence of — not proof of —
// a hallucination: real-but-obscure venues (cafes, tour desks) can be missing from
// OSM too. The report prints every non-ok place so a human can pass judgment; the
// honest headline number is a range, not a point.

require('../../lib/env');
const fs = require('fs');
const path = require('path');
const { pool } = require('../../lib/db');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const INCLUDE_SEEDS = argv.includes('--include-seeds');
const TRIP_IDS = flag('trips') ? flag('trips').split(',').map(Number) : null;
// seeds are the hand-curated demo trips from db/setup.js — ids 1..8 by construction
const SEED_MAX_ID = 8;

// ---------- text machinery ----------
// place_query is "Name, District?, City, Country" in English. A candidate matches
// when the *distinctive* words of the name (not "temple"/"park"/the city itself)
// appear in the OSM name. Diacritics and hyphens are folded so "Sensō-ji" ≈ "Sensoji".
const GENERIC = new Set([
  'temple', 'shrine', 'museum', 'market', 'park', 'garden', 'gardens', 'tower', 'hall',
  'palace', 'bridge', 'station', 'castle', 'center', 'centre', 'cultural', 'culture',
  'national', 'old', 'town', 'street', 'square', 'beach', 'bay', 'island', 'islands',
  'lake', 'mount', 'mountain', 'river', 'valley', 'falls', 'waterfall', 'gate', 'port',
  'harbor', 'harbour', 'cathedral', 'church', 'monastery', 'fort', 'fortress', 'grand',
  'observatory', 'aquarium', 'zoo', 'village', 'quarter', 'house', 'memorial', 'monument',
  'plaza', 'promenade', 'viewpoint', 'city', 'district', 'area', 'royal', 'big', 'little',
]);
// filler that appears in the locality part of queries but carries no identity
const CONTEXT_FILLER = new Set(['city', 'prefecture', 'province', 'district', 'ward', 'state']);
const COUNTRY_ALIAS = { usa: ['united', 'states'], us: ['united', 'states'], uk: ['united', 'kingdom'], uae: ['emirates'] };
// wording that describes an activity rather than a place — shown as a hint in the report
const ACTIVITY_RE = /\b(tour|dinner|lunch|breakfast|shopping|walk|experience|show|cruise|class|tasting|transfer|free time)\b/i;

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

function parseQuery(q) {
  const parts = q.split(',').map((p) => p.trim()).filter(Boolean);
  const nameTokens = toks(parts[0]);
  let contextTokens = parts.slice(1).flatMap(toks).filter((t) => !CONTEXT_FILLER.has(t));
  contextTokens = contextTokens.flatMap((t) => COUNTRY_ALIAS[t] ? [t, ...COUNTRY_ALIAS[t]] : [t]);
  const distinctive = nameTokens.filter((t) => !GENERIC.has(t) && !contextTokens.includes(t));
  return { parts, nameTokens, contextTokens, distinctive };
}

function scoreCandidate(f, parsed) {
  const p = f.properties || {};
  if (!p.name) return null;
  const candTokens = toks(p.name);
  const candJoined = candTokens.join('');
  const locTokens = [p.country, p.state, p.city, p.district, p.county, p.locality].flatMap(toks);
  const contextOk = !parsed.contextTokens.length ||
    parsed.contextTokens.some((t) => tokenIn(t, locTokens, locTokens.join('')));
  // no distinctive words ("Tokyo Tower") → every name word must appear; otherwise half is enough
  const need = parsed.distinctive.length ? parsed.distinctive : parsed.nameTokens;
  const hit = need.filter((t) => tokenIn(t, candTokens, candJoined)).length;
  const score = need.length ? hit / need.length : 0;
  const passing = parsed.distinctive.length ? score >= 0.5 : score === 1;
  return { name: p.name, where: [p.city || p.district, p.country].filter(Boolean).join(', '), score, contextOk, passing };
}

// ---------- geocoding ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function photon(q) {
  const url = 'https://photon.komoot.io/api/?limit=8&lang=en&q=' + encodeURIComponent(q);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'tripi-places-audit/1' } });
      if (res.status === 429) { await sleep(3000); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).features || [];
    } catch (e) {
      if (attempt) throw e;
      await sleep(2000);
    }
  }
  return [];
}

const cache = new Map();
async function verify(q) {
  if (cache.has(q)) return cache.get(q);
  const parsed = parseQuery(q);
  // the full query first; if that finds nothing, "Name, Country" — Photon sometimes
  // chokes on the middle locality parts the model likes to add
  const variants = [q];
  if (parsed.parts.length >= 3) variants.push(`${parsed.parts[0]}, ${parsed.parts[parsed.parts.length - 1]}`);
  let sawAny = false;
  let best = null;
  for (const v of variants) {
    const feats = await photon(v);
    await sleep(150);
    if (feats.length) sawAny = true;
    for (const f of feats) {
      const s = scoreCandidate(f, parsed);
      if (!s) continue;
      const better = !best || (s.contextOk && !best.contextOk) ||
        (s.contextOk === best.contextOk && s.score > best.score);
      if (better) best = s;
    }
    if (best && best.passing && best.contextOk) break;
  }
  const verdict = best && best.passing && best.contextOk ? 'ok' : sawAny ? 'mismatch' : 'none';
  const out = {
    verdict,
    best: best ? { name: best.name, where: best.where, score: +best.score.toFixed(2) } : null,
    activityLike: ACTIVITY_RE.test(parsed.parts[0]),
    genericName: !parsed.distinctive.length,
  };
  cache.set(q, out);
  return out;
}

// ---------- main ----------
(async () => {
  const where = TRIP_IDS ? `t.id = ANY($1)` : INCLUDE_SEEDS ? 'TRUE' : `t.id > ${SEED_MAX_ID}`;
  const params = TRIP_IDS ? [TRIP_IDS] : [];
  const { rows } = await pool.query(
    `SELECT t.id AS trip_id, t.title AS trip_title, i.day_number, i.title, i.category, i.place_query
     FROM trips t JOIN trip_items i ON i.trip_id = t.id
     WHERE ${where} AND i.place_query IS NOT NULL AND i.place_query <> ''
     ORDER BY t.id, i.day_number, i.sort_order`, params);
  await pool.end();

  const unique = new Set(rows.map((r) => r.place_query));
  console.log(`\nplaces-audit · ${rows.length} stops in ${new Set(rows.map((r) => r.trip_id)).size} trips · ${unique.size} unique places to geocode\n`);

  const items = [];
  let done = 0;
  for (const r of rows) {
    const v = await verify(r.place_query);
    items.push({ ...r, ...v });
    if (++done % 50 === 0) console.log(`  …${done}/${rows.length}`);
  }

  // per-trip table
  const byTrip = new Map();
  for (const it of items) {
    const k = it.trip_id;
    if (!byTrip.has(k)) byTrip.set(k, { title: it.trip_title, ok: 0, mismatch: 0, none: 0 });
    byTrip.get(k)[it.verdict]++;
  }
  console.log('\nלפי טיול (ok / mismatch / none):');
  for (const [id, t] of byTrip) {
    const total = t.ok + t.mismatch + t.none;
    const bad = t.mismatch + t.none;
    console.log(`  #${id} ${t.title}  ·  ${total} תחנות  ·  ${t.ok} ✓  ${t.mismatch} ≈  ${t.none} ✗  (${Math.round((bad / total) * 100)}% חשודות)`);
  }

  // every non-ok place, the part a human actually reads
  const suspects = items.filter((it) => it.verdict !== 'ok');
  console.log(`\nחשודות (${suspects.length}):`);
  for (const s of suspects) {
    const hint = [s.activityLike && 'פעילות?', s.genericName && 'שם גנרי'].filter(Boolean).join(' ');
    const near = s.best ? `הכי קרוב: "${s.best.name}" (${s.best.where}, ${s.best.score})` : 'אין תוצאות בכלל';
    console.log(`  [${s.verdict === 'none' ? '✗' : '≈'}] #${s.trip_id} יום ${s.day_number} · ${s.title}`);
    console.log(`      "${s.place_query}" → ${near}${hint ? `  · ${hint}` : ''}`);
  }

  const ok = items.length - suspects.length;
  const none = items.filter((i) => i.verdict === 'none').length;
  console.log(`\nסה"כ: ${items.length} תחנות · ${ok} אומתו (${Math.round((ok / items.length) * 100)}%) · ` +
    `${suspects.length - none} mismatch · ${none} none`);
  console.log(`טווח ההזיה האמיתי הוא בין ה-none לבין כלל החשודות — OSM לא מכיר כל מסעדה אמיתית.`);

  const dir = path.join(__dirname, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `places-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2));
  console.log(`full output → ${path.relative(process.cwd(), file)}`);
})();
