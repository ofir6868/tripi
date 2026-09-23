// תכנון — the planning chat of a draft trip.
//
// A trip created "with AI" opens on this conversation instead of on a finished
// itinerary. The AI plans the trip WITH the traveller: it asks the clarifying questions
// the wizard used to pop up, offers to build everything at once or step by step, and in
// the step-by-step path settles the areas, the flights and one or two anchors a day —
// writing stops into the draft as it goes, through the same structured ops, the same
// place verification and the same writer the smart editor uses (routes/ai.js).
//
// Two things the transcript is not trusted to carry:
// - the trip's planning memory (mode, stage, settled facts, the day→area split) lives in
//   trips.plan_state and is handed to the model whole on every turn, so a decision from
//   twenty messages ago is never "forgotten";
// - the conversation itself is stored server-side (trip_plan_messages), one row per turn,
//   so it survives a phone swap — and the ops the AI proposed are read back from the row
//   it proposed them in, never from the client.
//
// Manual mode shows every change as a proposal card and writes it only on approval;
// automatic mode writes it on the spot and shows the same card, already done, with an
// undo. Same card, different default — which is also what keeps the model honest: it is
// told which mode it is in and phrases its text accordingly.
//
// The moment the draft is published the tab becomes the recommendations chat, and
// every route here answers 409 — a saved trip is edited on its page, not planned.
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { tripWithEditAuth, cleanPlanState, areasCoverTrip, tripPrefsBlock, PLAN_MODES, PLAN_STAGES } = require('../lib/trips');
const flights = require('../lib/flights');
const { dailyQuota, exhausted } = require('../lib/quota');
const ai = require('./ai');
const dayRecs = require('./day-recs');
const COUNTRIES = require('../public/js/countries.js');

const router = express.Router();

// Every turn on the strong model. The first cut ran the clarifying and choosing turns
// on the weak tier (no place is named there), but the chat is one voice and the two
// tiers answered in noticeably different registers — the traveller met a duller
// planner exactly when the tone is set. Twenty strong turns a day is the budget for
// that: about the cost of one build. AI_MODEL_PLAN overrides the model.
const PLAN_MODEL = process.env.AI_MODEL_PLAN || ai.AI_MODEL_STRONG;
const planMeter = dailyQuota('plan', 20); // turns per user per day; AI_QUOTA_PLAN overrides
const AI_PLAN_MAX_MESSAGE = 400;
const PLAN_HISTORY = 12; // turns the model sees; the settled facts carry the rest
const THREAD_LIMIT = 80; // rows the client loads
// a single broad destination is split into areas only from this length on: below it
// the trip lives in one area (a 4-day Crete stays one area — the cities are a matter
// for the days, not a region split), so the areas stage has nothing to ask
const SPLIT_AREAS_FROM_DAYS = 6;

const SUGGEST_STEPS = 'שלב אחרי שלב 🪜';
const SUGGEST_ONCE = 'בבת אחת ✨';
// The fork of the whole conversation, and the two buttons under it already name the
// options — so the text does not describe them a second time. The long version spelled
// out what each way covers ("מהאזורים, דרך הטיסות ועד מה עושים בכל יום"), and on a phone
// it pushed the buttons themselves toward the fold: the first thing to read became a
// paragraph instead of a choice. One line, and the choice right under it.
const READY_TEXT = 'איך נבנה אותו? 🧭 שלב אחרי שלב יוצא מדויק יותר — ותמיד אפשר לשנות.';

// A trip across several countries ("the big trip", South America) is never offered
// "בבת אחת": it goes straight from the clarifying round into the step-by-step path,
// one country at a time. A one-shot build of three countries hands one model turn
// three countries' worth of context, and the places it invents cluster exactly there
// (PLAYBOOK §3: the invented-place baseline is worst on secondary destinations).
// Step by step keeps each turn on one area, and the "fill the rest" build at the end
// is per-area anyway. The rule is enforced in code (build_now is dropped), not just
// asked of the model. Distinct countries, not distinct destinations: Prague + Vienna
// is two countries; Tokyo + Kyoto is one.
const SUGGEST_SPLIT = 'תציע חלוקה 🗺️';
// The opening question has to name the countries it is about. "מתחילים מהאזורים?"
// read as jargon on a three-country trip — the traveller could not tell which
// country was being asked about, or what an "area" was here.
const listNames = (names) => (names.length > 1
  ? `${names.slice(0, -1).join(', ')} ו${names[names.length - 1]}`
  : names[0] || '');
const stepwiseText = (names) => 'טיול בכמה מדינות בונים שלב אחרי שלב, מדינה בכל פעם. ' +
  `נתחיל מהחלוקה: כמה ימים בכל יעד ובאיזה סדר — ${listNames(names)}. יש לכם חלוקה בראש, או שאציע אחת?`;
function multiCountry(dests) {
  const ccs = new Set((dests || []).map((d) => COUNTRIES.ccByName(String((d && (d.country || d.name)) || '').trim())).filter(Boolean));
  return ccs.size >= 2;
}

// The moment the conversation stops being an opening round and becomes a trip. Until it
// lands, the trip page is a chat and nothing else — the itinerary is empty and there is
// nothing to recommend — so the page's dock waits behind a veil and arrives here, with a
// spark running its length (trip-pages.js). The AI says so itself, in a message of its
// own, and names the two ways on: the trip's own page, or another turn here.
// "The basics" are behind us once the conversation reaches the days: what kind of trip
// this is (clarify), how it gets built (choose), where the days go (areas) and how the
// trip is flown (flights) have all been answered. Not one stage earlier, and not because
// of how much was answered but because of what is ON SCREEN: areas and flights each have
// a card of their own in the chat, and a "we're done with the basics" underneath a card
// still waiting to be filled in contradicts it. By the days stage the itinerary also has
// something real in it — the flights are written as stops — so "go look at the route" is
// true when it is said. And not by stage alone: something must actually have been
// written down, since a trip can reach a stage with the model having settled nothing.
const SETTLED_STAGES = ['days', 'done'];
const basicsSettled = (state) => SETTLED_STAGES.includes(state.stage) && !!(state.facts.length || state.areas.length);
const BASICS_TEXT = 'קבענו את הבסיס! עכשיו מתחילים באמת — זה הזמן לצפות במסלול, לצפות בהמלצות ולקבוע תחנות. תמיד אפשר לחזור לכאן.';
const SUGGEST_CHAT_ON = "אני רוצה להמשיך בצ'אט";
// A tap on a card is written as the travellers' turn so the model hears it — it answers
// the decision, and the conversation moves on instead of stalling on a card that just
// got a tick. On screen, though, that line is a receipt for a button they watched
// themselves press, one bubble under the card that already shows the outcome. So it is
// marked as one and the chat doesn't paint it; the model reads it like any other turn.
const RECEIPT = { receipt: true };

