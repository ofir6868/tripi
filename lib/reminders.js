// Scheduled pushes: a countdown a week out, a countdown the day before, and a
// morning brief on every trip day — the loop that brings a traveler back into the
// app while the trip is happening. And before any of that, a call back to a draft
// that went quiet (lib/draft-nudge.js).
//
// And the moments (lib/moments.js): the bus at 08:30, the flight, the check-in — each
// pushed once, inside its own lead window, with the ticket a tap away. Those do not
// wait for the Jerusalem morning: a 06:00 bus is pushed at 05:15, and the tick that
// finds it is whichever arrives first — the in-process timer on an always-on host, the
// daily cron, or an outside pinger on /api/cron/moments (routes/cron.js says how often).
//
// Every tick is idempotent — a daily send is claimed first in push_log with ON CONFLICT
// DO NOTHING, a moment by flipping its notified_at — so restarts, redeploys and
// overlapping ticks can never double-ping. The audience is Israeli: "morning" means
// morning in Asia/Jerusalem, whatever timezone the server or the destination is in.
const { pool } = require('./db');
const push = require('./push');
const drafts_ = require('./draft-nudge');
const moments = require('./moments');
const connectors = require('./connectors');

const TICK_MS = 20 * 60 * 1000;
const MOMENTS_TICK_MS = 5 * 60 * 1000; // how late a moment's push may run on an always-on host
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

// a draft that went quiet gets called back twice at most: after two days and after a
// week (lib/draft-nudge.js). The push opens the planning chat, where the draft left off.
const DRAFT_NUDGES = [[2, 'draft-2d'], [7, 'draft-7d']];
async function draftNudges() {
  for (const [age, kind] of DRAFT_NUDGES) {
    const drafts = await drafts_.quietDrafts(age, kind);
    for (const d of drafts) {
      try {
        if (!(await claim(d.id, kind))) continue;
        const to = await push.recipients(d.id, d.owner_id, null);
        if (!to.length) continue;
        const copy = drafts_.nudgeCopy(d);
        const sent = await push.sendToUsers(to, {
          kind,
          title: copy.title,
          body: copy.body,
          url: `/trip/${d.share_code}#plan`,
          tag: `trip-${d.share_code}`,
          cover: d.cover_image || null,
          countries: push.tripCountries(d),
        });
        console.log(`reminders: ${kind} draft ${d.id} → ${sent} sent`);
      } catch (err) {
        console.error(`reminders: ${kind} draft ${d.id} failed:`, err.message);
      }
    }
  }
}

// ---------- the moments ----------

// every moment whose window opened: claimed, worded for how much time is really left,
// and sent to everyone on the trip. The tap lands on the moment's own sheet, which
// opens its documents from the phone — so the push works where the signal does not.
async function momentsTick() {
  if (!push.enabled) return 0;
  const due = await moments.dueMoments();
  let total = 0;
  for (const m of due) {
    try {
      if (!(await moments.claim(m.id))) continue;
      const to = await push.recipients(m.trip_id, m.owner_id, null);
      if (!to.length) continue;
      const minutesLeft = Math.max((new Date(m.starts_at).getTime() - Date.now()) / 60000, 0);
      const copy = moments.pushCopy(m, minutesLeft);
      const sent = await push.sendToUsers(to, {
        kind: 'moment',
        title: copy.title,
        body: copy.body,
        url: `/trip/${m.share_code}#moment-${m.id}`,
        tag: `moment-${m.id}`, // its own tag: a bus and a check-in the same morning are two pings
        countries: push.tripCountries(m),
        docs: (m.docs || []).length,
      });
      total += sent;
      console.log(`reminders: moment ${m.id} (${m.kind}) trip ${m.trip_id} → ${sent} sent, ${Math.round(minutesLeft)} min left`);
    } catch (err) {
      console.error(`reminders: moment ${m.id} failed:`, err.message);
    }
  }
  return total;
}

