// המלצות ליום פנוי — the AI's picks for a day that has no stops yet.
//
// A free day in the itinerary used to be a line of placeholder text and a hotel rail.
// Now it shows three places the AI would put there — morning, midday, evening — as
// wide, short rows the traveller drops into the day with one tap, plus a button that
// swaps them for three others. The picks live in trip_day_recs (one row per free day),
// so every participant sees the same three and a reload doesn't cost a model call.
//
// How a pass is shaped, and why
// -----------------------------
// A 30-day trip broke the first shape of this file. It asked for every free day at
// once — chunks of six days, three chunks in flight — and wrote nothing until the last
// chunk came back. The page watched a skeleton for two and a half minutes, ran out of
// polls, and the day never filled. A request that answers only when thirty days are
// ready is a request nobody sees answer.
//
// So a pass now, in this order:
//  1. settles WHERE each stretch of days is — the area plan (areaPlan below);
//  2. asks for picks one area at a time, earliest day first, at most DAYS_PER_CALL
//     days per call: small prompts, and the first days of the trip arrive first;
//  3. writes each day's row the moment its own call lands, so the page fills in
//     progressively instead of all at once at the end;
//  4. keeps every day whose surroundings did not change (dayContext) — a stop added on
//     day 3 of a 30-day trip costs a couple of calls, not thirty.
// The refresh route answers as soon as the pass is under way; the page reads the
// snapshot and watches it fill. Only "המלצות אחרות" for one day still answers with
// the finished picks — it is one call, and the traveller is waiting on that button.
//
// When a pass runs:
// - right after an AI build, started behind the loading screen (trip-plan.js calls
//   `prepare`, which waits for the first days and lets the rest stream in);
// - on the itinerary for any free day that has nothing yet (a manual trip, a day that
//   was just emptied, a generation the server died in);
// - after any change to the trip — from the chats or by hand — because the picks are
//   chosen around the stops of the neighbouring days;
// - one day at a time from the "המלצות אחרות" button, which asks for places the day
//   hasn't been offered before.
//
// The model is the strong one — the cards name real places, and the weak tier invents
// them (PLAYBOOK §3) — and every card goes through the same verifyRecCards the
// recommendations chat uses: a place the geocoder can't confirm never reaches a day.
// A token per pass guards the writes: a pass that lands while a newer one is running
// finds its token retired and drops its results.
const express = require('express');
const { randomUUID, createHash } = require('crypto');
const { pool } = require('../lib/db');
const { authRequired, authOptional } = require('../lib/auth');
const { tripWithEditAuth, cleanPlanState, areasCoverTrip } = require('../lib/trips');
const { dailyQuota, exhausted } = require('../lib/quota');
const ai = require('./ai');

const router = express.Router();

// only the explicit "other picks" button is metered: the automatic passes ride on the
// build / planning / recs quota the change that triggered them already spent
const refreshMeter = dailyQuota('dayrecs', 40); // AI_QUOTA_DAYRECS overrides
const CARDS_PER_DAY = 3;
const DAYS_PER_CALL = 6; // free days one call covers, inside one area and never across areas
const CALLS_AT_ONCE = 2; // in flight at once; they start in day order, so the trip fills from its first day
const STALE_MS = 3 * 60 * 1000; // a 'pending' this old, with no pass running here, died with the process
const SEEN_CAP = 30; // titles a day remembers not to offer again
// below this a trip is one area whatever it spans — the same threshold the planning
// chat uses before it offers a split at all (SPLIT_AREAS_FROM_DAYS in routes/plan.js)
const SPLIT_AREAS_FROM_DAYS = 6;
const MAX_AREA_BLOCKS = 8;
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const HE_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const DAY_RECS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          day: { type: 'integer' },
          cards: { type: 'array', items: ai.REC_CARD_SCHEMA },
        },
        required: ['day', 'cards'],
      },
    },
  },
  required: ['days'],
};

const loadItems = (tripId) => pool.query(
  'SELECT id, day_number, time_label, title, category, area, place_query FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id',
  [tripId]
).then((r) => r.rows);

function freeDays(trip, items) {
  const has = new Set(items.map((it) => it.day_number));
  const out = [];
  for (let d = 1; d <= trip.days; d++) if (!has.has(d)) out.push(d);
  return out;
}

