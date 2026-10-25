// צ'קליסט לטיול — what has to happen before the plane, and who does it.
//
// Three headline items sit on the trip page itself, above the itinerary: an eSIM
// (Airalo), travel insurance (PassportCard), and the one destination-specific thing the
// model says matters most — Visit Japan Web for Japan, an ESTA for the States, a
// yellow-fever card for Tanzania. Those two links are ours; the third is a question we
// ask the model once per trip, and the answer is stored. Opening the full list asks the
// model for everything else: sections, items, which are shared (one person books the
// car) and which are personal (everyone packs their own charger), what to buy, what to
// find online, what to book before it sells out.
//
// Rules this file keeps, and why:
// - The model never hands us a URL. A made-up address is the checklist's version of a
//   made-up restaurant (PLAYBOOK §3), and there is no geocoder for links — so an item
//   carries a `search` query, and the page opens a web search for it. The only links
//   stored are the two we wrote ourselves.
// - One generation per trip is free of the meter: it runs on first open, and a list
//   that fails to appear because the day's quota is spent is a page that looks broken.
//   "רענון מה-AI" (force) is metered like every other model button.
// - Two participants opening the page together must not buy the list twice: a
//   `pending` status with a timestamp is the lock, stale after STALE_MS (the process
//   that held it may be gone — on this host it usually is).
// - Shared items are ticked once for everyone (done / done_by); personal items keep a
//   tick per user (trip_checklist_ticks). The page shows both as one checkbox.
const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../lib/db');
const { authOptional } = require('../lib/auth');
const { tripWithEditAuth, tripPrefsBlock } = require('../lib/trips');
const { dailyQuota, exhausted } = require('../lib/quota');
const ai = require('./ai');
const COUNTRIES = require('../public/js/countries.js');
const TAGS = require('../public/js/checklist-tags.js');

const router = express.Router();

const refreshMeter = dailyQuota('checklist', 10); // AI_QUOTA_CHECKLIST overrides
const STALE_MS = 2 * 60 * 1000;
const MAX_SECTIONS = 10;
const MAX_ITEMS = 60;
const CORE_SECTION = 'הכי חשוב';
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// Airalo sells by country page; the slug is the English name. Only the countries we
// are sure of get a direct page — anything else lands on the store's front door, which
// is a worse link than a wrong one is a broken one.
const AIRALO_SLUGS = {
  jp: 'japan', th: 'thailand', us: 'united-states', gb: 'united-kingdom', it: 'italy', fr: 'france', es: 'spain',
  pt: 'portugal', gr: 'greece', de: 'germany', nl: 'netherlands', at: 'austria', ch: 'switzerland', cz: 'czech-republic',
  hu: 'hungary', pl: 'poland', hr: 'croatia', tr: 'turkey', cy: 'cyprus', ge: 'georgia', ae: 'united-arab-emirates',
  vn: 'vietnam', kh: 'cambodia', la: 'laos', id: 'indonesia', my: 'malaysia', sg: 'singapore', ph: 'philippines',
  kr: 'south-korea', tw: 'taiwan', cn: 'china', hk: 'hong-kong', in: 'india', lk: 'sri-lanka', np: 'nepal',
  au: 'australia', nz: 'new-zealand', ca: 'canada', mx: 'mexico', br: 'brazil', ar: 'argentina', cl: 'chile',
  pe: 'peru', co: 'colombia', cr: 'costa-rica', za: 'south-africa', ma: 'morocco', eg: 'egypt', ke: 'kenya',
  tz: 'tanzania', ie: 'ireland', be: 'belgium', dk: 'denmark', se: 'sweden', no: 'norway', fi: 'finland', is: 'iceland',
  ro: 'romania', bg: 'bulgaria', rs: 'serbia', me: 'montenegro', al: 'albania', mt: 'malta', ee: 'estonia', lv: 'latvia',
  lt: 'lithuania', sk: 'slovakia', si: 'slovenia', jo: 'jordan', om: 'oman', qa: 'qatar', mv: 'maldives', mu: 'mauritius',
  sc: 'seychelles', do: 'dominican-republic', cu: 'cuba', pa: 'panama', gt: 'guatemala', uz: 'uzbekistan', kz: 'kazakhstan',
  am: 'armenia', az: 'azerbaijan', mn: 'mongolia', bt: 'bhutan', ec: 'ecuador', bo: 'bolivia', uy: 'uruguay',
};
const INSURANCE_URL = 'https://www.passportcard.co.il/';

