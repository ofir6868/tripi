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

const MAX_DAYS = 60; // the same ceiling trip creation keeps (routes/trips.js)

const KINDS = ['hotel_add', 'hotel_update', 'hotel_delete', 'budget_set', 'budget_clear', 'dates_set', 'moment_add'];
const BUDGET_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'JPY', 'THB', 'CHF'];

// one shape for every kind (strict JSON schema: every field present, null when unused)
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id', 'name', 'night_start', 'night_end', 'status', 'stars', 'price_total', 'link', 'note', 'total', 'currency', 'travelers', 'start_date', 'end_date', 'days', 'keep_calendar', 'moment'],
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
- לינה היא לא תחנה. מלון, דירה, הוסטל, ריוקאן, צ׳ק-אין, צ׳ק-אאוט או "חזרה למלון" לעולם לא נכנסים ל-ops כתחנה במסלול — מלון נכנס רק כ-hotel_add (status "idea" כשאתם מציעים אותו, "booked" כשהמטיילים הזמינו), עם הלילות שבהם ישנים בו. האפליקציה מציגה אותו בעצמה במסלול ובמפה כנקודת הלינה בסוף כל יום, אז אין צורך בתחנה בשבילו.
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

const coordsOf = (a) => {
  const lat = numOrNull(a && a.lat);
  const lon = numOrNull(a && a.lon);
  return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : { lat: null, lon: null };
};

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
        // never asked of the model (the schema has no such field): they ride in from
        // lodgingToHotels / locateHotels, and survive the round trip through the client
        ...coordsOf(a),
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
    }
  }
  return out;
}

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
  return { kind: 'update', title: a.kind };
}

// ---- reading what is on the trip, for the prompt and for the cleaners ----

const loadHotels = (client, tripId) => client.query(
  'SELECT * FROM trip_hotels WHERE trip_id = $1 ORDER BY night_start, id', [tripId]
).then((r) => r.rows);
const loadBudget = (client, tripId) => client.query(
  'SELECT total, currency, travelers FROM trip_budgets WHERE trip_id = $1', [tripId]
).then((r) => r.rows[0] || null);
const loadSide = async (client, tripId) => ({ hotels: await loadHotels(client, tripId), budget: await loadBudget(client, tripId) });

