// Moments — the things on a trip that happen at a clock time and must not be missed: the
// bus whose e-ticket is a photo in the app, the flight, the hotel check-in, the QR code
// Japan wants at the border. Each one is a row in trip_moments, and the whole point of
// the row is the push that arrives BEFORE it (lib/reminders.js): "the bus leaves in 45
// minutes" with the ticket one tap away — and the tap works with no signal, because the
// documents it opens never left the phone (public/js/trip-docs.js; the moment only
// carries their names and the page matches them in IndexedDB).
//
// Where moments come from, and the rule that holds for all of them — nothing becomes a
// moment without the traveller: the planning and recommendations chats write one when a
// ticket or a confirmation is handed to them (lib/plan-actions.js, `moment_add` — the same
// card, the same undo as a hotel); the מסמכים page offers one for a document it read; a
// Gmail scan (routes/moments.js) finds bookings in the traveller's own mail and PROPOSES
// them, status 'proposed', until they are ticked; and a form adds one by hand. A moment
// about a hotel also puts the hotel on the trip's hotel list, and one about a flight or a
// bus writes the travel stop, so what the mail knows shows up where the plan is read.
//
// Time is the hard part. A bus at 08:30 is 08:30 where the bus is, not in Jerusalem and
// not on the server, so every moment keeps the local clock it was written in (local_time
// + tz, IANA) beside the instant the push is computed from (starts_at). The zone comes
// from whoever knew it — the model names the city's zone, the form derives it from the
// destination's coordinates (Open-Meteo answers `timezone` for free, cached a year) — and
// an unknown zone is never guessed as the server's: the moment is refused, with a reason.
const { pool } = require('./db');
const { cacheGet, cacheSet } = require('./api-budget');
const COUNTRIES = require('../public/js/countries.js');
// the kinds, their default lead times and the words — shared with the browser
const { KINDS, KIND_KEYS, DETAIL_KEYS, leadText } = require('../public/js/moment-kinds.js');

const STATUSES = ['active', 'proposed', 'done'];
const MAX_LEAD = 7 * 24 * 60;
const MAX_DOCS = 6;

// ---------- time zones ----------

function validTz(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$|^UTC$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;

// the wall clock a zone shows for an instant, as the parts of a UTC date
function wallParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

// 'YYYY-MM-DDTHH:MM' as read on a clock in `tz` → the instant. Two rounds of
// correction cover a DST edge: the first guess takes the zone's offset at that instant,
// the second re-reads it where the first landed.
function zonedToUtc(local, tz) {
  const m = LOCAL.exec(String(local || '').trim());
  if (!m || !validTz(tz)) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (!Number.isFinite(want)) return null;
  let guess = want;
  for (let i = 0; i < 2; i++) guess = want - (wallParts(new Date(guess), tz) - guess);
  const d = new Date(guess);
  return Number.isNaN(d.getTime()) ? null : d;
}

// the instant, as 'YYYY-MM-DDTHH:MM' on a clock in `tz`
function utcToZoned(date, tz) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !validTz(tz)) return null;
  const w = new Date(wallParts(date, tz));
  return w.toISOString().slice(0, 16);
}

