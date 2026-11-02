// Weather watch: a push when the weather at a stop the traveller marked is extreme enough
// to change how they go there — 41° on the day of the desert hike, -18° at the ski lift,
// a storm over the ferry. Opt-in per stop (the switch on the stop sheet) and per person:
// the one who flipped it is the one who hears about it, nobody else on the trip.
//
// Once a day, inside the reminders' Jerusalem morning (lib/reminders.js tick), for every
// watched stop dated today through LOOKAHEAD_DAYS ahead:
//
//  1. the forecast for that date at the stop (free Open-Meteo, one call per place and run);
//  2. rough thresholds (hazardsOf) — a wide net, deliberately looser than "extreme". Most
//     days cross nothing and end here, so most watches never cost a model call;
//  3. only what crossed goes to the model, which knows what the stop IS: 36° is a reason to
//     move a hike to dawn and no reason at all to warn about a museum. It answers whether
//     this needs special care, and the words if it does.
//
// Each hazard kind is pushed about once per watch (weather_watches.alerted): a heatwave
// that sits in the forecast for three mornings is one push, a storm joining it is another.
// The daily claim is checked_on, so overlapping ticks never ask the model twice.
//
// Without OPENAI_API_KEY or VAPID keys this is a logged no-op — the switch stays, nothing
// is sent. A forecast that does not answer is a skipped stop, never a guessed alert.
const { pool } = require('./db');
const push = require('./push');
const { describeCode, geocode } = require('./weather');

const LOOKAHEAD_DAYS = 3;   // today + 3: close enough to be a forecast, far enough to prepare
const MAX_AI_PER_RUN = 60;  // a ceiling on what one morning may spend on the model

// The net. Each line is "worth asking about", not "dangerous": the model makes that call.
// Heat and cold read the felt temperature too, since humidity and wind are what make
// 34° or -8° a problem.
const RULES = [
  { kind: 'heat', label: 'חום קיצוני', test: (d) => d.max >= 35 || d.feels_max >= 38 },
  { kind: 'cold', label: 'קור קיצוני', test: (d) => d.min <= -10 || d.feels_min <= -15 || d.max <= -3 },
  { kind: 'wind', label: 'רוחות חזקות', test: (d) => d.gust_kmh >= 70 },
  { kind: 'rain', label: 'גשם כבד', test: (d) => d.rain_mm >= 30 },
  { kind: 'snow', label: 'שלג כבד', test: (d) => d.snow_cm >= 10 },
  { kind: 'storm', label: 'סופת רעמים', test: (d) => [95, 96, 99].includes(d.code) },
  { kind: 'uv', label: 'קרינת UV קיצונית', test: (d) => d.uv >= 11 },
];

function hazardsOf(day) {
  if (!day) return [];
  const n = (v) => (Number.isFinite(v) ? v : NaN); // a missing field crosses nothing
  const d = {
    max: n(day.max), min: n(day.min), feels_max: n(day.feels_max), feels_min: n(day.feels_min),
    gust_kmh: n(day.gust_kmh), rain_mm: n(day.rain_mm), snow_cm: n(day.snow_cm), code: day.code, uv: n(day.uv),
  };
  return RULES.filter((r) => r.test(d)).map(({ kind, label }) => ({ kind, label }));
}

const jerusalemToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

async function fetchDays(lat, lon) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
      'precipitation_sum,snowfall_sum,wind_gusts_10m_max,uv_index_max' +
      `&forecast_days=${LOOKAHEAD_DAYS + 2}&timezone=auto`,
    { signal: ctrl.signal, headers: { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; weather-watch)' } });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const d = (await res.json()).daily || {};
    const r = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    const byDate = {};
    (d.time || []).forEach((date, i) => {
      byDate[date] = {
        date, code: d.weather_code?.[i], desc: describeCode(d.weather_code?.[i]),
        max: r(d.temperature_2m_max?.[i]), min: r(d.temperature_2m_min?.[i]),
        feels_max: r(d.apparent_temperature_max?.[i]), feels_min: r(d.apparent_temperature_min?.[i]),
        rain_mm: r(d.precipitation_sum?.[i]), snow_cm: r(d.snowfall_sum?.[i]),
        gust_kmh: r(d.wind_gusts_10m_max?.[i]), uv: r(d.uv_index_max?.[i]),
      };
    });
    return byDate;
  } finally {
    clearTimeout(timer);
  }
}