const tripDests = (trip) => (Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : []);
const areaNamesOf = (trip) => {
  const dests = tripDests(trip);
  return dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
};
const destText = (trip) => {
  const dests = tripDests(trip);
  return dests.length
    ? dests.map((d) => (d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name)).join(', ')
    : [trip.destination, trip.country].filter(Boolean).join(', ');
};

// where a free day is: the last stop of the nearest earlier day with stops, else the
// first stop after it, else the trip's first destination — the same rule the page uses
// to pick a default area for a new stop, so the picks land where the stop would
function dayArea(trip, items, day) {
  const names = areaNamesOf(trip);
  if (names.length < 2) return names[0] || null;
  for (let d = day - 1; d >= 1; d--) {
    const prev = items.filter((it) => it.day_number === d);
    if (prev.length) return prev[prev.length - 1].area || names[0];
  }
  for (let d = day + 1; d <= trip.days; d++) {
    const next = items.filter((it) => it.day_number === d);
    if (next.length) return next[0].area || names[0];
  }
  return names[0];
}

function dayDateLabel(trip, day) {
  if (!trip.start_date) return '';
  const d = new Date(trip.start_date);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + day - 1);
  return `יום ${HE_DOW[d.getDay()]}, ${d.getDate()} ב${HE_MONTHS[d.getMonth()]}`;
}

// =====================================================================
//  THE AREA PLAN — which stretch of days belongs to which area
// =====================================================================
//
// It decides two things: the order the picks are asked for (earliest day first), and
// how they are batched (one call per area, never across two). Three sources, in this
// order of authority:
//  1. the split the travellers settled in the planning chat (plan_state.areas) — the
//     one they see on the calendar card there, and the ONLY one that is binding. When
//     it exists, nothing here asks the model anything;
//  2. the itinerary itself, when its stops already name more than one area — the day →
//     area map the page draws with, grouped into runs;
//  3. a model call, cached per itinerary (trip_rec_areas). This is the 30-day-in-one-
//     country case: nothing anywhere says which days are Kansai and which are Tokyo,
//     and "which stretch of days is which region" is exactly what the picks need in
//     order to be asked for in sensible batches.
// What (3) returns is never binding and never shown: it orders the calls and rides
// along as context. A card's own `area` stays one of the trip's destination names,
// decided by dayArea as before — so the calendar's colours and the per-area editor
// keep reading one list.
const AREA_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          area: { type: 'string' },
          day_from: { type: 'integer' },
          day_to: { type: 'integer' },
          cities: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['area', 'day_from', 'day_to', 'cities', 'note'],
      },
    },
  },
  required: ['areas'],
};

const cleanName = (v, n = 60) => String(v || '').slice(0, n).trim();

// model (or stored) blocks → full, contiguous coverage of 1..days. A gap is closed by
// the block before it and the tail belongs to the last block: a plan that covers the
// trip is worth more here than a plan that is exactly what the model said, because a
// day outside every block would never be asked for at all.
function repairBlocks(raw, days) {
  const blocks = (Array.isArray(raw) ? raw : []).map((b) => ({
    area: cleanName(b && (b.area ?? b.name)),
    from: parseInt(b && (b.day_from ?? b.from), 10),
    to: parseInt(b && (b.day_to ?? b.to), 10),
    cities: (Array.isArray(b && b.cities) ? b.cities : []).slice(0, 3).map((c) => cleanName(c)).filter(Boolean),
    note: cleanName(b && b.note, 160),
  })).filter((b) => b.area && Number.isInteger(b.from) && Number.isInteger(b.to) && b.to >= b.from)
    .sort((a, b) => a.from - b.from)
    .slice(0, MAX_AREA_BLOCKS);
  const out = [];
  let next = 1;
  for (const b of blocks) {
    if (next > days) break;
    const to = Math.min(Math.max(b.to, next), days);
    out.push({ ...b, from: next, to });
    next = to + 1;
  }
  if (!out.length) return null;
  out[out.length - 1].to = days;
  return out;
}

