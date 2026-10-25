// What the AI may change on a trip besides its stops: the hotels, the budget frame and
// the dates. Stops go through ops (routes/ai.js applyEditOps); these are the rest of
// what a traveller hands the chat — "we booked the Hilton for the first three nights",
// "our budget is 12,000 shekels", a hotel confirmation photographed off a screen — and
// they ride the same card: proposed and applied on approval, or committed on the spot
// with an undo (routes/plan.js decides which, per turn).
//
// Every action is checked here with the same cleaners the hand-edit routes use
// (routes/trips.js cleanHotel, the budget PUT, the dates PUT), inside the caller's
// transaction, and every write records its exact inverse so an undo never touches
// what a co-planner changed meanwhile.
const KINDS = ['hotel_add', 'hotel_update', 'hotel_delete', 'budget_set', 'budget_clear', 'dates_set'];
const BUDGET_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'JPY', 'THB', 'CHF'];

// one shape for every kind (strict JSON schema: every field present, null when unused)
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id', 'name', 'night_start', 'night_end', 'status', 'stars', 'price_total', 'link', 'note', 'total', 'currency', 'travelers', 'start_date'],
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
  },
};

// the rules, for the model — shared by the planning chat and the recommendations chat
const PROMPT_RULES = (days) =>
`פעולות על הטיול מעבר לתחנות (actions) — מלונות, תקציב ותאריכים; [] כשאין:
- hotel_add: name (שם המלון כפי שכתוב), night_start/night_end (לילה N = הלילה שבין יום N ליום N+1; בין 1 ל-${Math.max(days - 1, 1)}), status "booked" כשיש הזמנה/אישור ו-"idea" כשזה רק רעיון, price_total המחיר הכולל כמספר (או null), link, note קצר (מספר הזמנה, כתובת) או null.
- hotel_update: id של מלון קיים מהרשימה, ו-null בכל שדה שלא משתנה. hotel_delete: id בלבד.
- budget_set: total (סכום כולל, מספר), currency מתוך ILS/USD/EUR/GBP/JPY/THB/CHF, travelers (מספר נוסעים) — null במה שלא נאמר. budget_clear: מוחק את מסגרת התקציב.
- dates_set: start_date בפורמט YYYY-MM-DD — רק כשתאריך היציאה ידוע בוודאות (כרטיס טיסה, אמירה מפורשת).
- לא ממציאים: מלון, מחיר, מספר הזמנה או תאריך שלא נאמרו או לא כתובים במסמך.`;

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
const moneyOrNull = (v, max) => { const n = numOrNull(v); return n != null && n >= 0 ? Math.min(n, max) : null; };
const str = (v, n) => (v == null ? null : String(v).slice(0, n).trim() || null);
const isoDate = (v) => {
  const s = str(v, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s ? s : null;
};
const toIso = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));

// the model's raw actions → the ones that can be written, each in the row's own shape
function cleanActions(raw, trip, hotels) {
  const byId = new Map((hotels || []).map((h) => [h.id, h]));
  const maxNight = Math.max(trip.days - 1, 1);
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
      const d = isoDate(a.start_date);
      if (d) out.push({ kind: 'dates_set', start_date: d });
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
    const d = new Date(a.start_date + 'T00:00:00');
    return { kind: 'dates', title: `תאריך היציאה: ${d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })}` };
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

// → { count, undo: [inverse actions, in reverse order] }
async function applyActions(client, trip, actions) {
  const undo = [];
  let count = 0;
  for (const a of actions) {
    if (a.kind === 'hotel_add') {
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
      const { rows } = await client.query('SELECT start_date FROM trips WHERE id = $1', [trip.id]);
      const prev = toIso(rows[0] && rows[0].start_date);
      if (prev === a.start_date) continue;
      await client.query(
        `UPDATE trips SET start_date = $1::date, end_date = CASE WHEN $1::date IS NULL THEN NULL ELSE $1::date + (days - 1) END WHERE id = $2`,
        [a.start_date, trip.id]
      );
      undo.unshift({ kind: 'dates_restore', start_date: prev });
      count++;
    }
  }
  return { count, undo };
}

// the recorded inverse, replayed
async function undoActions(client, trip, undo) {
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
      await client.query(
        `UPDATE trips SET start_date = $1::date, end_date = CASE WHEN $1::date IS NULL THEN NULL ELSE $1::date + (days - 1) END WHERE id = $2`,
        [u.start_date, trip.id]
      );
    }
  }
}

// what the client gets back after actions ran: the hotels, the budget and the dates
// as they are now, so the page can swap them in like it swaps the item list
async function sideState(client, trip) {
  const side = await loadSide(client, trip.id);
  const { rows } = await client.query('SELECT start_date, end_date FROM trips WHERE id = $1', [trip.id]);
  return { hotels: side.hotels, budget: side.budget, trip: { start_date: toIso(rows[0].start_date), end_date: toIso(rows[0].end_date) } };
}

module.exports = {
  KINDS, ACTION_SCHEMA, PROMPT_RULES, cleanActions, describeAction, contextLines,
  loadHotels, loadBudget, loadSide, applyActions, undoActions, sideState,
};