const tripDests = (trip) => (Array.isArray(trip.destinations) ? trip.destinations.filter((d) => d && d.name) : []);
const destText = (trip) => {
  const dests = tripDests(trip);
  return dests.length
    ? dests.map((d) => (d.country && d.country !== d.name ? `${d.name} (${d.country})` : d.name)).join(', ')
    : [trip.destination, trip.country].filter(Boolean).join(', ');
};
function tripCountryCodes(trip) {
  const names = tripDests(trip).map((d) => d.country || d.name)
    .concat(String(trip.country || '').split(',').map((s) => s.trim()))
    .filter(Boolean);
  return [...new Set(names.map((n) => COUNTRIES.ccByName(n)).filter(Boolean))];
}
function esimUrl(trip) {
  const ccs = tripCountryCodes(trip);
  const slug = ccs.length === 1 ? AIRALO_SLUGS[ccs[0]] : null;
  return slug ? `https://www.airalo.com/${slug}-esim` : 'https://www.airalo.com/';
}

function datesText(trip) {
  if (!trip.start_date) return 'תאריכים עדיין לא נקבעו';
  const d = new Date(trip.start_date);
  if (Number.isNaN(d.getTime())) return '';
  const daysTo = Math.round((d - Date.now()) / 86400000);
  return `יוצאים ב-${d.getDate()} ב${HE_MONTHS[d.getMonth()]} ${d.getFullYear()}${daysTo >= 0 ? ` (עוד ${daysTo} ימים)` : ''}`;
}

// what the model is told about the trip — enough to be specific, never the whole table
async function tripBrief(trip) {
  const [items, hotels, participants] = await Promise.all([
    pool.query('SELECT day_number, title, category FROM trip_items WHERE trip_id = $1 ORDER BY day_number, sort_order, id', [trip.id]),
    pool.query('SELECT name, status FROM trip_hotels WHERE trip_id = $1', [trip.id]),
    pool.query('SELECT count(*)::int AS n FROM trip_participants WHERE trip_id = $1', [trip.id]),
  ]);
  const stops = items.rows.slice(0, 90).map((it) => `יום ${it.day_number}: ${it.title}${it.category ? ` (${it.category})` : ''}`);
  const cats = [...new Set(items.rows.map((it) => it.category).filter(Boolean))];
  const booked = hotels.rows.filter((h) => h.status === 'booked').length;
  const lines = [
    `הטיול: "${trip.title}" — ${destText(trip)}, ${trip.days} ימים. ${datesText(trip)}.`,
    trip.description ? `תיאור: ${String(trip.description).slice(0, 300)}` : '',
    `מטיילים: ${Math.max(1, participants.rows[0].n + 1)} (יוצאים מישראל).`,
    hotels.rows.length ? `לינה: ${hotels.rows.length} מלונות ברשימה, ${booked} מהם כבר הוזמנו.` : 'לינה: עדיין לא נרשמו מלונות.',
    cats.length ? `סוגי התחנות במסלול: ${cats.join(', ')}.` : '',
    stops.length ? `תחנות במסלול:\n${stops.join('\n')}` : 'המסלול עדיין ריק.',
    tripPrefsBlock(trip.plan_state),
  ];
  return lines.filter(Boolean).join('\n');
}

// =====================================================================
//  schemas — strict: every property required, "none" is null
// =====================================================================