const oneBlock = (trip) => [{ area: areaNamesOf(trip)[0] || trip.destination || '', from: 1, to: trip.days, cities: [], note: '' }];

// the day → area map of the itinerary, grouped into runs of days
function itineraryBlocks(trip, items) {
  if (areaNamesOf(trip).length < 2 || !items.length) return null;
  const out = [];
  for (let d = 1; d <= trip.days; d++) {
    const area = dayArea(trip, items, d);
    if (!area) return null;
    const last = out[out.length - 1];
    if (last && last.area === area) last.to = d;
    else out.push({ area, from: d, to: d, cities: [], note: '' });
  }
  return out.length ? out : null;
}

const itinerarySummary = (items, cap = 30) => {
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
    byDay.get(it.day_number).push(it.title);
  }
  return [...byDay.entries()].slice(0, cap)
    .map(([d, titles]) => `יום ${d}: ${titles.slice(0, 6).join(' · ')}`).join('\n');
};

async function aiAreaBlocks(trip, items, { ph }) {
  const names = areaNamesOf(trip);
  const dates = trip.start_date ? `, החל מ-${String(trip.start_date).slice(0, 10)}` : '';
  const known = itinerarySummary(items);
  const raw = await ai.aiJson({
    system: `אתם מתכנני המסלולים של TRIP MAKER, ומחלקים טיול לאזורים לפי ימים.
אזור = חבל ארץ שלנים בו כמה לילות ומטיילים ממנו בסביבה — לא עיר ליום ולא אתר בודד.
החלוקה הזו משמשת אותנו פנימית כדי לבקש המלצות אזור-אזור; היא לא מוצגת למטיילים ולא משנה את המסלול.`,
    user: `הטיול: "${trip.title}", ${trip.days} ימים${dates}. יעדים: ${destText(trip)}.
${known ? `ימים שכבר יש בהם תחנות:\n${known}\n` : 'המסלול עדיין ריק.\n'}
המשימה: לחלק את ימים 1 עד ${trip.days} לאזורים רצופים.
- כיסוי מלא ורצוף: הבלוק הראשון מתחיל ביום 1, האחרון נגמר ביום ${trip.days}, בלי חורים ובלי חפיפות.
- עד ${MAX_AREA_BLOCKS} בלוקים, וכל בלוק לפחות יומיים כשאפשר. סדר גאוגרפי הגיוני, בלי לקפוץ הלוך ושוב.
- יום שכבר יש בו תחנות חייב ליפול בבלוק של האזור שבו הוא נמצא בפועל.
${names.length > 1
    ? `- שמות האזורים בדיוק מהרשימה הזו: ${names.map((a) => `"${a}"`).join(', ')}.`
    : `- היעד הוא ${names[0] || trip.destination}: חלקו אותו לחבלי ארץ אמיתיים בתוכו (בעברית), כמו שמטייל היה מחלק.`}
- cities: עד שלוש ערים או בסיסים באותו אזור. note: שורה קצרה על מה עושים באזור הזה.`,
    schemaName: 'trip_rec_areas',
    schema: AREA_PLAN_SCHEMA,
    maxTokens: 700,
    model: ai.AI_MODEL_STRONG,
    timeoutMs: 25000,
    ph,
  });
  return repairBlocks(raw && raw.areas, trip.days);
}

// the itinerary as the plan sees it: a change to any stop (a chat turn or a manual
// edit) changes this, and with it the cached plan — which is what "ask for the areas
// again after every change" means in practice
const planSignature = (trip, items) => createHash('sha1').update(JSON.stringify([
  trip.days, areaNamesOf(trip), items.map((it) => [it.day_number, it.area || '', it.title]),
])).digest('hex');

async function readPlanCache(tripId) {
  const { rows } = await pool.query('SELECT signature, areas FROM trip_rec_areas WHERE trip_id = $1', [tripId]);
  return rows[0] || null;
}
const writePlanCache = (tripId, signature, areas) => pool.query(
  `INSERT INTO trip_rec_areas (trip_id, signature, areas, updated_at) VALUES ($1, $2, $3, now())
   ON CONFLICT (trip_id) DO UPDATE SET signature = EXCLUDED.signature, areas = EXCLUDED.areas, updated_at = now()`,
  [tripId, signature, JSON.stringify(areas)]
);