// countries with one clock, for a destination that came with no coordinates. A country
// that spans zones (US, Canada, Australia, Russia, Brazil…) is deliberately absent — a
// wrong zone is a missed bus, and the form then asks for the coordinates' zone instead.
const COUNTRY_TZ = {
  IL: 'Asia/Jerusalem', JP: 'Asia/Tokyo', KR: 'Asia/Seoul', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', KH: 'Asia/Phnom_Penh',
  LA: 'Asia/Vientiane', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur', PH: 'Asia/Manila', TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong',
  IN: 'Asia/Kolkata', LK: 'Asia/Colombo', NP: 'Asia/Kathmandu', MV: 'Indian/Maldives', AE: 'Asia/Dubai', QA: 'Asia/Qatar', OM: 'Asia/Muscat',
  JO: 'Asia/Amman', EG: 'Africa/Cairo', TR: 'Europe/Istanbul', GE: 'Asia/Tbilisi', AM: 'Asia/Yerevan', AZ: 'Asia/Baku', CY: 'Asia/Nicosia',
  GR: 'Europe/Athens', IT: 'Europe/Rome', FR: 'Europe/Paris', ES: 'Europe/Madrid', PT: 'Europe/Lisbon', GB: 'Europe/London', IE: 'Europe/Dublin',
  DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna', CZ: 'Europe/Prague',
  HU: 'Europe/Budapest', PL: 'Europe/Warsaw', SK: 'Europe/Bratislava', SI: 'Europe/Ljubljana', HR: 'Europe/Zagreb', ME: 'Europe/Podgorica',
  RS: 'Europe/Belgrade', BA: 'Europe/Sarajevo', MK: 'Europe/Skopje', AL: 'Europe/Tirane', BG: 'Europe/Sofia', RO: 'Europe/Bucharest',
  DK: 'Europe/Copenhagen', SE: 'Europe/Stockholm', NO: 'Europe/Oslo', FI: 'Europe/Helsinki', IS: 'Atlantic/Reykjavik', EE: 'Europe/Tallinn',
  LV: 'Europe/Riga', LT: 'Europe/Vilnius', MT: 'Europe/Malta', LU: 'Europe/Luxembourg', MA: 'Africa/Casablanca', TZ: 'Africa/Dar_es_Salaam',
  KE: 'Africa/Nairobi', ZA: 'Africa/Johannesburg', ET: 'Africa/Addis_Ababa', SC: 'Indian/Mahe', MU: 'Indian/Mauritius', AR: 'America/Argentina/Buenos_Aires',
  PE: 'America/Lima', CO: 'America/Bogota', CR: 'America/Costa_Rica', PA: 'America/Panama', CU: 'America/Havana', UY: 'America/Montevideo',
  NZ: 'Pacific/Auckland', ID: 'Asia/Jakarta', GT: 'America/Guatemala', CL: 'America/Santiago', BO: 'America/La_Paz', EC: 'America/Guayaquil',
};

// the zone of a point on the map — Open-Meteo answers it beside a one-day forecast, no
// key, and a zone does not change, so a year in the cache is still conservative
const TZ_SCOPE = 'tz';
async function tzFor(lat, lon) {
  if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) return null;
  const key = `${(+lat).toFixed(1)},${(+lon).toFixed(1)}`;
  const hit = await cacheGet(TZ_SCOPE, key, { ttlDays: 365 });
  if (hit.hit) return hit.value;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${+lat}&longitude=${+lon}&daily=weather_code&forecast_days=1&timezone=auto`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const tz = (await res.json()).timezone;
    if (!validTz(tz)) return null;
    await cacheSet(TZ_SCOPE, key, tz);
    return tz;
  } catch { return null; } finally { clearTimeout(timer); }
}

// the zone a trip's clocks most likely run on: the first destination with coordinates,
// else its country when that country keeps one clock. null when honesty demands it.
async function tzForTrip(trip) {
  const dests = (Array.isArray(trip.destinations) ? trip.destinations : []).filter((d) => d && d.name);
  for (const d of dests) {
    if (Number.isFinite(+d.lat) && Number.isFinite(+d.lon) && d.lat !== null) {
      const tz = await tzFor(d.lat, d.lon);
      if (tz) return tz;
    }
  }
  for (const name of [...dests.map((d) => d.country || d.name), trip.country, trip.destination]) {
    const cc = COUNTRIES.ccByName(String(name || '').trim());
    if (cc && COUNTRY_TZ[cc]) return COUNTRY_TZ[cc];
  }
  return null;
}

// ---------- cleaning ----------

const str = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const isoDate = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));
const ymd = (iso) => iso.split('-').map(Number);
const dayDiff = (fromIso, toIso) => {
  const [y1, m1, d1] = ymd(fromIso); const [y2, m2, d2] = ymd(toIso);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};

// which trip day a local date falls on (1-based), or null outside the trip / undated
function dayOf(trip, localIso) {
  const start = isoDate(trip.start_date);
  if (!start || !/^\d{4}-\d{2}-\d{2}/.test(String(localIso || ''))) return null;
  const n = dayDiff(start, String(localIso).slice(0, 10)) + 1;
  return n >= 1 && n <= Math.max(+trip.days || 1, 1) ? n : null;
}

function cleanDetails(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of DETAIL_KEYS) {
    const v = str(raw[k], k === 'note' || k === 'address' ? 300 : 120);
    if (!v) continue;
    if (k === 'link' && !/^https?:\/\//i.test(v)) continue;
    out[k] = v;
  }
  return out;
}

const SOURCE_TYPES = ['chat', 'gmail', 'doc', 'manual', 'scan'];
function cleanSource(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = { type: SOURCE_TYPES.includes(raw.type) ? raw.type : 'manual' };
  if (raw.id) out.id = String(raw.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || undefined;
  if (raw.subject) out.subject = str(raw.subject, 140);
  if (raw.from) out.from = str(raw.from, 100);
  if (raw.name) out.name = str(raw.name, 120);
  if (out.type === 'gmail' && out.id) out.link = `https://mail.google.com/mail/u/0/#all/${out.id}`;
  return out;
}

