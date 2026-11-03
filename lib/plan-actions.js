// What the AI may change on a trip besides its stops: the hotels, the budget frame, the
// dates — and the moments (lib/moments.js): a ticket or a confirmation handed to the chat
// becomes a timed push with the document a tap away, through this same card. Stops go through ops (routes/ai.js applyEditOps); these are the rest of
// what a traveller hands the chat — "we booked the Hilton for the first three nights",
// "our budget is 12,000 shekels", a hotel confirmation photographed off a screen — and
// they ride the same card: proposed and applied on approval, or committed on the spot
// with an undo (routes/plan.js decides which, per turn).
//
// Every action is checked here with the same cleaners the hand-edit routes use
// (routes/trips.js cleanHotel, the budget PUT, the dates PUT), inside the caller's
// transaction, and every write records its exact inverse so an undo never touches
// what a co-planner changed meanwhile.
const moments = require('./moments');
const clock = require('./trip-clock');
const { verifyPlace } = require('./places');
const { cleanDestinations } = require('./trips');

const MAX_DAYS = 60; // the same ceiling trip creation keeps (routes/trips.js)

const KINDS = ['hotel_add', 'hotel_update', 'hotel_delete', 'budget_set', 'budget_clear', 'dates_set', 'moment_add', 'trip_update'];
const TITLE_MAX = 120;
const DESC_MAX = 500; // the cap PATCH /api/trips/:id keeps
const MAX_DESTS = 10; // lib/trips.js cleanDestinations
const BUDGET_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'JPY', 'THB', 'CHF'];