async function areaPlan(trip, items, { ph }) {
  // the split the travellers settled, exactly as they settled it — nothing to ask.
  // Checked before any repair: a split that does not cover the trip is not the one
  // they were shown, and guessing the rest of it here would put words in their mouth
  const settled = cleanPlanState(trip.plan_state).areas;
  if (areasCoverTrip(settled, trip.days)) {
    return settled.map((a) => ({ area: a.area, from: a.from, to: a.to, cities: a.cities || [], note: '' }));
  }
  const fromItinerary = itineraryBlocks(trip, items);
  if (fromItinerary) return fromItinerary;
  if (trip.days < SPLIT_AREAS_FROM_DAYS || !process.env.OPENAI_API_KEY) return oneBlock(trip);

  const sig = planSignature(trip, items);
  const cached = await readPlanCache(trip.id).catch(() => null);
  if (cached && cached.signature === sig) {
    const blocks = repairBlocks(cached.areas, trip.days);
    if (blocks) return blocks;
  }
  const fresh = await aiAreaBlocks(trip, items, { ph }).catch((err) => {
    console.error(`day-recs: trip ${trip.id} area plan failed`, err.message);
    return null;
  });
  // the geocoder going quiet must not pass in silence, and neither may this: without a
  // plan the days are still asked for, in blocks of DAYS_PER_CALL, just without an area
  if (!fresh) {
    console.warn(`day-recs: trip ${trip.id} falling back to one area block`);
    return cached ? (repairBlocks(cached.areas, trip.days) || oneBlock(trip)) : oneBlock(trip);
  }
  await writePlanCache(trip.id, sig, fresh).catch(() => { /* a cache miss next time is the whole cost */ });
  return fresh;
}

// =====================================================================
//  WHAT A DAY'S PICKS DEPEND ON — the cache key of a single day
// =====================================================================
//
// The picks for a day are chosen around it: its area, and the stops on either side of
// it. Two travellers editing day 20 must not cost thirty model calls, so a day whose
// surroundings are unchanged keeps the cards it has. Stored on the row as `context`.
const blockOf = (blocks, day) => blocks.find((b) => day >= b.from && day <= b.to) || blocks[blocks.length - 1];
const normTitle = (s) => String(s || '').trim().toLowerCase();

function dayContext(trip, items, day, blocks) {
  const block = blockOf(blocks, day);
  const area = dayArea(trip, items, day);
  const prev = items.filter((it) => it.day_number === day - 1);
  const next = items.filter((it) => it.day_number === day + 1);
  const before = prev.length ? prev[prev.length - 1].title : '';
  const after = next.length ? next[0].title : '';
  return {
    block,
    area,
    before,
    after,
    sig: `${block ? block.area : ''}|${area || ''}|${before}|${after}`,
  };
}

// a pick the traveller has since added somewhere else is no longer a pick
const clashesWithTrip = (cards, titles) => (Array.isArray(cards) ? cards : []).some((c) => titles.has(normTitle(c && c.title)));

// =====================================================================
//  THE MODEL CALLS — one per area block, up to DAYS_PER_CALL days each
// =====================================================================

