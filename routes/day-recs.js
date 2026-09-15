// המלצות ליום פנוי — the AI's picks for a day that has no stops yet.
//
// A free day in the itinerary used to be a line of placeholder text and a hotel rail.
// Now it shows three places the AI would put there — morning, midday, evening — as
// wide, short rows the traveller drops into the day with one tap, plus a button that
// swaps them for three others. The picks live in trip_day_recs (one row per free day),
// so every participant sees the same three and a reload doesn't cost a model call.
//
// When they are made:
// - right after an AI build, behind the same loading screen (trip-plan.js calls
//   `refresh` with scope 'all' before landing on the itinerary);
// - on the itinerary itself for any free day that has nothing yet (scope 'missing' —
//   a manual trip, a day that was just emptied, a generation the server died in);
// - again for every free day after any change the AI chats make to the trip (scope
//   'all' from the page's replaceItems), because the picks are chosen around the
//   stops of the neighbouring days and must not repeat what is already in the plan;
// - one day at a time from the "המלצות אחרות" button (scope 'day'), which asks for
//   places the day hasn't been offered before.
//
// The model is the strong one — the cards name real places, and the weak tier invents
// them (PLAYBOOK §3) — and every card goes through the same verifyRecCards the
// recommendations chat uses: a place the geocoder can't confirm never reaches a day.
// A token per request guards the writes: a refresh that lands while an older, wider
// regeneration is still running wins, and the older results for that day are dropped.
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../lib/db');
const { authRequired, authOptional } = require('../lib/auth');
const { tripWithEditAuth } = require('../lib/trips');
const { dailyQuota, exhausted } = require('../lib/quota');
const ai = require('./ai');

const router = express.Router();

// only the explicit "other picks" button is metered: the automatic passes ride on the
// build / planning / recs quota the change that triggered them already spent
const refreshMeter = dailyQuota('dayrecs', 40); // AI_QUOTA_DAYRECS overrides
const CARDS_PER_DAY = 3;
const DAYS_PER_CALL = 6; // free days per model call — a 30-day empty trip is five calls
const CALLS_AT_ONCE = 3;
const STALE_MS = 3 * 60 * 1000; // a 'pending' older than this died with the process
const SEEN_CAP = 30; // titles a day remembers not to offer again
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