const TOP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    why: { type: 'string' },
    search: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string', enum: TAGS.KEYS } },
    due_days: { type: ['integer', 'null'] },
  },
  required: ['title', 'why', 'search', 'tags', 'due_days'],
};

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          emoji: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                note: { type: ['string', 'null'] },
                scope: { type: 'string', enum: TAGS.SCOPES },
                tags: { type: 'array', items: { type: 'string', enum: TAGS.KEYS } },
                due_days: { type: ['integer', 'null'] },
                priority: { type: 'integer', enum: [0, 1, 2] },
                search: { type: ['string', 'null'] },
              },
              required: ['title', 'note', 'scope', 'tags', 'due_days', 'priority', 'search'],
            },
          },
        },
        required: ['name', 'emoji', 'items'],
      },
    },
  },
  required: ['sections'],
};

// =====================================================================
//  cleaning — model output is loose input (PLAYBOOK §5)
// =====================================================================

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const strOrNull = (v, n) => { const s = str(v, n); return s || null; };
const cleanTags = (v) => [...new Set((Array.isArray(v) ? v : []).filter((t) => TAGS.KEYS.includes(t)))].slice(0, 5);
const cleanDue = (v) => (Number.isInteger(v) && v >= 0 && v <= 365 ? v : (v === null || v === undefined ? null : (Number.isFinite(+v) ? Math.min(365, Math.max(0, Math.round(+v))) : null)));
const cleanPriority = (v) => ([0, 1, 2].includes(+v) ? +v : 0);
const cleanScope = (v) => (TAGS.SCOPES.includes(v) ? v : 'shared');
// a user-typed URL: http(s) only, or nothing
const cleanLink = (v) => {
  const s = str(v, 500);
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
};
const cleanEmoji = (v) => {
  const s = str(v, 8);
  // one grapheme of emoji, or none — a section name is not where the model gets to write
  return /^\p{Extended_Pictographic}/u.test(s) ? [...s][0] : '';
};

function cleanItemInput(body, { user = true } = {}) {
  const out = {
    title: str(body.title, 120),
    note: strOrNull(body.note, 300),
    scope: cleanScope(body.scope),
    tags: cleanTags(body.tags),
    priority: cleanPriority(body.priority),
    due_days: cleanDue(body.due_days),
    search: strOrNull(body.search, 160),
    section: str(body.section, 60) || 'שונות',
  };
  if (user) out.link = cleanLink(body.link);
  return out;
}

// =====================================================================
//  the row per trip, and the three headline items
// =====================================================================

async function ensureMeta(tripId) {
  const { rows } = await pool.query(
    `INSERT INTO trip_checklists (trip_id) VALUES ($1)
     ON CONFLICT (trip_id) DO UPDATE SET trip_id = EXCLUDED.trip_id
     RETURNING *`, [tripId]
  );
  return rows[0];
}

async function ensureCoreItems(trip) {
  const { rows } = await pool.query(
    `SELECT key FROM trip_checklist_items WHERE trip_id = $1 AND source = 'core'`, [trip.id]
  );
  const have = new Set(rows.map((r) => r.key));
  const core = [
    { key: 'esim', title: 'eSIM לחו״ל', note: 'אינטרנט מהרגע שנוחתים — מתקינים בבית, מפעילים בנחיתה', why: 'בלי זה אין ניווט, אין תרגום ואין קשר בשדה', link: esimUrl(trip), tags: ['online'], due_days: 3, sort: 0 },
    { key: 'insurance', title: 'ביטוח נסיעות לחו״ל', note: 'כולל כיסוי רפואי, כבודה וביטול; מי שעושה ספורט אתגרי מוסיף הרחבה', why: 'הדבר היחיד ברשימה שאי אפשר לקנות אחרי שצריך אותו', link: INSURANCE_URL, tags: ['online', 'urgent'], due_days: 7, sort: 1 },
  ];
  for (const c of core) {
    if (have.has(c.key)) continue;
    await pool.query(
      `INSERT INTO trip_checklist_items (trip_id, key, section, title, note, why, scope, tags, priority, due_days, link, source, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'personal', $7, 2, $8, $9, 'core', $10)`,
      [trip.id, c.key, CORE_SECTION, c.title, c.note, c.why, JSON.stringify(c.tags), c.due_days, c.link, c.sort]
    );
  }
}

