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
const { tripWithEditAuth, cleanPlanState, PLAN_MODES, PLAN_STAGES } = require('../lib/trips');
const { dailyQuota, exhausted } = require('../lib/quota');
const ai = require('./ai');

const router = express.Router();

// Two tiers, by stage (PLAYBOOK §3: the strong model only where the weak one is known
// to fail). The clarifying and choosing turns are conversation — no place is named
// into the itinerary — and run on the weak model; from the areas stage on, every turn
// may write stops, which is exactly where the weak model was measured inventing
// places, so those run on the strong one. AI_MODEL_PLAN overrides the strong half.
const PLAN_MODEL = process.env.AI_MODEL_PLAN || ai.AI_MODEL_STRONG;
const TALK_STAGES = ['clarify', 'choose'];
const planMeter = dailyQuota('plan', 60); // turns per user per day — a planning session is dozens of them
const AI_PLAN_MAX_MESSAGE = 400;
const PLAN_HISTORY = 12; // turns the model sees; the settled facts carry the rest
const THREAD_LIMIT = 80; // rows the client loads

const SUGGEST_STEPS = 'שלב אחרי שלב 🪜';
const SUGGEST_ONCE = 'בבת אחת ✨';
const READY_TEXT = 'אני מוכן ליצור עבורכם טיול מושלם 🧭 רוצים שנבנה אותו שלב אחרי שלב — מהאזורים, דרך הטיסות ועד מה עושים בכל יום — או בבת אחת? ' +
  'שלב אחרי שלב יוצא מדויק יותר, ובכל מקרה תמיד אפשר לערוך ולשנות הכול.';

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
  const where = trip.dests.map((d) => d.name).join(' ו') || trip.destination;
  const hello = `היי! אני אתכנן איתכם את הטיול ל${where} — ${trip.days} ימים. `;
  let text, payload;
  if (questions.length) {
    state.stage = 'clarify';
    state.pending = questions.map((q) => ({ question: q.question, options: q.options, multi: !!q.multi }));
    const q = state.pending[0];
    text = hello + 'שאלה קטנה קודם, כדי שנסדר את המסלול נכון: ' + q.question;
    payload = { suggestions: q.options.slice(0, 6), multi: q.multi };
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
  required: ['text', 'stage', 'build_now', 'approve_pending', 'trip_ready', 'suggestions', 'facts', 'pending_questions', 'areas', 'cards', 'ops'],
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

function turnPrompt({ trip, items, state, mode, history, pendingProposal }) {
  const dests = trip.dests;
  const areaNames = dests.length ? dests.map((d) => d.name) : [trip.destination].filter(Boolean);
  const multiArea = areaNames.length > 1;
  const dates = trip.start_date ? `, מתאריך ${String(trip.start_date).slice(0, 10)}` : ' (בלי תאריכים עדיין)';
  const perDay = [];
  for (let d = 1; d <= trip.days; d++) perDay.push(items.filter((it) => it.day_number === d).length);

  const system =
`אתם המתכנן האישי של TRIP MAKER: מומחה טיולים שמכיר את ${ai.destDescFull(dests) || trip.destination} לעומק, ובונים יחד עם מטיילים ישראלים את הטיול המושלם עבורם — בשיחה.
עונים בעברית, בגוף רבים ("אתם"), בחום, בקצרה ובענייניות. השדה text — עד 90 מילים, בלי רשימות ארוכות.

המטרה: לא להמליץ אלא לעשות. אתם בונים ועורכים את תחנות הטיול בעצמכם דרך ops, ושואלים את המטיילים רק את מה שבאמת משנה את הטיול. בכל תור: הצעה קונקרטית + לכל היותר שאלה אחת.

שלבי התכנון (stage) — התקדמו לפי הסדר, אבל תמיד ענו קודם על מה שהמטיילים שאלו:
- clarify: יש שאלות הבהרה פתוחות (ברשימה למטה). שאלו אחת בכל תור, בדיוק כלשונה, עם ה-suggestions שלה. תשובה שהתקבלה נרשמת ב-facts ויורדת מ-pending_questions. כשנגמרו — עברו ל-choose ואמרו: "${READY_TEXT}" עם suggestions ["${SUGGEST_STEPS}", "${SUGGEST_ONCE}"].
- choose: המטיילים בוחרים. "בבת אחת" (או ניסוח דומה: הכול, מהר, תבנה לבד) → build_now=true, ops ריק, text קצר שמודיע שבונים עכשיו. "שלב אחרי שלב" (או ניסוח דומה) → stage=areas והתחילו.
- areas: לקבוע יחד את האזורים וחלוקת הימים. הציעו חלוקה קונקרטית (אזור, ימים, ערים) והחזירו אותה מיד ב-areas (רצף ימים מלא מ-1 עד ${trip.days}, בלי חורים) — המטיילים רואים אותה על לוח שנה ויכולים לצבוע ימים ולשנות; בקשו אישור. כשהוסכם (או כשהמטיילים אישרו חלוקה מהלוח) — עברו ל-flights. טיול לעיר אחת: אזור אחד, אין מה לשאול — עברו ישר ל-flights.
- flights: הבינו את הטיסות: מאיפה טסים, לאן נוחתים, שעות ומיד קונקשן אם יש, וטיסת החזרה. אל תמציאו שעות טיסה: מה שהמטיילים לא יודעים נשאר בלי time_label ועם הערה "עדכנו את השעה". צרו תחנות נסיעה (category "נסיעה") ליום 1 (המראה, קונקשן אם יש, נחיתה) וליום ${trip.days} (טיסת החזרה), ואז עברו ל-days.
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
${state.interests.length ? `תחומי עניין מהאשף: ${state.interests.join(', ')}.\n` : ''}${state.notes ? `הערות מהאשף: "${state.notes}"\n` : ''}שלב נוכחי: ${state.stage}.
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

// the model's areas → the state's, only when they cover the trip properly
function cleanAreas(raw, days) {
  const blocks = (Array.isArray(raw) ? raw : []).map((a) => ({
    area: String(a?.area || '').slice(0, 60).trim(),
    from: parseInt(a?.day_from, 10), to: parseInt(a?.day_to, 10),
    cities: (Array.isArray(a?.cities) ? a.cities : []).slice(0, 3).map((c) => String(c).slice(0, 60).trim()).filter(Boolean),
  })).filter((a) => a.area && Number.isInteger(a.from) && Number.isInteger(a.to) && a.from >= 1 && a.to <= days && a.to >= a.from)
    .sort((a, b) => a.from - b.from);
  if (!blocks.length || blocks.length > 12) return null;
  for (let i = 1; i < blocks.length; i++) if (blocks[i].from <= blocks[i - 1].to) return null;
  return blocks;
}

async function planTurn({ trip, items, state, mode, history, message, pendingProposal, ph }) {
  const { system, user } = turnPrompt({ trip, items, state, mode, history, pendingProposal });
  const raw = await ai.aiJson({
    system,
    user: user + `\n\nההודעה החדשה של המטיילים:\n${message}`,
    schemaName: 'plan_turn',
    schema: TURN_SCHEMA,
    maxTokens: 3000,
    timeoutMs: 60000,
    model: TALK_STAGES.includes(state.stage) ? ai.AI_MODEL_WEAK : PLAN_MODEL,
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
    buildNow: !!raw.build_now,
    approvePending: !!raw.approve_pending,
    tripReady: !!raw.trip_ready,
    suggestions: (raw.suggestions || []).slice(0, 3).map((s) => String(s).slice(0, 60).trim()).filter(Boolean),
    facts: (raw.facts || []).slice(0, 24).map((s) => String(s).slice(0, 160).trim()).filter(Boolean),
    pendingQuestions: (raw.pending_questions || []).map((s) => String(s).slice(0, 200).trim()).filter(Boolean),
    areas: cleanAreas(raw.areas, trip.days),
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
  const row = await addMessage(client, trip.id, null, 'ai', turn.text, payload);
  await saveState(client, trip.id, state);
  await client.query('COMMIT');
  return { row, fresh, approvedId };
}

// ---------- routes ----------

// the thread + the planning memory; the opening message is minted on the first load
router.get('/api/trips/code/:code/plan', authRequired, async (req, res) => {
  const client = await pool.connect().catch(() => null);
  if (!client) return res.status(503).json({ error: 'מסד הנתונים לא זמין כרגע — נסו שוב בעוד רגע' });
  try {
    const trip = await draftWithAuth(req, res);
    if (!trip) return;
    let messages = await loadThread(trip.id);
    if (!messages.length) {
      await client.query('BEGIN');
      messages = [await openingMessage(client, trip, req.user.id)];
      await client.query('COMMIT');
    }
    res.json({ state: trip.plan_state, messages });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'שגיאת שרת' });
  } finally {
    client.release();
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
      if (!areas || areas[0].from !== 1 || areas[areas.length - 1].to !== trip.days) {
        return res.status(400).json({ error: 'חלוקת האזורים לא מכסה את כל ימי הטיול' });
      }
      for (let i = 1; i < areas.length; i++) {
        if (areas[i].from !== areas[i - 1].to + 1) return res.status(400).json({ error: 'חלוקת האזורים לא רציפה' });
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
    await addMessage(client, trip.id, req.user.id, 'user', message.slice(0, AI_PLAN_MAX_MESSAGE));
    await client.query('COMMIT');

    const turn = await planTurn({
      trip, items, state, mode: state.mode, history, message, pendingProposal,
      ph: { distinctId: 'user_' + req.user.id, traceId: randomUUID() },
    });
    if (!turn) return res.status(502).json({ error: 'ה-AI לא הצליח לענות — נסו שוב עוד רגע' });
    quota.spend();

    const { row, fresh, approvedId } = await recordTurn(client, trip, state, items, turn, waiting);

    res.json({
      message: row,
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
    await addMessage(client, trip.id, req.user.id, 'user', said);
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
    res.json({ message: upd[0], items: answer.fresh || items, said, follow: answer.row, state, approved_message_id: answer.approvedId, remaining: quota.remaining });
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
        it.google_place_id ? String(it.google_place_id).slice(0, 300) : null, it.cost ?? null, base0 + i);
      const b = vals.length - 13;
      return `(${Array.from({ length: 13 }, (_, k) => '$' + (b + k + 1)).join(',')})`;
    });
    await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, place_query, category, area, lat, lon, google_place_id, cost, sort_order)
       VALUES ${tuples.join(',')}`, vals
    );
    if (built.meta) {
      await client.query(
        `UPDATE trips SET description = COALESCE(description, $1), emoji = COALESCE(emoji, $2), cover_image = COALESCE(cover_image, $3) WHERE id = $4`,
        [built.meta.description, built.meta.emoji, built.meta.cover_image, trip.id]
      );
    }
    state.stage = 'done';
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
