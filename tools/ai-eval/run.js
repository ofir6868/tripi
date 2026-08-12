#!/usr/bin/env node
// Drives the real /api/ai/itinerary against a running server and reports what came
// back. Every call is a real OpenAI call — see README.md before running the build phase.
//
//   node tools/ai-eval/run.js                 # the cheap clarifying-round cases
//   node tools/ai-eval/run.js --build         # those plus the full itinerary builds
//   node tools/ai-eval/run.js --edit          # those plus the smart-edit cases
//   node tools/ai-eval/run.js japan-14-country rome-florence-answered
//   node tools/ai-eval/run.js --edit --model gpt-4o    # same edits on a different model
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
const WITH_EDIT = argv.includes('--edit');
// edits run in-process, so a model override here compares tiers on identical input
const EDIT_MODEL = flag('model', null);
const ids = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== EDIT_MODEL);
// the edit path is a function call, not a request — see the edit cases in cases.js
if (EDIT_MODEL) process.env.AI_MODEL_WEAK = EDIT_MODEL;
const { aiEditOps } = require('../../routes/ai');
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

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
  // the wording has to match what the modal will let them do: a pick-one that asks
  // "אילו אזורים" invites ticking three and allows one
  if (expect.multi === false && /אילו אזורים/.test(first.question)) {
    bad.push('single-select question is phrased as a multi-pick ("אילו אזורים")');
  }
  if (expect.multi === true && /באיזה אזור/.test(first.question)) {
    bad.push('multi-select question is phrased as a pick-one ("באיזה אזור")');
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

// ---------- the smart edit ----------
// Apply the ops to the fixture the way the route does, then check the itinerary that
// comes out. The edit prompt asks the model to verify these itself ("no empty day, each
// area still contiguous") — asking is what makes them worth checking.
function applyOps(items, ops) {
  const out = items.map((it) => ({ ...it }));
  for (const op of ops) {
    if (op.action === 'delete') {
      const i = out.findIndex((it) => it.id === op.id);
      if (i !== -1) out.splice(i, 1);
    } else if (op.action === 'update') {
      const it = out.find((x) => x.id === op.id);
      if (it) for (const k of ['day_number', 'time_label', 'title', 'note', 'place_query', 'category', 'area', 'cost']) {
        if (op[k] !== null && op[k] !== undefined) it[k] = op[k];
      }
    } else if (op.action === 'add') {
      out.push({ ...op, id: `new-${out.length}` });
    }
  }
  return out;
}

function checkEdit(result, expect, fixture) {
  if (!result) return ['the edit call came back empty'];
  const bad = [];
  const ops = result.ops || [];
  if (expect.noOps && ops.length) bad.push(`expected no ops (out of scope), got ${ops.length}`);
  if (expect.opsAtLeast && ops.length < expect.opsAtLeast) bad.push(`expected ≥${expect.opsAtLeast} ops, got ${ops.length}`);
  if (expect.opsAtMost && ops.length > expect.opsAtMost) bad.push(`expected ≤${expect.opsAtMost} ops, got ${ops.length}`);
  if (expect.onlyActions) {
    const stray = [...new Set(ops.map((o) => o.action))].filter((a) => !expect.onlyActions.includes(a));
    if (stray.length) bad.push(`unexpected op kind(s): ${stray.join(', ')}`);
  }
  if (expect.onlyTouchesDays) {
    const [lo, hi] = expect.onlyTouchesDays;
    const byId = new Map(fixture.items.map((it) => [it.id, it]));
    const touched = new Set();
    for (const op of ops) {
      if (op.day_number != null) touched.add(op.day_number);
      const before = byId.get(op.id); // an update also touches the day it moved OFF
      if (before) touched.add(before.day_number);
    }
    const outside = [...touched].filter((d) => d < lo || d > hi).sort((a, b) => a - b);
    if (outside.length) bad.push(`the request named days ${lo}-${hi}, ops touch day(s) ${outside.join(', ')}`);
  }
  if (ops.length && (expect.noEmptyDays || expect.areasContiguous)) {
    const after = applyOps(fixture.items, ops);
    if (expect.noEmptyDays) {
      const empty = [];
      for (let d = 1; d <= fixture.days; d++) if (!after.some((it) => it.day_number === d)) empty.push(d);
      if (empty.length) bad.push(`edit leaves day(s) ${empty.join(', ')} with no stops`);
    }
    if (expect.areasContiguous) {
      for (const area of [...new Set(after.map((it) => it.area).filter(Boolean))]) {
        const days = [...new Set(after.filter((it) => it.area === area).map((it) => it.day_number))].sort((a, b) => a - b);
        if (days.length && days[days.length - 1] - days[0] + 1 !== days.length) {
          bad.push(`"${area}" is no longer one stretch of days (${days.join(',')})`);
        }
      }
    }
  }
  return bad;
}

// ---------- reporting ----------
function describeEdit(result, fixture) {
  if (!result) return ['    (no result)'];
  const ops = result.ops || [];
  const counts = ops.reduce((a, o) => ({ ...a, [o.action]: (a[o.action] || 0) + 1 }), {});
  const out = [`    ${ops.length} ops  ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' ')}`];
  if (result.summary) out.push(`    "${result.summary}"`);
  if (ops.length) {
    const after = applyOps(fixture.items, ops);
    const before = fixture.items;
    const line = (arr) => Array.from({ length: fixture.days }, (_, i) => arr.filter((it) => it.day_number === i + 1).length).join(' ');
    out.push(`    לפני: ${line(before)}`);
    out.push(`    אחרי: ${line(after)}`);
  }
  return out;
}

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
  const wanted = (c) => (c.phase === 'ask') || (c.phase === 'build' && WITH_BUILD) || (c.phase === 'edit' && WITH_EDIT);
  let cases = ids.length ? CASES.filter((c) => ids.includes(c.id)) : CASES.filter(wanted);
  if (!cases.length) {
    console.error(`no cases matched. known ids:\n  ${CASES.map((c) => c.id).join('\n  ')}`);
    process.exit(1);
  }

  const builds = cases.filter((c) => c.phase === 'build').length * RUNS;
  console.log(`\nai-eval · ${cases.length} case(s) × ${RUNS} run(s) against localhost:${PORT}`);
  console.log(`${builds} of them build a full itinerary — real OpenAI calls, several per build.`);
  if (EDIT_MODEL) console.log(`edit cases forced onto ${EDIT_MODEL}`);
  console.log('');

  const results = [];
  for (const c of cases) {
    for (let run = 1; run <= RUNS; run++) {
      const label = RUNS > 1 ? `${c.id} #${run}` : c.id;
      let bad, secs, payload, lines;

      if (c.phase === 'edit') {
        const fixture = loadFixture(c.fixture);
        const t0 = Date.now();
        const result = await aiEditOps({
          title: fixture.title,
          destText: fixture.destinations.map((d) => d.name).join(', '),
          dests: fixture.destinations,
          days: fixture.days,
          items: fixture.items,
          description: fixture.description || '',
          prompt: c.prompt,
        }).catch((e) => ({ __error: e.message }));
        secs = ((Date.now() - t0) / 1000).toFixed(1);
        bad = result && result.__error ? [`edit threw: ${result.__error}`] : checkEdit(result, c.expect, fixture);
        payload = result;
        lines = [`    ← "${c.prompt}"`, ...describeEdit(result, fixture)];
      } else {
        const r = await callApi(c.body);
        secs = r.secs;
        payload = r.json;
        if (r.status !== 200) bad = [`HTTP ${r.status} ${r.json.error || ''}`.trim()];
        else bad = [...checkQuestions(r.json, c.expect), ...checkBuild(r.json, c.expect, c.body)];
        lines = describe(r.json, c.body);
      }

      results.push({ id: c.id, run, ok: !bad.length, secs, failures: bad, response: payload });
      console.log(`${bad.length ? '✗' : '✓'} ${label}  (${secs}s)`);
      lines.forEach((l) => console.log(l));
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
  // exitCode rather than exit(): tearing the process down while fetch's keep-alive
  // sockets are still closing makes libuv print an assertion after a clean run
  process.exitCode = failed.length ? 1 : 0;
})();