const isStale = (ts) => !ts || Date.now() - new Date(ts).getTime() > STALE_MS;

// the model's one pick: the destination-specific thing a traveller from Israel must not
// leave without. Writes the `top` core item; returns true when one now exists.
async function generateTop(trip, ph) {
  const meta = await ensureMeta(trip.id);
  const { rows: existing } = await pool.query(
    `SELECT id FROM trip_checklist_items WHERE trip_id = $1 AND key = 'top'`, [trip.id]
  );
  if (existing.length && meta.top_status === 'ready') return true;
  if (meta.top_status === 'pending' && !isStale(meta.requested_at)) return false;
  await pool.query(`UPDATE trip_checklists SET top_status = 'pending', requested_at = now() WHERE trip_id = $1`, [trip.id]);

  const brief = await tripBrief(trip);
  const raw = await ai.aiJson({
    system: `אתם היועצים של TRIP MAKER להכנות לטיול. מטיילים מישראל, הכול בעברית.
ברשימה שלהם כבר יש eSIM וביטוח נסיעות — אל תציעו אותם. בחרו את הדבר **האחד** הכי חשוב וספציפי ליעד הזה שהם חייבים לסדר לפני היציאה: אישור כניסה או ויזה אלקטרונית (Visit Japan Web, ESTA, ETA, K-ETA), חיסון או תעודה שנדרשים בכניסה, כרטיס תחבורה שכדאי לקנות מראש (Suica, JR Pass רק אם המסלול מצדיק), רישיון נהיגה בינלאומי אם שוכרים רכב, אישור הורים לקטין, מזומן במטבע שלא משיגים בארץ, כרטיס לאטרקציה שנגמר שבועות מראש — מה שהכי יקר לפספס **לטיול הזה**, לא כלל אצבע.
כללים: title קצר (עד 8 מילים), why במשפט אחד שמסביר למה זה הכי חשוב כאן, search — מילות חיפוש שיובילו לדף הרשמי (באנגלית, כולל שם המדינה); אין להמציא כתובות אינטרנט. tags רק מהרשימה; due_days = כמה ימים לפני היציאה צריך לסיים את זה.`,
    user: brief,
    schemaName: 'checklist_top',
    schema: TOP_SCHEMA,
    maxTokens: 400,
    model: ai.AI_MODEL_STRONG, // entry rules and permits are exactly where a cheap guess costs a flight
    timeoutMs: 30000,
    ph,
  });
  if (!raw || !str(raw.title, 120)) {
    await pool.query(`UPDATE trip_checklists SET top_status = 'failed' WHERE trip_id = $1`, [trip.id]);
    return false;
  }
  const item = {
    title: str(raw.title, 120), why: strOrNull(raw.why, 220), search: strOrNull(raw.search, 160) || str(raw.title, 120),
    tags: cleanTags(raw.tags), due_days: cleanDue(raw.due_days),
  };
  if (existing.length) {
    await pool.query(
      `UPDATE trip_checklist_items SET title = $2, why = $3, search = $4, tags = $5, due_days = $6, done = false, done_by = NULL, done_at = NULL, updated_at = now()
       WHERE id = $1`,
      [existing[0].id, item.title, item.why, item.search, JSON.stringify(item.tags), item.due_days]
    );
    await pool.query('DELETE FROM trip_checklist_ticks WHERE item_id = $1', [existing[0].id]);
  } else {
    await pool.query(
      `INSERT INTO trip_checklist_items (trip_id, key, section, title, why, scope, tags, priority, due_days, search, source, sort_order)
       VALUES ($1, 'top', $2, $3, $4, 'personal', $5, 2, $6, $7, 'core', 2)`,
      [trip.id, CORE_SECTION, item.title, item.why, JSON.stringify(item.tags), item.due_days, item.search]
    );
  }
  await pool.query(`UPDATE trip_checklists SET top_status = 'ready' WHERE trip_id = $1`, [trip.id]);
  return true;
}