// one shape for every kind (strict JSON schema: every field present, null when unused)
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id', 'name', 'night_start', 'night_end', 'status', 'stars', 'price_total', 'link', 'note', 'total', 'currency', 'travelers', 'start_date', 'end_date', 'days', 'keep_calendar', 'moment', 'title', 'description', 'destinations'],
  properties: {
    kind: { type: 'string', enum: KINDS },
    id: { type: ['integer', 'null'] },
    name: { type: ['string', 'null'] },
    night_start: { type: ['integer', 'null'] },
    night_end: { type: ['integer', 'null'] },
    status: { type: ['string', 'null'], enum: ['booked', 'idea', null] },
    stars: { type: ['integer', 'null'] },
    price_total: { type: ['number', 'null'] },
    link: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
    total: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'], enum: [...BUDGET_CURRENCIES, null] },
    travelers: { type: ['integer', 'null'] },
    start_date: { type: ['string', 'null'] },
    // dates_set only: the last day, or the trip's length — a trip's length used to be
    // fixed at creation, and "from the 26th to the 17th" had nowhere to go but the facts
    end_date: { type: ['string', 'null'] },
    days: { type: ['integer', 'null'] },
    // dates_set only: the stops and hotels keep their calendar dates when day 1 moves
    // (true), or move with the trip (false/null)
    keep_calendar: { type: ['boolean', 'null'] },
    // trip_update only: the trip's name, its description and its destinations — null for
    // what does not change. The destinations are the WHOLE new list, in order.
    title: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    destinations: {
      type: ['array', 'null'],
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'country', 'query'],
        properties: { name: { type: 'string' }, country: { type: ['string', 'null'] }, query: { type: 'string' } },
      },
    },
    // moment_add only: the timed thing and its documents (lib/moments.js). null elsewhere.
    moment: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['kind', 'title', 'local_time', 'tz', 'lead_minutes', 'details', 'docs', 'hotel'],
      properties: {
        kind: { type: 'string', enum: moments.KIND_KEYS },
        title: { type: 'string' },
        local_time: { type: 'string' },
        tz: { type: ['string', 'null'] },
        lead_minutes: { type: ['integer', 'null'] },
        details: {
          type: 'object', additionalProperties: false,
          required: moments.DETAIL_KEYS,
          properties: Object.fromEntries(moments.DETAIL_KEYS.map((k) => [k, { type: ['string', 'null'] }])),
        },
        docs: { type: 'array', items: { type: 'string' } },
        hotel: {
          type: ['object', 'null'], additionalProperties: false,
          required: ['name', 'night_start', 'night_end', 'price_total', 'note'],
          properties: {
            name: { type: 'string' }, night_start: { type: ['integer', 'null'] }, night_end: { type: ['integer', 'null'] },
            price_total: { type: ['number', 'null'] }, note: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};

// the rules, for the model — shared by the planning chat and the recommendations chat
const PROMPT_RULES = (days) =>
`פעולות על הטיול מעבר לתחנות (actions) — מלונות, תקציב ותאריכים; [] כשאין:
- hotel_add: name (שם המלון כפי שכתוב), night_start/night_end (לילה N = הלילה שבין יום N ליום N+1; בין 1 ל-${Math.max(days - 1, 1)}, או לפי אורך הטיול החדש כשבאותו תור יש dates_set שמאריך אותו), status "booked" כשיש הזמנה/אישור ו-"idea" כשזה רק רעיון, price_total המחיר הכולל כמספר (או null), link, note קצר (מספר הזמנה, כתובת) או null.
- hotel_update: id של מלון קיים מהרשימה, ו-null בכל שדה שלא משתנה. hotel_delete: id בלבד.
- budget_set: total (סכום כולל, מספר), currency מתוך ILS/USD/EUR/GBP/JPY/THB/CHF, travelers (מספר נוסעים) — null במה שלא נאמר. budget_clear: מוחק את מסגרת התקציב.
- dates_set: תאריכי הטיול ואורכו. start_date (יום 1) ו/או end_date (היום האחרון) בפורמט YYYY-MM-DD, או days (מספר הימים, עד ${MAX_DAYS}) — null במה שלא משתנה. "מה-26.10 עד ה-17.11" → start_date ו-end_date שניהם. keep_calendar=true כשיום 1 זז אבל התחנות והמלונות צריכים להישאר בתאריכים שלהם (למשל "יצאנו יום קודם", "היום יום ההגעה" כשהמסלול כבר מתוכנן לפי תאריכים) — אז מספרי הימים שלהם זזים; false כשכל הטיול זז יחד ("הטיול נדחה בשבוע"). כשיש באותו תור גם ops — מספרי הימים שבהם הם לפי הטיול אחרי השינוי. מספיק שהמטיילים אמרו תאריך, או שהוא נגזר בוודאות ממה שאמרו ומהתאריך של היום — לא צריך כרטיס.
- moment_add: תזכורת שהאפליקציה דוחפת לטלפון לפני אירוע בשעה נתונה, עם המסמך פתוח בלחיצה — כל כרטיס או אישור שצורף או נקרא מ-Gmail מניב כזו (טיסה: לכל המראה, גם קונקשן; אוטובוס/רכבת/מעבורת; צ׳ק-אין במלון; אישור כניסה כמו Visit Japan Web — בשעת הנחיתה; כרטיס עם שעה; איסוף רכב). השדה moment: kind מתוך flight/transport/hotel_checkin/hotel_checkout/entry/activity/car/other; title קצר בעברית; local_time YYYY-MM-DDTHH:MM בשעה המקומית של מקום האירוע; tz אזור הזמן IANA של אותו מקום (Asia/Jerusalem להמראה מנתב"ג, Asia/Tokyo לנחיתה בטוקיו); lead_minutes או null לברירת המחדל; details רק מה שכתוב (code = מספר הזמנה/PNR, number = מספר טיסה/קו, from/to, seat, gate, terminal, platform, address, phone, provider, passenger, price, link, note — null באחרים); docs = שמות הקבצים שצורפו ושהתזכורת צריכה לפתוח (או []). אישור מלון שצורף: moment_add אחד עם kind hotel_checkin ועם hotel (name, night_start, night_end, price_total, note) — במקום hotel_add; צ�)ק-אין בלי שעה כתובה: 15:00 ו-note על זה. בכל פעולה אחרת moment הוא null. כשלמסמך אין תאריך ולטיול אין תאריך יציאה — שאלו במקום לנחש.
- trip_update: פרטי הטיול עצמו — title (שם הטיול), description (תיאור קצר, 1-2 משפטים, עד ${DESC_MAX} תווים) ו-destinations (הרשימה המלאה והחדשה של היעדים, לפי הסדר: name בעברית כפי שמוצג בטיול, country בעברית, query באנגלית לחיפוש במפה, למשל "Kyoto, Japan") — null במה שלא משתנה. יעד שנשאר שומר בדיוק על אותו name. שינוי שם הטיול תמיד מוצע לאישור (commit=false), גם כשהתבקש. שינוי ביעדים מאפס את הצ'קליסט ואת ההמלצות לפי יום, והם נבנים מחדש לבד ליעדים החדשים — אמרו זאת ב-text. כשמוציאים יעד מהטיול, באותו תור מוחקים או מעבירים ב-ops את התחנות שלו; תחנות ביעד חדש מוסיפים בתור הבא, אחרי שהיעד נכנס. משנים את היעדים רק כשהמטיילים ביקשו או אישרו — לא כהצעה שלכם לשיפור.
- לא ממציאים: מלון, מחיר, מספר הזמנה, שעה או תאריך שלא נאמרו או לא כתובים במסמך.`;

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
const moneyOrNull = (v, max) => { const n = numOrNull(v); return n != null && n >= 0 ? Math.min(n, max) : null; };
const str = (v, n) => (v == null ? null : String(v).slice(0, n).trim() || null);
const isoDate = (v) => {
  const s = str(v, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s ? s : null;
};
// a DATE column read in the server's own zone — never toISOString() (lib/trip-clock.js)
const toIso = clock.isoOf;

// the model's raw actions → the ones that can be written, each in the row's own shape
function cleanActions(raw, trip, hotels) {
  const byId = new Map((hotels || []).map((h) => [h.id, h]));
  // a trip lengthened in the same answer ("make it 23 days, and the Hilton for the last
  // three nights") takes hotel nights up to its new length; applyActions clamps again
  // against what was actually written
  let days = trip.days;
  for (const a of Array.isArray(raw) ? raw : []) {
    if (!a || a.kind !== 'dates_set') continue;
    const s = isoDate(a.start_date) || clock.isoOf(trip.start_date);
    const e = isoDate(a.end_date);
    const n = s && e ? clock.dayDiff(s, e) + 1 : parseInt(a.days, 10);
    if (Number.isInteger(n) && n > days && n <= MAX_DAYS) days = n;
  }
  const maxNight = Math.max(days - 1, 1);
  const night = (v, dflt) => Math.min(Math.max(parseInt(v, 10) || dflt, 1), maxNight);
  const out = [];
  for (const a of (Array.isArray(raw) ? raw : []).slice(0, 12)) {
    if (!a || !KINDS.includes(a.kind)) continue;
    if (a.kind === 'hotel_add') {
      const name = str(a.name, 160);
      if (!name) continue;
      const night_start = night(a.night_start, 1);
      const stars = numOrNull(a.stars);
      out.push({
        kind: 'hotel_add', name, night_start,
        night_end: Math.max(night(a.night_end, night_start), night_start),
        status: a.status === 'idea' ? 'idea' : 'booked',
        stars: stars != null && stars >= 1 ? Math.min(Math.round(stars), 5) : null,
        price_total: moneyOrNull(a.price_total, 999999999),
        link: a.link && /^https?:\/\//i.test(String(a.link).trim()) ? str(a.link, 400) : null,
        note: str(a.note, 300),
      });
    } else if (a.kind === 'hotel_update') {
      const cur = byId.get(a.id);
      if (!cur) continue;
      const patch = {};
      if (str(a.name, 160)) patch.name = str(a.name, 160);
      if (a.night_start != null) patch.night_start = night(a.night_start, cur.night_start);
      if (a.night_end != null) patch.night_end = night(a.night_end, cur.night_end);
      if (patch.night_start != null || patch.night_end != null) {
        const s = patch.night_start ?? cur.night_start;
        patch.night_end = Math.max(patch.night_end ?? cur.night_end, s);
      }
      if (a.status === 'booked' || a.status === 'idea') patch.status = a.status;
      if (a.stars != null) { const s = numOrNull(a.stars); patch.stars = s != null && s >= 1 ? Math.min(Math.round(s), 5) : null; }
      if (a.price_total != null) patch.price_total = moneyOrNull(a.price_total, 999999999);
      if (a.link != null) patch.link = /^https?:\/\//i.test(String(a.link).trim()) ? str(a.link, 400) : null;
      if (a.note != null) patch.note = str(a.note, 300);
      if (!Object.keys(patch).length) continue;
      out.push({ kind: 'hotel_update', id: cur.id, patch });
    } else if (a.kind === 'hotel_delete') {
      if (byId.has(a.id)) out.push({ kind: 'hotel_delete', id: a.id });
    } else if (a.kind === 'budget_set') {
      const total = moneyOrNull(a.total, 999999999);
      const currency = BUDGET_CURRENCIES.includes(a.currency) ? a.currency : null;
      const travelers = a.travelers != null ? Math.min(Math.max(parseInt(a.travelers, 10) || 1, 1), 50) : null;
      if (total == null && !currency && travelers == null) continue;
      out.push({ kind: 'budget_set', total: total != null && total > 0 ? total : null, currency, travelers });
    } else if (a.kind === 'budget_clear') {
      out.push({ kind: 'budget_clear' });
    } else if (a.kind === 'dates_set') {
      // start and end both said → the length follows from them; one of them alone moves
      // that end (resolved at write time against the trip as it is then)
      const start = isoDate(a.start_date);
      const end = isoDate(a.end_date);
      let days = a.days != null ? parseInt(a.days, 10) : null;
      days = Number.isInteger(days) && days >= 1 ? Math.min(days, MAX_DAYS) : null;
      if (start && end) {
        const n = clock.dayDiff(start, end) + 1;
        if (n < 1 || n > MAX_DAYS) continue;
        days = n;
      }
      if (!start && !end && days == null) continue;
      out.push({ kind: 'dates_set', start_date: start, end_date: start ? null : end, days, keep_calendar: a.keep_calendar === true });
    } else if (a.kind === 'moment_add') {
      // shape-checked here, with the model's zone when it named a real one; the trip's own
      // zone is looked up at write time (applyActions — it is a network question). The
      // chat already writes the flight stop through its ops, so a chat moment adds no stop.
      const m = a.moment && typeof a.moment === 'object' ? a.moment : a;
      const title = str(m.title, 120);
      const local = str(m.local_time, 16);
      if (!title || !local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) continue;
      out.push({
        kind: 'moment_add',
        moment: {
          kind: moments.KIND_KEYS.includes(m.kind) ? m.kind : 'other',
          title, local_time: local,
          tz: moments.validTz(m.tz) ? m.tz : null,
          lead_minutes: m.lead_minutes == null ? null : parseInt(m.lead_minutes, 10),
          details: moments.cleanDetails(m.details),
          docs: moments.cleanDocs(m.docs),
          hotel: m.kind === 'hotel_checkin' && m.hotel && typeof m.hotel === 'object' ? {
            name: str(m.hotel.name, 160) || title,
            night_start: m.hotel.night_start, night_end: m.hotel.night_end,
            price_total: m.hotel.price_total, note: str(m.hotel.note, 300),
          } : null,
          source: { type: 'chat' },
          stop: false,
        },
      });
    } else if (a.kind === 'trip_update') {
      const title = str(a.title, TITLE_MAX);
      const description = a.description == null ? null : String(a.description).replace(/\s+/g, ' ').slice(0, DESC_MAX).trim() || null;
      let destinations = null;
      if (Array.isArray(a.destinations)) {
        const seen = new Set();
        destinations = a.destinations.slice(0, MAX_DESTS).map((d) => ({
          name: str(d && d.name, 80), country: str(d && d.country, 60), query: str(d && d.query, 160),
        })).filter((d) => d.name && !seen.has(d.name) && seen.add(d.name));
        if (!destinations.length) destinations = null; // a trip always has somewhere to go
      }
      if (!title && description == null && !destinations) continue;
      out.push({ kind: 'trip_update', title, description, destinations });
    }
  }
  return out;
}

// a trip_update that renames the trip waits for a tap, whatever the model flagged: the
// name is the travellers' own words, on every invite and in the gallery
const needsApproval = (acts) => (acts || []).some((a) => a.kind === 'trip_update' && a.title);

const nights = (a, b) => (a === b ? `לילה ${a}` : `לילות ${a}–${b}`);
const money = (n, cur) => `${Math.round(+n).toLocaleString('he-IL')} ${cur || ''}`.trim();

// one Hebrew line per action — for the card, and for the history the model reads back
function describeAction(a, hotels, budget) {
  const byId = new Map((hotels || []).map((h) => [h.id, h]));
  if (a.kind === 'hotel_add') {
    return { kind: 'hotel', title: a.name, when: nights(a.night_start, a.night_end), note: [a.status === 'idea' ? 'רעיון' : 'הוזמן', a.price_total != null ? money(a.price_total) : ''].filter(Boolean).join(' · ') };
  }
  if (a.kind === 'hotel_update') {
    const cur = byId.get(a.id) || {};
    const changes = [];
    const p = a.patch || {};
    if (p.name) changes.push(`שם: ${p.name}`);
    if (p.night_start != null || p.night_end != null) changes.push(nights(p.night_start ?? cur.night_start, p.night_end ?? cur.night_end));
    if (p.status) changes.push(p.status === 'idea' ? 'רעיון' : 'הוזמן');
    if (p.price_total !== undefined) changes.push(p.price_total == null ? 'בלי מחיר' : money(p.price_total));
    if (p.note !== undefined) changes.push('הערה');
    if (p.link !== undefined) changes.push('קישור');
    if (p.stars !== undefined) changes.push(p.stars ? `${p.stars} כוכבים` : 'בלי כוכבים');
    return { kind: 'hotel', title: cur.name || `מלון #${a.id}`, when: '', changes };
  }
  if (a.kind === 'hotel_delete') {
    const cur = byId.get(a.id) || {};
    return { kind: 'hotel_delete', title: cur.name || `מלון #${a.id}`, when: cur.night_start ? nights(cur.night_start, cur.night_end) : '' };
  }
  if (a.kind === 'budget_set') {
    const cur = budget || {};
    const parts = [];
    if (a.total != null) parts.push(money(a.total, a.currency || cur.currency || 'ILS'));
    else if (a.currency) parts.push(a.currency);
    if (a.travelers != null) parts.push(`${a.travelers} נוסעים`);
    return { kind: 'budget', title: `תקציב: ${parts.join(' · ') || 'עדכון'}` };
  }
  if (a.kind === 'budget_clear') return { kind: 'budget', title: 'ביטול מסגרת התקציב' };
  if (a.kind === 'dates_set') {
    const he = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('he-IL', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
    const parts = [];
    if (a.start_date && a.days != null) {
      parts.push(`${he(a.start_date)} – ${he(clock.addDays(a.start_date, a.days - 1))}`);
    } else if (a.start_date) parts.push(`יציאה: ${he(a.start_date)}`);
    else if (a.end_date) parts.push(`חזרה: ${he(a.end_date)}`);
    const changes = [];
    if (a.days != null) changes.push(`${a.days} ימים`);
    if (a.keep_calendar) changes.push('התחנות נשארות בתאריכים שלהן');
    return { kind: 'dates', title: `תאריכי הטיול: ${parts.join(' ') || `${a.days} ימים`}`, when: '', changes: a.start_date || a.end_date ? changes : [] };
  }
  if (a.kind === 'moment_add') {
    const m = a.moment || {};
    const k = moments.KINDS[m.kind] || moments.KINDS.other;
    const d = new Date(m.local_time + ':00Z');
    const when = Number.isNaN(d.getTime()) ? m.local_time
      : `${d.toLocaleDateString('he-IL', { timeZone: 'UTC', day: 'numeric', month: 'short' })} · ${m.local_time.slice(11, 16)}`;
    const lead = Number.isInteger(m.lead_minutes) ? m.lead_minutes : k.lead;
    return { kind: 'moment', title: `${k.emoji} ${m.title}`, when, note: `תזכורת ${moments.leadText(lead, { prefix: '' })} לפני${(m.docs || []).length ? ' · עם המסמך' : ''}${m.hotel ? ' · המלון נוסף לרשימה' : ''}` };
  }
  if (a.kind === 'trip_update') {
    const changes = [];
    if (a.description != null) changes.push('תיאור חדש');
    if (a.destinations) changes.push(`יעדים: ${a.destinations.map((d) => d.name).join(' · ')}`);
    if (a.destinations) changes.push('הצ\'קליסט וההמלצות לפי יום ייבנו מחדש');
    return { kind: 'trip', title: a.title ? `שם הטיול: ${a.title}` : 'פרטי הטיול', when: '', changes };
  }
  return { kind: 'update', title: a.kind };
}

// ---- reading what is on the trip, for the prompt and for the cleaners ----

const loadHotels = (client, tripId) => client.query(
  'SELECT * FROM trip_hotels WHERE trip_id = $1 ORDER BY night_start, id', [tripId]
).then((r) => r.rows);
const loadBudget = (client, tripId) => client.query(
  'SELECT total, currency, travelers FROM trip_budgets WHERE trip_id = $1', [tripId]
).then((r) => r.rows[0] || null);
// What else is on the trip, for the model to READ: the reminders already set (so it
// doesn't set the same flight twice), what was spent (so "how are we doing on money"
// has an answer), and how the co-planners voted on the stops. Each is a few short
// lines — the prompt grows by tens of tokens, not hundreds.
const loadMoments = (client, tripId) => client.query(
  `SELECT kind, title, local_time FROM trip_moments WHERE trip_id = $1 AND status = 'active'
   ORDER BY starts_at, id LIMIT 20`, [tripId]
).then((r) => r.rows).catch(() => []);
const loadSpend = (client, tripId) => client.query(
  `SELECT category, count(*)::int AS n, coalesce(sum(amount), 0)::float AS total
   FROM trip_expenses WHERE trip_id = $1 GROUP BY category ORDER BY total DESC`, [tripId]
).then((r) => r.rows).catch(() => []);
const loadVotes = (client, tripId) => client.query(
  `SELECT v.item_id, sum(CASE WHEN v.vote > 0 THEN 1 ELSE 0 END)::int AS up,
          sum(CASE WHEN v.vote < 0 THEN 1 ELSE 0 END)::int AS down
   FROM trip_stop_votes v JOIN trip_items i ON i.id = v.item_id
   WHERE i.trip_id = $1 GROUP BY v.item_id ORDER BY v.item_id LIMIT 40`, [tripId]
).then((r) => r.rows).catch(() => []);
const loadSide = async (client, tripId) => ({
  hotels: await loadHotels(client, tripId), budget: await loadBudget(client, tripId),
  moments: await loadMoments(client, tripId), spend: await loadSpend(client, tripId), votes: await loadVotes(client, tripId),
});

function extraLines(side) {
  if (!side) return '';
  const out = [];
  const ms = side.moments || [];
  out.push(`תזכורות שכבר קיימות (לא מוסיפים שוב את אותה אחת): ${ms.length
    ? ms.map((m) => `${(moments.KINDS[m.kind] || moments.KINDS.other).emoji} ${m.title}${m.local_time ? ` ${m.local_time.replace('T', ' ')}` : ''}`).join(' | ')
    : '(אין)'}`);
  const sp = side.spend || [];
  if (sp.length) {
    const total = sp.reduce((t, r) => t + r.total, 0);
    const cur = side.budget && side.budget.currency ? side.budget.currency : '';
    out.push(`הוצאות שנרשמו: ${sp.reduce((t, r) => t + r.n, 0)} בסך ${money(total, cur)} (${sp.slice(0, 6).map((r) => `${r.category} ${money(r.total)}`).join(' · ')})`);
  }
  const vs = (side.votes || []).filter((v) => v.up || v.down);
  if (vs.length) out.push(`הצבעות המשתתפים על תחנות (#מזהה 👍/👎): ${vs.map((v) => `#${v.item_id} ${v.up}/${v.down}`).join(' · ')} — תחנה עם רוב 👎 היא מועמדת להחלפה כשמבקשים לשפר.`);
  return '\n' + out.join('\n');
}

// the lines the model reads: every hotel with its id, the budget frame, and — when the
// whole side was loaded — the reminders, the spending and the votes
function contextLines(hotels, budget, side = null) {
  const h = (hotels || []).length
    ? hotels.map((x) => `#${x.id} | ${x.name} | ${nights(x.night_start, x.night_end)} | ${x.status === 'idea' ? 'רעיון' : 'הוזמן'}${x.price_total != null ? ` | ${money(x.price_total)}` : ''}${x.note ? ` | ${String(x.note).slice(0, 80)}` : ''}`).join('\n')
    : '(אין עדיין)';
  const b = budget
    ? `${budget.total != null ? money(budget.total, budget.currency) : `בלי תקרה (${budget.currency})`} · ${budget.travelers} נוסעים`
    : '(לא הוגדר)';
  return `מלונות (כל שורה: #מזהה | שם | לילות | סטטוס | מחיר):\n${h}\nתקציב: ${b}${extraLines(side)}`;
}

// ---- writing, inside the caller's transaction ----

// Moving every day-numbered row of a trip by `shift` days: the stops, the hotel nights
// and the expenses' day tags. What lives on a calendar instant (moments) does not move.
// The free days' picks are keyed by day number and are simply dropped — the page asks
// for them again (routes/day-recs.js) against the trip as it now is.
async function shiftDays(client, tripId, shift) {
  if (!shift) return;
  await client.query('UPDATE trip_items SET day_number = day_number + $1 WHERE trip_id = $2', [shift, tripId]);
  await client.query('UPDATE trip_hotels SET night_start = night_start + $1, night_end = night_end + $1 WHERE trip_id = $2', [shift, tripId]);
  await client.query('UPDATE trip_expenses SET day_number = day_number + $1 WHERE trip_id = $2 AND day_number IS NOT NULL', [shift, tripId]);
}
const dropDayRecs = (client, tripId) => client.query('DELETE FROM trip_day_recs WHERE trip_id = $1', [tripId]);

// ---- the trip's own details: title, description, destinations ----

const TRIP_COLS = 'title, description, destinations, destination, country, cover_image';
// a place is its name: the model writing "Japan" where the trip says "יפן" is not a move
const destKey = (list) => JSON.stringify((list || []).map((d) => d.name));

// the model's new list → the trip's shape, with coordinates: a place the trip already
// had keeps its own (the browser geocoded it at creation); a new one is looked up once
// on the keyless geocoder, and goes in without a pin when that finds nothing — the page
// and the time zone fall back to the country, as they do for a typed destination
async function resolveDestinations(list, prev) {
  const known = new Map((prev || []).map((d) => [d.name, d]));
  const out = await Promise.all(list.map(async (d) => {
    const had = known.get(d.name);
    if (had) return { ...had };
    let lat = null;
    let lon = null;
    if (d.query) {
      const v = await verifyPlace(d.query, { allowGoogle: false, timeoutMs: 4000 }).catch(() => null);
      if (v && v.verdict === 'ok' && v.best) { lat = v.best.lat; lon = v.best.lon; }
    }
    return { name: d.name, country: d.country || null, lat, lon };
  }));
  return cleanDestinations(out);
}

// what hangs on where the trip goes, brought in line after it changed (and after an
// undo changed it back): the checklist built for the old places (routes/checklist.js
// resetForDestinations — rebuilt free on the next open), the free days' picks, and a
// landmark cover of a place the trip no longer visits. The area recommendations key
// themselves by the destinations (trip_rec_areas.signature) and the time zone is read
// from them every time, so neither needs a hand here. Lazy requires: both routes
// require this file.
async function destinationsMoved(client, trip, dests) {
  await require('../routes/checklist').resetForDestinations(client, { ...trip, destinations: dests }).catch((err) => {
    console.warn('plan-actions: checklist reset failed', err.message);
  });
  await dropDayRecs(client, trip.id);
  const { rows } = await client.query('SELECT cover_image FROM trips WHERE id = $1', [trip.id]);
  const cover = require('../routes/ai').coverForDests(rows[0] && rows[0].cover_image, dests);
  if (cover) await client.query('UPDATE trips SET cover_image = $1 WHERE id = $2', [cover, trip.id]);
}

const destColumns = (dests) => ({
  destinations: JSON.stringify(dests),
  destination: dests.map((d) => d.name).join(' · ').slice(0, 160),
  country: [...new Set(dests.map((d) => d.country).filter(Boolean))].join(', ') || null,
});

async function writeTrip(client, trip, cols) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  await client.query(
    `UPDATE trips SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => cols[k]), trip.id]
  );
  for (const k of keys) trip[k] = k === 'destinations' ? JSON.parse(cols[k]) : cols[k];
}

// → { count, undo: [inverse actions, in reverse order], already, skipped, calendar }
// `already`: actions that asked for what the trip already is — the card says "already
// so", not "not done" (2026-11-01: a date the trip already had came back as a refused
// proposal, and the traveller read it as the AI failing to do what they asked).
// `skipped`: [{ title, reason }] for what could not be written, in words for the card
// and for the model's next turn. `calendar`: { shift, days } when the trip's days moved,
// so the caller can move whatever else it keeps by day number (the plan's areas).
async function applyActions(client, trip, actions) {
  const undo = [];
  let count = 0;
  let already = 0;
  const skipped = [];
  let calendar = null;
  // { removed: [names] } when the trip's destinations changed — the caller's planning
  // memory drops the area blocks named after a place the trip no longer visits
  let moved = null;
  for (const a of actions) {
    if (a.kind === 'hotel_add') {
      const last = Math.max((parseInt(trip.days, 10) || 1) - 1, 1);
      a.night_start = Math.min(a.night_start, last);
      a.night_end = Math.min(Math.max(a.night_end, a.night_start), last);
      const { rows } = await client.query(
        `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, price_total, link, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [trip.id, a.name, a.night_start, a.night_end, a.status, a.stars, a.price_total, a.link, a.note]
      );
      undo.unshift({ kind: 'hotel_delete', id: rows[0].id });
      count++;
    } else if (a.kind === 'hotel_update') {
      const { rows } = await client.query('SELECT * FROM trip_hotels WHERE id = $1 AND trip_id = $2', [a.id, trip.id]);
      const cur = rows[0];
      if (!cur) continue;
      const cols = Object.keys(a.patch);
      const pre = {};
      cols.forEach((c) => { pre[c] = cur[c]; });
      await client.query(
        `UPDATE trip_hotels SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND trip_id = $${cols.length + 2}`,
        [...cols.map((c) => a.patch[c]), a.id, trip.id]
      );
      undo.unshift({ kind: 'hotel_update', id: a.id, patch: pre });
      count++;
    } else if (a.kind === 'hotel_delete') {
      const { rows } = await client.query('DELETE FROM trip_hotels WHERE id = $1 AND trip_id = $2 RETURNING *', [a.id, trip.id]);
      if (!rows[0]) continue;
      undo.unshift({ kind: 'hotel_restore', row: rows[0] });
      count++;
    } else if (a.kind === 'budget_set') {
      const prev = await loadBudget(client, trip.id);
      const total = a.total !== null && a.total !== undefined ? a.total : (prev ? prev.total : null);
      const currency = a.currency || (prev ? prev.currency : 'ILS');
      const travelers = a.travelers != null ? a.travelers : (prev ? prev.travelers : 2);
      await client.query(
        `INSERT INTO trip_budgets (trip_id, total, currency, travelers) VALUES ($1,$2,$3,$4)
         ON CONFLICT (trip_id) DO UPDATE SET total = $2, currency = $3, travelers = $4, updated_at = now()`,
        [trip.id, total, currency, travelers]
      );
      undo.unshift(prev ? { kind: 'budget_restore', row: prev } : { kind: 'budget_clear' });
      count++;
    } else if (a.kind === 'budget_clear') {
      const prev = await loadBudget(client, trip.id);
      if (!prev) continue;
      await client.query('DELETE FROM trip_budgets WHERE trip_id = $1', [trip.id]);
      undo.unshift({ kind: 'budget_restore', row: prev });
      count++;
    } else if (a.kind === 'dates_set') {
      const { rows } = await client.query('SELECT start_date, days FROM trips WHERE id = $1', [trip.id]);
      const prevStart = toIso(rows[0] && rows[0].start_date);
      const prevDays = Math.max(parseInt(rows[0] && rows[0].days, 10) || 1, 1);
      let start = a.start_date || prevStart;
      let days = a.days || prevDays;
      if (a.end_date) {
        if (start) days = clock.dayDiff(start, a.end_date) + 1;
        else start = clock.addDays(a.end_date, -(days - 1));
      }
      const title = describeAction(a).title;
      if (days < 1 || days > MAX_DAYS) { skipped.push({ title, reason: `טיול יכול להיות בין יום אחד ל-${MAX_DAYS} ימים` }); continue; }
      if (start === prevStart && days === prevDays) { already++; continue; }
      // the stops keep their calendar dates only when there was a calendar to keep
      const shift = a.keep_calendar && prevStart && start ? clock.dayDiff(start, prevStart) : 0;
      // nothing is silently dropped off either end of the trip: a stop or a hotel night
      // that would land outside it refuses the change, with the days it is on
      const { rows: off } = await client.query(
        'SELECT DISTINCT day_number FROM trip_items WHERE trip_id = $1 AND (day_number + $2 < 1 OR day_number + $2 > $3) ORDER BY day_number',
        [trip.id, shift, days]
      );
      const { rows: offHotels } = await client.query(
        'SELECT name FROM trip_hotels WHERE trip_id = $1 AND (night_start + $2 < 1 OR night_end + $2 > $3)',
        [trip.id, shift, Math.max(days - 1, 1)]
      );
      if (off.length || offHotels.length) {
        const what = [
          off.length ? `תחנות ב${off.length === 1 ? 'יום' : 'ימים'} ${off.map((r) => r.day_number).join(', ')}` : '',
          offHotels.length ? `המלון ${offHotels.map((h) => h.name).join(', ')}` : '',
        ].filter(Boolean).join(' ו');
        skipped.push({ title, reason: `${what} היו נשארים מחוץ לטיול — קודם מזיזים או מוחקים אותם` });
        continue;
      }
      await shiftDays(client, trip.id, shift);
      if (shift || days !== prevDays) await dropDayRecs(client, trip.id);
      await client.query(
        `UPDATE trips SET start_date = $1::date, days = $2,
                end_date = CASE WHEN $1::date IS NULL THEN NULL ELSE $1::date + ($2 - 1) END WHERE id = $3`,
        [start, days, trip.id]
      );
      trip.days = days; // the actions after this one, and the caller's ops, read the new length
      trip.start_date = start;
      undo.unshift({ kind: 'dates_restore', start_date: prevStart, days: prevDays, shift: -shift });
      calendar = { shift: (calendar ? calendar.shift : 0) + shift, days };
      count++;
    } else if (a.kind === 'moment_add') {
      // the trip's dates may have been set by a dates_set earlier in this same list
      const { rows } = await client.query('SELECT start_date, days FROM trips WHERE id = $1', [trip.id]);
      const t = { ...trip, start_date: rows[0] ? rows[0].start_date : trip.start_date, days: rows[0] ? rows[0].days : trip.days };
      const tz = a.moment.tz || await moments.tzForTrip(t);
      const m = moments.cleanMoment({ ...a.moment, status: 'active' }, t, { tz });
      if (m.error) { console.warn(`plan-actions: moment "${a.moment.title}" skipped — ${m.error}`); continue; }
      m.stop = null; // the chat's ops own the itinerary
      const r = await moments.createMoment(client, trip, m, null);
      undo.unshift({ kind: 'moment_undo', undo: r.undo });
      count++;
    } else if (a.kind === 'trip_update') {
      const { rows } = await client.query(`SELECT ${TRIP_COLS} FROM trips WHERE id = $1`, [trip.id]);
      const cur = rows[0];
      if (!cur) continue;
      const curDests = Array.isArray(cur.destinations) ? cur.destinations : [];
      const cols = {};
      if (a.title && a.title !== cur.title) cols.title = a.title;
      if (a.description != null && a.description !== (cur.description || null)) cols.description = a.description;
      let dests = null;
      if (a.destinations && destKey(a.destinations) !== destKey(curDests)) {
        dests = await resolveDestinations(a.destinations, curDests);
        if (dests.length) Object.assign(cols, destColumns(dests));
        else dests = null;
      }
      if (!Object.keys(cols).length) { already++; continue; }
      await writeTrip(client, trip, cols);
      if (dests) {
        await destinationsMoved(client, trip, dests);
        const gone = curDests.map((d) => d.name).filter((n) => !dests.some((d) => d.name === n));
        moved = { removed: [...new Set([...(moved ? moved.removed : []), ...gone])] };
      }
      undo.unshift({ kind: 'trip_restore', row: {
        ...(cols.title ? { title: cur.title } : {}),
        ...(cols.description !== undefined ? { description: cur.description } : {}),
        ...(dests ? { destinations: curDests, destination: cur.destination, country: cur.country, cover_image: cur.cover_image } : {}),
      } });
      count++;
    }
  }
  return { count, undo, already, skipped, calendar, moved };
}

// the recorded inverse, replayed → { calendar } when the trip's days moved back
async function undoActions(client, trip, undo) {
  let calendar = null;
  for (const u of Array.isArray(undo) ? undo : []) {
    if (u.kind === 'hotel_delete') {
      await client.query('DELETE FROM trip_hotels WHERE id = $1 AND trip_id = $2', [u.id, trip.id]);
    } else if (u.kind === 'hotel_update') {
      const cols = Object.keys(u.patch || {});
      if (!cols.length) continue;
      await client.query(
        `UPDATE trip_hotels SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND trip_id = $${cols.length + 2}`,
        [...cols.map((c) => u.patch[c]), u.id, trip.id]
      );
    } else if (u.kind === 'hotel_restore' && u.row) {
      const r = u.row;
      await client.query(
        `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, lat, lon, price_total, link, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [trip.id, r.name, r.night_start, r.night_end, r.status, r.stars, r.lat, r.lon, r.price_total, r.link, r.note]
      );
    } else if (u.kind === 'budget_restore' && u.row) {
      await client.query(
        `INSERT INTO trip_budgets (trip_id, total, currency, travelers) VALUES ($1,$2,$3,$4)
         ON CONFLICT (trip_id) DO UPDATE SET total = $2, currency = $3, travelers = $4, updated_at = now()`,
        [trip.id, u.row.total, u.row.currency, u.row.travelers]
      );
    } else if (u.kind === 'budget_clear') {
      await client.query('DELETE FROM trip_budgets WHERE trip_id = $1', [trip.id]);
    } else if (u.kind === 'dates_restore') {
      // older undo records carry the start only; the length and the shift came later
      const shift = parseInt(u.shift, 10) || 0;
      const days = Number.isInteger(u.days) && u.days >= 1 ? u.days : null;
      await shiftDays(client, trip.id, shift);
      if (shift || days) await dropDayRecs(client, trip.id);
      await client.query(
        `UPDATE trips SET start_date = $1::date, days = COALESCE($2::int, days),
                end_date = CASE WHEN $1::date IS NULL THEN NULL ELSE $1::date + (COALESCE($2::int, days) - 1) END WHERE id = $3`,
        [u.start_date, days, trip.id]
      );
      if (days) trip.days = days;
      if (shift || days) calendar = { shift: (calendar ? calendar.shift : 0) + shift, days: trip.days };
    } else if (u.kind === 'moment_undo') {
      await moments.undoCreate(client, trip, u.undo);
    } else if (u.kind === 'trip_restore' && u.row) {
      // the recs chat keeps its undo in the browser and sends it back: everything here is
      // cleaned to the shape and caps a hand edit would get
      const r = u.row;
      const cols = {};
      if (str(r.title, TITLE_MAX)) cols.title = str(r.title, TITLE_MAX);
      if ('description' in r) cols.description = r.description == null ? null : String(r.description).slice(0, DESC_MAX).trim() || null;
      const dests = cleanDestinations(r.destinations);
      if (dests.length) {
        Object.assign(cols, destColumns(dests));
        if (str(r.destination, 160)) cols.destination = str(r.destination, 160);
        if (r.country !== undefined) cols.country = str(r.country, 200);
      }
      await writeTrip(client, trip, cols);
      if (dests.length) {
        await destinationsMoved(client, trip, dests);
        // the cover the trip had before — the swap above only knows landmarks
        const cover = str(r.cover_image, 500);
        if (cover && /^https:\/\//.test(cover)) await client.query('UPDATE trips SET cover_image = $1 WHERE id = $2', [cover, trip.id]);
      }
    }
  }
  return { calendar };
}

// what the client gets back after actions ran: the hotels, the budget and the dates
// as they are now, so the page can swap them in like it swaps the item list
async function sideState(client, trip) {
  const side = await loadSide(client, trip.id);
  const { rows } = await client.query(`SELECT start_date, end_date, days, ${TRIP_COLS} FROM trips WHERE id = $1`, [trip.id]);
  const list = await moments.listForTrip(client, trip.id);
  const t = rows[0];
  return {
    hotels: side.hotels, budget: side.budget, moments: list,
    trip: {
      start_date: toIso(t.start_date), end_date: toIso(t.end_date), days: t.days,
      title: t.title, description: t.description, destinations: t.destinations,
      destination: t.destination, country: t.country, cover_image: t.cover_image,
    },
  };
}

module.exports = {
  KINDS, ACTION_SCHEMA, PROMPT_RULES, cleanActions, describeAction, contextLines, needsApproval,
  loadHotels, loadBudget, loadSide, applyActions, undoActions, sideState,
};
