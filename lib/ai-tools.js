// The AI's tools — what a chat turn may look up before it answers.
//
// Until now a turn knew the trip and its own memory and nothing else: the weather was
// a guess, a hotel's price was a guess, "is it open on Monday" was a guess dressed as an
// answer. Each tool below is one real question to one real source, and every one of
// them is a source this codebase already trusts: Open-Meteo for weather (lib/weather.js),
// a fixed list of travel sites for search and reading (lib/web-search.js), the same
// place verifier the builds run (lib/places.js), OSRM for the road (lib/travel-fit.js),
// OSM/Google for opening hours (lib/opening-hours.js), and — only when the traveller
// switched them on — their own calendar, mail and Drive (lib/connectors.js).
//
// Rules that hold for every tool:
// - It never throws into the model loop. A source that is down answers { error }, in
//   Hebrew the model can repeat; the turn goes on without it.
// - It is bounded: results are cut to what a model turn can afford to read.
// - It leaves a trace: every call is written to the turn's progress row (the chat shows
//   "בודק מזג אוויר…" while it waits) and summarised on the stored message afterwards.
// - A tool is a way to KNOW, not a way to WRITE: nothing here changes the trip. Changes
//   still travel as ops and actions, through the same cards and checks as before.
const weather = require('./weather');
const web = require('./web-search');
const connectors = require('./connectors');
const { verifyPlace } = require('./places');
const { routeLegs } = require('./travel-fit');
const hours = require('./opening-hours');
const { pool } = require('./db');

const MAX_TOOL_ROUNDS = 4;      // model → tools → model, at most this many times per turn
const MAX_CALLS_PER_ROUND = 4;  // parallel tool calls the model may make in one round
const RESULT_MAX_CHARS = 3500;  // what one tool result may hand back

// labels the chat shows while a tool runs, and on the answer afterwards
const LABELS = {
  get_weather: { icon: '🌤️', doing: 'בודק מזג אוויר', done: 'מזג אוויר' },
  web_search: { icon: '🔎', doing: 'מחפש', done: 'חיפוש' },
  read_page: { icon: '📄', doing: 'קורא דף', done: 'קריאת דף' },
  find_place: { icon: '📍', doing: 'מאתר במפה', done: 'מפה' },
  travel_time: { icon: '🚗', doing: 'מחשב זמן נסיעה', done: 'זמן נסיעה' },
  opening_hours: { icon: '🕒', doing: 'בודק שעות פתיחה', done: 'שעות פתיחה' },
  calendar_events: { icon: '📅', doing: 'קורא את היומן', done: 'יומן' },
  gmail_search: { icon: '✉️', doing: 'מחפש ב-Gmail', done: 'Gmail' },
  gmail_read: { icon: '✉️', doing: 'קורא הודעה', done: 'Gmail' },
  drive_search: { icon: '📁', doing: 'מחפש ב-Drive', done: 'Drive' },
  drive_read: { icon: '📁', doing: 'קורא קובץ מ-Drive', done: 'Drive' },
};
const SITE_LABEL = { hotels: 'Booking', activities: 'Klook', flights: 'טיסות', maps: 'Google Maps', transport: 'תחבורה', guides: 'מדריכים', food: 'מסעדות', reference: 'מידע', any: '' };

