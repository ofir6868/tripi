#!/usr/bin/env node
// Drives the real /api/ai/itinerary against a running server and reports what came
// back. Every call is a real OpenAI call — see README.md before running the build phase.
//
//   node tools/ai-eval/run.js                 # the cheap clarifying-round cases
//   node tools/ai-eval/run.js --build         # those plus the full itinerary builds
//   node tools/ai-eval/run.js japan-14-country rome-florence-answered
//   node tools/ai-eval/run.js --port 3000 --runs 2
//
// A FAIL means an invariant broke. The questions and plans are printed in full because
// the half that matters most — are these good options for this trip? — is a human call.

const fs = require('fs');
const path = require('path');
require('../../lib/env');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../lib/auth');
const CASES = require('./cases');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const PORT = flag('port', process.env.PORT || 3000);
const RUNS = Math.max(1, parseInt(flag('runs', 1), 10) || 1);
const WITH_BUILD = argv.includes('--build');
const ids = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

// an eval run is not a user — mint a throwaway token rather than borrowing someone's.
// The build never writes to the DB, so the id not existing there costs nothing.
const TOKEN = jwt.sign({ id: 999999, name: 'ai-eval' }, JWT_SECRET, { expiresIn: '2h' });

const TRANSPORT_WORDS = ['טיסה', 'רכבת', 'אוטובוס', 'רכב', 'שיט', 'מעבורת'];
const isTransportQuestion = (q) => q.options.some((o) => TRANSPORT_WORDS.some((w) => o.includes(w)));

// ---------- checks ----------
// Each returns a list of failure strings; empty means the case held.
function checkQuestions(res, expect) {
  const bad = [];
  const qs = res.questions || [];
  if (expect.questions === false) {
    if (qs.length) bad.push(`expected no questions, got ${qs.length}`);
    return bad;
  }
  // a build case says nothing about questions — it only cares that it got a build
  if (expect.questions === undefined) return qs.length ? ['expected a build, got the question round'] : [];
  if (!qs.length) return [`expected ${expect.questions} question(s), the build ran instead`];
  if (typeof expect.questions === 'number' && qs.length !== expect.questions) {
    bad.push(`expected ${expect.questions} question(s), got ${qs.length}`);
  }
  const first = qs[0];
  if (expect.multi !== undefined && !!first.multi !== expect.multi) {
    bad.push(`expected multi=${expect.multi} on the first question, got ${!!first.multi}`);
  }
  if (expect.optionsAtLeast && first.options.length < expect.optionsAtLeast) {
    bad.push(`expected ≥${expect.optionsAtLeast} options, got ${first.options.length}`);
  }
  // a region option carries the cities that place it — "קנסאי (קיוטו, אוסקה)"
  if (expect.regionOptions) {
    const named = first.options.filter((o) => /\(.+\)/.test(o)).length;
    if (named < Math.ceil(first.options.length / 2)) {
      bad.push(`region options should name their cities, only ${named}/${first.options.length} do`);
    }
  }
  for (const word of expect.transportOptionsExclude || []) {
    const q = qs.find(isTransportQuestion);
    if (!q) { bad.push('expected a transport question, found none'); break; }
    if (q.options.some((o) => o.includes(word))) bad.push(`transport options offer "${word}" for this distance`);
  }
  return bad;
}