// A week out, for every traveller on the trip who lent us their Gmail (lib/connectors.js):
// read the mail once, and PROPOSE what it holds — flights, hotels, buses — as moments the
// traveller approves in the app. Nothing is written as active here, and the push says
// "we found", never "we added". Once per trip (push_log), and only where the key to read
// exists. A proposal that already sits on the trip (same title, same hour) is not repeated.
async function proposeFromMail(trip) {
  if (!process.env.OPENAI_API_KEY || !connectors.configured()) return;
  if (!(await claim(trip.id, 'scan-7d'))) return;
  const { scanGmail } = require('../routes/moments');
  const { rows: people } = await pool.query(
    `SELECT DISTINCT u.id FROM users u
     WHERE u.id = $2 OR u.id IN (SELECT user_id FROM trip_participants WHERE trip_id = $1)`,
    [trip.id, trip.owner_id]
  );
  const { rows: have } = await pool.query('SELECT title, starts_at FROM trip_moments WHERE trip_id = $1', [trip.id]);
  const seen = new Set(have.map((h) => `${h.title}|${new Date(h.starts_at).getTime()}`));
  for (const u of people) {
    try {
      if (!(await connectors.enabledFor(u.id)).includes('gmail')) continue;
      const r = await scanGmail({ trip, userId: u.id, ph: { distinctId: 'user_' + u.id, traceId: `scan7d-${trip.id}` } });
      const fresh = r.proposals.filter((p) => !p.error && !seen.has(`${p.title}|${new Date(p.starts_at).getTime()}`));
      if (!fresh.length) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const p of fresh) {
          // the attachments ride as references (message + id), so approving on the phone
          // can fetch them through the proxy — the bytes themselves never pass through here
          const docs = (p.attachments || []).map((a) => ({ name: a.name, size: a.size, message: (p.source || {}).id, attachment: a.id, mime: a.mime }));
          const m = moments.cleanMoment({ ...p, status: 'proposed', docs }, trip, { tz: p.tz });
          if (m.error) continue;
          m.stop = null; m.hotel = null; // a proposal puts nothing on the plan until it is approved
          await moments.createMoment(client, trip, m, u.id);
          seen.add(`${m.title}|${m.starts_at.getTime()}`);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      const where = trip.country || trip.destination;
      const sent = await push.sendToUsers([u.id], {
        kind: 'moment-scan',
        title: `מצאנו ${fresh.length === 1 ? 'הזמנה אחת' : `${fresh.length} הזמנות`} במייל לטיול ל${where}`,
        body: `${fresh.slice(0, 3).map((p) => p.title).join(' · ')}${fresh.length > 3 ? ' ועוד' : ''} — אישור אחד, ונזכיר לכם לפני כל אחת`,
        url: `/trip/${trip.share_code}#moments`,
        tag: `trip-${trip.share_code}-scan`,
        countries: push.tripCountries(trip),
      });
      console.log(`reminders: scan-7d trip ${trip.id} user ${u.id} → ${fresh.length} proposed, ${sent} sent`);
    } catch (err) {
      console.error(`reminders: scan-7d trip ${trip.id} user ${u.id} failed:`, err.message);
    }
  }
}

async function tick() {
  if (!push.enabled) return;
  // the moments first and always: they have their own clock, not the Jerusalem morning
  await momentsTick().catch((err) => console.error('reminders: moments tick failed:', err.message));
  const h = jerusalemHour();
  if (h < WINDOW_FROM || h >= WINDOW_TO) return;
  await draftNudges().catch((err) => console.error('reminders: draft nudges failed:', err.message));
  // the stops a traveller asked us to watch for extreme weather (lib/weather-watch.js) —
  // claimed per watch per day, so the ~8 ticks inside the window ask the model once
  await require('./weather-watch').tick().catch((err) => console.error('reminders: weather watch failed:', err.message));
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
        await proposeFromMail(trip).catch((err) => console.error(`reminders: scan-7d trip ${trip.id} failed:`, err.message));
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
  setInterval(() => momentsTick().catch((err) => console.error('reminders: moments tick failed:', err.message)), MOMENTS_TICK_MS).unref?.();
}

module.exports = { start, tick, momentsTick, proposeFromMail };
