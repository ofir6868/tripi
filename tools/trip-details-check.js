// The AI changing the trip itself — its name, its description, where it goes — and what
// it can read beside the stops, checked with no network, no key and no database.
// Pinned here: a rename always waits for a tap; a new set of destinations resets the
// checklist and the free days' picks, swaps a landmark cover that no longer fits, and
// the undo puts every one of them back; the prompt carries the reminders, the spending
// and the votes in a few lines. Part of `npm test`.
process.env.DATABASE_URL = '';

const assert = require('assert');
const actions = require('../lib/plan-actions');
const ai = require('../routes/ai');

let failed = 0;
const pending = [];
const check = (name, fn) => {
  pending.push((async () => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
  })());
};

const trip0 = () => ({ id: 7, days: 10, start_date: '2026-12-01' });
const JAPAN = [{ name: 'טוקיו', country: 'יפן', lat: 35.68, lon: 139.69 }, { name: 'קיוטו', country: 'יפן', lat: 35.01, lon: 135.77 }];
const FUJI = 'https://images.unsplash.com/fuji';

// ---- cleaning ----
check('a rename always waits for approval; a description alone does not', () => {
  const [rename] = actions.cleanActions([{ kind: 'trip_update', title: 'יפן בסתיו', description: null, destinations: null }], trip0(), []);
  assert.deepStrictEqual(rename, { kind: 'trip_update', title: 'יפן בסתיו', description: null, destinations: null });
  assert.strictEqual(actions.needsApproval([rename]), true);
  const [desc] = actions.cleanActions([{ kind: 'trip_update', title: null, description: 'שבועיים של אוכל ומקדשים', destinations: null }], trip0(), []);
  assert.strictEqual(actions.needsApproval([desc]), false);
});
check('an empty destination list is no change at all — a trip always goes somewhere', () => {
  assert.strictEqual(actions.cleanActions([{ kind: 'trip_update', title: null, description: null, destinations: [] }], trip0(), []).length, 0);
  const [a] = actions.cleanActions([{ kind: 'trip_update', title: null, description: null, destinations: [{ name: 'בנגקוק', country: 'תאילנד', query: 'Bangkok, Thailand' }, { name: 'בנגקוק', country: 'תאילנד', query: 'x' }] }], trip0(), []);
  assert.strictEqual(a.destinations.length, 1, 'the same place twice is once');
});
check('the card says the checklist will be rebuilt', () => {
  const d = actions.describeAction({ kind: 'trip_update', title: null, description: null, destinations: [{ name: 'בנגקוק', country: 'תאילנד' }] });
  assert.strictEqual(d.kind, 'trip');
  assert(d.changes.join(' ').includes('בנגקוק'));
  assert(d.changes.join(' ').includes('צ\'קליסט'));
});
check('the action schema stays strict (every property required)', () => {
  const s = actions.ACTION_SCHEMA;
  assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort());
});

// ---- what the model reads ----
check('reminders, spending and votes reach the prompt, briefly', () => {
  const lines = actions.contextLines([], { total: 12000, currency: 'ILS', travelers: 2 }, {
    moments: [{ kind: 'flight', title: 'טיסה לטוקיו', local_time: '2026-12-01T08:30' }],
    spend: [{ category: 'אוכל', n: 3, total: 450 }, { category: 'תחבורה', n: 1, total: 120 }],
    votes: [{ item_id: 12, up: 1, down: 2 }],
    budget: { currency: 'ILS' },
  });
  assert(lines.includes('טיסה לטוקיו 2026-12-01 08:30'));
  assert(lines.includes('הוצאות שנרשמו: 4'));
  assert(lines.includes('#12 1/2'));
  assert(lines.length < 900, `the block is ${lines.length} chars`);
  // and nothing extra without the side (the importer's call)
  assert(!actions.contextLines([], null).includes('תזכורות'));
});

// ---- the cover ----
check('a landmark cover that no longer fits is swapped; a generic one stays', () => {
  const opts = ai.coverForDests;
  assert.strictEqual(opts('https://example.com/custom.jpg', [{ name: 'בנגקוק', country: 'תאילנד' }]), null);
});

