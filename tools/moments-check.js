// The moments (lib/moments.js), checked with no network, no key and no database: the
// clock arithmetic a missed bus hangs on (a local hour in a named zone → the instant,
// across a DST edge), the cleaner that refuses to guess a zone, the push copy, and the
// chat's moment_add action (lib/plan-actions.js) — shape, description, and that the
// action schema stays a strict one OpenAI will accept. Part of `npm test` (tools/check.js).
process.env.DATABASE_URL = '';

const assert = require('assert');
const moments = require('../lib/moments');
const actions = require('../lib/plan-actions');
const kinds = require('../public/js/moment-kinds');

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
};

// ---- the clock ----
check('zone: Tokyo 08:30 is 23:30Z the night before', () => {
  assert.strictEqual(moments.zonedToUtc('2026-07-10T08:30', 'Asia/Tokyo').toISOString(), '2026-07-09T23:30:00.000Z');
});
check('zone: Jerusalem keeps summer and winter apart', () => {
  assert.strictEqual(moments.zonedToUtc('2026-07-10T08:30', 'Asia/Jerusalem').toISOString(), '2026-07-10T05:30:00.000Z');
  assert.strictEqual(moments.zonedToUtc('2026-01-10T08:30', 'Asia/Jerusalem').toISOString(), '2026-01-10T06:30:00.000Z');
});
check('zone: a round trip returns the same wall clock', () => {
  for (const [local, tz] of [['2026-03-28T23:15', 'Europe/Paris'], ['2026-11-01T01:30', 'America/New_York'], ['2026-12-31T23:59', 'Pacific/Auckland']]) {
    assert.strictEqual(moments.utcToZoned(moments.zonedToUtc(local, tz), tz), local, `${local} ${tz}`);
  }
});
check('zone: only real IANA names pass', () => {
  assert(moments.validTz('Asia/Tokyo'));
  assert(moments.validTz('America/Argentina/Buenos_Aires'));
  assert(!moments.validTz('Mars/Olympus'));
  assert(!moments.validTz(''));
  assert(!moments.validTz(null));
});

// ---- the cleaner ----
const trip = { id: 1, days: 7, start_date: '2026-07-08', destinations: [{ name: 'טוקיו', country: 'יפן', lat: 35.68, lon: 139.69 }] };
check('clean: a bus with its ticket, filed on the right trip day', () => {
  const m = moments.cleanMoment({ kind: 'transport', title: ' אוטובוס לקיוטו ', local_time: '2026-07-10T08:30', tz: 'Asia/Tokyo', details: { code: 'AB12', link: 'not-a-url', nope: 'x' }, docs: ['bus.jpg', { name: 'a.pdf', size: 12, message: 'm1', attachment: 'att==1', mime: 'application/pdf' }] }, trip);
  assert.strictEqual(m.title, 'אוטובוס לקיוטו');
  assert.strictEqual(m.lead_minutes, 45);
  assert.strictEqual(m.stop, 3);
  assert.deepStrictEqual(m.details, { code: 'AB12' });
  assert.deepStrictEqual(m.docs[0], { name: 'bus.jpg' });
  assert.deepStrictEqual(m.docs[1], { name: 'a.pdf', size: 12, message: 'm1', attachment: 'att==1', mime: 'application/pdf' });
  assert.strictEqual(m.starts_at.toISOString(), '2026-07-09T23:30:00.000Z');
});
check('clean: no zone anywhere is a refusal, never the server clock', () => {
  const m = moments.cleanMoment({ kind: 'flight', title: 'x', local_time: '2026-07-10T08:30' }, { ...trip, destinations: [] });
  assert(m.error && /אזור זמן/.test(m.error));
});
check('clean: the trip zone fills in when the moment names none', () => {
  const m = moments.cleanMoment({ kind: 'flight', title: 'x', local_time: '2026-07-10T08:30' }, trip, { tz: 'Asia/Tokyo' });
  assert.strictEqual(m.tz, 'Asia/Tokyo');
  assert.strictEqual(m.lead_minutes, 180);
});
check('clean: an instant with a zone gets its wall clock back; a date far off is a typo', () => {
  const m = moments.cleanMoment({ kind: 'other', title: 'x', starts_at: '2026-07-09T23:30:00Z', tz: 'Asia/Tokyo' }, trip);
  assert.strictEqual(m.local_time, '2026-07-10T08:30');
  assert(moments.cleanMoment({ kind: 'other', title: 'x', local_time: '2041-01-01T10:00', tz: 'Asia/Tokyo' }, trip).error);
  assert(moments.cleanMoment({ kind: 'other', title: 'x' }, trip).error);
});
check('clean: a check-in carries its hotel; a bus does not', () => {
  const m = moments.cleanMoment({ kind: 'hotel_checkin', title: 'Granbell', local_time: '2026-07-08T15:00', tz: 'Asia/Tokyo', hotel: { name: 'Granbell', night_start: 1, night_end: 9, price_total: 900 } }, trip);
  assert.deepStrictEqual(m.hotel, { name: 'Granbell', night_start: 1, night_end: 6, price_total: 900, link: null, note: null });
  assert.strictEqual(moments.cleanMoment({ kind: 'transport', title: 'x', local_time: '2026-07-08T15:00', tz: 'Asia/Tokyo', hotel: { name: 'y' } }, trip).hotel, null);
});
check('clean: lead is bounded and the status is one of ours', () => {
  assert.strictEqual(moments.cleanMoment({ title: 'x', local_time: '2026-07-08T15:00', tz: 'Asia/Tokyo', lead_minutes: 99999, status: 'weird' }, trip).lead_minutes, 7 * 24 * 60);
  assert.strictEqual(moments.cleanMoment({ title: 'x', local_time: '2026-07-08T15:00', tz: 'Asia/Tokyo', status: 'proposed' }, trip).status, 'proposed');
});
check('clean: a gmail source gets its link, an unknown type becomes manual', () => {
  assert.strictEqual(moments.cleanSource({ type: 'gmail', id: 'abc' }).link, 'https://mail.google.com/mail/u/0/#all/abc');
  assert.strictEqual(moments.cleanSource({ type: 'hack' }).type, 'manual');
});