function systemPrompt(trip, blocks) {
  const areaNames = areaNamesOf(trip);
  const dates = trip.start_date ? `, החל מ-${String(trip.start_date).slice(0, 10)}` : '';
  const route = blocks.map((b) => `ימים ${b.from}-${b.to}: ${b.area}${b.cities.length ? ` (${b.cities.join(', ')})` : ''}`).join(' | ');
  return `אתם המדריך המקומי של TRIP MAKER — מומחה לטיולים שמכיר את ${destText(trip)} לעומק, ועוזרים למטייל ישראלי למלא את הימים הפנויים בטיול שלו.
עונים בעברית, בגוף רבים ("אתם").

הטיול: "${trip.title}", ${trip.days} ימים${dates}. יעדים: ${destText(trip)}.
מבנה הטיול: ${route}

המשימה: לכל יום פנוי ברשימה שבהודעה — בדיוק ${CARDS_PER_DAY} כרטיסים, שממלאים את היום יפה מהבוקר עד הערב: בוקר, צהריים וערב, לפי הסדר, עם שעת התחלה לכל אחד. המקומות באזור של אותו יום ובמרחק סביר מהתחנות של הימים הסמוכים. ימים פנויים רצופים באותו אזור מקבלים תוכניות שונות זו מזו, לא אותה תוכנית כמה פעמים.

כרטיסים (cards):
- כרטיס הוא מקום אמיתי אחד שאפשר להגיע אליו: אתר, מסעדה, שוק, פארק, שכונה, מוזיאון, חוף. לא רעיון כללי ולא "סיור" בלי מקום.
- אין להציע מקום שכבר נמצא במסלול, ולא מקום מרשימת "לא להציע שוב" של אותו יום.
- title: שם המקום בעברית, כפי שמטייל ישראלי מכיר אותו (עד 50 תווים).
- place_query: השם הרשמי באנגלית (או בשפה המקומית באותיות לטיניות), ואחריו העיר והמדינה מופרדים בפסיקים, כך שמנוע מפות ימצא אותו. למשל: "Mercato di Testaccio, Rome, Italy".
- blurb: משפט-שניים קונקרטיים (עד 160 תווים): מה עושים שם, מתי הכי טוב להגיע, טיפ אחד.
- category מתוך: ${ai.REC_CATS.join(', ')}. cost: ${ai.REC_COSTS.join(' / ')}. duration בעברית קצרה ("שעה", "שעתיים", "חצי יום"). time: שעת התחלה בפורמט HH:MM.
- area: שם היעד מהטיול שהמקום שייך אליו, בדיוק באחת הצורות האלה: ${areaNames.map((a) => `"${a}"`).join(', ')}.
- day: מספר היום הפנוי מהרשימה, כפי שנכתב.
כל מקום בכרטיס חייב להיות מקום שקיים באמת ושאתם בטוחים בשמו; מקום שאינכם בטוחים בו לא נכנס לכרטיס.`;
}

// one call's worth: the area, what is already fixed in its days (context — never
// offered again), and the days that actually need picks
function blockUserPrompt(trip, items, block, days, { seenByDay, contexts }) {
  const fixed = [];
  for (let d = block.from; d <= block.to; d++) {
    const stops = items.filter((it) => it.day_number === d);
    // not "- יום N" like the list below it: the days that need picks are the ones
    // written that way, and a background day must not read as one of them
    if (stops.length) fixed.push(`יום ${d} (קבוע): ${stops.map((it) => it.title).slice(0, 6).join(' · ')}`);
  }
  const lines = days.map((day) => {
    const ctx = contexts.get(day) || {};
    const parts = [`יום ${day}`];
    const date = dayDateLabel(trip, day);
    if (date) parts[0] += ` (${date})`;
    // the block already says where these days are; the day's own area is worth a line
    // only on a trip with several destinations, where it can differ from the block's
    if (ctx.area && ctx.area !== block.area && areaNamesOf(trip).length > 1) parts.push(`האזור: ${ctx.area}`);
    if (ctx.before) parts.push(`יום ${day - 1} נגמר ב"${ctx.before}"`);
    if (ctx.after) parts.push(`יום ${day + 1} מתחיל ב"${ctx.after}"`);
    const seen = seenByDay.get(day) || [];
    if (seen.length) parts.push(`לא להציע שוב: ${seen.join(', ')}`);
    return '- ' + parts.join(' · ');
  });
  const where = `${block.area}${block.cities.length ? ` (${block.cities.join(', ')})` : ''}`;
  return `האזור: ${where} — ימים ${block.from}-${block.to} בטיול.${block.note ? `\n${block.note}` : ''}
${fixed.length ? `ימים בטווח הזה שכבר קבועים (רקע — אל תציעו את המקומות האלה שוב):\n${fixed.join('\n')}\n` : ''}
הימים שצריך להם המלצות:
${lines.join('\n')}`;
}