// the whole list. `force` throws away what the model wrote before (never what people
// added or ticked by hand) and asks again.
async function generateList(trip, ph, { force = false } = {}) {
  const meta = await ensureMeta(trip.id);
  if (meta.status === 'ready' && !force) return 'ready';
  if (meta.status === 'pending' && !isStale(meta.requested_at)) return 'pending';
  await pool.query(`UPDATE trip_checklists SET status = 'pending', requested_at = now() WHERE trip_id = $1`, [trip.id]);

  await ensureCoreItems(trip);
  const topTask = generateTop(trip, ph).catch(() => false);
  const brief = await tripBrief(trip);
  const { rows: existing } = await pool.query(
    `SELECT title FROM trip_checklist_items WHERE trip_id = $1 AND source <> 'ai'`, [trip.id]
  );
  const raw = await ai.aiJson({
    system: `אתם היועצים של TRIP MAKER להכנות לטיול, וכותבים צ'קליסט מלא לטיול הזה. מטיילים מישראל, הכול בעברית.
מבנה: 6–9 סעיפים, בסך הכול 30–45 פריטים. סעיפים מקובלים: מסמכים ואישורים, כסף ותשלומים, בריאות, הזמנות מראש, תחבורה ביעד, אריזה, אלקטרוניקה, יום לפני היציאה, ביום הטיסה — אבל כל סעיף חייב להרוויח את מקומו בטיול **הזה**: סעיף "הזמנות מראש" מונה את התחנות שבמסלול שבאמת נגמרות (מוזיאונים עם כרטיסים מתוארכים, מסעדות מבוקשות, רכבות), סעיף "אריזה" מתאים לעונה ולסוג הפעילות (טרקים, שנורקלינג, חורף), ו"בריאות" כולל חיסונים/תרופות רק כשהיעד דורש.
לכל פריט:
- title קצר ומעשי (עד 10 מילים), note אופציונלי — פרט שחוסך טעות (איפה, כמה, למה), עד 20 מילים, או null.
- scope: "shared" כשמישהו אחד עושה את זה בשם כולם (לשכור רכב, להזמין שולחן, להדפיס את ההזמנות); "personal" כשכל מטייל צריך את שלו (דרכון, תרופות, מטען).
- tags מהרשימה: buy = צריך לקנות; online = למצוא/להשוות/להזמין ברשת; book = להזמין מראש כי נגמר; print = להדפיס; pack = נכנס למזוודה; ask = שאלה שצריך לברר; urgent = חייב להיסגר השבוע. 0–3 תגיות, ובלי "later".
- due_days: כמה ימים לפני היציאה זה צריך להיות גמור (60/30/14/7/3/1/0), או null אם לא משנה.
- priority: 2 = מפספסים את זה ואין טיול; 1 = חשוב; 0 = נחמד.
- search: מילות חיפוש לדף הרשמי (באנגלית) כשיש כזה, אחרת null. אין להמציא כתובות אינטרנט.
כבר ברשימה ואין לחזור עליהם: ${existing.map((r) => `"${r.title}"`).join(', ')}.
בלי פריטים גנריים חסרי ערך ("לארוז בגדים"), בלי כפילויות, ובלי להמציא דרישות כניסה — כשלא בטוחים, זה פריט "לברר" (ask) ולא עובדה.`,
    user: brief,
    schemaName: 'checklist_full',
    schema: LIST_SCHEMA,
    maxTokens: 4500,
    model: ai.AI_MODEL_STRONG, // visa rules and what sells out are knowledge, and the weak tier guesses
    timeoutMs: 55000,
    ph,
  });
  await topTask;
  const sections = (Array.isArray(raw && raw.sections) ? raw.sections : []).slice(0, MAX_SECTIONS);
  const cleaned = [];
  const seen = new Set(existing.map((r) => r.title.trim()));
  let sort = 100;
  for (const sec of sections) {
    const name = str(sec.name, 60);
    if (!name) continue;
    const emoji = cleanEmoji(sec.emoji);
    for (const it of (Array.isArray(sec.items) ? sec.items : [])) {
      const title = str(it.title, 120);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      cleaned.push({
        section: emoji ? `${emoji} ${name}` : name, title, note: strOrNull(it.note, 300), scope: cleanScope(it.scope),
        tags: cleanTags(it.tags).filter((t) => t !== 'later'), due_days: cleanDue(it.due_days),
        priority: cleanPriority(it.priority), search: strOrNull(it.search, 160), sort: sort++,
      });
      if (cleaned.length >= MAX_ITEMS) break;
    }
    if (cleaned.length >= MAX_ITEMS) break;
  }
  if (!cleaned.length) {
    await pool.query(`UPDATE trip_checklists SET status = 'failed' WHERE trip_id = $1`, [trip.id]);
    return 'failed';
  }
  // the write is one transaction: a reload mid-way never sees half a list
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (force) await client.query(`DELETE FROM trip_checklist_items WHERE trip_id = $1 AND source = 'ai'`, [trip.id]);
    for (const c of cleaned) {
      await client.query(
        `INSERT INTO trip_checklist_items (trip_id, section, title, note, scope, tags, priority, due_days, search, source, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ai', $10)`,
        [trip.id, c.section, c.title, c.note, c.scope, JSON.stringify(c.tags), c.priority, c.due_days, c.search, c.sort]
      );
    }
    await client.query(
      `UPDATE trip_checklists SET status = 'ready', generated_at = now(), context = $2 WHERE trip_id = $1`,
      [trip.id, destText(trip).slice(0, 200)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(`UPDATE trip_checklists SET status = 'failed' WHERE trip_id = $1`, [trip.id]).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return 'ready';
}

// =====================================================================
//  reading — one shape for every route that answers with the list
// =====================================================================

async function snapshot(trip, userId) {
  const [meta, items] = await Promise.all([
    pool.query('SELECT status, top_status, generated_at, requested_at FROM trip_checklists WHERE trip_id = $1', [trip.id]),
    pool.query(
      `SELECT i.id, i.key, i.section, i.title, i.note, i.why, i.scope, i.owner_id, i.tags, i.priority, i.due_days,
              i.assignee_id, a.name AS assignee_name, i.link, i.search, i.source, i.sort_order,
              i.done, i.done_by, d.name AS done_by_name, i.done_at, i.created_by, i.created_at,
              (t.user_id IS NOT NULL) AS my_tick,
              (SELECT count(*)::int FROM trip_checklist_ticks tt WHERE tt.item_id = i.id) AS tick_count
       FROM trip_checklist_items i
       LEFT JOIN users a ON a.id = i.assignee_id
       LEFT JOIN users d ON d.id = i.done_by
       LEFT JOIN trip_checklist_ticks t ON t.item_id = i.id AND t.user_id = $2
       WHERE i.trip_id = $1 AND (i.owner_id IS NULL OR i.owner_id = $2)
       ORDER BY i.sort_order, i.id`,
      [trip.id, userId]
    ),
  ]);
  const m = meta.rows[0] || { status: 'empty', top_status: 'empty', generated_at: null, requested_at: null };
  // a lock whose holder died reads as failed, so the page offers to try again instead of spinning
  for (const k of ['status', 'top_status']) if (m[k] === 'pending' && isStale(m.requested_at)) m[k] = 'failed';
  return {
    meta: { status: m.status, top_status: m.top_status, generated_at: m.generated_at },
    items: items.rows.map((r) => ({
      id: r.id, key: r.key, section: r.section, title: r.title, note: r.note, why: r.why, scope: r.scope,
      mine: r.owner_id === userId, tags: Array.isArray(r.tags) ? r.tags : [], priority: r.priority, due_days: r.due_days,
      assignee_id: r.assignee_id, assignee_name: r.assignee_name, link: r.link, search: r.search, source: r.source,
      sort_order: r.sort_order,
      // one boolean for the page, whatever the scope: shared = the trip's tick, personal = mine
      done: r.scope === 'shared' ? r.done : r.my_tick,
      done_by: r.scope === 'shared' ? r.done_by : null, done_by_name: r.scope === 'shared' ? r.done_by_name : null,
      done_at: r.done_at, tick_count: r.tick_count, created_by: r.created_by,
    })),
  };
}

const phFor = (req) => ({ distinctId: 'user_' + req.user.id, traceId: randomUUID() });
const serverError = (res, err) => {
  console.error(err);
  res.status(500).json({ error: 'שגיאת שרת' });
};

// =====================================================================
//  routes — participants only, every one of them
// =====================================================================

router.get('/api/trips/code/:code/checklist', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    let snap = await snapshot(trip, req.user.id);
    // the two fixed headline items are the list's skeleton, not generated content: the
    // first read brings them up, so the widget paints them before any model answers
    if (!snap.items.some((i) => i.source === 'core')) {
      await ensureMeta(trip.id);
      await ensureCoreItems(trip);
      snap = await snapshot(trip, req.user.id);
    }
    res.json(snap);
  } catch (err) { serverError(res, err); }
});