// ---------- definitions (OpenAI function tools) ----------
const str = (description) => ({ type: 'string', description });
const base = [
  {
    name: 'get_weather',
    description: 'מזג אוויר נוכחי ותחזית/מזג אוויר טיפוסי לעיר או אזור בתאריכים נתונים. השתמשו כשמדברים על מה ללבוש, מה לארוז, ימים בחוץ או עונה.',
    parameters: { type: 'object', additionalProperties: false, required: ['place'], properties: {
      place: str('שם העיר או האזור באנגלית, למשל "Kyoto"'),
      date_from: str('YYYY-MM-DD, היום הראשון שמעניין (ברירת מחדל: היום)'),
      date_to: str('YYYY-MM-DD, היום האחרון'),
    } },
  },
  {
    name: 'web_search',
    description: `חיפוש באתרי טיולים מורשים בלבד. category: hotels (Booking, Airbnb), activities (Klook, GetYourGuide, Viator, Tiqets), flights (SWISS, El Al, Skyscanner, Kayak), maps (Google Maps), transport (Rome2rio, Omio, 12Go), guides (Wikipedia, Wikivoyage, Time Out, Lonely Planet), food (Tripadvisor, TheFork, Michelin), reference (XE, gov.il), any. השתמשו למחירים, זמינות, סיורים, טיסות ומידע עדכני.`,
    parameters: { type: 'object', additionalProperties: false, required: ['query', 'category'], properties: {
      query: str('מילות החיפוש, עדיף באנגלית, כולל עיר'),
      category: { type: 'string', enum: [...web.CATEGORIES, 'any'] },
    } },
  },
  {
    name: 'read_page',
    description: 'קריאת הטקסט של דף אחד מתוצאות החיפוש (רק מאתרים מורשים) כדי לדייק מחיר, שעות, כתובת או פרטים.',
    parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: str('כתובת מלאה מתוצאת חיפוש') } },
  },
  {
    name: 'find_place',
    description: 'איתור מקום ספציפי במפה (מסעדה, אטרקציה, מלון, שכונה): האם קיים, איפה בדיוק, קישור Google Maps. השתמשו לפני שמציעים מקום שאתם לא בטוחים בו.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: str('השם באנגלית ואחריו עיר ומדינה, למשל "Nishiki Market, Kyoto, Japan"') } },
  },
  {
    name: 'travel_time',
    description: 'זמן נסיעה ומרחק ברכב בין שני מקומות (OSRM). טוב בתוך עיר ובין ערים קרובות; מעל ~120 ק״מ ציינו שרכבת/טיסה עשויות להיות מהירות יותר.',
    parameters: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: {
      from: str('מקום מוצא באנגלית עם עיר ומדינה'), to: str('מקום יעד באנגלית עם עיר ומדינה'),
    } },
  },
  {
    name: 'opening_hours',
    description: 'האם מקום פתוח בתאריך ובשעה נתונים, לפי OSM/Google. השתמשו כשמציעים שעה לתחנה או כששואלים אם משהו פתוח.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: str('השם באנגלית עם עיר ומדינה'), date: str('YYYY-MM-DD'), time: str('HH:MM'),
    } },
  },
];
const connectorTools = {
  calendar: [{
    name: 'calendar_events',
    description: 'האירועים ביומן Google של המטיילים בטווח תאריכים — מה כבר קבוע, מתי פנויים.',
    parameters: { type: 'object', additionalProperties: false, required: ['date_from', 'date_to'], properties: { date_from: str('YYYY-MM-DD'), date_to: str('YYYY-MM-DD') } },
  }],
  gmail: [
    {
      name: 'gmail_search',
      description: 'חיפוש בהודעות Gmail של המטיילים (תחביר חיפוש של Gmail), למשל "booking confirmation Kyoto" או "from:elal.co.il". מחזיר נושא, שולח, תאריך וקטע.',
      parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: str('שאילתת חיפוש') } },
    },
    {
      name: 'gmail_read',
      description: 'הטקסט המלא של הודעה אחת מתוצאות gmail_search, לפי id.',
      parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: str('מזהה ההודעה') } },
    },
  ],
  drive: [
    {
      name: 'drive_search',
      description: 'חיפוש קבצים ב-Google Drive של המטיילים לפי שם או תוכן.',
      parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: str('מילות חיפוש') } },
    },
    {
      name: 'drive_read',
      description: 'הטקסט של קובץ אחד מ-Drive (מסמך Google, גיליון או קובץ טקסט), לפי id.',
      parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: str('מזהה הקובץ') } },
    },
  ],
};

// the tool list for one turn: the base set, plus the connectors this user switched on
function toolsFor({ services = [] } = {}) {
  const defs = [...base];
  for (const s of services) if (connectorTools[s]) defs.push(...connectorTools[s]);
  return defs.map((d) => ({ type: 'function', function: { ...d, strict: false } }));
}