// the lines the model reads: every hotel with its id, and the budget frame
function contextLines(hotels, budget) {
  const h = (hotels || []).length
    ? hotels.map((x) => `#${x.id} | ${x.name} | ${nights(x.night_start, x.night_end)} | ${x.status === 'idea' ? 'רעיון' : 'הוזמן'}${x.price_total != null ? ` | ${money(x.price_total)}` : ''}${x.note ? ` | ${String(x.note).slice(0, 80)}` : ''}`).join('\n')
    : '(אין עדיין)';
  const b = budget
    ? `${budget.total != null ? money(budget.total, budget.currency) : `בלי תקרה (${budget.currency})`} · ${budget.travelers} נוסעים`
    : '(לא הוגדר)';
  return `מלונות (כל שורה: #מזהה | שם | לילות | סטטוס | מחיר):\n${h}\nתקציב: ${b}`;
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
  for (const a of actions) {
    if (a.kind === 'hotel_add') {
      const last = Math.max((parseInt(trip.days, 10) || 1) - 1, 1);
      a.night_start = Math.min(a.night_start, last);
      a.night_end = Math.min(Math.max(a.night_end, a.night_start), last);
      const { rows } = await client.query(
        `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, stars, price_total, link, note, lat, lon)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [trip.id, a.name, a.night_start, a.night_end, a.status, a.stars, a.price_total, a.link, a.note, a.lat ?? null, a.lon ?? null]
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
    }
  }
  return { count, undo, already, skipped, calendar };
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
    }
  }
  return { calendar };
}

// what the client gets back after actions ran: the hotels, the budget and the dates
// as they are now, so the page can swap them in like it swaps the item list
async function sideState(client, trip) {
  const side = await loadSide(client, trip.id);
  const { rows } = await client.query('SELECT start_date, end_date, days FROM trips WHERE id = $1', [trip.id]);
  const list = await moments.listForTrip(client, trip.id);
  return { hotels: side.hotels, budget: side.budget, moments: list, trip: { start_date: toIso(rows[0].start_date), end_date: toIso(rows[0].end_date), days: rows[0].days } };
}

// ---- lodging is a hotel, never a stop ----
//
// Until 2026-11 the model filed the night as a stop: "צ'ק-אין במלון Gracery" at 15:00,
// "חזרה למלון" at 21:00 — with no nights, no price, and the hotels page (where the nights,
// the cost and the nearby suggestions live) none the wiser. The hotel is now the hotels
// page's alone, and the itinerary and the map draw it on their own as the place each day
// ends (trip-modals.js nightCardHtml, trip-map.js). The prompts say so (PROMPT_RULES, the
// category lists without "לינה"); this is the net under them: a lodging stop the model
// added anyway becomes a hotel_add idea for the nights it stood on, or — a nameless
// "back to the hotel" — is simply not added. An edit that only re-labels an existing
// stop as lodging keeps the stop and drops the label.
const LODGING = 'לינה';
const CHECKOUT_RE = /אאוט|check[\s-]?out|עזיבת|יציאה מה/i;
// the words around a hotel's name in a stop title — "צ'ק-אין במלון X", "לינה ב-X"
const LODGING_PREFIX_RE = /^(?:צ['׳]?ק[\s-]?(?:אין|אאוט)|check[\s-]?(?:in|out)|לינה|חזרה|מנוחה|שינה|הגעה|עזיבה|התמקמות)(?:\s+(?:ו?ב|ל|מ)?[-־]?)?\s*/i;
const GENERIC_STAY_RE = /^(?:ה?מלון|ה?לינה|ה?דירה|ה?הוסטל|ה?חדר|ה?צימר|ה?אכסניה|ה?בקתה|hotel|the hotel|hostel)?$/i;

// "מלון Gracery" and "Gracery" are the same stay
const stayKey = (n) => String(n || '').trim().replace(/^(?:ה?מלון|hotel)\s+/i, '').toLowerCase();

function lodgingName(op) {
  let t = String(op.title || '').trim();
  for (let i = 0; i < 2; i++) t = t.replace(LODGING_PREFIX_RE, '').trim();
  t = t.replace(/^ב-?/, '').trim();
  if (t && !GENERIC_STAY_RE.test(t)) return t.slice(0, 160);
  const q = String(op.place_query || '').split(',')[0].trim();
  return q && !GENERIC_STAY_RE.test(q) ? q.slice(0, 160) : null;
}

// ops/acts are already cleaned (verifyEditOps, cleanActions). `items` the trip's stops
// (for the category of a stop an update touches), `hotels` its hotel rows.
function lodgingToHotels(ops, acts, { trip, items = [], hotels = [], quiet = false } = {}) {
  const lastNight = Math.max((parseInt(trip && trip.days, 10) || 1) - 1, 0);
  const byId = new Map((items || []).map((it) => [it.id, it]));
  const keep = [];
  const stays = new Map(); // lowercased name → { name, nights:Set, lat, lon, note }
  let dropped = 0;
  for (const op of ops || []) {
    if (!op) continue;
    if (op.action === 'update' && op.category === LODGING) {
      const cur = byId.get(op.id);
      if (!cur || cur.category !== LODGING) op.category = null; // a label, not a new stop
      keep.push(op);
      continue;
    }
    if (op.action !== 'add' || op.category !== LODGING) { keep.push(op); continue; }
    const name = lodgingName(op);
    const day = parseInt(op.day_number, 10) || 1;
    const night = CHECKOUT_RE.test(op.title || '') ? day - 1 : day;
    if (!name || night < 1 || night > lastNight) { dropped++; continue; }
    const key = stayKey(name);
    const s = stays.get(key) || { name, nights: new Set(), lat: null, lon: null, note: null };
    s.nights.add(night);
    // the coordinates are the stop's verified place — the hotel's own, when the query named it
    if (s.lat == null && op.lat != null && op.lon != null) { s.lat = op.lat; s.lon = op.lon; }
    if (!s.note && op.note) s.note = String(op.note).slice(0, 300);
    stays.set(key, s);
  }
  const out = [...(acts || [])];
  const named = stayKey;
  for (const s of stays.values()) {
    // one stay from its first night to its last: a nameless "back to the hotel" in the
    // middle is the same bed, and nobody leaves a hotel to come back to it
    const nights = [...s.nights];
    const r = { from: Math.min(...nights), to: Math.max(...nights) };
    const known = (hotels || []).some((h) => named(h.name) === named(s.name) && h.night_start <= r.to && r.from <= h.night_end)
      || out.some((a) => a.kind === 'hotel_add' && named(a.name) === named(s.name));
    if (known) continue;
    out.push({
      kind: 'hotel_add', name: s.name, night_start: r.from, night_end: r.to, status: 'idea',
      stars: null, price_total: null, link: null, note: s.note, lat: s.lat, lon: s.lon,
    });
  }
  const converted = out.length - (acts || []).length;
  if (!quiet && (converted || dropped)) {
    console.log(`lodging: trip ${trip && trip.id} — ${converted} lodging stop group(s) became hotel ideas, ${dropped} dropped`);
  }
  return { ops: keep, actions: out };
}

// A hotel the AI named has a name and no pin, and the map draws each night where it is
// slept. One keyless lookup per new hotel (Photon, never the paid second opinion — this
// is a nicety, PLAYBOOK §2), accepted only when it lands near the trip's own places; a
// miss leaves the hotel without a pin, which is what the map already does with one.
async function locateHotels(acts, trip, items = []) {
  const todo = (acts || []).filter((a) => a.kind === 'hotel_add' && (a.lat == null || a.lon == null));
  if (!todo.length) return acts;
  const places = require('./places');
  const list = Array.isArray(trip.dests) ? trip.dests : trip.destinations;
  const dests = Array.isArray(list) ? list.filter((d) => d && d.name) : [];
  const anchors = [
    ...(items || []).filter((it) => it.lat != null && it.lon != null).map((it) => ({ lat: +it.lat, lon: +it.lon })),
    ...dests.filter((d) => d.lat != null && d.lon != null).map((d) => ({ lat: +d.lat, lon: +d.lon })),
  ];
  const near = (p) => !anchors.length || anchors.some((a) => Math.hypot((a.lat - p.lat) * 111, (a.lon - p.lon) * 111 * Math.cos(p.lat * Math.PI / 180)) < 80);
  const where = [...new Set(dests.map((d) => d.country || d.name).filter(Boolean))].join(', ') || trip.destination || '';
  await Promise.all(todo.slice(0, 6).map(async (a) => {
    try {
      const v = await places.verifyPlace(`${a.name}${where ? `, ${where}` : ''}`, { timeoutMs: 3000, allowGoogle: false });
      if (v && v.verdict === 'ok' && v.best && v.best.lat != null && near(v.best)) { a.lat = v.best.lat; a.lon = v.best.lon; }
    } catch { /* no pin is an honest answer */ }
  }));
  return acts;
}

module.exports = {
  KINDS, ACTION_SCHEMA, PROMPT_RULES, cleanActions, describeAction, contextLines,
  loadHotels, loadBudget, loadSide, applyActions, undoActions, sideState,
  lodgingToHotels, locateHotels,
};
