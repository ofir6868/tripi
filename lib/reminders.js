// Scheduled trip pushes: a countdown a week out, a countdown the day before, and a
// morning brief on every trip day — the loop that brings a traveler back into the
// app while the trip is happening.
//
// One in-process timer (no external cron: this is a single always-on web service,
// kept warm by the pinger). Every tick is idempotent — a send is claimed first in
// push_log with ON CONFLICT DO NOTHING, so restarts, redeploys and overlapping
// ticks can never double-ping. The audience is Israeli: "morning" means morning in
// Asia/Jerusalem, whatever timezone the server or the destination is in.
const { pool } = require('./db');
const push = require('./push');

const TICK_MS = 20 * 60 * 1000;
const WINDOW_FROM = 8; // Jerusalem hours: sends happen 08:00–10:59
const WINDOW_TO = 11;

const jerusalemHour = () => +new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false,
}).format(new Date());

// claim the (trip, kind, today) slot; only the claimer sends
async function claim(tripId, kind) {
  const { rowCount } = await pool.query(
    `INSERT INTO push_log (trip_id, kind, sent_on)
     VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Jerusalem')::date)
     ON CONFLICT DO NOTHING`,
    [tripId, kind]
  );
  return rowCount === 1;
}

// the caller claims first — a morning brief pays a DB query and a weather fetch
// to compose itself, and the ~8 later ticks inside the window must skip all of
// that, not just the send
async function sendTrip(trip, kind, copy) {
  const to = await push.recipients(trip.id, trip.owner_id, null);
  if (!to.length) return;
  const sent = await push.sendToUsers(to, {
    kind,
    title: copy.title,
    body: copy.body,
    url: `/trip/${trip.share_code}`,
    tag: `trip-${trip.share_code}`, // replaces this trip's stale pings, still buzzes
    cover: trip.cover_image || null,
    countries: push.tripCountries(trip),
  });
  console.log(`reminders: ${kind} trip ${trip.id} → ${sent} sent`);
}

// today's temperature at the destination, for the morning brief — best-effort,
// a brief without a temperature is still a brief
async function todayTemp(lat, lon) {
  if (lat == null || lon == null) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&daily=temperature_2m_max&timezone=auto&forecast_days=1',
      { signal: ctrl.signal }
    );
    if (!res.ok) return null;
    const t = (await res.json()).daily?.temperature_2m_max?.[0];
    return Number.isFinite(t) ? Math.round(t) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function morningBrief(trip, tripDay) {
  if (!(await claim(trip.id, 'remind-daily'))) return;
  const { rows: items } = await pool.query(
    `SELECT time_label, title, lat, lon FROM trip_items
     WHERE trip_id = $1 AND day_number = $2
     ORDER BY time_label NULLS LAST, sort_order, id`,
    [trip.id, tripDay]
  );
  const where = trip.country || trip.destination;
  let body;
  if (items.length) {
    const first = items.find((it) => it.lat != null) || {};
    const temp = await todayTemp(first.lat, first.lon);
    body = items.slice(0, 3)
      .map((it) => `${it.time_label ? it.time_label + ' ' : ''}${it.title}`)
      .join(' · ')
      + (items.length > 3 ? ` · ועוד ${items.length - 3}` : '')
      + (temp != null ? ` · ${temp}°` : '');
  } else {
    body = 'יום פתוח במסלול — הזדמנות מצוינת להרפתקה ספונטנית';
  }
  await sendTrip(trip, 'remind-daily', {
    title: `בוקר טוב! יום ${tripDay} בטיול ל${where}`,
    body,
  });
}

async function tick() {
  if (!push.enabled) return;
  const h = jerusalemHour();
  if (h < WINDOW_FROM || h >= WINDOW_TO) return;
  // one query catches every trip in the reminder window: a week before through
  // the last trip day. day_offset: -7 = a week out, -1 = tomorrow, 0.. = ongoing.
  // end_date is derived from days, not trusted — it's never recomputed on edits.
  const { rows: trips } = await pool.query(
    `SELECT id, owner_id, title, destination, country, destinations, cover_image,
            share_code, days,
            ((now() AT TIME ZONE 'Asia/Jerusalem')::date - start_date) AS day_offset
     FROM trips
     WHERE NOT is_draft AND start_date IS NOT NULL
       AND (now() AT TIME ZONE 'Asia/Jerusalem')::date
           BETWEEN start_date - 7 AND start_date + (GREATEST(days, 1) - 1)`
  );
  for (const trip of trips) {
    const offset = +trip.day_offset;
    const where = trip.country || trip.destination;
    try {
      if (offset === -7) {
        if (!(await claim(trip.id, 'remind-7d'))) continue;
        await sendTrip(trip, 'remind-7d', {
          title: `עוד שבוע יוצאים ל${where}!`,
          body: 'זה הזמן לסגור פינות — מסלול, מלונות, תקציב. הכול מחכה בפנים',
        });
      } else if (offset === -1) {
        if (!(await claim(trip.id, 'remind-1d'))) continue;
        await sendTrip(trip, 'remind-1d', {
          title: `מחר יוצאים ל${where}!`,
          body: 'הציצו ביום הראשון של המסלול וארזו בהתאם ✈️',
        });
      } else if (offset >= 0) {
        await morningBrief(trip, offset + 1);
      }
    } catch (err) {
      console.error(`reminders: trip ${trip.id} failed:`, err.message);
    }
  }
}

function start() {
  if (!push.enabled) return; // dev without VAPID keys: stay silent, like push itself
  tick().catch((err) => console.error('reminders tick failed:', err.message));
  setInterval(() => tick().catch((err) => console.error('reminders tick failed:', err.message)), TICK_MS).unref?.();
}

module.exports = { start, tick };