// the three headline items — created on first ask, the model's pick generated once
router.post('/api/trips/code/:code/checklist/top', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await ensureMeta(trip.id);
    await ensureCoreItems(trip);
    if (process.env.OPENAI_API_KEY) await generateTop(trip, phFor(req));
    else await pool.query(`UPDATE trip_checklists SET top_status = 'failed' WHERE trip_id = $1`, [trip.id]);
    res.json(await snapshot(trip, req.user.id));
  } catch (err) { serverError(res, err); }
});

router.post('/api/trips/code/:code/checklist/generate', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'הצ\'קליסט החכם לא זמין כרגע — אפשר להוסיף פריטים ידנית' });
    const force = !!(req.body && req.body.force);
    const meta = await ensureMeta(trip.id);
    // the first list a trip gets is free; asking again is a model button like any other
    let quota = null;
    if (force || meta.status === 'ready') {
      quota = await refreshMeter.check(req);
      if (!quota) return exhausted(res, 'checklist', 'ניצלתם את רענוני הצ\'קליסט להיום — הרשימה נשארת כמו שהיא, ומחר יש מכסה חדשה');
    }
    const status = await generateList(trip, phFor(req), { force });
    if (quota && status === 'ready') quota.spend();
    const snap = await snapshot(trip, req.user.id);
    if (status === 'failed') snap.error = 'לא הצלחנו לבנות את הרשימה הפעם — אפשר לנסות שוב או להוסיף ידנית';
    res.json(snap);
  } catch (err) { serverError(res, err); }
});