// a document by name (matched on the device, in IndexedDB), and — when it came out of a
// mail — where in Gmail it lives, so a second phone can fetch it again through the proxy
function cleanDocs(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_DOCS).map((d) => {
    const name = str(d && (d.name || d), 160);
    if (!name) return null;
    const out = { name };
    if (d && Number.isFinite(+d.size) && d.size !== null && typeof d !== 'string') out.size = Math.max(0, Math.round(+d.size));
    if (d && d.message && d.attachment) {
      out.message = String(d.message).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
      out.attachment = String(d.attachment).replace(/[^a-zA-Z0-9_=-]/g, '').slice(0, 400);
      if (d.mime && /^(image\/|application\/pdf)/.test(String(d.mime))) out.mime = String(d.mime).slice(0, 60);
    }
    return out;
  }).filter(Boolean);
}

// the hotel a moment asks to put on the trip (hotel_checkin, when the row is new)
function cleanHotelRef(raw, trip) {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name, 160);
  if (!name) return null;
  const maxNight = Math.max((+trip.days || 1) - 1, 1);
  const night = (v, dflt) => Math.min(Math.max(parseInt(v, 10) || dflt, 1), maxNight);
  const night_start = night(raw.night_start, 1);
  const price = raw.price_total === null || raw.price_total === undefined || !Number.isFinite(+raw.price_total) ? null : Math.min(Math.max(+raw.price_total, 0), 999999999);
  return {
    name, night_start,
    night_end: Math.max(night(raw.night_end, night_start), night_start),
    price_total: price,
    link: raw.link && /^https?:\/\//i.test(String(raw.link).trim()) ? str(raw.link, 400) : null,
    note: str(raw.note, 300),
  };
}

// one raw moment (model-written, mail-derived or typed) → a row that can be written, or
// { error } in Hebrew. `tz` is the trip's zone, used only when the moment names none.
function cleanMoment(raw, trip, { tz: fallbackTz = null } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'תזכורת לא תקינה' };
  const kind = KIND_KEYS.includes(raw.kind) ? raw.kind : 'other';
  const title = str(raw.title, 120);
  if (!title) return { error: 'לתזכורת חסר שם' };
  const tz = validTz(raw.tz) ? raw.tz : (validTz(fallbackTz) ? fallbackTz : null);
  let starts = null;
  let local = null;
  if (raw.local_time && LOCAL.test(String(raw.local_time).trim())) {
    if (!tz) return { error: `לא ידוע באיזה אזור זמן השעה של "${title}" — הוסיפו מיקום לטיול` };
    starts = zonedToUtc(String(raw.local_time).trim(), tz);
    local = String(raw.local_time).trim().slice(0, 16);
  } else if (raw.starts_at) {
    const d = new Date(raw.starts_at);
    if (!Number.isNaN(d.getTime())) {
      starts = d;
      local = tz ? utcToZoned(d, tz) : null;
    }
  }
  if (!starts) return { error: `ל"${title}" חסרים תאריך ושעה` };
  // a moment years away or long gone is a typo, not a plan
  const span = starts.getTime() - Date.now();
  if (span > 3 * 365 * 86400000 || span < -400 * 86400000) return { error: `התאריך של "${title}" לא נראה נכון` };
  const leadRaw = parseInt(raw.lead_minutes, 10);
  const lead = Number.isInteger(leadRaw) ? Math.min(Math.max(leadRaw, 0), MAX_LEAD) : KINDS[kind].lead;
  const status = STATUSES.includes(raw.status) ? raw.status : 'active';
  return {
    kind, title, starts_at: starts, local_time: local, tz,
    lead_minutes: lead,
    details: cleanDetails(raw.details),
    docs: cleanDocs(raw.docs),
    source: cleanSource(raw.source),
    status,
    hotel: kind === 'hotel_checkin' ? cleanHotelRef(raw.hotel, trip) : null,
    // a travel stop for the itinerary, when the trip is dated and the moment lands in it
    stop: (kind === 'flight' || kind === 'transport') && raw.stop !== false && local ? dayOf(trip, local) : null,
  };
}

// ---------- writing (inside the caller's transaction) ----------

const WRITE_COLS = ['trip_id', 'kind', 'title', 'starts_at', 'local_time', 'tz', 'lead_minutes', 'details', 'docs', 'source', 'status', 'hotel_id', 'item_id', 'created_by'];