// model → verified cards, per day, for one block. A day the model skipped, or whose
// call failed, comes back null (failed); a day whose every card fell in verification
// is [] (ready, nothing to show — the button offers another try).
async function generateBlock(trip, items, { block, days }, { seenByDay, contexts, system, ph }) {
  const dests = tripDests(trip);
  const areaNames = areaNamesOf(trip);
  const results = new Map();
  const raw = await ai.aiJson({
    system,
    user: blockUserPrompt(trip, items, block, days, { seenByDay, contexts }),
    schemaName: 'trip_day_recs',
    schema: DAY_RECS_SCHEMA,
    maxTokens: 500 + 650 * days.length,
    model: ai.AI_MODEL_STRONG,
    timeoutMs: 45000,
    ph,
  });
  if (!raw) { days.forEach((d) => results.set(d, null)); return results; }
  const byDay = new Map();
  for (const entry of Array.isArray(raw.days) ? raw.days : []) {
    const d = parseInt(entry && entry.day, 10);
    if (days.includes(d) && !byDay.has(d)) byDay.set(d, Array.isArray(entry.cards) ? entry.cards : []);
  }
  await Promise.all(days.map(async (d) => {
    const cards = byDay.get(d);
    if (!cards) { results.set(d, null); return; }
    const area = (contexts.get(d) || {}).area;
    // a card the model filed under an area name it made up belongs to the day's area
    const filed = cards.slice(0, CARDS_PER_DAY).map((c) => ({ ...c, area: areaNames.includes(c.area) ? c.area : area }));
    try {
      const { cards: verified, dropped } = await ai.verifyRecCards(filed, { dests, areaNames });
      if (dropped) console.warn(`day-recs: trip ${trip.id} day ${d}: ${dropped} of ${filed.length} picks dropped in verification`);
      results.set(d, verified);
    } catch (err) {
      console.error(`day-recs: trip ${trip.id} day ${d} verification failed`, err.message);
      results.set(d, null);
    }
  }));
  return results;
}

// =====================================================================
//  THE ROWS
// =====================================================================

async function readRows(tripId) {
  const { rows } = await pool.query(
    'SELECT day_number, status, cards, seen, context, requested_at, updated_at FROM trip_day_recs WHERE trip_id = $1 ORDER BY day_number', [tripId]
  );
  return new Map(rows.map((r) => [r.day_number, r]));
}
const isStale = (r) => r.status === 'pending' && Date.now() - new Date(r.requested_at).getTime() > STALE_MS;

// what the page reads: {days: {n: {status, cards, updated_at}}, running, ready, waiting}.
// A pending row nobody is working on any more (the process died mid-pass) reports as
// failed, so the page offers a retry instead of a skeleton that never ends — but while
// a pass IS running here, its queue is pending however long the queue is.
async function snapshot(tripId) {
  const rows = await readRows(tripId);
  const running = inflight.has(tripId);
  const days = {};
  let ready = 0;
  let waiting = 0;
  for (const [d, r] of rows) {
    const status = !running && isStale(r) ? 'failed' : r.status;
    if (status === 'pending') waiting++;
    if (status === 'ready') ready++;
    days[d] = { status, cards: r.status === 'ready' ? r.cards : [], updated_at: r.updated_at };
  }
  return { days, running, ready, waiting };
}

async function markPending(tripId, days) {
  const token = randomUUID();
  await pool.query(
    `INSERT INTO trip_day_recs (trip_id, day_number, status, token, requested_at, updated_at)
     SELECT $1, d, 'pending', $3, now(), now() FROM unnest($2::int[]) AS d
     ON CONFLICT (trip_id, day_number) DO UPDATE SET status = 'pending', token = EXCLUDED.token, requested_at = now(), updated_at = now()`,
    [tripId, days, token]
  );
  return token;
}

// the queue of a long trip is alive for minutes: without this the days waiting their
// turn would cross STALE_MS and report as failed while the pass is still working
const heartbeat = (tripId, token) => pool.query(
  `UPDATE trip_day_recs SET requested_at = now() WHERE trip_id = $1 AND token = $2 AND status = 'pending'`,
  [tripId, token]
).catch(() => { /* the pass matters more than its heartbeat */ });