// The turn the milestone lands on must not end on a question. What comes right under it
// hands the traveller the route and the choice of leaving the chat — and a question
// asked one bubble above that is a question walked away from, by the one who asked it.
// Where the milestone lands in practice — the flights card's confirmation — there is no
// model turn at all any more: the milestone IS the answer. This is for the other way in,
// a turn where the model takes the conversation to the days by itself; trailing question
// sentences are dropped from its text, and a turn that was nothing BUT a question is
// replaced by the line that closes the stage.
// The basics are in, so the free days' picks start here — not on a page the traveller
// has not opened yet. The pass reads the split and the flights that were just settled
// (routes/day-recs.js) and writes each day the moment it lands, so the itinerary they
// open seconds later is already filling in instead of starting from three skeletons a
// day when they get there. Fire and forget, and signed with the same signature the
// page's own request carries, so that request joins this pass instead of superseding
// it. A pass that fails leaves the day asking again from the page, as it does today.
function startDayRecs(trip, items, userId) {
  if (!process.env.OPENAI_API_KEY) return;
  try {
    dayRecs.regenerate(trip, {
      scope: 'auto',
      sig: dayRecs.planSignature(trip, items),
      ph: { distinctId: 'user_' + userId, traceId: randomUUID() },
    });
  } catch (err) {
    console.error('day-recs kickoff failed', err.message);
  }
}
const CLOSING_TEXT = 'זהו — הבסיס של הטיול סגור.';
const ENDS_IN_QUESTION = /\?[^\p{L}\p{N}]*$/u;
const WORDLESS = /^[^\p{L}\p{N}]*$/u;
function withoutTrailingQuestion(text) {
  const parts = String(text || '').trim().split(/(?<=[.!?…])\s+/);
  let end = parts.length;
  while (end > 0) {
    // an emoji of its own lands in a part of its own — it goes with the sentence it
    // belongs to, so a question's smiley is dropped with it and a statement's is kept
    let last = end;
    while (last > 0 && WORDLESS.test(parts[last - 1])) last--;
    if (last === 0 || !ENDS_IN_QUESTION.test(parts[last - 1])) break;
    end = last - 1;
  }
  return parts.slice(0, end).join(' ').trim() || CLOSING_TEXT;
}

const dayRange = (d, days) => Math.min(Math.max(parseInt(d, 10) || 1, 1), days);

// ---------- the thread ----------

const ROW_FIELDS = 'id, role, text, payload, created_at';
async function loadThread(tripId) {
  const { rows } = await pool.query(
    `SELECT ${ROW_FIELDS} FROM trip_plan_messages WHERE trip_id = $1 ORDER BY id DESC LIMIT $2`, [tripId, THREAD_LIMIT]
  );
  return rows.reverse();
}
async function addMessage(client, tripId, userId, role, text, payload = {}) {
  const { rows } = await client.query(
    `INSERT INTO trip_plan_messages (trip_id, user_id, role, text, payload) VALUES ($1,$2,$3,$4,$5) RETURNING ${ROW_FIELDS}`,
    [tripId, userId, role, text, JSON.stringify(payload)]
  );
  return rows[0];
}
async function saveState(client, tripId, state) {
  await client.query('UPDATE trips SET plan_state = $1 WHERE id = $2', [JSON.stringify(state), tripId]);
}
const loadItems = (client, tripId) => client.query(
  'SELECT * FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [tripId]
).then((r) => r.rows);

// a draft with edit rights, or nothing (the response is already written)
async function draftWithAuth(req, res) {
  const trip = await tripWithEditAuth(req, res);
  if (!trip) return null;
  if (!trip.is_draft) {
    res.status(409).json({ error: 'הטיול כבר נשמר — עורכים אותו בדף הטיול, וההמלצות ממשיכות בטאב ההמלצות' });
    return null;
  }
  trip.plan_state = cleanPlanState(trip.plan_state);
  trip.dests = Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : [];
  return trip;
}

// ---------- the opening turn: the clarifying round, without a model turn ----------
//
// The wizard's questions come from the same aiClarify the one-shot build uses — the
// prompt that learned (the hard way) to ask only about the route's structure. Here
// they open the conversation one at a time, as chips; the model takes over from the
// first reply.
async function openingMessage(client, trip, userId) {
  const state = trip.plan_state;
  const broadSingle = trip.dests.length === 1 && (!trip.dests[0].country || trip.dests[0].country === trip.dests[0].name);
  let questions = [];
  if ((trip.dests.length >= 2 || broadSingle) && process.env.OPENAI_API_KEY) {
    questions = await ai.aiClarify({
      dests: trip.dests, from: 1, to: trip.days,
      interestList: state.interests, freeText: state.notes,
      ph: { distinctId: 'user_' + userId, traceId: randomUUID() },
    }).catch(() => []);
  }
  // "פרו, בוליביה וארגנטינה" — three destinations strung together with a ו each
  // ("פרו ובוליביה וארגנטינה") read as a list nobody had proofread
  const where = listNames(trip.dests.map((d) => d.name)) || trip.destination;
  const hello = `היי! מתכננים יחד את הטיול ל${where} — ${trip.days} ימים. `;
  let text, payload;
  if (questions.length) {
    state.stage = 'clarify';
    state.pending = questions.map((q) => ({ question: q.question, options: q.options, multi: !!q.multi }));
    const q = state.pending[0];
    text = hello + 'שאלה קטנה קודם: ' + q.question;
    payload = { suggestions: q.options.slice(0, 6), multi: q.multi };
  } else if (multiCountry(trip.dests)) {
    // no choice to make: several countries start on the areas step right away
    state.stage = 'areas';
    state.build = 'steps';
    text = hello + stepwiseText(trip.dests.map((d) => d.name));
    payload = { suggestions: [SUGGEST_SPLIT] };
  } else {
    state.stage = 'choose';
    text = hello + READY_TEXT;
    payload = { suggestions: [SUGGEST_STEPS, SUGGEST_ONCE] };
  }
  state.opened = true;
  const row = await addMessage(client, trip.id, null, 'ai', text, payload);
  await saveState(client, trip.id, state);
  return row;
}

// ---------- one turn ----------

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

