// The AI's tools, checked with no network, no key and no database: the tool-calling
// loop in routes/ai.js aiJson (a fake OpenAI that asks for a tool, then answers), the
// site allowlist of lib/web-search.js, the weather module's date arithmetic, the
// connectors vault, and the import route's shape (an import without a key is a 503,
// never a crash). Part of `npm test` (tools/check.js).
//
// The fakes stand in for the only two things a turn reaches for outside the process:
// global fetch (OpenAI, the search engine, Open-Meteo) and the database pool (the
// progress row). Everything else runs for real.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.DATABASE_URL = '';

const assert = require('assert');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`); }
};

(async () => {
  // ---- the allowlist ----
  const web = require('../lib/web-search');
  check('allowlist: booking.com and a subdomain pass', () => {
    assert(web.allowed('https://www.booking.com/hotel/jp/x.html'));
    assert(web.allowed('https://secure.booking.com/x'));
    assert(web.allowed('https://he.wikipedia.org/wiki/קיוטו'));
  });
  check('allowlist: the open web does not', () => {
    assert(!web.allowed('https://example.com/booking.com'));
    assert(!web.allowed('https://notbooking.com/'));
    assert(!web.allowed('javascript:alert(1)'));
    assert(!web.allowed('https://google.com/search?q=x')); // google is allowed for /maps only
    assert(web.allowed('https://www.google.com/maps/place/Kyoto'));
  });
  check('allowlist: every category names only allowlisted hosts', () => {
    for (const hosts of Object.values(web.SITES)) for (const h of hosts) assert(web.ALL_HOSTS.includes(h), h);
  });

  // ---- the weather module's calendar ----
  const weather = require('../lib/weather');
  check('weather: dates shift by whole days and years', () => {
    assert.strictEqual(weather._test.addDays('2026-02-28', 1), '2026-03-01');
    assert.strictEqual(weather._test.addDays('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(weather._test.shiftYears('2026-07-15', 1), '2025-07-15');
    assert.strictEqual(weather.describeCode(0), 'בהיר');
    assert.strictEqual(weather.describeCode(63), 'גשם');
    assert.strictEqual(weather.describeCode(95), 'סופת רעמים');
  });

  // ---- the vault ----
  const connectors = require('../lib/connectors');
  check('connectors: a sealed token opens to itself and nothing else does', () => {
    const blob = connectors._test.seal('1//refresh-token');
    assert.notStrictEqual(blob, '1//refresh-token');
    assert.strictEqual(connectors._test.open(blob), '1//refresh-token');
    assert.strictEqual(connectors._test.open(blob.slice(0, -4) + 'AAAA'), null);
    assert.strictEqual(connectors._test.open('garbage'), null);
  });
  check('connectors: without client credentials the feature is a closed door', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    assert.strictEqual(connectors.configured(), false);
  });
  check('connectors: a mail body prefers text/plain and decodes base64url', () => {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: b64('<b>Flight</b> LY 081') } },
      { mimeType: 'text/plain', body: { data: b64('Flight LY 081 — 10:30') } },
    ] };
    assert.strictEqual(connectors._test.bodyText(payload), 'Flight LY 081 — 10:30');
  });

  // ---- the tool registry ----
  const aiTools = require('../lib/ai-tools');
  check('tools: connectors add their tools only when switched on', () => {
    const base = aiTools.toolsFor({ services: [] }).map((t) => t.function.name);
    assert(base.includes('get_weather') && base.includes('web_search') && base.includes('find_place'));
    assert(!base.includes('gmail_search'));
    const withGmail = aiTools.toolsFor({ services: ['gmail'] }).map((t) => t.function.name);
    assert(withGmail.includes('gmail_search') && withGmail.includes('gmail_read') && !withGmail.includes('drive_read'));
  });
  await checkAsync('tools: a tool the turn does not carry is refused, bad JSON is refused', async () => {
    const r1 = JSON.parse(await aiTools.execute('gmail_search', '{"query":"x"}', { services: [] }));
    assert(r1.error);
    const r2 = JSON.parse(await aiTools.execute('get_weather', '{not json', { services: [] }));
    assert(r2.error);
  });
  check('tools: a call is described for the UI without its arguments', () => {
    const d = aiTools.describeCall('web_search', JSON.stringify({ query: 'secret hotel', category: 'hotels' }));
    assert.strictEqual(d.detail, 'Booking');
    assert(!JSON.stringify(d).includes('secret'));
  });

  // ---- the loop: a fake OpenAI asks for a tool, then answers ----
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('api.openai.com')) {
      const body = JSON.parse(opts.body);
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (!hasToolResult && body.tool_choice === 'auto') {
        return json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ place: 'Kyoto', date_from: '2026-11-01', date_to: '2026-11-02' }) } },
        ] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      const seen = toolMsg ? JSON.parse(toolMsg.content) : null;
      return json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ text: seen && seen.place ? `weather for ${seen.place}` : 'no tool' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    if (String(url).includes('geocoding-api.open-meteo.com')) return json({ results: [{ name: 'Kyoto', country: 'Japan', latitude: 35.0, longitude: 135.7 }] });
    if (String(url).includes('api.open-meteo.com') && String(url).includes('current=')) return json({ current: { temperature_2m: 18.2, weather_code: 2, wind_speed_10m: 7, time: '2026-10-30T10:00' } });
    if (String(url).includes('api.open-meteo.com')) return json({ daily: { time: ['2026-11-01', '2026-11-02'], weather_code: [1, 61], temperature_2m_max: [19, 16], temperature_2m_min: [11, 10], precipitation_probability_max: [5, 70], wind_speed_10m_max: [12, 20] } });
    if (String(url).includes('archive-api.open-meteo.com')) return json({ daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] } });
    return json({}, 404);
  };
  // the dates above are "in the forecast window" only relative to a clock — pin it
  const RealDate = Date;
  const fixed = new RealDate('2026-10-30T09:00:00Z').getTime();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };

  const ai = require('../routes/ai');
  await checkAsync('loop: the model asks for the weather, gets it, and answers from it', async () => {
    const progress = aiTools.progress('turn-1234-abcd', 1);
    const out = await ai.aiJson({
      system: 's', user: 'u', schemaName: 't', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      maxTokens: 100, tools: aiTools.toolsFor({ services: [] }), toolCtx: { userId: 1, services: [] }, progress,
    });
    assert.strictEqual(out.text, 'weather for Kyoto');
    const openai = calls.filter((c) => c.url.includes('api.openai.com'));
    assert.strictEqual(openai.length, 2, 'two model rounds');
    assert.strictEqual(openai[0].body.tool_choice, 'auto');
    assert(openai[1].body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1'));
    const toolResult = JSON.parse(openai[1].body.messages.find((m) => m.role === 'tool').content);
    assert.strictEqual(toolResult.days.length, 2);
    assert.strictEqual(toolResult.days[1].desc, 'גשם קל');
    assert.strictEqual(toolResult.now.temp, 18);
    const summary = progress.summary();
    assert.strictEqual(summary.length, 1);
    assert.strictEqual(summary[0].tool, 'get_weather');
    assert.strictEqual(summary[0].status, 'done');
  });
  await checkAsync('loop: a turn without tools is one call, as before', async () => {
    calls.length = 0;
    const out = await ai.aiJson({ system: 's', user: 'u', schemaName: 't', schema: { type: 'object' }, maxTokens: 50 });
    assert.strictEqual(out.text, 'no tool');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.tools, undefined);
  });
  await checkAsync('loop: the tool rounds are capped and the model is then made to answer', async () => {
    calls.length = 0;
    // a model that always asks for another tool
    const prev = global.fetch;
    global.fetch = async (url, opts) => {
      if (!String(url).includes('api.openai.com')) return prev(url, opts);
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      const body = JSON.parse(opts.body);
      if (body.tool_choice === 'auto') {
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
          { id: 'c' + calls.length, type: 'function', function: { name: 'get_weather', arguments: '{"place":"Kyoto"}' } },
        ] } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"text":"finally"}' } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const out = await ai.aiJson({ system: 's', user: 'u', schemaName: 't', schema: { type: 'object' }, maxTokens: 50, tools: aiTools.toolsFor({}), toolCtx: {} });
    assert.strictEqual(out.text, 'finally');
    const rounds = calls.filter((c) => c.url.includes('api.openai.com'));
    assert.strictEqual(rounds.length, aiTools.MAX_TOOL_ROUNDS + 1);
    assert.strictEqual(rounds[rounds.length - 1].body.tool_choice, 'none');
    global.fetch = prev;
  });
  global.Date = RealDate;
  global.fetch = realFetch;

  // ---- the search parser (DuckDuckGo's HTML page) ----
  await checkAsync('search: results are filtered to the allowlist', async () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.booking.com%2Fhotel%2Fjp%2Fgion.html&amp;rut=x">Gion Hotel – Booking.com</a>
      <a class="result__snippet" href="#">A lovely place &amp; more</a>
      <a class="result__a" href="https://randomblog.example/kyoto">Random blog</a>
      <div class="result__snippet">not allowed</div>`;
    global.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    delete process.env.BRAVE_SEARCH_API_KEY;
    const r = await web.search('gion hotel', { category: 'hotels' });
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].url, 'https://www.booking.com/hotel/jp/gion.html');
    assert.strictEqual(r.results[0].title, 'Gion Hotel – Booking.com');
    assert.strictEqual(r.results[0].snippet, 'A lovely place & more');
    global.fetch = realFetch;
  });
  await checkAsync('read_page: refuses a host off the list before fetching', async () => {
    let fetched = false;
    global.fetch = async () => { fetched = true; return new Response('x'); };
    const r = await web.readPage('https://randomblog.example/kyoto');
    assert(r.error && !fetched);
    global.fetch = realFetch;
  });

  // ---- the import route exists and refuses without a key ----
  await checkAsync('import: mounted, and a 503 without an API key', async () => {
    const express = require('express');
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const app = express();
    app.use(express.json());
    app.use(require('../routes/ai-import'));
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const port = server.address().port;
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../lib/auth');
    const token = jwt.sign({ id: 1, name: 't' }, JWT_SECRET);
    const res = await realFetch(`http://127.0.0.1:${port}/api/trips/code/000000/ai-import`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ text: 'x', mode: 'rebuild' }),
    });
    assert.strictEqual(res.status, 503);
    server.close();
    process.env.OPENAI_API_KEY = saved;
  });

  console.log(failed ? `ai-tools: ${failed} check(s) failed` : 'ai-tools: all checks pass');
  process.exit(failed ? 1 : 0);
})();