async function writeDay(tripId, token, day, cards, seen) {
  if (!cards) {
    await pool.query(
      `UPDATE trip_day_recs SET status = 'failed', updated_at = now() WHERE trip_id = $1 AND day_number = $2 AND token = $3`,
      [tripId, day, token]
    );
    return;
  }
  await pool.query(
    `UPDATE trip_day_recs SET status = 'ready', cards = $4, seen = $5, context = $6, updated_at = now()
     WHERE trip_id = $1 AND day_number = $2 AND token = $3`,
    [tripId, day, token, JSON.stringify(cards), JSON.stringify(seen.titles), seen.context]
  );
}

// =====================================================================
//  THE PASS
// =====================================================================

// passes in flight, per trip: a page that opens while one is running joins it instead
// of starting a second. A pass started after the itinerary changed supersedes the one
// running — the older one stops at its next block boundary, and its writes are dead
// anyway (the new pass took the token).
const inflight = new Map(); // tripId → {promise, sig, gen}
let passes = 0;

const superseded = (tripId, gen) => (inflight.get(tripId) || {}).gen !== gen;

// batches, in the order the traveller reads the trip: area by area, earliest day
// first, and never more than DAYS_PER_CALL days in one call
function batchesOf(blocks, targets) {
  const out = [];
  for (const b of blocks) {
    const days = targets.filter((d) => d >= b.from && d <= b.to);
    // an eight-day area is two calls of four, not a call of six and a call of one: a
    // lone day in its own request costs as much as six and reads worse
    const parts = Math.ceil(days.length / DAYS_PER_CALL);
    for (let k = 0, i = 0; k < parts; k++) {
      const n = Math.ceil((days.length - i) / (parts - k));
      out.push({ block: b, days: days.slice(i, i + n) });
      i += n;
    }
  }
  // a day outside every block would never be asked for — repairBlocks makes that
  // impossible, and this says so out loud if it ever stops being true
  const covered = out.reduce((n, b) => n + b.days.length, 0);
  if (covered !== targets.length) console.warn(`day-recs: ${targets.length - covered} day(s) fell outside the area plan`);
  return out;
}