// the stable part first, so the provider's prompt cache holds it (PLAYBOOK §3)
const SYSTEM = `אתם עוזרים למטיילים ישראלים בטיול בחו״ל. מטייל ביקש שנתריע לו אם מזג האוויר בתחנה מסוימת במסלול יהיה קיצוני עד כדי שצריך להיערך אליו במיוחד.
מקבלים: התחנה (שם, סוג, שעה, מקום), התאריך, תחזית היום, ואילו ספים גסים נחצו.
מחליטים: alert=true רק אם מזג האוויר באמת מחייב התייחסות מיוחדת לתחנה הזו — סכנה לבריאות, לבטיחות, או סיכוי ממשי שהתחנה לא תתאפשר כמתוכנן. מזג אוויר לא נעים אבל רגיל למקום ולעונה, או כזה שלא נוגע לסוג התחנה (למשל חום כבד וביקור במוזיאון ממוזג), הוא alert=false.
כשיש התראה: title קצר (עד 50 תווים) שאומר מה ואיפה, ו-body (עד 140 תווים) עם הנתון החשוב ועצה מעשית אחת או שתיים שמתאימות לתחנה — להקדים לשעות הבוקר, מים, ביגוד, לבדוק שהמקום פתוח. בעברית פשוטה, בלי הפחדה ובלי סימני קריאה מיותרים.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['alert', 'title', 'body'],
  properties: { alert: { type: 'boolean' }, title: { type: 'string' }, body: { type: 'string' } },
};

const heDate = (date) => new Date(date + 'T12:00:00Z').toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

async function judge(w, day, hazards) {
  const { aiJson } = require('../routes/ai');
  const out = await aiJson({
    system: SYSTEM,
    user: JSON.stringify({
      stop: { title: w.title, category: w.category || null, time: w.time_label || null, place: w.place },
      date: day.date,
      forecast: day,
      crossed: hazards.map((h) => h.label),
    }),
    schemaName: 'weather_watch',
    maxTokens: 400,
    ph: { distinctId: 'user_' + w.user_id, traceId: `weather-${w.id}-${day.date}` },
    schema: SCHEMA,
  });
  if (!out || !out.alert) return null;
  const title = String(out.title || '').trim().slice(0, 80);
  const body = String(out.body || '').trim().slice(0, 180);
  return title ? { title, body } : null;
}

// every watch on a stop dated in the window, not yet checked today, whose owner is still
// on the trip (someone who left must stop hearing about it)
async function dueWatches(today) {
  const { rows } = await pool.query(
    `SELECT w.id, w.user_id, w.alerted, i.id AS item_id, i.title, i.category, i.time_label,
            i.area, i.lat, i.lon, t.id AS trip_id, t.share_code, t.destination, t.country,
            t.destinations, to_char(t.start_date + i.day_number - 1, 'YYYY-MM-DD') AS stop_date
     FROM weather_watches w
     JOIN trip_items i ON i.id = w.item_id
     JOIN trips t ON t.id = i.trip_id
     WHERE t.start_date IS NOT NULL
       AND (t.start_date + i.day_number - 1) BETWEEN $1::date AND $1::date + $2::int
       AND w.checked_on IS DISTINCT FROM $1::date
       AND (w.user_id = t.owner_id
            OR EXISTS (SELECT 1 FROM trip_participants p WHERE p.trip_id = t.id AND p.user_id = w.user_id))`,
    [today, LOOKAHEAD_DAYS]
  );
  return rows;
}

async function claim(id, today) {
  const { rowCount } = await pool.query(
    'UPDATE weather_watches SET checked_on = $2::date WHERE id = $1 AND checked_on IS DISTINCT FROM $2::date',
    [id, today]
  );
  return rowCount === 1;
}

async function tick() {
  if (!push.enabled) return { skipped: 'push disabled' };
  const today = jerusalemToday();
  const due = await dueWatches(today);
  if (!due.length) return { due: 0 };
  if (!process.env.OPENAI_API_KEY) {
    console.warn(`weather-watch: ${due.length} watches due but OPENAI_API_KEY is not set — nothing judged`);
    return { due: due.length, skipped: 'no ai key' };
  }
  const forecasts = new Map(); // "lat,lon" → byDate, or null when the provider failed
  const stats = { due: due.length, crossed: 0, asked: 0, sent: 0, failed: 0 };
  for (const w of due) {
    try {
      if (!(await claim(w.id, today))) continue;
      let lat = w.lat; let lon = w.lon;
      w.place = [w.area, w.country || w.destination].filter(Boolean).join(', ');
      if (lat == null || lon == null) {
        const g = await geocode(w.area || w.destination);
        if (!g) continue;
        lat = g.lat; lon = g.lon;
      }
      const key = `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`;
      if (!forecasts.has(key)) forecasts.set(key, await fetchDays(lat, lon).catch((err) => {
        console.error(`weather-watch: forecast ${key} failed —`, err.message);
        return null;
      }));
      const day = forecasts.get(key)?.[w.stop_date];
      if (!day) continue;
      const already = new Set(w.alerted || []);
      const fresh = hazardsOf(day).filter((h) => !already.has(h.kind));
      if (!fresh.length) continue;
      stats.crossed++;
      if (stats.asked >= MAX_AI_PER_RUN) continue;
      stats.asked++;
      const copy = await judge(w, day, fresh);
      if (!copy) continue;
      await pool.query(
        'UPDATE weather_watches SET alerted = (SELECT ARRAY(SELECT DISTINCT unnest(alerted || $2::text[]))) WHERE id = $1',
        [w.id, fresh.map((h) => h.kind)]
      );
      const sent = await push.sendToUsers([w.user_id], {
        kind: 'weather',
        title: copy.title,
        body: copy.body,
        url: `/trip/${w.share_code}`,
        tag: `weather-${w.item_id}`,
        countries: push.tripCountries(w),
      });
      stats.sent += sent;
      console.log(`weather-watch: item ${w.item_id} user ${w.user_id} ${heDate(day.date)} [${fresh.map((h) => h.kind)}] → ${sent} sent`);
    } catch (err) {
      stats.failed++;
      console.error(`weather-watch: watch ${w.id} failed —`, err.message);
    }
  }
  if (stats.crossed > stats.asked) console.warn(`weather-watch: ${stats.crossed - stats.asked} watches crossed a threshold past the per-run AI ceiling`);
  console.log('weather-watch:', JSON.stringify(stats));
  return stats;
}

// ---- the switch ----

async function watchedItems(userId, tripId) {
  const { rows } = await pool.query(
    `SELECT w.item_id FROM weather_watches w JOIN trip_items i ON i.id = w.item_id
     WHERE w.user_id = $1 AND i.trip_id = $2`, [userId, tripId]
  );
  return rows.map((r) => r.item_id);
}

async function setWatch(userId, itemId, on) {
  if (on) {
    await pool.query(
      'INSERT INTO weather_watches (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, itemId]
    );
  } else {
    await pool.query('DELETE FROM weather_watches WHERE user_id = $1 AND item_id = $2', [userId, itemId]);
  }
}

module.exports = { tick, watchedItems, setWatch, hazardsOf, LOOKAHEAD_DAYS, RULES };
