// Weather for the AI, server-side — the same free Open-Meteo the trip page already reads
// in the browser (public/js/geo.js), so the planner and the page cannot disagree about
// what the week looks like.
//
// Two horizons, named honestly in the answer: a forecast reaches 16 days out; a trip
// further away gets what those dates were LIKE there in the last two years (the archive
// API, averaged) and is labelled "typical", never passed off as a forecast. No key, no
// quota of ours — Open-Meteo asks only for a sane request rate, and the answers are
// cached a day in api_cache so a conversation that asks twice costs one call.
const { cacheGet, cacheSet } = require('./api-budget');

const SCOPE = 'weather_ai';
const FORECAST_DAYS = 16;

// WMO weather codes → short Hebrew, the same words the page uses for its icons
const WMO = [
  [0, 'בהיר'], [1, 'בהיר ברובו'], [2, 'מעונן חלקית'], [3, 'מעונן'],
  [45, 'ערפל'], [48, 'ערפל'], [51, 'טפטוף'], [53, 'טפטוף'], [55, 'טפטוף'],
  [56, 'טפטוף קפוא'], [57, 'טפטוף קפוא'], [61, 'גשם קל'], [63, 'גשם'], [65, 'גשם כבד'],
  [66, 'גשם קפוא'], [67, 'גשם קפוא'], [71, 'שלג קל'], [73, 'שלג'], [75, 'שלג כבד'], [77, 'שלג'],
  [80, 'ממטרים'], [81, 'ממטרים'], [82, 'ממטרים עזים'], [85, 'ממטרי שלג'], [86, 'ממטרי שלג'],
  [95, 'סופת רעמים'], [96, 'סופת רעמים וברד'], [99, 'סופת רעמים וברד'],
];
const describeCode = (code) => {
  if (!Number.isFinite(code)) return '';
  let best = '';
  for (const [c, label] of WMO) if (code >= c) best = label;
  return best;
};

async function getJson(url, timeoutMs = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TRIPMAKER/1.0 (https://tripmaker.co.il; weather)' } });
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => { const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const shiftYears = (isoDate, years) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return iso(new Date(Date.UTC(y - years, m - 1, d)));
};
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// a place name → { name, country, lat, lon } through Open-Meteo's own geocoder (a city
// or region is what weather is asked about; a restaurant does not need its own forecast)
async function geocode(name) {
  const q = String(name || '').trim().slice(0, 80);
  if (!q) return null;
  const key = 'geo:' + q.toLowerCase();
  const hit = await cacheGet(SCOPE, key, { ttlDays: 30 });
  if (hit.hit) return hit.value;
  let out = null;
  try {
    const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=he&format=json&name=${encodeURIComponent(q)}`);
    const r = data && data.results && data.results[0];
    if (r) out = { name: r.name, country: r.country || '', lat: r.latitude, lon: r.longitude };
  } catch { return null; } // a blip is not a remembered miss
  await cacheSet(SCOPE, key, out);
  return out;
}

// the forecast window that overlaps [from, to], per day
async function forecast(lat, lon, from, to) {
  const today = iso(new Date());
  const horizon = addDays(today, FORECAST_DAYS - 1);
  const start = from > today ? from : today;
  const end = to < horizon ? to : horizon;
  if (start > end) return [];
  const key = `fc:${(+lat).toFixed(2)},${(+lon).toFixed(2)}:${start}:${end}`;
  const hit = await cacheGet(SCOPE, key, { ttlDays: 1 });
  if (hit.hit) return hit.value;
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&start_date=${start}&end_date=${end}&timezone=auto`);
  const d = data.daily || {};
  const out = (d.time || []).map((date, i) => ({
    date, kind: 'forecast',
    desc: describeCode(d.weather_code?.[i]),
    max: Math.round(d.temperature_2m_max?.[i]), min: Math.round(d.temperature_2m_min?.[i]),
    rain_pct: Number.isFinite(d.precipitation_probability_max?.[i]) ? d.precipitation_probability_max[i] : null,
    wind_kmh: Number.isFinite(d.wind_speed_10m_max?.[i]) ? Math.round(d.wind_speed_10m_max[i]) : null,
  }));
  await cacheSet(SCOPE, key, out);
  return out;
}

// what [from, to] was like in the last two years, averaged — the page's typicalWeather
async function typical(lat, lon, from, to) {
  const key = `ty:${(+lat).toFixed(2)},${(+lon).toFixed(2)}:${from}:${to}`;
  const hit = await cacheGet(SCOPE, key, { ttlDays: 30 });
  if (hit.hit) return hit.value;
  const year = async (years) => {
    const data = await getJson(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${shiftYears(from, years)}&end_date=${shiftYears(to, years)}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto');
    return { years, daily: data.daily || {} };
  };
  const settled = await Promise.allSettled([year(1), year(2)]);
  const samples = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!samples.length) return [];
  const out = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const rows = samples.map((s) => {
      const i = (s.daily.time || []).indexOf(shiftYears(date, s.years));
      return i < 0 ? null : { max: s.daily.temperature_2m_max?.[i], min: s.daily.temperature_2m_min?.[i], code: s.daily.weather_code?.[i], rain: s.daily.precipitation_sum?.[i] };
    }).filter(Boolean);
    const maxs = rows.map((r) => r.max).filter(Number.isFinite);
    const mins = rows.map((r) => r.min).filter(Number.isFinite);
    if (!maxs.length || !mins.length) continue;
    const codes = rows.map((r) => r.code).filter(Number.isFinite);
    const rains = rows.map((r) => r.rain).filter(Number.isFinite);
    out.push({
      date, kind: 'typical',
      desc: describeCode(codes.length ? Math.max(...codes) : 1),
      max: Math.round(maxs.reduce((a, b) => a + b, 0) / maxs.length),
      min: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length),
      rain_mm: rains.length ? Math.round(rains.reduce((a, b) => a + b, 0) / rains.length) : null,
    });
  }
  await cacheSet(SCOPE, key, out);
  return out;
}

