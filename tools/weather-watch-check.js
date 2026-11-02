// The weather watch (lib/weather-watch.js), checked with no network, no key and no
// database: the thresholds that decide whether the model is asked at all, and one full
// morning run against a stubbed database, forecast, model and push — that a calm day
// costs no model call, a hot one asks once and pushes to the watcher alone, a hazard
// already pushed about is not asked again, and a model that says "no" sends nothing.
// Part of `npm test` (tools/check.js).
process.env.DATABASE_URL = '';
process.env.OPENAI_API_KEY = 'test';

const assert = require('assert');
const path = require('path');

// the model, stubbed before the module that calls it is loaded
let aiAnswer = { alert: true, title: 'חום קיצוני במצדה ביום שלישי', body: '41° — לצאת לפני 07:00 ולקחת 3 ליטר מים' };
const aiCalls = [];
require.cache[path.join(__dirname, '../routes/ai.js')] = {
  id: 'ai', filename: 'ai', loaded: true,
  exports: { aiJson: async (args) => { aiCalls.push(args); return aiAnswer; } },
};
const { pool } = require('../lib/db');
const push = require('../lib/push');
const ww = require('../lib/weather-watch');

let failed = 0;
const pending = [];
const check = (name, fn) => pending.push(async () => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
});

const kinds = (day) => ww.hazardsOf(day).map((h) => h.kind).sort();

// ---- the net ----
check('a mild day crosses nothing', () => {
  assert.deepStrictEqual(kinds({ max: 28, min: 18, feels_max: 30, feels_min: 17, gust_kmh: 30, rain_mm: 2, snow_cm: 0, code: 2, uv: 8 }), []);
});
check('heat by the thermometer, and by the felt temperature alone', () => {
  assert.deepStrictEqual(kinds({ max: 39, min: 27 }), ['heat']);
  assert.deepStrictEqual(kinds({ max: 33, min: 26, feels_max: 39 }), ['heat']);
});
check('cold, storm, wind, snow and rain each have their line', () => {
  assert.deepStrictEqual(kinds({ max: -5, min: -16 }), ['cold']);
  assert.deepStrictEqual(kinds({ max: 20, min: 12, code: 95 }), ['storm']);
  assert.deepStrictEqual(kinds({ max: 10, min: 4, gust_kmh: 85, rain_mm: 45 }), ['rain', 'wind']);
  assert.deepStrictEqual(kinds({ max: -1, min: -6, snow_cm: 25 }), ['snow']);
});
check('a missing field crosses nothing (no NaN alarms)', () => {
  assert.deepStrictEqual(kinds({ max: null, min: undefined }), []);
  assert.deepStrictEqual(kinds(null), []);
});

// ---- a morning, end to end ----
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
function setup(watches, day) {
  const state = { claimed: [], alerted: [], sent: [] };
  pool.query = async (sql, params) => {
    if (/FROM weather_watches w\s+JOIN trip_items/.test(sql)) return { rows: watches };
    if (/SET checked_on/.test(sql)) { state.claimed.push(params[0]); return { rowCount: 1 }; }
    if (/SET alerted/.test(sql)) { state.alerted.push(params); return { rowCount: 1 }; }
    throw new Error('unexpected query: ' + sql.slice(0, 60));
  };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ daily: {
      time: [today], weather_code: [day.code ?? 0], temperature_2m_max: [day.max], temperature_2m_min: [day.min],
      apparent_temperature_max: [day.max], apparent_temperature_min: [day.min], precipitation_sum: [0],
      snowfall_sum: [0], wind_gusts_10m_max: [20], uv_index_max: [9],
    } }),
  });
  push.enabled = true;
  push.sendToUsers = async (to, payload) => { state.sent.push({ to, payload }); return 1; };
  return state;
}
const watch = (over = {}) => ({
  id: 1, user_id: 7, alerted: [], item_id: 55, title: 'טיפוס למצדה', category: 'טבע', time_label: '10:00',
  area: 'מצדה', lat: 31.31, lon: 35.35, trip_id: 3, share_code: '123456', destination: 'ים המלח',
  country: 'ישראל', destinations: [], stop_date: today, ...over,
});

check('a calm day: claimed, no model call, no push', async () => {
  aiCalls.length = 0;
  const s = setup([watch()], { max: 26, min: 15 });
  const r = await ww.tick();
  assert.deepStrictEqual(s.claimed, [1]);
  assert.strictEqual(aiCalls.length, 0);
  assert.strictEqual(s.sent.length, 0);
  assert.strictEqual(r.asked, 0);
});
check('a hot day: one model call, one push to the watcher alone, hazard remembered', async () => {
  aiCalls.length = 0;
  const s = setup([watch()], { max: 41, min: 29 });
  await ww.tick();
  assert.strictEqual(aiCalls.length, 1);
  assert.match(aiCalls[0].user, /טיפוס למצדה/);
  assert.deepStrictEqual(s.sent.map((x) => x.to), [[7]]);
  assert.strictEqual(s.sent[0].payload.kind, 'weather');
  assert.strictEqual(s.sent[0].payload.url, '/trip/123456');
  assert.deepStrictEqual(s.alerted[0][1], ['heat']);
});
check('heat already pushed about: not asked again', async () => {
  aiCalls.length = 0;
  const s = setup([watch({ alerted: ['heat'] })], { max: 41, min: 29 });
  await ww.tick();
  assert.strictEqual(aiCalls.length, 0);
  assert.strictEqual(s.sent.length, 0);
});
check('the model says it is fine for this stop: nothing sent, nothing remembered', async () => {
  aiCalls.length = 0;
  aiAnswer = { alert: false, title: '', body: '' };
  const s = setup([watch({ category: 'מוזיאון', title: 'מוזיאון ישראל' })], { max: 36, min: 24 });
  await ww.tick();
  assert.strictEqual(aiCalls.length, 1);
  assert.strictEqual(s.sent.length, 0);
  assert.strictEqual(s.alerted.length, 0);
});

(async () => {
  for (const run of pending) await run();
  console.log(failed ? `${failed} failed` : `weather watch: ${pending.length} checks pass`);
  process.exit(failed ? 1 : 0);
})();