const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'stage', 'build_now', 'approve_pending', 'trip_ready', 'suggestions', 'facts', 'pending_questions', 'areas', 'flights', 'cards', 'ops'],
  properties: {
    text: { type: 'string' },
    stage: { type: 'string', enum: PLAN_STAGES },
    build_now: { type: 'boolean' },
    approve_pending: { type: 'boolean' },
    trip_ready: { type: 'boolean' },
    suggestions: { type: 'array', items: { type: 'string' } },
    facts: { type: 'array', items: { type: 'string' } },
    pending_questions: { type: 'array', items: { type: 'string' } },
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'day_from', 'day_to', 'cities'],
        properties: {
          area: { type: 'string' },
          day_from: { type: 'integer' },
          day_to: { type: 'integer' },
          cities: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'place_query', 'blurb', 'category', 'duration', 'cost', 'time', 'area'],
        properties: {
          title: { type: 'string' },
          place_query: { type: 'string' },
          blurb: { type: 'string' },
          category: { type: 'string', enum: ai.REC_CATS },
          duration: { type: 'string' },
          cost: { type: 'string', enum: ['חינם', '₪', '₪₪', '₪₪₪'] },
          time: { type: 'string' },
          area: { type: 'string' },
        },
      },
    },
    ops: { type: 'array', items: OP_SCHEMA },
    // the flights card's opening values, and the ONLY thing the model is asked about
    // flights: which airports, on which day, through where. Never hours — it does not
    // know them, and a departure it made up is a flight somebody misses. Codes are
    // checked against public/js/airports.js; one that isn't there drops the whole plan
    // back to the one this server worked out from the trip itself.
    flights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'day', 'from', 'to', 'via'],
        properties: {
          kind: { type: 'string', enum: ['out', 'inner', 'return'] },
          day: { type: 'integer' },
          from: { type: 'string' },
          to: { type: 'string' },
          via: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// the itinerary as the editor prompt shows it — id, day, clock, category, title, area
function itineraryLines(items, multiArea) {
  return items.map((it) =>
    `#${it.id} | יום ${it.day_number} | ${it.time_label || '--:--'} | [${it.category || 'כללי'}] ${it.title}` +
    (multiArea && it.area ? ` | אזור: ${it.area}` : '') +
    (it.place_query ? ` | ${it.place_query}` : '')).join('\n') || '(המסלול עדיין ריק)';
}

// a proposed/applied change as one Hebrew line — for the card, and for the history the
// model reads back ("what did I propose last turn, and was it taken?")
function describeOp(op, byId) {
  const when = (o, cur) => {
    const d = o.day_number != null ? o.day_number : (cur ? cur.day_number : null);
    const t = o.time_label != null ? o.time_label : (cur ? cur.time_label : null);
    return d != null ? `יום ${d}${t ? ' · ' + t : ''}` : '';
  };
  if (op.action === 'add') return { kind: 'add', title: op.title, when: when(op), note: op.note || '' };
  const cur = byId.get(op.id);
  if (op.action === 'delete') return { kind: 'delete', title: cur ? cur.title : `#${op.id}`, when: cur ? when({}, cur) : '' };
  const changes = [];
  if (op.day_number != null && cur && op.day_number !== cur.day_number) changes.push(`ליום ${op.day_number}`);
  if (op.time_label != null && cur && op.time_label !== cur.time_label) changes.push(`לשעה ${op.time_label}`);
  if (op.title != null && cur && op.title !== cur.title) changes.push(`שם: ${op.title}`);
  if (op.place_query != null) changes.push('מקום אחר');
  if (op.note != null) changes.push('הערה');
  if (op.category != null && cur && op.category !== cur.category) changes.push(op.category);
  if (op.area != null && cur && op.area !== cur.area) changes.push(`אזור ${op.area}`);
  return { kind: 'update', title: cur ? cur.title : `#${op.id}`, when: cur ? when(op, cur) : '', changes };
}

function turnPrompt({ trip, items, state, mode, history, pendingProposal, stepwise = false }) {
  const dests = trip.dests;
  const areaNames = dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
  const multiArea = areaNames.length > 1;
  // a day→area split is worth discussing only when the trip has room for more than one
  // area: several destinations, or a single broad one long enough to move between regions
  const splitAreas = multiArea || trip.days >= SPLIT_AREAS_FROM_DAYS;
  const dates = trip.start_date ? `, מתאריך ${String(trip.start_date).slice(0, 10)}` : ' (בלי תאריכים עדיין)';
  const perDay = [];
  for (let d = 1; d <= trip.days; d++) perDay.push(items.filter((it) => it.day_number === d).length);

  const system =
`אתם המתכנן האישי של TRIP MAKER: מומחה טיולים שמכיר את ${ai.destDescFull(dests) || trip.destination} לעומק, ובונים יחד עם מטיילים ישראלים את הטיול המושלם עבורם — בשיחה.
עונים בעברית, בגוף רבים ("אתם"), בחום, בקצרה ובענייניות. השדה text — עד 90 מילים, בלי רשימות ארוכות.

המטרה: לא להמליץ אלא לעשות. אתם בונים ועורכים את תחנות הטיול בעצמכם דרך ops, ושואלים את המטיילים רק את מה שבאמת משנה את הטיול. בכל תור: הצעה קונקרטית + לכל היותר שאלה אחת.

שלבי התכנון (stage) — התקדמו לפי הסדר, אבל תמיד ענו קודם על מה שהמטיילים שאלו:
${stepwise
    // several countries: the "all at once" fork is not on the menu — the clarifying
    // round flows into the areas step, and a request to build everything now is
    // answered by the next step, not by a build (build_now is dropped in code too)
    ? `- clarify: יש שאלות הבהרה פתוחות (ברשימה למטה). שאלו אחת בכל תור, בדיוק כלשונה, עם ה-suggestions שלה. תשובה שהתקבלה נרשמת ב-facts ויורדת מ-pending_questions. כשנגמרו — עברו ישר ל-areas והתחילו.
- choose: לא קיים בטיול הזה. טיול בכמה מדינות נבנה תמיד שלב אחרי שלב, מדינה אחת בכל פעם — build_now תמיד false. אם המטיילים מבקשים לבנות הכול בבת אחת: משפט אחד שמסביר שבטיול של כמה מדינות בונים אזור אחרי אזור כדי שכל מדינה תקבל תשומת לב, ומיד הצעד הבא של השלב הנוכחי.`
    : `- clarify: יש שאלות הבהרה פתוחות (ברשימה למטה). שאלו אחת בכל תור, בדיוק כלשונה, עם ה-suggestions שלה. תשובה שהתקבלה נרשמת ב-facts ויורדת מ-pending_questions. כשנגמרו — עברו ל-choose ואמרו: "${READY_TEXT}" עם suggestions ["${SUGGEST_STEPS}", "${SUGGEST_ONCE}"].
- choose: המטיילים בוחרים. "בבת אחת" (או ניסוח דומה: הכול, מהר, תבנה לבד) → build_now=true, ops ריק, text קצר שמודיע שבונים עכשיו. "שלב אחרי שלב" (או ניסוח דומה) → stage=areas והתחילו.`}
- areas: לקבוע יחד את האזורים וחלוקת הימים. ${splitAreas
    ? `הציעו חלוקה קונקרטית (אזור, ימים, ערים) והחזירו אותה מיד ב-areas (רצף ימים מלא מ-1 עד ${trip.days}, בלי חורים) — המטיילים רואים אותה על לוח שנה ויכולים לצבוע ימים ולשנות; בקשו אישור. כשהוסכם (או כשהמטיילים אישרו חלוקה מהלוח) — עברו ל-flights. אזור = חבל ארץ נפרד שלנים בו (לא עיר ליום): כשכל הטיול נשאר באזור אחד — אל תחלקו, החזירו areas ריק ועברו ישר ל-flights.`
    : `בטיול הזה יש אזור אחד (${areaNames[0] || trip.destination}) — אין מה לחלק ואין מה לשאול: החזירו areas ריק ועברו ישר ל-flights. את הערים והמקומות מתכננים בשלב days, יום אחרי יום.`}
- flights: **אל תשאלו על טיסות בשיחה ואל תיצרו תחנות טיסה ב-ops.** המטיילים מקבלים כרטיס טיסות ממולא מראש ומתקנים בו מה שצריך — שדות תעופה, יום, שעות (לא חובה) ועצירות ביניים. מה שמוטל עליכם: להחזיר ב-flights את ההצעה שלכם לשדות התעופה — קודי IATA אמיתיים בלבד, kind מתוך out (הלוך, יום 1), inner (טיסה פנימית בין אזורים, ביום שבו האזור מתחלף) ו-return (חזור, יום ${trip.days}), ו-via רק כשקונקשן הוא באמת הדרך המקובלת. בלי שעות — אתם לא יודעים אותן, והכרטיס מבקש אותן מהמטיילים. ב-text: משפט אחד שאומר שמילאתם הצעה ושאפשר לשנות הכול בכרטיס. כשהמטיילים מאשרים את הכרטיס — הטיסות נכנסות למסלול לבד והשלב עובר ל-days.
- days: אזור אחרי אזור, יום אחרי יום: הציעו 1-2 עוגנים ליום — מקומות אמיתיים ומוכרים שמתאימים למטיילים — ובקשו אישור או שינוי. אל תמלאו ימים בתחנות רבות או ספציפיות מדי; את השאר משלימים אוטומטית בסוף. ביום שבו מתחלף אזור — תחנת נסיעה אחת שמתארת את המעבר.
- done: כל הימים נדונו. הציעו להשלים את שאר התחנות אוטומטית (יש למטיילים כפתור לזה), או להמשיך לחקור.
בכל שלב אפשר לחקור: כשהמטיילים שואלים "מה יש ב…", "מה כדאי", "איפה אוכלים" — ענו ב-text והראו 2-3 cards של מקומות אמיתיים (עם תמונות בצד שלנו). cards הן להצגה בלבד — הן לא תחנות; תחנה נכנסת רק דרך ops.

מצב עבודה: ${mode === 'auto'
    ? 'אוטומטי — ה-ops שלכם מתבצעים מיד בלי אישור. נסחו ב-text מה עשיתם ("הוספתי…", "הזזתי…") ומה השאלה הבאה.'
    : 'ידני — ה-ops שלכם מוצגים למטיילים ככרטיס הצעה ומתבצעים רק אחרי אישור. נסחו ב-text כהצעה ("אני מציע להוסיף…") וסיימו ב"מאשרים?" או בשאלה הבאה.'}
${pendingProposal ? `יש הצעה קודמת שלכם שממתינה לאישור: ${pendingProposal}. אם המטיילים מאשרים אותה במילים ("כן", "סבבה", "מאשר") — החזירו approve_pending=true ו-ops ריק. אם הם מבקשים שינוי — החזירו ops חדש במקומה.` : 'approve_pending תמיד false.'}

trip_ready: true רק כשהטיול נראה מגובש — האזורים והטיסות סגורים ולרוב הימים יש לפחות עוגן אחד (או שנבנה כולו). אז המטיילים יקבלו הצעה להזמין חברים לתכנון משותף; אל תכתבו את ההצעה הזו בעצמכם ב-text.
facts: הרשימה המלאה והמעודכנת של מה שכבר הוסכם או נודע (העדפות, תשובות, החלטות, טיסות) — עד 20 שורות קצרות. שמרו את הקיימות והוסיפו חדשות; זו הזיכרון שלכם.
suggestions: 0-3 תשובות קצרות (עד 5 מילים) שסביר שהמטיילים ירצו לענות עכשיו — לא שאלות שלכם.
areas: [] כשאין שינוי בחלוקה; אחרת החלוקה המלאה. day_from/day_to בין 1 ל-${trip.days}.
flights: [] בכל שלב שאינו flights, וגם ב-flights ברגע שהכרטיס כבר מולא — ממלאים אותו פעם אחת, והתיקונים של המטיילים בכרטיס גוברים על כל הצעה שלכם.

חוקי ops (כמו בעורך המסלולים): add חייב title קצר בעברית, note טיפ פרקטי קצר בעברית, time_label בפורמט HH:MM (או null כשלא ידוע), day_number בין 1 ל-${trip.days}; place_query באנגלית וכולל תמיד עיר ומדינה (למשל "Nishiki Market, Kyoto, Japan") ורק למקום אמיתי וספציפי — לתחנה כללית או לטיסה החזירו null; cost הערכה לאדם בש"ח (מספר שלם) או null; category מתוך: ${ai.AI_CATEGORIES.join(', ')}${multiArea ? `; area מתוך: ${areaNames.join(', ')}` : `; area תמיד "${areaNames[0] || trip.destination}"`}. update/delete חייבים id של תחנה קיימת מהמסלול למטה, וב-update null בכל שדה שלא משתנה. אל תיגעו בתחנות שהמטיילים לא ביקשו לשנות. כל מקום ב-ops או ב-cards חייב להיות מקום שקיים באמת ושאתם בטוחים בשמו.`;

  const facts = state.facts.length ? state.facts.map((f) => `- ${f}`).join('\n') : '(עדיין אין)';
  const areasLine = state.areas.length
    ? state.areas.map((a) => `${a.area}: ימים ${a.from}-${a.to}${a.cities.length ? ` (${a.cities.join(', ')})` : ''}`).join(' | ')
    : '(טרם נקבעה)';
  const pending = state.pending.length
    ? state.pending.map((q) => `- ${q.question}${q.options.length ? ` [אפשרויות: ${q.options.join(' / ')}${q.multi ? ' — אפשר לבחור כמה' : ''}]` : ''}`).join('\n')
    : '(אין)';
  const turns = history.map((h) => `${h.role === 'user' ? 'מטיילים' : 'מתכנן'}: ${h.text}`).join('\n');

  const user =
`הטיול: "${trip.title}" — ${ai.destDescFull(dests) || trip.destination}, ${trip.days} ימים${dates}.
${tripPrefsBlock(state, { facts: false })}שלב נוכחי: ${state.stage}.
מה שכבר הוסכם (facts):
${facts}
חלוקת האזורים: ${areasLine}
שאלות הבהרה שטרם נשאלו:
${pending}
המסלול הנוכחי (כל שורה: #מזהה | יום | שעה | [קטגוריה] כותרת | מקום):
${itineraryLines(items, multiArea)}
עומס (תחנות ליום): ${perDay.map((c, i) => `${i + 1}:${c}`).join(' ')}

השיחה האחרונה:
${turns}`;
  return { system, user };
}

// what the history shows the model about an AI turn beyond its text: the fate of the
// changes it carried
function historyLine(row) {
  const p = row.payload || {};
  if (row.role === 'user' || !Array.isArray(p.changes) || !p.changes.length) return row.text;
  const fate = { pending: 'ממתין לאישור', applied: 'בוצע', rejected: 'נדחה', undone: 'בוטל' }[p.decision] || '';
  return `${row.text} [שינויים: ${p.changes.map((c) => c.title).join(', ')} — ${fate}]`;
}

// the model's areas → the state's, only when they cover the trip properly. Blocks
// arrive in two shapes: the model's (day_from/day_to) and the calendar card's
// (from/to, the same shape the state keeps) — both are read.
function cleanAreas(raw, days) {
  const blocks = (Array.isArray(raw) ? raw : []).map((a) => ({
    area: String(a?.area || '').slice(0, 60).trim(),
    from: parseInt(a?.day_from ?? a?.from, 10), to: parseInt(a?.day_to ?? a?.to, 10),
    cities: (Array.isArray(a?.cities) ? a.cities : []).slice(0, 3).map((c) => String(c).slice(0, 60).trim()).filter(Boolean),
  })).filter((a) => a.area && Number.isInteger(a.from) && Number.isInteger(a.to) && a.from >= 1 && a.to <= days && a.to >= a.from)
    .sort((a, b) => a.from - b.from);
  if (!blocks.length || blocks.length > 12) return null;
  for (let i = 1; i < blocks.length; i++) if (blocks[i].from <= blocks[i - 1].to) return null;
  return blocks;
}

// The flights card's opening values, filled in ONCE — the turn that first reaches the
// flights stage. The model's airports when it named real ones, the trip's own geography
// otherwise (lib/flights.js), and after that nobody overwrites them: from here on the
// card is the travellers', and a later turn that happens to mention flights must not
// wipe an hour they typed.
function seedFlights(trip, state, modelLegs = null) {
  if (state.stage !== 'flights' || state.flights) return;
  state.flights = { legs: modelLegs || flights.defaultLegs(trip, state), confirmed: false, items: [] };
}

async function planTurn({ trip, items, state, mode, history, message, pendingProposal, ph }) {
  const stepwise = multiCountry(trip.dests);
  const { system, user } = turnPrompt({ trip, items, state, mode, history, pendingProposal, stepwise });
  const raw = await ai.aiJson({
    system,
    user: user + `\n\nההודעה החדשה של המטיילים:\n${message}`,
    schemaName: 'plan_turn',
    schema: TURN_SCHEMA,
    maxTokens: 3000,
    timeoutMs: 60000,
    model: PLAN_MODEL,
    ph,
  });
  if (!raw) return null;
  const dests = trip.dests;
  const areaNames = dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
  // the same verification the smart editor's ops get — invented places repaired or
  // dropped, foreign ones dropped, coordinates attached
  const verified = await ai.verifyEditOps({ ops: Array.isArray(raw.ops) ? raw.ops.slice(0, 40) : [] }, {
    items, dests, destText: trip.destination, title: trip.title, ph,
  });
  const { cards } = await ai.verifyRecCards((raw.cards || []).slice(0, 3), { dests, areaNames });
  return {
    text: String(raw.text || '').trim().slice(0, 1200),
    stage: PLAN_STAGES.includes(raw.stage) ? raw.stage : state.stage,
    // several countries never build in one shot, whatever the model answered
    buildNow: !!raw.build_now && !stepwise,
    approvePending: !!raw.approve_pending,
    tripReady: !!raw.trip_ready,
    suggestions: (raw.suggestions || []).slice(0, 3).map((s) => String(s).slice(0, 60).trim()).filter(Boolean),
    facts: (raw.facts || []).slice(0, 24).map((s) => String(s).slice(0, 160).trim()).filter(Boolean),
    pendingQuestions: (raw.pending_questions || []).map((s) => String(s).slice(0, 200).trim()).filter(Boolean),
    areas: cleanAreas(raw.areas, trip.days),
    // null when the model named an airport that is not in the index — the defaults this
    // server worked out from the trip stand instead (lib/flights.js)
    flights: flights.legsFromModel(raw.flights, trip.days),
    cards,
    ops: verified.ops || [],
  };
}

// what a turn does to the trip and its memory, inside one transaction: facts, areas
// and pending questions folded into the state; the ops written (auto) or parked on the
// message as a proposal (manual); a spoken "yes" applied to the proposal it answered.
// Returns the AI's stored row, the fresh item list when anything was written, and the
// id of the earlier proposal a spoken approval flipped.
async function recordTurn(client, trip, state, items, turn, waiting) {
  // the memory: facts replace, areas replace when valid, pending questions shrink to
  // what the model says is left (never grow — it cannot invent a clarifying question)
  state.stage = turn.stage;
  if (turn.facts.length || state.facts.length) state.facts = turn.facts.length ? turn.facts : state.facts;
  if (turn.areas) state.areas = turn.areas;
  if (state.pending.length) {
    const left = new Set(turn.pendingQuestions);
    state.pending = state.pending.filter((q) => left.has(q.question));
    if (state.stage === 'clarify' && !state.pending.length) state.stage = 'choose';
  }
  if (turn.buildNow) { state.build = 'once'; state.stage = 'choose'; }
  else if (state.stage !== 'clarify' && state.stage !== 'choose') state.build = 'steps';
  seedFlights(trip, state, turn.flights);

  const byId = new Map(items.map((it) => [it.id, it]));
  const payload = {
    suggestions: turn.suggestions,
    cards: turn.cards,
    build: turn.buildNow ? 'once' : null,
  };
  // the trip looks settled: one invitation to bring co-planners in, offered once
  if (turn.tripReady && !state.invited && !turn.buildNow) { payload.invite = true; state.invited = true; }
  let fresh = null;
  let approvedId = null;
  await client.query('BEGIN');
  if (turn.approvePending && waiting) {
    // "yes" in words: the proposal that was waiting is written, and its own card
    // flips to done — the new turn carries no changes of its own
    const cur = await loadItems(client, trip.id);
    const r = await ai.applyEditOps(client, trip, cur, waiting.payload.ops || []);
    const changed = r.added + r.updated + r.removed > 0;
    await client.query(
      `UPDATE trip_plan_messages SET payload = payload || $1 WHERE id = $2`,
      [JSON.stringify({ decision: changed ? 'applied' : 'rejected', undo: changed ? r.undoOps : null, applied: { added: r.added, updated: r.updated, removed: r.removed } }), waiting.id]
    );
    approvedId = waiting.id;
    fresh = await loadItems(client, trip.id);
  } else if (turn.ops.length) {
    payload.ops = turn.ops;
    payload.changes = turn.ops.map((op) => describeOp(op, byId));
    if (state.mode === 'auto') {
      const r = await ai.applyEditOps(client, trip, items, turn.ops);
      const changed = r.added + r.updated + r.removed > 0;
      payload.decision = changed ? 'applied' : 'rejected';
      payload.undo = changed ? r.undoOps : null;
      payload.applied = { added: r.added, updated: r.updated, removed: r.removed };
      fresh = await loadItems(client, trip.id);
    } else {
      payload.decision = 'pending';
    }
  }
  // the basics just landed: this turn closes the stage instead of opening the next one,
  // a second message from the AI marks it, and the dock arrives under that. Stored rows,
  // not a flourish the client invents — they have to still be there after a reload, and
  // the milestone's chip is a real suggestion for the next turn.
  const landing = !state.basics && basicsSettled(state);
  const row = await addMessage(client, trip.id, null, 'ai', landing ? withoutTrailingQuestion(turn.text) : turn.text, payload);
  let milestone = null;
  if (landing) {
    state.basics = true;
    milestone = await addMessage(client, trip.id, null, 'ai', BASICS_TEXT, { unlocked: true, suggestions: [SUGGEST_CHAT_ON] });
  }
  await saveState(client, trip.id, state);
  await client.query('COMMIT');
  return { row, fresh, approvedId, milestone };
}

// ---------- routes ----------

// the thread + the planning memory; the opening message is minted on the first load
router.get('/api/trips/code/:code/plan', authRequired, async (req, res) => {
  // the client is checked out only for the one transaction that needs it, AFTER the
  // pool-based reads: on a serverless instance (lib/db.js) a client held across those
  // reads is a connection the reads then wait for — this route is where that froze
  // production on 2026-09-23
  let client = null;
  try {
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    let messages = await loadThread(trip.id);
    if (!messages.length) {
      client = await pool.connect();
      await client.query('BEGIN');
      messages = [await openingMessage(client, trip, req.user.id)];
      await client.query('COMMIT');
    }
    // a chat reopened at the flights stage — a reload, another co-planner's phone — must
    // find the card filled, even when the turn that moved it here predates this code
    if (trip.plan_state.stage === 'flights' && !trip.plan_state.flights) {
      seedFlights(trip, trip.plan_state);
      await saveState(pool, trip.id, trip.plan_state).catch(() => { /* the next turn seeds it again */ });
    }
    res.json({ state: trip.plan_state, messages });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

// the mode switch beside the composer, and the day→area split repainted on the
// chat's calendar card — both remembered per trip, for every co-planner
router.patch('/api/trips/code/:code/plan', authRequired, async (req, res) => {
  try {
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    let touched = false;
    if (b.mode !== undefined) {
      if (!PLAN_MODES.includes(b.mode)) return res.status(400).json({ error: 'מצב לא מוכר' });
      trip.plan_state.mode = b.mode;
      touched = true;
    }
    if (b.areas !== undefined) {
      const areas = cleanAreas(b.areas, trip.days);
      // the split saved here is the one that counts — the picks for the free days read
      // it instead of asking the model for a split of their own (routes/day-recs.js),
      // so it is stored only when it covers the whole trip, by that same definition
      if (!areas || !areasCoverTrip(areas, trip.days)) {
        return res.status(400).json({ error: 'חלוקת האזורים צריכה לכסות את כל ימי הטיול ברצף' });
      }
      trip.plan_state.areas = areas;
      touched = true;
    }
    if (!touched) return res.status(400).json({ error: 'אין מה לעדכן' });
    await saveState(pool, trip.id, trip.plan_state);
    res.json({ state: trip.plan_state });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// The flights card, confirmed. This is the whole flights stage now: no model call
// decides anything here, because nothing here is a judgement — the travellers named two
// airports, a day and, if they knew them, two hours, and those become stops exactly as
// written (lib/flights.js). Re-confirming replaces the stops the card wrote last time
// rather than laying a second set of flights beside them.
//
// The AI still hears it, the way it hears an approved proposal on the card in /decide:
// the confirmation is written as the travellers' turn and answered like one, so the
// conversation moves on to the days by itself instead of stalling on a card that just
// got a tick. A spent quota costs the answer, never the flights — those are already in.
router.post('/api/trips/code/:code/plan/flights', authRequired, async (req, res) => {
  let client = null;
  try {
    client = await pool.connect();
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    const state = trip.plan_state;
    const skip = !!(req.body || {}).skip;
    const cleaned = skip ? null : flights.cleanFlights({ legs: (req.body || {}).legs }, trip.days);
    const legs = cleaned ? cleaned.legs : [];
    if (!skip && !legs.length) return res.status(400).json({ error: 'צריך לפחות טיסה אחת — או לדלג על השלב' });
    // the flights stage is the one this confirmation ends; reopened later (a traveller
    // who finally has their hours) it changes the stops and leaves the conversation alone
    const advancing = state.stage === 'flights';

    await client.query('BEGIN');
    // the stops the previous confirmation wrote, and only those: a flight somebody added
    // by hand in the itinerary is theirs, not this card's, and stays
    const previous = (state.flights && state.flights.items) || [];
    if (previous.length) {
      await client.query('DELETE FROM trip_items WHERE trip_id = $1 AND id = ANY($2::int[])', [trip.id, previous]);
    }
    const written = [];
    for (const row of flights.flightItems(legs, trip, state)) {
      const { rows } = await client.query(
        `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, category, area, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE((SELECT MAX(sort_order)+1 FROM trip_items WHERE trip_id=$1), 0))
         RETURNING id`,
        [trip.id, row.day_number, row.time_label, row.title, row.note, row.category, row.area]
      );
      written.push(rows[0].id);
    }
    state.flights = { legs, confirmed: true, items: written };
    if (advancing) state.stage = 'days';
    // the planning memory carries the flights in words too: the model reads facts on
    // every turn, and "when do we land on day 1" is a question the days stage asks
    const kept = state.facts.filter((f) => !/^(הלוך|חזור|טיסה פנימית) ·/.test(f));
    state.facts = [...kept, ...legs.map((l) => flights.legLine(l))].slice(-24);
    const said = (skip
      ? 'אין לנו עדיין פרטי טיסות — נמשיך לתכנן את הימים'
      : `✓ ${advancing ? 'אישרנו' : 'עדכנו'} את הטיסות: ${flights.legsSummary(legs)}`).slice(0, AI_PLAN_MAX_MESSAGE);
    await addMessage(client, trip.id, req.user.id, 'user', said, RECEIPT);
    await saveState(client, trip.id, state);
    await client.query('COMMIT');

    const items = await loadItems(pool, trip.id);
    // reopened from the days stage, the answer is not a judgement — it is a receipt, and
    // a model turn for it would cost a message from the day's allowance to say so
    if (!advancing) {
      await client.query('BEGIN');
      const row = await addMessage(client, trip.id, null, 'ai',
        legs.length ? `עדכנתי את הטיסות במסלול: ${flights.legsSummary(legs)}` : 'הסרתי את תחנות הטיסה מהמסלול.');
      await client.query('COMMIT');
      return res.json({ items, state, said, follow: row });
    }
    // This confirmation is where the basics land, and there the milestone is the whole
    // answer: one message that says the basics are settled and hands over the route.
    // Asking the model for a line to sit above it bought nothing — it cost a message from
    // the day's allowance to say what the milestone says better, and left the traveller
    // reading two bubbles where one was the point. The days start on the next turn, which
    // is what the chip under the message is for.
    if (!state.basics && basicsSettled(state)) {
      await client.query('BEGIN');
      state.basics = true;
      const row = await addMessage(client, trip.id, null, 'ai', BASICS_TEXT, { unlocked: true, suggestions: [SUGGEST_CHAT_ON] });
      await saveState(client, trip.id, state);
      await client.query('COMMIT');
      startDayRecs(trip, items, req.user.id);
      return res.json({ items, state, said, milestone: row });
    }
    const quota = await planMeter.check(req);
    if (!quota || !process.env.OPENAI_API_KEY) return res.json({ items, state, said, quota: quota ? undefined : 'plan' });
    const thread = await loadThread(trip.id);
    const history = thread.slice(-PLAN_HISTORY).map((m) => ({ role: m.role, text: historyLine(m) }));
    const turn = await planTurn({
      trip, items, state, mode: state.mode, history,
      message: said + (skip
        ? '\n(אין פרטי טיסות. אל תשאלו עליהן שוב — המשיכו לשלב days: האזור הראשון, יום 1.)'
        : '\n(הטיסות כבר נכתבו למסלול — אל תציעו אותן שוב ואל תשאלו עליהן. המשיכו לשלב days: האזור הראשון, יום 1.)'),
      pendingProposal: null,
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (!turn) return res.json({ items, state, said });
    quota.spend();
    const answer = await recordTurn(client, trip, state, items, turn, null);
    res.json({ items: answer.fresh || items, state, said, follow: answer.row, milestone: answer.milestone, remaining: quota.remaining });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

router.post('/api/trips/code/:code/plan', authRequired, async (req, res) => {
  let client = null;
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'התכנון עם ה-AI לא זמין כרגע' });
    client = await pool.connect();
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    const b = req.body || {};
    const message = String(b.message || '').trim();
    if (!message) return res.status(400).json({ error: 'כתבו משהו' });
    if (message.length > AI_PLAN_MAX_MESSAGE) return res.status(400).json({ error: `ההודעה ארוכה מדי — עד ${AI_PLAN_MAX_MESSAGE} תווים` });
    const state = trip.plan_state;
    if (PLAN_MODES.includes(b.mode)) state.mode = b.mode;

    const quota = await planMeter.check(req);
    if (!quota) return exhausted(res, 'plan', 'ניצלתם את הודעות התכנון להיום — אפשר להמשיך לתכנן ידנית, ואני כאן שוב מחר');

    const items = await loadItems(client, trip.id);
    const thread = await loadThread(trip.id);
    // the last proposal still waiting for a word — the model is told, so a spoken
    // "yes" lands on it instead of on a fresh copy
    const waiting = [...thread].reverse().find((m) => m.role === 'ai' && m.payload && m.payload.decision === 'pending');
    const pendingProposal = waiting ? waiting.payload.changes.map((c) => c.title).join(', ') : null;
    const history = thread.slice(-PLAN_HISTORY).map((m) => ({ role: m.role, text: historyLine(m) }));

    // the traveller's turn is stored first: a model failure still leaves what they said
    await client.query('BEGIN');
    // a confirmation the client sent for the traveller (the area calendar's) is a receipt
    // like the card ones: the model hears it, the chat doesn't paint it
    await addMessage(client, trip.id, req.user.id, 'user', message.slice(0, AI_PLAN_MAX_MESSAGE), b.receipt ? RECEIPT : {});
    await client.query('COMMIT');

    const turn = await planTurn({
      trip, items, state, mode: state.mode, history, message, pendingProposal,
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (!turn) return res.status(502).json({ error: 'ה-AI לא הצליח לענות — נסו שוב עוד רגע' });
    quota.spend();

    const { row, fresh, approvedId, milestone } = await recordTurn(client, trip, state, items, turn, waiting);
    if (milestone) startDayRecs(trip, fresh || items, req.user.id);

    res.json({
      message: row,
      milestone,
      state,
      items: fresh,
      approved_message_id: approvedId,
      remaining: quota.remaining,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

// the card's buttons: accept writes the proposal stored in that turn; reject marks it;
// undo replays the inverse of an applied one (the latest only — later changes may
// stand on it)
router.post('/api/trips/code/:code/plan/decide', authRequired, async (req, res) => {
  let client = null;
  try {
    client = await pool.connect();
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    const id = parseInt(req.body && req.body.message_id, 10);
    const decision = req.body && req.body.decision;
    if (!Number.isInteger(id) || !['accept', 'reject', 'undo'].includes(decision)) {
      return res.status(400).json({ error: 'בקשה לא תקינה' });
    }
    const { rows } = await pool.query(
      `SELECT ${ROW_FIELDS} FROM trip_plan_messages WHERE id = $1 AND trip_id = $2 AND role = 'ai'`, [id, trip.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'ההודעה לא נמצאה' });
    const p = row.payload || {};
    // every refusal is decided before the transaction opens — a return from inside
    // one would hand the pool back a connection with BEGIN still hanging on it
    if (decision === 'undo') {
      if (p.decision !== 'applied' || !p.undo) return res.status(409).json({ error: 'אין כאן שינוי לבטל' });
      const { rows: later } = await pool.query(
        `SELECT 1 FROM trip_plan_messages WHERE trip_id = $1 AND id > $2 AND payload->>'decision' = 'applied' LIMIT 1`, [trip.id, id]
      );
      if (later.length) return res.status(409).json({ error: 'יש שינויים חדשים יותר — אפשר לבטל רק את האחרון' });
    } else if (p.decision !== 'pending') {
      return res.status(409).json({ error: 'ההצעה הזו כבר הוכרעה' });
    }
    const patch = {};
    await client.query('BEGIN');
    if (decision === 'undo') {
      await ai.undoApplied(client, trip, p.undo);
      patch.decision = 'undone';
      patch.undo = null;
    } else if (decision === 'reject') {
      patch.decision = 'rejected';
    } else {
      const items = await loadItems(client, trip.id);
      const r = await ai.applyEditOps(client, trip, items, p.ops || []);
      const changed = r.added + r.updated + r.removed > 0;
      patch.decision = changed ? 'applied' : 'rejected';
      patch.undo = changed ? r.undoOps : null;
      patch.applied = { added: r.added, updated: r.updated, removed: r.removed };
    }
    const { rows: upd } = await client.query(
      `UPDATE trip_plan_messages SET payload = payload || $1 WHERE id = $2 RETURNING ${ROW_FIELDS}`, [JSON.stringify(patch), id]
    );
    const items = await loadItems(client, trip.id);
    await client.query('COMMIT');

    // A tap on the card is an answer, and the AI has to hear it or the conversation
    // stalls right after its first proposal — the traveller approved, and nothing came
    // next. So the decision is written as their turn and answered like one: after an
    // approval the AI moves to the next step, after a refusal it offers another way.
    // An undo is not a reply. A spent quota skips the answer, and says so.
    if (decision === 'undo') return res.json({ message: upd[0], items });
    const titles = (p.changes || []).map((c) => c.title).join(', ');
    const said = decision === 'accept'
      ? `✓ אישרתי את השינויים${titles ? ': ' + titles : ''}`
      : `לא עכשיו — בלי ${titles || 'ההצעה הזו'}`;
    const quota = await planMeter.check(req);
    await client.query('BEGIN');
    await addMessage(client, trip.id, req.user.id, 'user', said, RECEIPT);
    await client.query('COMMIT');
    if (!quota) return res.json({ message: upd[0], items, quota: 'plan' });
    const state = trip.plan_state;
    const thread = await loadThread(trip.id);
    const history = thread.slice(-PLAN_HISTORY).map((m) => ({ role: m.role, text: historyLine(m) }));
    const turn = await planTurn({
      trip, items, state, mode: state.mode, history,
      message: said + (decision === 'accept'
        ? '\n(השינויים כבר בוצעו במסלול — אל תציעו אותם שוב; המשיכו לצעד הבא של השלב הנוכחי, או לשלב הבא.)'
        : '\n(ההצעה נדחתה ולא בוצעה — הציעו חלופה אחרת, או שאלו מה היו מעדיפים.)'),
      pendingProposal: null,
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (!turn) return res.json({ message: upd[0], items, said });
    quota.spend();
    const answer = await recordTurn(client, trip, state, items, turn, null);
    if (answer.milestone) startDayRecs(trip, answer.fresh || items, req.user.id);
    res.json({ message: upd[0], items: answer.fresh || items, said, follow: answer.row, milestone: answer.milestone, state, approved_message_id: answer.approvedId, remaining: quota.remaining });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? 'שגיאת שרת' : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

// the one-shot build, inside the draft: "בבת אחת" right after the clarifying round, or
// "להשלים את השאר" (fill) around the anchors the conversation settled. The same
// pipeline as the wizard's build, with the chat's memory standing in for the wizard's
// answers, written straight into the trip. Costs a build from the daily build quota.
router.post('/api/trips/code/:code/plan/build', authRequired, async (req, res) => {
  let client = null;
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'בניית AI לא זמינה כרגע' });
    client = await pool.connect();
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    if (!trip.dests.length) return res.status(400).json({ error: 'לטיול אין יעדים' });
    if (trip.days > 30) return res.status(400).json({ error: 'אפשר לבנות עד 30 ימים בבקשה אחת' });
    const spend = await ai.buildQuota(req);
    if (!spend) return exhausted(res, 'build', ai.BUILD_EXHAUSTED);
    const fill = !!(req.body && req.body.fill);
    const state = trip.plan_state;
    const items = await loadItems(client, trip.id);

    // the settled facts are the build's clarifying answers; the settled split, when it
    // covers the trip, is its preset plan — cleanPresetPlan says whether it does
    const freeText = [state.notes, ...state.facts.map((f) => `- ${f}`)].filter(Boolean).join('\n').slice(0, 500);
    const preset = state.areas.length ? state.areas.map((a) => ({ area: a.area, from: a.from, to: a.to, cities: a.cities })) : null;
    const areaNames = trip.dests.map((d) => d.name);
    const broadSingle = trip.dests.length === 1 && (!trip.dests[0].country || trip.dests[0].country === trip.dests[0].name);
    const presetRaw = preset && ai.cleanPresetPlan(preset, { from: 1, to: trip.days, areaNames, broadSingle }) ? preset : null;
    const ph = { distinctId: 'user_' + req.user.id, traceId: randomUUID() };
    const built = await ai.buildItinerary({
      dests: trip.dests, from: 1, to: trip.days,
      interestList: state.interests, freeText,
      answerList: [], // the clarifying round happened in the chat
      presetRaw,
      existing: fill ? items : [],
      wantMeta: !trip.description,
      // the draft already has its dates, so the build can check its own opening hours
      // and move a stop off an hour the door is shut (lib/hours-fit.js)
      startDate: trip.start_date || null,
      ph,
    });
    if (!built.items.length) return res.status(502).json({ error: 'ה-AI החזיר מסלול ריק — נסו שוב' });
    spend();

    await client.query('BEGIN');
    // a fresh build replaces whatever was there; a fill only adds around it
    if (!fill && items.length) await client.query('DELETE FROM trip_items WHERE trip_id = $1', [trip.id]);
    const vals = [];
    const base0 = fill ? items.length : 0;
    const tuples = built.items.map((it, i) => {
      vals.push(trip.id, dayRange(it.day_number, trip.days), it.time_label || null, String(it.title).slice(0, 200), it.note || null,
        it.place_query || null, it.category || null, it.area ? String(it.area).slice(0, 80) : null,
        Number.isFinite(it.lat) ? it.lat : null, Number.isFinite(it.lon) ? it.lon : null,
        it.google_place_id ? String(it.google_place_id).slice(0, 300) : null,
        it.osm_type ? String(it.osm_type).slice(0, 10) : null,
        it.osm_id ? String(it.osm_id).slice(0, 20) : null,
        it.cost ?? null, base0 + i);
      const b = vals.length - 15;
      return `(${Array.from({ length: 15 }, (_, k) => '$' + (b + k + 1)).join(',')})`;
    });
    await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, google_place_id, osm_type, osm_id, cost, sort_order)
       VALUES ${tuples.join(',')}`, vals
    );
    if (built.meta) {
      await client.query(
        `UPDATE trips SET description = COALESCE(description, $1), emoji = COALESCE(emoji, $2), cover_image = COALESCE(cover_image, $3) WHERE id = $4`,
        [built.meta.description, built.meta.emoji, built.meta.cover_image, trip.id]
      );
    }
    state.stage = 'done';
    // a built trip is long past "the basics": it leaves for its own page, dock and all
    state.basics = true;
    state.build = fill ? state.build : 'once';
    state.areas = built.plan.map((b) => ({ area: b.area, from: b.from, to: b.to, cities: b.cities }));
    const n = built.items.length;
    // a built trip is a settled trip — the invitation to co-planners rides on this
    // message (once), so it is there when they come back to the chat
    const invite = !state.invited;
    state.invited = true;
    const row = await addMessage(client, trip.id, null, 'ai',
      fill ? `השלמתי את שאר הימים — נוספו ${n} תחנות סביב מה שכבר קבענו. עברו על המסלול, וכל מה שלא מתאים אפשר לשנות כאן או ידנית.`
        : `בניתי את הטיול — ${n} תחנות על פני ${trip.days} ימים. עברו על המסלול; מכאן אפשר להמשיך לשנות איתי כל דבר, או לערוך ידנית.`,
      { built: { count: n, fill }, invite });
    await saveState(client, trip.id, state);
    await client.query('COMMIT');
    const fresh = await loadItems(pool, trip.id);
    const { rows: t } = await pool.query('SELECT description, emoji, cover_image FROM trips WHERE id = $1', [trip.id]);
    res.json({ items: fresh, plan: built.plan, message: row, state, trip: t[0] });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(client ? 500 : 503).json({ error: client ? ai.buildErrorMessage(err) : 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
