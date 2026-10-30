// ייבוא — a plan written somewhere else becomes this trip.
//
// People arrive with a plan already: fourteen days of ChatGPT, a friend's Google Doc, a
// forum post pasted into Notes. Until now the chat could read such a text only as a
// message (400 characters, a request) — the traveller retyped their own trip to the AI
// a day at a time. Here the text is handed over whole and treated as the source of
// truth, in one of two ways the sheet names in plain words:
//
//   rebuild  the itinerary becomes the text. Everything there is cleared, every stop the
//            text names is written, day by day, with the times and notes it gives.
//   fix      the itinerary is brought to the text. What the text has and the trip lacks
//            is added; what both have is kept (times and days corrected to the text);
//            what the trip has and the text does not is removed — the text decides.
//
// Both go through the only door a stop may enter by: the same ops the editor and the
// planning chat produce, verified against the map (verifyEditOps) and written by the
// same op-writer (applyEditOps). Hotels, budget and dates named in the text ride the
// same actions as a chat turn's (lib/plan-actions.js). A day the text has and the trip
// does not (day 16 of a 14-day trip) is reported, never silently folded in. Costs a
// build from the daily build quota: this is a build, whatever it is called.
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { tripWithEditAuth, cleanPlanState, areasCoverTrip } = require('../lib/trips');
const actions = require('../lib/plan-actions');
const { exhausted } = require('../lib/quota');
const ai = require('./ai');

const router = express.Router();
const TEXT_MIN = 40;
const TEXT_MAX = 16000;
const OPS_CAP = 160;

const OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'id', 'day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area', 'cost'],
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'delete'] },
    id: { type: ['integer', 'null'] },
    day_number: { type: ['integer', 'null'] },
    time_label: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
    place_query: { type: ['string', 'null'] },
    category: { type: ['string', 'null'] },
    area: { type: ['string', 'null'] },
    cost: { type: ['integer', 'null'] },
  },
};
const IMPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'ops', 'actions', 'areas', 'facts', 'ignored'],
  properties: {
    summary: { type: 'string' },
    ops: { type: 'array', items: OP_SCHEMA },
    actions: { type: 'array', items: actions.ACTION_SCHEMA },
    areas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['area', 'day_from', 'day_to', 'cities'],
        properties: { area: { type: 'string' }, day_from: { type: 'integer' }, day_to: { type: 'integer' }, cities: { type: 'array', items: { type: 'string' } } },
      },
    },
    facts: { type: 'array', items: { type: 'string' } },
    ignored: { type: 'array', items: { type: 'string' } },
  },
};

const itineraryLines = (items, multiArea) => items.map((it) =>
  `#${it.id} | יום ${it.day_number} | ${it.time_label || '--:--'} | [${it.category || 'כללי'}] ${it.title}` +
  (multiArea && it.area ? ` | אזור: ${it.area}` : '') + (it.place_query ? ` | ${it.place_query}` : '')).join('\n') || '(ריק)';