// the prompt paragraph that tells the model what it can look up — and that a look-up
// beats a guess. Positive forms only (PLAYBOOK §3: "don't" is ignored half the time).
function promptRules({ services = [] } = {}) {
  const extra = services.length
    ? ` המטיילים חיברו גם: ${services.map((s) => connectors.SERVICES[s] ? connectors.SERVICES[s].label : s).join(', ')} — כשהשאלה נוגעת למה שיש להם שם (טיסות שהוזמנו, אירועים, מסמכים), קראו משם במקום לשאול.`
    : '';
  return `כלים: יש לכם כלים לבדוק דברים במקום לנחש — מזג אוויר (get_weather), חיפוש באתרי טיולים מורשים (web_search: Booking, Klook, SWISS, אל על, Google Maps ועוד) וקריאת דף (read_page), איתור מקום במפה (find_place), זמן נסיעה (travel_time) ושעות פתיחה (opening_hours).${extra}
מתי משתמשים: כל שאלה על מחיר, זמינות, שעות, מזג אוויר, מרחק או "האם קיים" נענית אחרי בדיקה בכלי המתאים; מקום שאתם לא בטוחים בו עובר find_place לפני שהוא נכנס ל-ops או ל-cards. כשהתשובה ברורה מהידע שלכם ומהטיול — ענו ישר, בלי כלים. עד ${MAX_TOOL_ROUNDS} סבבי כלים בתור; כשכלי מחזיר error — אמרו זאת במשפט ועברו הלאה. בתשובה ציינו בקצרה על מה הסתמכתם ("לפי Booking…", "התחזית ל-…"), ואת הקישור כשיש אחד רלוונטי.`;
}

// ---------- execution ----------
const isoOrNull = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
const cut = (v) => {
  const s = JSON.stringify(v);
  return s.length <= RESULT_MAX_CHARS ? s : s.slice(0, RESULT_MAX_CHARS - 20) + '…"}';
};
const mapsUrl = (q, placeId) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) + (placeId ? '&query_place_id=' + encodeURIComponent(placeId) : '');

async function locate(query) {
  const q = String(query || '').trim().slice(0, 160);
  if (!q) return { error: 'חסר שם מקום' };
  const v = await verifyPlace(q, { timeoutMs: 5000 });
  if (v.verdict === 'skipped') return { query: q, verdict: 'skipped', note: 'שירות המפות לא ענה — לא ניתן לאמת כרגע' };
  if (!v.best || v.verdict !== 'ok') return { query: q, verdict: v.verdict, note: 'לא נמצא מקום כזה במפה — כנראה לא קיים בשם הזה; הציעו משהו אחר או שאלו' };
  const b = v.best;
  return { query: q, verdict: 'ok', name: b.name, where: b.where, country: b.cc, lat: b.lat, lon: b.lon, maps_url: mapsUrl(q, b.place_id), _ref: { osm_type: b.osm_type, osm_id: b.osm_id, place_id: b.place_id } };
}

async function run(name, args, { userId }) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'get_weather':
      return weather.weatherFor({ place: a.place, from: isoOrNull(a.date_from), to: isoOrNull(a.date_to) });
    case 'web_search':
      return web.search(a.query, { category: a.category });
    case 'read_page':
      return web.readPage(a.url);
    case 'find_place': {
      const r = await locate(a.query);
      delete r._ref;
      return r;
    }
    case 'travel_time': {
      const [from, to] = await Promise.all([locate(a.from), locate(a.to)]);
      if (from.verdict !== 'ok' || to.verdict !== 'ok') return { error: `לא הצלחתי לאתר ${from.verdict !== 'ok' ? `את "${a.from}"` : `את "${a.to}"`}` };
      const legs = await routeLegs([{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }]);
      if (!legs) return { from: from.name, to: to.name, error: 'שירות הניווט לא ענה' };
      const leg = legs[0];
      return { from: from.name, to: to.name, minutes: leg.minutes, km: leg.km, mode: 'driving', note: leg.km > 120 ? 'מרחק גדול — בין ערים כדאי לבדוק רכבת או טיסה' : '' };
    }
    case 'opening_hours': {
      const p = await locate(a.query);
      if (p.verdict !== 'ok') return p;
      const h = await hours.placeHours({ osmType: p._ref.osm_type, osmId: p._ref.osm_id, googlePlaceId: p._ref.place_id });
      const date = isoOrNull(a.date) || new Date().toISOString().slice(0, 10);
      const v = hours.verifyOpen(h, new Date(date + 'T00:00:00'), a.time || null);
      return { place: p.name, date, time: a.time || null, verdict: v.verdict, reason: v.reason || '', windows: h ? hours.openWindows(h, new Date(date + 'T00:00:00')) : null };
    }
    case 'calendar_events': return connectors.calendarEvents(userId, { from: a.date_from, to: a.date_to });
    case 'gmail_search': return connectors.gmailSearch(userId, { query: a.query });
    case 'gmail_read': return connectors.gmailRead(userId, { id: a.id });
    case 'drive_search': return connectors.driveSearch(userId, { query: a.query });
    case 'drive_read': return connectors.driveRead(userId, { id: a.id });
    default: return { error: `כלי לא מוכר: ${name}` };
  }
}