router.post('/api/trips/code/:code/checklist/items', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    await ensureMeta(trip.id);
    const it = cleanItemInput(req.body || {});
    if (!it.title) return res.status(400).json({ error: 'צריך כותרת לפריט' });
    const assignee = Number.isInteger(+req.body.assignee_id) && +req.body.assignee_id > 0 ? +req.body.assignee_id : null;
    // a personal item someone types is theirs alone — the AI's personal items are the
    // template everybody shares; a traveller's own are not everybody's business
    const ownerId = it.scope === 'personal' ? req.user.id : null;
    const { rows: last } = await pool.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM trip_checklist_items WHERE trip_id = $1', [trip.id]);
    await pool.query(
      `INSERT INTO trip_checklist_items (trip_id, section, title, note, scope, owner_id, tags, priority, due_days, assignee_id, link, search, source, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'user', $13, $14)`,
      [trip.id, it.section, it.title, it.note, it.scope, ownerId, JSON.stringify(it.tags), it.priority, it.due_days,
        it.scope === 'shared' ? assignee : null, it.link, it.search, last[0].n, req.user.id]
    );
    res.json(await snapshot(trip, req.user.id));
  } catch (err) { serverError(res, err); }
});

async function loadItem(trip, id, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM trip_checklist_items WHERE id = $1 AND trip_id = $2 AND (owner_id IS NULL OR owner_id = $3)',
    [id, trip.id, userId]
  );
  return rows[0] || null;
}