function importPrompt({ trip, dests, items, mode, text, hotels }) {
  const areaNames = dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
  const multiArea = areaNames.length > 1;
  const dates = trip.start_date ? `, מתאריך ${String(trip.start_date).slice(0, 10)}` : '';
  const system =
`אתם עורך המסלולים של TRIP MAKER. המטיילים הדביקו תוכנית טיול שנכתבה במקום אחר (AI אחר, חבר, פורום), והיא **מקור האמת**: המסלול צריך להיות התוכנית הזו, לא פרשנות שלכם עליה ולא תוספות משלכם.
${mode === 'rebuild'
    ? 'מצב: בנייה מחדש. המסלול הנוכחי נמחק כולו לפני שה-ops שלכם נכתבים — החזירו add לכל תחנה שבתוכנית, יום אחרי יום, בסדר הכרונולוגי של התוכנית, בלי update ובלי delete.'
    : 'מצב: תיקון. התאימו את המסלול הקיים (למטה, עם מזהים) לתוכנית: add לכל תחנה שבתוכנית וחסרה במסלול; update לתחנה שקיימת בשניהם אבל היום/השעה/השם/ההערה שונים (null בכל שדה שלא משתנה); delete לכל תחנה במסלול שאינה בתוכנית ולא קשורה אליה. תחנה זהה בשניהם — לא נוגעים. טיסות שכבר במסלול נשארות אלא אם התוכנית סותרת אותן.'}
חוקי ops: title קצר בעברית (שם המקום כפי שמטייל ישראלי מכיר אותו); note — מה שהתוכנית אומרת על התחנה (טיפ, פרטים, הסתייגות), בעברית, עד 200 תווים, null כשאין; time_label HH:MM כשהתוכנית נותנת שעה או סדר ברור (בוקר≈09:00, צהריים≈13:00, ערב≈19:00), אחרת null; day_number בין 1 ל-${trip.days}; place_query באנגלית עם עיר ומדינה ("Nishiki Market, Kyoto, Japan") רק למקום אמיתי וספציפי, null לתחנה כללית ("בוקר חופשי", "נסיעה לדרום"); cost הערכה לאדם בש"ח כשהתוכנית נוקבת במחיר, אחרת null; category מתוך: ${ai.AI_CATEGORIES.join(', ')}${multiArea ? `; area מתוך: ${areaNames.join(', ')}` : `; area תמיד "${areaNames[0] || trip.destination}"`}. תחנת נסיעה (טיסה, רכבת, מעבר בין ערים) מקבלת category "נסיעה".
כל מה שבתוכנית נכנס — גם מסעדות, גם "בוקר חופשי", גם לינה כתחנת "לינה" כשהתוכנית מציינת היכן ישנים. שום דבר שלא בתוכנית לא נכנס.
areas: אם התוכנית מחלקת את הימים לאזורים/ערים (למשל ימים 1-3 טוקיו, 4-6 קיוטו) — החזירו את החלוקה המלאה (רצף מ-1 עד ${trip.days}); אחרת [].
facts: עד 10 עובדות קצרות מהתוכנית שחשוב לזכור (סגנון, תקציב, העדפות, החלטות) — לזיכרון של המתכנן.
ignored: כל דבר בתוכנית שלא נכנס ולמה — ימים מעבר ל-${trip.days}, יעד שאינו בטיול, פרט לא ברור. משפט לכל פריט. [] כשהכול נכנס.
summary: 2-3 משפטים בעברית למטיילים: מה הבנתם מהתוכנית ומה נעשה.
${actions.PROMPT_RULES(trip.days)}`;
  const user =
`הטיול: "${trip.title}" — ${ai.destDescFull(dests) || trip.destination}, ${trip.days} ימים${dates}.
${mode === 'fix' ? `המסלול הנוכחי (#מזהה | יום | שעה | [קטגוריה] כותרת | מקום):\n${itineraryLines(items, multiArea)}\n` : ''}${actions.contextLines(hotels, null)}

התוכנית שהודבקה:
"""
${text}
"""`;
  return { system, user };
}

function cleanAreas(raw, days) {
  const blocks = (Array.isArray(raw) ? raw : []).map((a) => ({
    area: String(a?.area || '').slice(0, 60).trim(), from: parseInt(a?.day_from, 10), to: parseInt(a?.day_to, 10),
    cities: (Array.isArray(a?.cities) ? a.cities : []).slice(0, 3).map((c) => String(c).slice(0, 60).trim()).filter(Boolean),
  })).filter((a) => a.area && Number.isInteger(a.from) && Number.isInteger(a.to) && a.from >= 1 && a.to <= days && a.to >= a.from)
    .sort((a, b) => a.from - b.from);
  return areasCoverTrip(blocks, days) ? blocks : null;
}

router.post('/api/trips/code/:code/ai-import', authRequired, async (req, res) => {
  let client = null;
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'ייבוא עם AI לא זמין כרגע' });
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const mode = b.mode === 'fix' ? 'fix' : 'rebuild';
    const text = String(b.text || '').replace(/\r/g, '').trim();
    if (text.length < TEXT_MIN) return res.status(400).json({ error: 'הדביקו תוכנית ארוכה יותר — לפחות כמה שורות' });
    if (text.length > TEXT_MAX) return res.status(400).json({ error: `התוכנית ארוכה מדי — עד ${TEXT_MAX.toLocaleString('en-US')} תווים` });
    const spend = await ai.buildQuota(req);
    if (!spend) return exhausted(res, 'build', ai.BUILD_EXHAUSTED);

    const dests = Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [];
    const { rows: items } = await pool.query('SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]);
    const hotels = await actions.loadHotels(pool, trip.id);
    const ph = { distinctId: 'user_' + req.user.id, traceId: randomUUID() };
    const { system, user } = importPrompt({ trip, dests, items: mode === 'fix' ? items : [], mode, text, hotels });
    const raw = await ai.aiJson({
      system, user, schemaName: 'trip_import', schema: IMPORT_SCHEMA,
      maxTokens: 9000, timeoutMs: 120000, model: ai.AI_MODEL_STRONG, ph,
    });
    if (!raw) return res.status(502).json({ error: 'ה-AI לא הצליח לקרוא את התוכנית — נסו שוב, או קצרו אותה' });
    // in a rebuild the slate is empty, so the model's ops are checked against nothing —
    // an update or a delete it wrote anyway has nothing to land on and is dropped
    const base = mode === 'fix' ? items : [];
    const ops = (Array.isArray(raw.ops) ? raw.ops : []).slice(0, OPS_CAP)
      .filter((op) => op && (mode === 'fix' || op.action === 'add'));
    const verified = await ai.verifyEditOps({ ops }, { items: base, dests, destText: trip.destination, title: trip.title, ph });
    const acts = actions.cleanActions(raw.actions, trip, hotels);
    if (!verified.ops.length && !acts.length) {
      return res.status(422).json({ error: 'לא מצאתי בתוכנית תחנות שאפשר להכניס למסלול — ודאו שהיא מתארת ימים ומקומות' });
    }
    spend();

    client = await pool.connect();
    await client.query('BEGIN');
    if (mode === 'rebuild' && items.length) await client.query('DELETE FROM trip_items WHERE trip_id = $1', [trip.id]);
    const r = verified.ops.length ? await ai.applyEditOps(client, trip, base, verified.ops) : { added: 0, updated: 0, removed: 0 };
    const a = acts.length ? await actions.applyActions(client, trip, acts) : { count: 0 };
    // the planning memory: the split the text drew, and what it said worth remembering
    const state = cleanPlanState(trip.plan_state);
    const areas = cleanAreas(raw.areas, trip.days);
    if (areas) state.areas = areas;
    const facts = (raw.facts || []).slice(0, 10).map((f) => String(f).slice(0, 160).trim()).filter(Boolean);
    if (facts.length) state.facts = [...state.facts.filter((f) => !facts.includes(f)), ...facts].slice(-24);
    if (trip.is_draft) { state.stage = 'done'; state.basics = true; state.build = 'once'; }
    await client.query('UPDATE trips SET plan_state = $1 WHERE id = $2', [JSON.stringify(state), trip.id]);
    const summary = String(raw.summary || '').trim().slice(0, 600);
    const ignored = (raw.ignored || []).slice(0, 8).map((s) => String(s).slice(0, 200).trim()).filter(Boolean);
    const removed = mode === 'rebuild' ? items.length : r.removed;
    const payload = { imported: { mode, added: r.added, updated: r.updated, removed, actions: a.count, ignored } };
    let message = null;
    if (trip.is_draft) {
      // the planning chat keeps the import as a turn of its own — it is the conversation's
      // history that the trip was built from a pasted plan
      const { rows } = await client.query(
        `INSERT INTO trip_plan_messages (trip_id, user_id, role, text, payload) VALUES ($1, NULL, 'ai', $2, $3) RETURNING id, role, text, payload, created_at`,
        [trip.id, summary || 'ייבאתי את התוכנית למסלול.', JSON.stringify(payload)]
      );
      message = rows[0];
    } else {
      message = { role: 'ai', text: summary || 'ייבאתי את התוכנית למסלול.', payload };
    }
    await client.query('COMMIT');
    const fresh = await pool.query('SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]);
    const side = await actions.sideState(pool, trip);
    res.json({ items: fresh.rows, side, state, message, imported: payload.imported, plan: areas });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('ai-import failed', err);
    res.status(client ? 500 : 503).json({ error: client ? ai.buildErrorMessage(err) : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