function systemPrompt(trip, items) {
  const dests = tripDests(trip);
  const destText = dests.length
    ? dests.map((d) => d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name).join(', ')
    : [trip.destination, trip.country].filter(Boolean).join(', ');
  const areaNames = areaNamesOf(trip);
  const dates = trip.start_date ? `, החל מ-${String(trip.start_date).slice(0, 10)}` : '';
  const byDay = new Map();
  for (const it of items) {
    if (!byDay.has(it.day_number)) byDay.set(it.day_number, []);
    byDay.get(it.day_number).push(it.title);
  }
  const itinerary = [...byDay.entries()].slice(0, 30)
    .map(([d, titles]) => `יום ${d}: ${titles.slice(0, 6).join(' · ')}`).join('\n') || '(עדיין ריק — כל הימים פנויים)';
  return `אתם המדריך המקומי של TRIP MAKER — מומחה לטיולים שמכיר את ${destText} לעומק, ועוזרים למטייל ישראלי למלא את הימים הפנויים בטיול שלו.
עונים בעברית, בגוף רבים ("אתם").

הטיול: "${trip.title}", ${trip.days} ימים${dates}. יעדים: ${destText}.
המסלול הנוכחי (ימים שכבר יש בהם תחנות):
${itinerary}

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

function userPrompt(trip, items, days, seenByDay) {
  const lines = days.map((day) => {
    const parts = [`יום ${day}`];
    const date = dayDateLabel(trip, day);
    if (date) parts[0] += ` (${date})`;
    const area = dayArea(trip, items, day);
    if (area) parts.push(`האזור: ${area}`);
    const prev = items.filter((it) => it.day_number === day - 1);
    const next = items.filter((it) => it.day_number === day + 1);
    if (prev.length) parts.push(`יום ${day - 1} נגמר ב"${prev[prev.length - 1].title}"`);
    if (next.length) parts.push(`יום ${day + 1} מתחיל ב"${next[0].title}"`);
    const seen = seenByDay.get(day) || [];
    if (seen.length) parts.push(`לא להציע שוב: ${seen.join(', ')}`);
    return '- ' + parts.join(' · ');
  });
  return `הימים הפנויים:\n${lines.join('\n')}`;
}

// a small pool: the chunks of a long empty trip run a few at a time, not all at once
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const k = i++;
      out[k] = await fn(list[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

// model → verified cards, per day. A day the model skipped, or whose chunk failed,
// comes back null (failed); a day whose every card fell in verification is [] (ready,
// nothing to show — the button offers another try).
async function generate(trip, items, days, { seenByDay, ph }) {
  const dests = tripDests(trip);
  const areaNames = areaNamesOf(trip);
  const system = systemPrompt(trip, items);
  const chunks = [];
  for (let i = 0; i < days.length; i += DAYS_PER_CALL) chunks.push(days.slice(i, i + DAYS_PER_CALL));
  const results = new Map();
  await mapLimit(chunks, CALLS_AT_ONCE, async (chunk) => {
    const raw = await ai.aiJson({
      system,
      user: userPrompt(trip, items, chunk, seenByDay),
      schemaName: 'trip_day_recs',
      schema: DAY_RECS_SCHEMA,
      maxTokens: 500 + 650 * chunk.length,
      model: ai.AI_MODEL_STRONG,
      timeoutMs: 45000,
      ph,
    });
    if (!raw) { chunk.forEach((d) => results.set(d, null)); return; }
    const byDay = new Map();
    for (const entry of Array.isArray(raw.days) ? raw.days : []) {
      const d = parseInt(entry && entry.day, 10);
      if (chunk.includes(d) && !byDay.has(d)) byDay.set(d, Array.isArray(entry.cards) ? entry.cards : []);
    }
    await Promise.all(chunk.map(async (d) => {
      const cards = byDay.get(d);
      if (!cards) { results.set(d, null); return; }
      const area = dayArea(trip, items, d);
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
  });
  return results;
}

async function readRows(tripId) {
  const { rows } = await pool.query(
    'SELECT day_number, status, cards, seen, requested_at, updated_at FROM trip_day_recs WHERE trip_id = $1 ORDER BY day_number', [tripId]
  );
  return new Map(rows.map((r) => [r.day_number, r]));
}
const isStale = (r) => r.status === 'pending' && Date.now() - new Date(r.requested_at).getTime() > STALE_MS;

// what the page reads: {days: {n: {status, cards, updated_at}}}. A pending row the
// process died on reports as failed, so the page offers a retry instead of a skeleton
// that never ends.
async function snapshot(tripId) {
  const rows = await readRows(tripId);
  const days = {};
  for (const [d, r] of rows) {
    days[d] = { status: isStale(r) ? 'failed' : r.status, cards: r.status === 'ready' ? r.cards : [], updated_at: r.updated_at };
  }
  return { days };
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

// whole-trip passes in flight, per trip: a page that opens while the post-build pass is
// still running joins it instead of starting a second one. A pass after an AI change
// never joins — it must see the new itinerary — and its token retires the older writes.
const inflight = new Map(); // tripId → Promise<number of model calls>

// scope 'all' | 'missing' | 'day' (with `day`). Resolves to how many model calls ran.
function regenerate(trip, { scope, day = null, ph }) {
  if (scope === 'missing' && inflight.has(trip.id)) return inflight.get(trip.id);
  const run = (async () => {
    const items = await loadItems(trip.id);
    const free = freeDays(trip, items);
    // a day that has stops now needs no picks — its row would only go stale
    await pool.query('DELETE FROM trip_day_recs WHERE trip_id = $1 AND NOT (day_number = ANY($2::int[]))', [trip.id, free]);
    const existing = await readRows(trip.id);
    let targets;
    if (scope === 'day') targets = free.includes(day) ? [day] : [];
    else if (scope === 'missing') targets = free.filter((d) => { const r = existing.get(d); return !r || r.status === 'failed' || isStale(r); });
    else targets = free;
    if (!targets.length) return 0;

    // "other picks" for one day steers clear of what that day was already offered; a
    // whole-trip pass starts fresh — the itinerary changed, so the old picks are moot
    const seenByDay = new Map(targets.map((d) => [d, scope === 'day' ? (existing.get(d) || {}).seen || [] : []]));
    const token = await markPending(trip.id, targets);
    const results = await generate(trip, items, targets, { seenByDay, ph });
    for (const d of targets) {
      const cards = results.get(d);
      if (!cards) {
        await pool.query(
          `UPDATE trip_day_recs SET status = 'failed', updated_at = now() WHERE trip_id = $1 AND day_number = $2 AND token = $3`,
          [trip.id, d, token]
        );
        continue;
      }
      const seen = [...new Set([...(seenByDay.get(d) || []), ...cards.map((c) => c.title)])].slice(-SEEN_CAP);
      await pool.query(
        `UPDATE trip_day_recs SET status = 'ready', cards = $4, seen = $5, updated_at = now()
         WHERE trip_id = $1 AND day_number = $2 AND token = $3`,
        [trip.id, d, token, JSON.stringify(cards), JSON.stringify(seen)]
      );
    }
    return Math.ceil(targets.length / DAYS_PER_CALL);
  })();
  if (scope !== 'day') {
    inflight.set(trip.id, run);
    run.finally(() => { if (inflight.get(trip.id) === run) inflight.delete(trip.id); }).catch(() => {});
  }
  return run;
}

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

// body: {scope: 'all' | 'missing'} or {day: n}. Answers with the fresh snapshot once the
// generation is done — the caller shows skeletons meanwhile.
router.post('/api/trips/code/:code/day-recs/refresh', authRequired, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'ההמלצות לא זמינות כרגע' });
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const day = parseInt(b.day, 10);
    const scope = Number.isInteger(day) ? 'day' : (b.scope === 'all' ? 'all' : 'missing');
    if (scope === 'day' && (day < 1 || day > trip.days)) return res.status(400).json({ error: 'יום לא תקין' });
    let quota = null;
    if (scope === 'day') {
      quota = await refreshMeter.check(req);
      if (!quota) return exhausted(res, 'dayrecs', 'ניצלתם את רענוני ההמלצות להיום — נסו שוב מחר');
    }
    const calls = await regenerate(trip, {
      scope, day, ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (quota && calls) quota.spend(); // the model call is the budgeted resource, not the tap
    res.json({ ...(await snapshot(trip.id)), remaining: quota ? quota.remaining : null });
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