// ---- the words ----
check('copy: time left is said as the traveller would', () => {
  assert.strictEqual(kinds.leadText(45), 'עוד 45 דקות');
  assert.strictEqual(kinds.leadText(120), 'עוד שעתיים');
  assert.strictEqual(kinds.leadText(180, { prefix: '' }), '3 שעות');
  assert.strictEqual(kinds.leadText(1440), 'עוד יום');
  assert.strictEqual(kinds.leadText(0), 'עכשיו');
});
check('copy: the push names the thing, the hour and the document', () => {
  const c = moments.pushCopy({ kind: 'transport', title: 'אוטובוס לקיוטו', local_time: '2026-07-10T08:30', details: { code: 'AB12', platform: '4' }, docs: [{ name: 't.jpg' }] }, 45);
  assert.strictEqual(c.title, '🚌 עוד 45 דקות אוטובוס לקיוטו');
  assert(/08:30/.test(c.body) && /AB12/.test(c.body) && /רציף 4/.test(c.body) && /בלי קליטה/.test(c.body));
  const f = moments.pushCopy({ kind: 'flight', title: 'x', local_time: '2026-07-10T08:30', details: { from: 'TLV', to: 'NRT', number: 'LY91' }, docs: [] }, 170);
  assert(/TLV ← NRT/.test(f.title) && /LY91/.test(f.body));
  const h = moments.pushCopy({ kind: 'hotel_checkin', title: 'Granbell', local_time: '2026-07-08T15:00', details: { code: 'R1', address: 'Shibuya 1-1' }, docs: [] }, 90);
  assert(/צ׳ק-אין בGranbell מ-15:00/.test(h.title) && /R1/.test(h.body));
  assert(c.title.length <= 90 && c.body.length <= 180);
});

// ---- the chat's action ----
check('action: moment_add is shaped here and described for the card', () => {
  const out = actions.cleanActions([
    { kind: 'moment_add', moment: { kind: 'transport', title: 'אוטובוס לקיוטו', local_time: '2026-07-10T08:30', tz: 'Asia/Tokyo', lead_minutes: null, details: { code: 'X1' }, docs: ['bus.pdf'], hotel: null } },
    { kind: 'moment_add', moment: { kind: 'hotel_checkin', title: 'Granbell', local_time: '2026-07-08T15:00', tz: 'Bad/Zone', hotel: { name: 'Granbell', night_start: 1, night_end: 3, price_total: 900 } } },
    { kind: 'moment_add', moment: { kind: 'flight', title: 'no time' } },
  ], trip, []);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].moment.tz, 'Asia/Tokyo');
  assert.strictEqual(out[0].moment.stop, false);
  assert.strictEqual(out[1].moment.tz, null); // resolved from the trip at write time
  assert.strictEqual(out[1].moment.hotel.name, 'Granbell');
  const d = actions.describeAction(out[0], [], null);
  assert.strictEqual(d.kind, 'moment');
  assert(/אוטובוס לקיוטו/.test(d.title) && /08:30/.test(d.when) && /45 דקות לפני/.test(d.note));
});
check('action: the schema is strict — every property required, no extras, moment nullable', () => {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
      assert.strictEqual(node.additionalProperties, false, `${path}: additionalProperties`);
      const keys = Object.keys(node.properties || {});
      assert.deepStrictEqual([...(node.required || [])].sort(), keys.sort(), `${path}: required ≠ properties`);
      for (const k of keys) walk(node.properties[k], `${path}.${k}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
  };
  walk(actions.ACTION_SCHEMA, 'action');
  assert(actions.KINDS.includes('moment_add'));
  assert.deepStrictEqual(actions.ACTION_SCHEMA.properties.moment.type, ['object', 'null']);
});
check('kinds: one table serves the server and the browser', () => {
  assert.strictEqual(moments.KINDS, kinds.KINDS);
  assert.deepStrictEqual(moments.KIND_KEYS, kinds.KIND_KEYS);
  assert(kinds.KIND_KEYS.every((k) => Number.isInteger(kinds.KINDS[k].lead) && kinds.KINDS[k].emoji && kinds.KINDS[k].label));
});
check('routes: the extract schema is strict too, and the gmail query is bounded in time', () => {
  const r = require('../routes/moments');
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
      assert.strictEqual(node.additionalProperties, false, path);
      assert.deepStrictEqual([...(node.required || [])].sort(), Object.keys(node.properties || {}).sort(), path);
      for (const k of Object.keys(node.properties || {})) walk(node.properties[k], `${path}.${k}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
  };
  walk(r.EXTRACT_SCHEMA, 'extract');
  assert(/after:2026\/1\/\d+/.test(r.gmailQuery({ start_date: '2026-07-08' })));
  assert(/-category:promotions/.test(r.gmailQuery({})));
});

console.log(failed ? `${failed} check(s) failed` : 'moments: all checks pass');
process.exit(failed ? 1 : 0);
