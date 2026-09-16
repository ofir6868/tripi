// Budget and cache for the paid third-party APIs — today, all four Google Places call
// sites (place photos, the verifier's second opinion, the picker's autocomplete and its
// coordinate lookup).
//
// This is lib/quota.js's lesson applied to money instead of fairness. Every one of those
// call sites kept its own `new Map()` for the answers and, where it bothered to cap at
// all, its own `let used = 0` for the month. On the free Render instance — which restarts
// on every deploy and sleeps after fifteen idle minutes — a cache that lives in the
// process is not a cache and a monthly cap that lives in the process is not a cap: the
// same place was paid for again after every deploy, and the cap counted back from zero
// each time. A limit that forgets itself whenever the process does is not a limit; the
// same is true of a cache, except that a cache forgetting itself arrives as a bill.
//
// Two tables, both written by migration 24:
//   api_usage  (meter, month, count)            — what we have spent this month
//   api_cache  (scope, key, value, fetched_at)  — what we already bought
//
// Both stay out of the escrow backup on purpose (lib/db-restore.js): a budget and a cache
// are not user data, and a restored month's counter would be a lie in either direction.
const { pool } = require('./db');

const month = () => new Date().toISOString().slice(0, 7); // YYYY-MM, UTC — Google bills in UTC

// No DATABASE_URL at all is not "the database blinked" — it is a standalone run of one
// of the tools (tools/ai-eval, the probes), which has no server and no Postgres beside
// it. Those fall back to the in-process behaviour this module replaced: a counter and a
// cache that live for the length of the run. That is the right shape for a tool the
// PLAYBOOK says you run knowingly and pay for on purpose, and it keeps the audit's
// numbers comparable to the ones taken before any of this existed. Production always has
// DATABASE_URL, so production is always on the durable path.
const HAS_DB = !!process.env.DATABASE_URL;
let toldNoDb = false;
function noDbOnce() {
  if (toldNoDb) return;
  toldNoDb = true;
  console.warn('api-budget: no DATABASE_URL — budgets and caches are per-process for this run');
}

/* ------------------------------- monthly meters ------------------------------ */

// One paid SKU's monthly allowance. claim() reserves calls atomically and answers
// whether they may go ahead.
//
// Two deliberate departures from lib/quota.js, both because the resource here is a bill
// rather than a traveller's patience:
//
//   1. It counts BEFORE the call, not after. A Google request bills whether or not it
//      answers — a timeout is charged like a photo — so counting the intent is the only
//      count that matches the invoice. quota.js spends after the model answered for the
//      mirrored reason: there, a failed call gave the traveller nothing.
//
//   2. It fails CLOSED. quota.js lets a traveller through when the database blinks,
//      because refusing them costs us nothing. Here, letting the call through when the
//      counter cannot be read is exactly how an unbounded bill runs up with nobody
//      watching — so an unreachable database means "no budget", and the caller takes its
//      free path. Every paid call site has one.
function monthlyMeter(name, defaultLimit, envVar) {
  const raw = parseInt(process.env[envVar || ('API_LIMIT_' + name.toUpperCase())], 10);
  const limit = Number.isInteger(raw) && raw >= 0 ? raw : defaultLimit;
  let warned = '';
  let local = { month: '', count: 0 }; // only used without a database — see HAS_DB above

  return {
    name,
    limit,
    // true = n calls are reserved and already counted; false = spent, or unreadable
    async claim(n = 1) {
      if (limit <= 0 || n > limit) return false;
      if (!HAS_DB) {
        noDbOnce();
        if (local.month !== month()) local = { month: month(), count: 0 };
        if (local.count + n > limit) return false;
        local.count += n;
        return true;
      }
      try {
        // One statement, so two requests landing together cannot both squeeze past the
        // last unit: the conditional DO UPDATE is what makes the claim atomic. The bare
        // INSERT path needs no condition — n <= limit is checked above, and it only runs
        // for the month's first call.
        const { rowCount } = await pool.query(
          `INSERT INTO api_usage (meter, month, count) VALUES ($1, $2, $3)
           ON CONFLICT (meter, month) DO UPDATE SET count = api_usage.count + $3
           WHERE api_usage.count + $3 <= $4`,
          [name, month(), n, limit]
        );
        if (!rowCount) {
          // a spent budget is routine per call but news per month — said once, so the
          // month we quietly start serving the free path is a month somebody knows about
          if (warned !== month()) {
            warned = month();
            console.warn(`api-budget: ${name} spent for ${month()} (${limit}/${limit}) — falling back to the free path`);
          }
          return false;
        }
        return true;
      } catch (err) {
        console.error(`api-budget: could not claim ${name} (${err.code || err.message}) — refusing the paid call`);
        return false; // fail closed: see (2) above
      }
    },
    // Give back a claim for a call that provably never billed — a 400 or a 403 is
    // Google rejecting the request, not serving it. Without this, one misconfigured
    // field mask quietly eats a whole month's allowance on retries: the errors are
    // (correctly) never cached, so every boot asks again, and the meter counts every
    // one of them. Only ever called for a status that means "we were not charged".
    async refund(n = 1) {
      if (!HAS_DB) { local.count = Math.max(0, local.count - n); return; }
      try {
        await pool.query(
          `UPDATE api_usage SET count = GREATEST(0, count - $3) WHERE meter = $1 AND month = $2`,
          [name, month(), n]
        );
      } catch (err) {
        console.error(`api-budget: could not refund ${name} (${err.code || err.message})`);
      }
    },
    // for the admin panel and for probes — never gates anything
    async used() {
      if (!HAS_DB) return local.month === month() ? local.count : 0;
      try {
        const { rows } = await pool.query(
          'SELECT count FROM api_usage WHERE meter = $1 AND month = $2', [name, month()]
        );
        return rows[0] ? rows[0].count : 0;
      } catch { return null; }
    },
  };
}