// a tick on one item, by scope: the trip's (shared) or mine (personal)
async function setDone(item, userId, done) {
  if (item.scope === 'shared') {
    await pool.query(
      // the CASE leaves $3 untyped and Postgres guesses text — the cast says it is a user id
      `UPDATE trip_checklist_items SET done = $2, done_by = CASE WHEN $2 THEN $3::int ELSE NULL END,
         done_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
      [item.id, !!done, userId]
    );
  } else if (done) {
    await pool.query(
      'INSERT INTO trip_checklist_ticks (item_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [item.id, userId]
    );
  } else {
    await pool.query('DELETE FROM trip_checklist_ticks WHERE item_id = $1 AND user_id = $2', [item.id, userId]);
  }
}

router.patch('/api/trips/code/:code/checklist/items/:id', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const item = await loadItem(trip, parseInt(req.params.id, 10), req.user.id);
    if (!item) return res.status(404).json({ error: 'הפריט לא נמצא' });
    const b = req.body || {};
    if (typeof b.done === 'boolean') await setDone(item, req.user.id, b.done);
    const sets = [];
    const vals = [item.id];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (typeof b.title === 'string' && item.source !== 'core') { const t = str(b.title, 120); if (t) set('title', t); }
    if ('note' in b) set('note', strOrNull(b.note, 300));
    if ('tags' in b) set('tags', JSON.stringify(cleanTags(b.tags)));
    if ('priority' in b) set('priority', cleanPriority(b.priority));
    if ('due_days' in b) set('due_days', cleanDue(b.due_days));
    if ('link' in b && item.source !== 'core') set('link', cleanLink(b.link));
    if ('search' in b) set('search', strOrNull(b.search, 160));
    if (typeof b.section === 'string' && item.source !== 'core') { const s = str(b.section, 60); if (s) set('section', s); }
    if ('assignee_id' in b) {
      const a = Number.isInteger(+b.assignee_id) && +b.assignee_id > 0 ? +b.assignee_id : null;
      set('assignee_id', a);
    }
    // moving between shared and personal: the old tick state means nothing on the other side
    if (typeof b.scope === 'string' && TAGS.SCOPES.includes(b.scope) && b.scope !== item.scope && item.source !== 'core') {
      set('scope', b.scope);
      set('owner_id', null);
      set('done', false); set('done_by', null); set('done_at', null);
      await pool.query('DELETE FROM trip_checklist_ticks WHERE item_id = $1', [item.id]);
    }
    if (sets.length) {
      sets.push('updated_at = now()');
      await pool.query(`UPDATE trip_checklist_items SET ${sets.join(', ')} WHERE id = $1`, vals);
    }
    res.json(await snapshot(trip, req.user.id));
  } catch (err) { serverError(res, err); }
});

router.delete('/api/trips/code/:code/checklist/items/:id', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const item = await loadItem(trip, parseInt(req.params.id, 10), req.user.id);
    if (!item) return res.status(404).json({ error: 'הפריט לא נמצא' });
    // the three headline items can be ticked or snoozed, never removed — the widget stands on them
    if (item.source === 'core') return res.status(400).json({ error: 'את שלושת הפריטים החשובים אפשר לסמן, לא למחוק' });
    await pool.query('DELETE FROM trip_checklist_items WHERE id = $1', [item.id]);
    res.json(await snapshot(trip, req.user.id));
  } catch (err) { serverError(res, err); }
});

// many ticks at once: a section marked done, "reset everything", "hide what's done"
router.post('/api/trips/code/:code/checklist/bulk', authOptional, async (req, res) => {
  try {
    const trip = await tripWithEditAuth(req, res);
    if (!trip) return;
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n)).slice(0, 200);
    const done = !!(req.body && req.body.done);
    if (ids.length) {
      const { rows } = await pool.query(
        'SELECT * FROM trip_checklist_items WHERE trip_id = $1 AND id = ANY($2) AND (owner_id IS NULL OR owner_id = $3)',
        [trip.id, ids, req.user.id]
      );
      for (const item of rows) await setDone(item, req.user.id, done);
    }
    res.json(await snapshot(trip, req.user.id));
  } catch (err) { serverError(res, err); }
});

module.exports = router;