// ---- writing, against a fake database ----
function fakeDb(trip) {
  const db = { trip: { ...trip }, log: [], checklist: true };
  db.query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    db.log.push(q.slice(0, 60));
    if (/^SELECT title, description, destinations/.test(q)) return { rows: [{ ...db.trip }] };
    if (/^UPDATE trips SET cover_image = \$1/.test(q)) { db.trip.cover_image = p[0]; return { rows: [] }; }
    if (/^UPDATE trips SET /.test(q)) {
      const cols = q.slice('UPDATE trips SET '.length, q.indexOf(' WHERE')).split(', ').map((c) => c.split(' = ')[0]);
      cols.forEach((c, i) => { db.trip[c] = c === 'destinations' ? JSON.parse(p[i]) : p[i]; });
      return { rows: [] };
    }
    if (/^SELECT cover_image FROM trips/.test(q)) return { rows: [{ cover_image: db.trip.cover_image }] };
    if (/^SELECT 1 FROM trip_checklists/.test(q)) return { rows: [], rowCount: db.checklist ? 1 : 0 };
    if (/^DELETE FROM trip_checklist_items/.test(q)) { db.checklistReset = (db.checklistReset || 0) + 1; return { rows: [] }; }
    if (/^UPDATE trip_checklist_items SET link/.test(q)) { db.esim = p[1]; return { rows: [] }; }
    if (/^UPDATE trip_checklists SET status = 'empty'/.test(q)) return { rows: [] };
    if (/^DELETE FROM trip_day_recs/.test(q)) { db.dayRecsDropped = (db.dayRecsDropped || 0) + 1; return { rows: [] }; }
    throw new Error('unexpected SQL: ' + q.slice(0, 80));
  };
  return db;
}

check('new destinations: written, checklist and day picks reset, undo restores all', async () => {
  const db = fakeDb({ title: 'יפן', description: 'טיול ביפן', destinations: JAPAN, destination: 'טוקיו · קיוטו', country: 'יפן', cover_image: FUJI });
  const trip = trip0();
  const acts = actions.cleanActions([{ kind: 'trip_update', title: null, description: 'טיול בתאילנד', destinations: [
    { name: 'טוקיו', country: 'יפן', query: '' }, { name: 'בנגקוק', country: 'תאילנד', query: '' },
  ] }], trip, []);
  const r = await actions.applyActions(db, trip, acts);
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(db.trip.destinations.map((d) => d.name), ['טוקיו', 'בנגקוק']);
  assert.strictEqual(db.trip.destinations[0].lat, 35.68, 'a place the trip had keeps its pin');
  assert.strictEqual(db.trip.destination, 'טוקיו · בנגקוק');
  assert.strictEqual(db.trip.country, 'יפן, תאילנד');
  assert.strictEqual(db.trip.description, 'טיול בתאילנד');
  assert.strictEqual(db.checklistReset, 1);
  assert.strictEqual(db.dayRecsDropped, 1);
  assert.deepStrictEqual(r.moved, { removed: ['קיוטו'] });
  await actions.undoActions(db, trip, r.undo);
  assert.deepStrictEqual(db.trip.destinations.map((d) => d.name), ['טוקיו', 'קיוטו']);
  assert.strictEqual(db.trip.description, 'טיול ביפן');
  assert.strictEqual(db.trip.cover_image, FUJI);
  assert.strictEqual(db.checklistReset, 2, 'the checklist follows the undo too');
});
check('the same destinations and description are "already so", and touch nothing', async () => {
  const db = fakeDb({ title: 'יפן', description: 'טיול ביפן', destinations: JAPAN, destination: 'טוקיו · קיוטו', country: 'יפן', cover_image: FUJI });
  const r = await actions.applyActions(db, trip0(), actions.cleanActions([{ kind: 'trip_update', title: 'יפן', description: 'טיול ביפן', destinations: JAPAN.map((d) => ({ ...d, query: '' })) }], trip0(), []));
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.already, 1);
  assert.strictEqual(db.checklistReset, undefined);
});
check('a rename leaves the checklist alone', async () => {
  const db = fakeDb({ title: 'יפן', description: null, destinations: JAPAN, destination: 'טוקיו · קיוטו', country: 'יפן', cover_image: FUJI });
  const trip = trip0();
  const r = await actions.applyActions(db, trip, actions.cleanActions([{ kind: 'trip_update', title: 'יפן בסתיו', description: null, destinations: null }], trip, []));
  assert.strictEqual(db.trip.title, 'יפן בסתיו');
  assert.strictEqual(db.checklistReset, undefined);
  await actions.undoActions(db, trip, r.undo);
  assert.strictEqual(db.trip.title, 'יפן');
});
check('an undo sent back by the browser is cleaned like a hand edit', async () => {
  const db = fakeDb({ title: 'יפן', description: null, destinations: JAPAN, destination: 'טוקיו · קיוטו', country: 'יפן', cover_image: FUJI });
  await actions.undoActions(db, trip0(), [{ kind: 'trip_restore', row: { title: 'x'.repeat(500), cover_image: 'javascript:alert(1)', destinations: [{ name: 'רומא', country: 'איטליה', evil: 1 }] } }]);
  assert.strictEqual(db.trip.title.length, 120);
  assert.strictEqual(db.trip.cover_image, FUJI, 'a non-https cover is never written');
  assert.deepStrictEqual(Object.keys(db.trip.destinations[0]).sort(), ['country', 'lat', 'lon', 'name']);
});

Promise.all(pending).then(() => {
  if (failed) { console.log(`trip details: ${failed} failed`); process.exit(1); }
  console.log('trip details: the AI renames, re-describes and re-routes the trip, and what hangs on it follows');
  process.exit(0);
});