/* -------------------------------- answer cache ------------------------------- */

// Google's terms let us keep a place_id indefinitely but any other Places content for at
// most 30 consecutive days, so this is a ceiling on every scope rather than a tuning
// knob. It happens to be right for the photo URLs too: the lh3.googleusercontent.com
// link Google hands back is time-limited, and one kept forever eventually resolves to
// nothing and leaves the card blank.
const TTL_DAYS = 30;

const L1_MAX = 5000;
const l1 = new Map(); // "scope<NUL>key" → { value, at } — saves a query per card, not a bill

const SEP = String.fromCharCode(0); // a byte no scope name can contain, kept out of the source as an escape
const l1Key = (scope, key) => scope + SEP + key;
const fresh = (at, ttlDays) => Date.now() - at < ttlDays * 86400000;

function remember(lk, value) {
  if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value);
  l1.set(lk, { value, at: Date.now() });
}

// { hit, value } — `hit: true` with `value: null` is a remembered miss, and that is the
// entry that matters most: a place Google has no photo for costs exactly as much to ask
// about as one it does, so failing to remember the "no" is paying for it on repeat.
async function cacheGet(scope, key, { ttlDays = TTL_DAYS } = {}) {
  const lk = l1Key(scope, key);
  const hot = l1.get(lk);
  if (hot && fresh(hot.at, ttlDays)) return { hit: true, value: hot.value };
  if (hot) l1.delete(lk);
  if (!HAS_DB) { noDbOnce(); return { hit: false, value: null }; }
  try {
    const { rows } = await pool.query(
      `SELECT value FROM api_cache
       WHERE scope = $1 AND key = $2 AND fetched_at > now() - ($3 || ' days')::interval`,
      [scope, key, String(ttlDays)]
    );
    if (!rows.length) return { hit: false, value: null };
    remember(lk, rows[0].value);
    return { hit: true, value: rows[0].value };
  } catch (err) {
    // a blinking database costs a cache hit, never a wrong answer — the caller pays for
    // a lookup it could have skipped, which is the safe direction to fail in
    console.error(`api-budget: cache read failed for ${scope} (${err.code || err.message})`);
    return { hit: false, value: null };
  }
}

async function cacheSet(scope, key, value) {
  remember(l1Key(scope, key), value);
  if (!HAS_DB) return;
  try {
    await pool.query(
      `INSERT INTO api_cache (scope, key, value, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()`,
      [scope, key, value === null ? null : JSON.stringify(value)]
    );
  } catch (err) {
    console.error(`api-budget: cache write failed for ${scope} (${err.code || err.message})`);
  }
}

// Rows past the ceiling are unusable and must never be served, so they are swept rather
// than left to grow — one pass at boot is plenty for a table this size.
async function sweep() {
  if (!HAS_DB) return;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM api_cache WHERE fetched_at < now() - ($1 || ' days')::interval`, [String(TTL_DAYS)]
    );
    if (rowCount) console.log(`api-budget: swept ${rowCount} cache rows past ${TTL_DAYS} days`);
  } catch { /* the sweep is hygiene, never a reason to fail a boot */ }
}

// One promise per in-flight key, so N cards naming the same place pay for one lookup
// instead of N. Without it the recs route's Promise.all over the survivors is a race:
// they all miss the cache together, and they all buy the same answer.
const inFlight = new Map();
function once(key, run) {
  const running = inFlight.get(key);
  if (running) return running;
  const p = Promise.resolve().then(run).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

module.exports = { monthlyMeter, cacheGet, cacheSet, sweep, once, TTL_DAYS };