// → { row, undo } — undo is the exact inverse: the moment, and whatever it put on the
// trip beside itself, removed by id; nothing a co-planner did meanwhile is touched
async function createMoment(client, trip, m, userId = null) {
  let hotelId = null;
  let itemId = null;
  const undo = [];
  if (m.hotel) {
    const { rows } = await client.query(
      `INSERT INTO trip_hotels (trip_id, name, night_start, night_end, status, price_total, link, note)
       VALUES ($1,$2,$3,$4,'booked',$5,$6,$7) RETURNING id`,
      [trip.id, m.hotel.name, m.hotel.night_start, m.hotel.night_end, m.hotel.price_total, m.hotel.link, m.hotel.note]
    );
    hotelId = rows[0].id;
    undo.unshift({ kind: 'hotel_delete', id: hotelId });
  }
  if (m.stop) {
    const d = m.details || {};
    const note = [d.code && `מספר ${d.code}`, d.number && d.number, d.seat && `מושב ${d.seat}`, d.gate && `שער ${d.gate}`, d.platform && `רציף ${d.platform}`, d.terminal && `טרמינל ${d.terminal}`]
      .filter(Boolean).join(' · ').slice(0, 500) || null;
    const { rows } = await client.query(
      `INSERT INTO trip_items (trip_id, day_number, time_label, title, note, category, sort_order)
       VALUES ($1,$2,$3,$4,$5,'נסיעה', 0) RETURNING id`,
      [trip.id, m.stop, m.local_time ? m.local_time.slice(11, 16) : null, m.title.slice(0, 200), note]
    );
    itemId = rows[0].id;
    undo.unshift({ kind: 'item_delete', id: itemId });
  }
  const vals = [trip.id, m.kind, m.title, m.starts_at, m.local_time, m.tz, m.lead_minutes, JSON.stringify(m.details), JSON.stringify(m.docs), JSON.stringify(m.source), m.status, hotelId, itemId, userId];
  const { rows } = await client.query(
    `INSERT INTO trip_moments (${WRITE_COLS.join(', ')}) VALUES (${WRITE_COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    vals
  );
  undo.unshift({ kind: 'moment_delete', id: rows[0].id });
  return { row: rows[0], undo };
}

// the inverse of createMoment, replayed — also understood by lib/plan-actions.js undo
async function undoCreate(client, trip, undo) {
  for (const u of Array.isArray(undo) ? undo : []) {
    if (u.kind === 'moment_delete') await client.query('DELETE FROM trip_moments WHERE id = $1 AND trip_id = $2', [u.id, trip.id]);
    else if (u.kind === 'hotel_delete') await client.query('DELETE FROM trip_hotels WHERE id = $1 AND trip_id = $2', [u.id, trip.id]);
    else if (u.kind === 'item_delete') await client.query('DELETE FROM trip_items WHERE id = $1 AND trip_id = $2', [u.id, trip.id]);
  }
}

// a moment the client edits by hand: the fields the form can change, cleaned the same way
async function updateMoment(client, trip, id, patch) {
  const { rows: cur } = await client.query('SELECT * FROM trip_moments WHERE id = $1 AND trip_id = $2', [id, trip.id]);
  const row = cur[0];
  if (!row) return null;
  const merged = cleanMoment({
    kind: patch.kind ?? row.kind, title: patch.title ?? row.title,
    local_time: patch.local_time ?? (patch.starts_at ? null : row.local_time), tz: patch.tz ?? row.tz,
    starts_at: patch.starts_at ?? row.starts_at,
    lead_minutes: patch.lead_minutes ?? row.lead_minutes,
    details: patch.details ?? row.details, docs: patch.docs ?? row.docs, source: row.source,
    status: patch.status ?? row.status, stop: false,
  }, trip, { tz: row.tz });
  if (merged.error) return { error: merged.error };
  // a moment moved to a later hour counts down again; one already sent stays sent
  const resend = merged.starts_at.getTime() !== new Date(row.starts_at).getTime() && merged.starts_at.getTime() > Date.now();
  const { rows } = await client.query(
    `UPDATE trip_moments SET kind=$1, title=$2, starts_at=$3, local_time=$4, tz=$5, lead_minutes=$6, details=$7, docs=$8, status=$9,
       notified_at = CASE WHEN $10 THEN NULL ELSE notified_at END, updated_at = now()
     WHERE id = $11 AND trip_id = $12 RETURNING *`,
    [merged.kind, merged.title, merged.starts_at, merged.local_time, merged.tz, merged.lead_minutes, JSON.stringify(merged.details), JSON.stringify(merged.docs), merged.status, resend, id, trip.id]
  );
  return { row: rows[0] };
}

const listForTrip = (q, tripId) => q.query(
  'SELECT * FROM trip_moments WHERE trip_id = $1 ORDER BY starts_at, id', [tripId]
).then((r) => r.rows);

// ---------- the push ----------

const clockOf = (m) => (m.local_time ? m.local_time.slice(11, 16) : (m.tz ? (utcToZoned(new Date(m.starts_at), m.tz) || '').slice(11, 16) : ''));

// the words of the push: what is about to happen and when, and the one line that matters
// at the door. `minutesLeft` is measured at send time, not the lead — a pinger that ran
// late says "in 20 minutes", not "in 45".
function pushCopy(m, minutesLeft) {
  const k = KINDS[m.kind] || KINDS.other;
  const d = m.details || {};
  const when = leadText(minutesLeft);
  const clock = clockOf(m);
  const at = clock ? ` ב-${clock}` : '';
  const docs = (m.docs || []).length ? (m.docs.length === 1 ? 'המסמך פתוח בלחיצה — גם בלי קליטה' : 'המסמכים פתוחים בלחיצה — גם בלי קליטה') : '';
  let title;
  let body;
  switch (m.kind) {
    case 'flight':
      title = `${k.emoji} ${when} הטיסה${d.from && d.to ? ` ${d.from} ← ${d.to}` : ''}`;
      body = [clock && `המראה ${clock}`, d.number, d.terminal && `טרמינל ${d.terminal}`, d.gate && `שער ${d.gate}`, d.seat && `מושב ${d.seat}`, d.code && `אישור ${d.code}`].filter(Boolean).join(' · ');
      break;
    case 'transport':
      title = `${k.emoji} ${when} ${m.title}`;
      body = [clock && `יוצא${at}`, d.platform && `רציף ${d.platform}`, d.seat && `מושב ${d.seat}`, d.code && `כרטיס ${d.code}`].filter(Boolean).join(' · ');
      break;
    case 'hotel_checkin':
      title = `${k.emoji} צ׳ק-אין ב${m.title}${clock ? ` מ-${clock}` : ''}`;
      body = [d.code && `הזמנה ${d.code}`, d.address, d.phone].filter(Boolean).join(' · ');
      break;
    case 'hotel_checkout':
      title = `${k.emoji} צ׳ק-אאוט מ${m.title}${clock ? ` עד ${clock}` : ''}`;
      body = [d.code && `הזמנה ${d.code}`, d.note].filter(Boolean).join(' · ');
      break;
    case 'entry':
      title = `${k.emoji} ${m.title}`;
      body = [d.code && `קוד ${d.code}`, d.note].filter(Boolean).join(' · ') || 'ה-QR והמסמכים לביקורת הגבולות — בלחיצה';
      break;
    default:
      title = `${k.emoji} ${when} ${m.title}`;
      body = [clock && `ב-${clock}`, d.code && `קוד ${d.code}`, d.address, d.note].filter(Boolean).join(' · ');
  }
  body = [body, docs].filter(Boolean).join(' · ') || k.label;
  return { title: title.slice(0, 90), body: body.slice(0, 180) };
}

// the moments whose window opened and nobody has sent yet, with the trip around them.
// Also closes the stale ones: a bus that left three hours ago is not news, and a push about
// it after a pinger outage would be worse than none.
async function dueMoments() {
  await pool.query(
    `UPDATE trip_moments SET notified_at = now()
     WHERE status = 'active' AND notified_at IS NULL AND starts_at < now() - interval '3 hours'`
  );
  const { rows } = await pool.query(
    `SELECT m.*, t.share_code, t.owner_id, t.title AS trip_title, t.country, t.destination, t.destinations, t.cover_image
     FROM trip_moments m JOIN trips t ON t.id = m.trip_id
     WHERE m.status = 'active' AND m.notified_at IS NULL
       AND m.starts_at - make_interval(mins => m.lead_minutes) <= now()
     ORDER BY m.starts_at LIMIT 200`
  );
  return rows;
}

// the claim — only the caller that flips notified_at sends
async function claim(id) {
  const { rowCount } = await pool.query(
    'UPDATE trip_moments SET notified_at = now() WHERE id = $1 AND notified_at IS NULL', [id]
  );
  return rowCount === 1;
}

module.exports = {
  KINDS, KIND_KEYS, STATUSES, DETAIL_KEYS, COUNTRY_TZ, MAX_DOCS,
  validTz, zonedToUtc, utcToZoned, tzFor, tzForTrip, dayOf,
  cleanMoment, cleanDetails, cleanSource, cleanDocs,
  createMoment, undoCreate, updateMoment, listForTrip,
  leadText, pushCopy, dueMoments, claim,
};