// a small ordered pool: the batches start in day order, a couple at a time
async function runQueue(list, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const k = i++;
      await fn(list[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

async function runPass(trip, { scope, day, gen, ph }) {
  const items = await loadItems(trip.id);
  const free = freeDays(trip, items);
  // a day that has stops now needs no picks — its row would only go stale
  await pool.query('DELETE FROM trip_day_recs WHERE trip_id = $1 AND NOT (day_number = ANY($2::int[]))', [trip.id, free]);
  if (!free.length) return 0;
  const existing = await readRows(trip.id);

  const blocks = await areaPlan(trip, items, { ph });
  const contexts = new Map(free.map((d) => [d, dayContext(trip, items, d, blocks)]));
  const titles = new Set(items.map((it) => normTitle(it.title)));

  let targets;
  if (scope === 'day') targets = free.includes(day) ? [day] : [];
  else if (scope === 'all') targets = free; // an explicit "make them all again"
  else {
    targets = free.filter((d) => {
      const r = existing.get(d);
      // missing, failed, or pending from a pass that is not this one — and a 'ready'
      // day only when what it was chosen around has changed since
      if (!r || r.status !== 'ready') return true;
      return r.context !== contexts.get(d).sig || clashesWithTrip(r.cards, titles);
    });
  }
  if (!targets.length) return 0;

  // "other picks" for one day steers clear of what that day was already offered; an
  // automatic pass starts that day fresh — its surroundings changed, so the old picks
  // are moot
  const seenByDay = new Map(targets.map((d) => [d, scope === 'day' ? (existing.get(d) || {}).seen || [] : []]));
  const token = await markPending(trip.id, targets);
  const system = systemPrompt(trip, blocks);
  const batches = batchesOf(blocks, targets);
  let calls = 0;
  await runQueue(batches, CALLS_AT_ONCE, async (batch) => {
    if (gen != null && superseded(trip.id, gen)) return;
    await heartbeat(trip.id, token);
    calls++;
    let results;
    try {
      results = await generateBlock(trip, items, batch, { seenByDay, contexts, system, ph });
    } catch (err) {
      // one area's call falling over is that area's days, not the trip's: the rest of
      // the queue keeps going and these days get a retry button
      console.error(`day-recs: trip ${trip.id} days ${batch.days.join(',')} failed`, err.message);
      results = new Map(batch.days.map((d) => [d, null]));
    }
    // written here, one day at a time, rather than after the last batch: the page is
    // watching, and a day that is ready should be on screen
    for (const d of batch.days) {
      const cards = results.get(d);
      const seen = cards
        ? { titles: [...new Set([...(seenByDay.get(d) || []), ...cards.map((c) => c.title)])].slice(-SEEN_CAP), context: contexts.get(d).sig }
        : null;
      await writeDay(trip.id, token, d, cards, seen).catch((err) => console.error(`day-recs: trip ${trip.id} day ${d} write failed`, err.message));
    }
  });
  return calls;
}

// scope 'auto' (the default — what is missing or has gone out of date) | 'all' (every
// free day again) | 'day' (one day, the "המלצות אחרות" button). Resolves to how many
// model calls ran. Whole-trip passes are registered so a second page joins instead of
// starting its own.
function regenerate(trip, { scope = 'auto', day = null, ph, sig = null } = {}) {
  if (scope === 'day') return runPass(trip, { scope, day, gen: null, ph });
  const current = inflight.get(trip.id);
  // the same trip, unchanged since that pass started: one pass is the right number
  if (current && scope !== 'all' && (sig == null || sig === current.sig)) return current.promise;
  const gen = ++passes;
  const entry = { sig, gen };
  entry.promise = runPass(trip, { scope, day: null, gen, ph })
    .finally(() => { if (inflight.get(trip.id) === entry) inflight.delete(trip.id); });
  inflight.set(trip.id, entry);
  entry.promise.catch((err) => console.error(`day-recs: trip ${trip.id} pass failed`, err.message));
  return entry.promise;
}

// =====================================================================
//  ROUTES
// =====================================================================

// anyone who can open the trip may read the picks (the page only draws them for
// editors, but a share-code holder's reload must not 403 on a side request)
router.get('/api/trips/code/:code/day-recs', authOptional, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM trips WHERE share_code = $1', [req.params.code]);
    if (!rows[0]) return res.status(404).json({ error: 'לא נמצא טיול עם הקוד הזה' });
    res.json(await snapshot(rows[0].id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// body: {scope: 'auto' | 'all'} or {day: n}.
// A whole-trip pass answers the moment it is under way, with the snapshot the page
// starts from: on a long trip the pass takes minutes, and a request that answers only
// at the end is a request the page never sees answer. One day answers when it is done —
// it is one call, and a finger is on that button.
router.post('/api/trips/code/:code/day-recs/refresh', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'ההמלצות לא זמינות כרגע' });
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const day = parseInt(b.day, 10);
    const ph = { distinctId: 'user_' + req.user.id, traceId: randomUUID() };
    if (Number.isInteger(day)) {
      if (day < 1 || day > trip.days) return res.status(400).json({ error: 'יום לא תקין' });
      const quota = await refreshMeter.check(req);
      if (!quota) return exhausted(res, 'dayrecs', 'ניצלתם את רענוני ההמלצות להיום — נסו שוב מחר');
      const calls = await regenerate(trip, { scope: 'day', day, ph });
      if (calls) quota.spend(); // the model call is the budgeted resource, not the tap
      return res.json({ ...(await snapshot(trip.id)), remaining: quota.remaining });
    }
    // 'missing' is what browsers running the older page still send for this
    const scope = b.scope === 'all' ? 'all' : 'auto';
    const items = await loadItems(trip.id);
    regenerate(trip, { scope, ph, sig: planSignature(trip, items) });
    res.json({ ...(await snapshot(trip.id)), remaining: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

module.exports = router;
// exported for tests: the same pass the route runs
module.exports.regenerate = regenerate;
module.exports.freeDays = freeDays;
module.exports.snapshot = snapshot;
// the shape of a pass, without a database or a model behind it: what the areas are,
// how the days are batched into calls, and what a day's picks depend on.
// tools/day-recs-plan-check.js runs them over a shelf of trips
module.exports.areaPlan = areaPlan;
module.exports.repairBlocks = repairBlocks;
module.exports.batchesOf = batchesOf;
module.exports.dayContext = dayContext;
module.exports.DAYS_PER_CALL = DAYS_PER_CALL;