function checkBuild(res, expect, body) {
  const bad = [];
  const plan = res.plan || [];
  const items = res.items || [];
  const from = body.day_from, to = body.day_to;
  if (!items.length) return ['the build came back empty'];

  // invariants that hold for every trip, whatever the AI decided
  const sorted = [...plan].sort((a, b) => a.from - b.from);
  if (!plan.length) bad.push('no plan returned');
  if (sorted.length && (sorted[0].from !== from || sorted[sorted.length - 1].to !== to)) {
    bad.push(`plan covers ${sorted[0]?.from}–${sorted[sorted.length - 1]?.to}, trip is ${from}–${to}`);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from !== sorted[i - 1].to + 1) bad.push(`gap or overlap between "${sorted[i - 1].area}" and "${sorted[i].area}"`);
  }
  if (new Set(plan.map((b) => b.area)).size !== plan.length) bad.push('the same area appears twice in the plan');
  const outOfRange = items.filter((it) => it.day_number < from || it.day_number > to);
  if (outOfRange.length) bad.push(`${outOfRange.length} item(s) fall outside days ${from}–${to}`);
  const emptyDays = [];
  for (let d = from; d <= to; d++) if (!items.some((it) => it.day_number === d)) emptyDays.push(d);
  if (emptyDays.length) bad.push(`no stops at all on day(s) ${emptyDays.join(', ')}`);
  const strayAreas = [...new Set(items.map((it) => it.area))].filter((a) => !plan.some((b) => b.area === a));
  if (strayAreas.length) bad.push(`items carry areas that are not in the plan: ${strayAreas.join(', ')}`);

  // per-case expectations
  if (expect.areas) {
    const [min, max] = expect.areas;
    if (plan.length < min || plan.length > max) bad.push(`expected ${min}–${max} areas, got ${plan.length}`);
  }
  if (expect.areaIs && plan[0] && plan[0].area !== expect.areaIs) {
    bad.push(`expected the area to be "${expect.areaIs}", got "${plan[0].area}"`);
  }
  if (expect.areasDifferFromDestination) {
    const dest = body.destinations[0].name;
    if (plan.every((b) => b.area === dest)) bad.push(`the trip was built as one undivided "${dest}" — no areas`);
  }
  if (expect.minDaysPerArea) {
    const thin = plan.filter((b) => b.to - b.from + 1 < expect.minDaysPerArea);
    if (thin.length) bad.push(`area(s) with under ${expect.minDaysPerArea} days: ${thin.map((b) => `${b.area} (${b.to - b.from + 1})`).join(', ')}`);
  }
  if (expect.transferStops && plan.length > 1) {
    for (const b of sorted.slice(1)) {
      const has = items.some((it) => it.day_number === b.from && it.category === 'נסיעה');
      if (!has) bad.push(`no travel stop on day ${b.from}, where the trip moves to "${b.area}"`);
    }
  }
  return bad;
}

// ---------- reporting ----------
function describe(res, body) {
  const out = [];
  if (res.questions) {
    for (const q of res.questions) {
      out.push(`    ${q.multi ? '☑' : '◉'} ${q.question}`);
      if (q.options.length) out.push(`       ${q.options.join('  |  ')}`);
    }
    return out;
  }
  for (const b of res.plan || []) {
    const days = {};
    for (const it of (res.items || []).filter((i) => i.area === b.area)) {
      const city = (it.place_query || '').split(',').slice(-2)[0];
      (days[it.day_number] = days[it.day_number] || new Set()).add((city || '').trim());
    }
    const span = Object.keys(days).length;
    out.push(`    ${b.area}  ימים ${b.from}–${b.to} (${b.to - b.from + 1})  ·  ${span} ימים עם תחנות`);
    out.push(`       ${[...new Set(Object.values(days).flatMap((s) => [...s]))].filter(Boolean).join(', ')}`);
  }
  return out;
}

async function callApi(body) {
  const t0 = Date.now();
  const r = await fetch(`http://localhost:${PORT}/api/ai/itinerary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, secs: ((Date.now() - t0) / 1000).toFixed(1), json };
}

(async () => {
  let cases = CASES.filter((c) => (WITH_BUILD ? true : c.phase === 'ask'));
  if (ids.length) cases = CASES.filter((c) => ids.includes(c.id));
  if (!cases.length) {
    console.error(`no cases matched. known ids:\n  ${CASES.map((c) => c.id).join('\n  ')}`);
    process.exit(1);
  }

  const builds = cases.filter((c) => c.phase === 'build').length * RUNS;
  console.log(`\nai-eval · ${cases.length} case(s) × ${RUNS} run(s) against localhost:${PORT}`);
  console.log(`${builds} of them build a full itinerary — real OpenAI calls, several per build.\n`);

  const results = [];
  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      const label = RUNS > 1 ? `${c.id} #${run}` : c.id;
      const { status, secs, json } = await callApi(c.body);
      let bad;
      if (status !== 200) bad = [`HTTP ${status} ${json.error || ''}`.trim()];
      else if (json.questions) bad = checkQuestions(json, c.expect);
      else bad = [...checkQuestions(json, c.expect), ...checkBuild(json, c.expect, c.body)];

      results.push({ id: c.id, run, ok: !bad.length, secs, failures: bad, response: json });
      console.log(`${bad.length ? '✗' : '✓'} ${label}  (${secs}s)`);
      describe(json, c.body).forEach((l) => console.log(l));
      bad.forEach((f) => console.log(`      ↳ ${f}`));
      console.log('');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log(`failing: ${[...new Set(failed.map((f) => f.id))].join(', ')}`);

  const dir = path.join(__dirname, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ port: PORT, runs: RUNS, results }, null, 2));
  console.log(`full output → ${path.relative(process.cwd(), file)}`);
  process.exit(failed.length ? 1 : 0);
})();