// the tool's answer: today's weather at the place, and the trip's dates — forecast where
// one exists, typical weather where it does not. Never throws: a provider that is quiet
// comes back as { error } the model can say out loud.
async function weatherFor({ place, lat, lon, from, to }) {
  let where = null;
  if (Number.isFinite(+lat) && Number.isFinite(+lon)) where = { name: place || '', country: '', lat: +lat, lon: +lon };
  else where = await geocode(place);
  if (!where) return { error: `לא מצאתי את המקום "${place}" כדי לבדוק מזג אוויר` };
  const today = iso(new Date());
  let start = isIso(from) ? from : today;
  let end = isIso(to) ? to : start;
  if (end < start) end = start;
  if (addDays(start, 31) < end) end = addDays(start, 31); // a month is plenty for one answer
  const out = { place: where.name, country: where.country, lat: where.lat, lon: where.lon, days: [], note: '' };
  try {
    const now = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`, 6000);
    if (now && now.current) out.now = { temp: Math.round(now.current.temperature_2m), desc: describeCode(now.current.weather_code), wind_kmh: Math.round(now.current.wind_speed_10m || 0), time: now.current.time };
  } catch { /* the days below still answer */ }
  try {
    const fc = await forecast(where.lat, where.lon, start, end);
    out.days.push(...fc);
    const lastFc = fc.length ? fc[fc.length - 1].date : null;
    const restFrom = lastFc ? addDays(lastFc, 1) : start;
    if (restFrom <= end && end > addDays(today, FORECAST_DAYS - 1)) {
      const ty = await typical(where.lat, where.lon, restFrom > start ? restFrom : start, end);
      out.days.push(...ty);
      if (ty.length) out.note = 'ימים המסומנים typical הם מה שהתאריכים האלה היו כמוהם בשנתיים האחרונות, לא תחזית.';
    }
  } catch (err) {
    if (!out.days.length && !out.now) return { error: 'שירות מזג האוויר לא ענה כרגע' };
    out.note = (out.note ? out.note + ' ' : '') + `חלק מהימים לא נענו (${err.message}).`;
  }
  return out;
}

module.exports = { weatherFor, geocode, describeCode, _test: { forecast, typical, addDays, shiftYears } };