// one tool call, never throwing — the model gets a string either way
async function execute(name, rawArgs, ctx) {
  let args = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return cut({ error: 'ארגומנטים לא תקינים' }); }
  const allowed = new Set(toolsFor(ctx).map((t) => t.function.name));
  if (!allowed.has(name)) return cut({ error: 'הכלי הזה לא זמין בתור הזה' });
  try {
    const out = await run(name, args, ctx);
    return cut(out);
  } catch (err) {
    const msg = err && err.message === 'permission' ? 'אין הרשאה — החיבור הזה צריך אישור מחדש בהגדרות'
      : err && err.message === 'not connected' ? 'השירות הזה לא מחובר'
        : `הכלי נכשל (${(err && err.message) || 'unknown'})`;
    console.warn(`ai-tools: ${name} failed: ${err && err.message}`);
    return cut({ error: msg });
  }
}

// one line per call for the UI: "🔎 חיפוש · Booking"
function describeCall(name, rawArgs) {
  let a = {};
  try { a = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* label without detail */ }
  const l = LABELS[name] || { icon: '🛠️', doing: name, done: name };
  let detail = '';
  if (name === 'web_search') detail = SITE_LABEL[a.category] || '';
  else if (name === 'get_weather') detail = String(a.place || '').slice(0, 30);
  else if (name === 'find_place' || name === 'opening_hours') detail = String(a.query || '').split(',')[0].slice(0, 30);
  else if (name === 'travel_time') detail = `${String(a.from || '').split(',')[0]} → ${String(a.to || '').split(',')[0]}`.slice(0, 40);
  else if (name === 'read_page') { try { detail = new URL(a.url).hostname.replace(/^www\./, ''); } catch { /* none */ } }
  else if (name === 'gmail_search' || name === 'drive_search') detail = String(a.query || '').slice(0, 30);
  return { tool: name, icon: l.icon, doing: l.doing, done: l.done, detail };
}

// ---------- progress: what the chat shows while the turn works ----------
// One api_cache row per turn (scope ai_progress), written straight to the table — the
// L1 in lib/api-budget.js would hand a polling instance its own stale copy. The chat
// polls GET /api/ai/progress/:id while it waits. Nothing here may fail a turn.
const PROGRESS_SCOPE = 'ai_progress';
function progress(turnId, userId) {
  const id = /^[a-zA-Z0-9-]{8,64}$/.test(String(turnId || '')) ? String(turnId) : null;
  const steps = [];
  const write = async () => {
    if (!id) return;
    try {
      await pool.query(
        `INSERT INTO api_cache (scope, key, value, fetched_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
        [PROGRESS_SCOPE, id, JSON.stringify({ user_id: userId, steps })]
      );
    } catch { /* a progress line that did not land is not news */ }
  };
  return {
    id,
    steps,
    start(name, rawArgs) {
      const step = { ...describeCall(name, rawArgs), status: 'running', at: Date.now() };
      steps.push(step);
      write();
      return step;
    },
    finish(step, ok = true) { step.status = ok ? 'done' : 'failed'; write(); },
    thinking() { if (steps.length) write(); },
    // what the stored message keeps: tool, label, detail — not the arguments
    summary: () => steps.map((s) => ({ tool: s.tool, icon: s.icon, label: s.done, detail: s.detail, status: s.status })),
  };
}
async function readProgress(turnId, userId) {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(String(turnId || ''))) return null;
  try {
    const { rows } = await pool.query('SELECT value FROM api_cache WHERE scope = $1 AND key = $2', [PROGRESS_SCOPE, String(turnId)]);
    const v = rows[0] && rows[0].value;
    if (!v || v.user_id !== userId) return null;
    return (v.steps || []).map((s) => ({ tool: s.tool, icon: s.icon, label: s.status === 'running' ? s.doing : s.done, detail: s.detail, status: s.status }));
  } catch { return null; }
}

module.exports = {
  toolsFor, promptRules, execute, describeCall, progress, readProgress, LABELS,
  MAX_TOOL_ROUNDS, MAX_CALLS_PER_ROUND,
};
