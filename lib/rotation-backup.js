// The monthly free-tier rotation, app side. See tools/db-rotation-runbook.md.
//
// Render deletes a free Postgres 30 days after it's created. The old design leaned on a
// scheduled Claude session to dump the database to GitHub before that; on 2026-09-05 that
// session hit its usage limit mid-run, and only luck (an earlier dump) saved the data. So
// the app now backs itself up: on a timer it dumps every table, encrypts the dump with
// DB_BACKUP_KEY, and commits it to the escrow branch on GitHub. lib/db-restore.js is the
// other half — on an empty boot it fetches that file and rebuilds. Neither half needs a
// human or a Claude session in the loop.
//
// It runs only when ESCROW_GITHUB_TOKEN (a token that can push to the escrow repo) and
// DB_BACKUP_KEY are both set; otherwise it logs once and stays out of the way, and the
// external rotation Routine remains the backup path.
const crypto = require('crypto');
const { pool } = require('./db');
const { TABLE_ORDER } = require('./db-restore');

const DUMP_FORMAT = 2; // superset of the tripi format-1 dumps; db-restore reads either
const BACKUP_INTERVAL_MS = Math.max(1, +(process.env.BACKUP_INTERVAL_HOURS || 24)) * 3600 * 1000;

// owner/repo and branch the escrow lives in — same place lib/db-restore.js reads from
const ESCROW_REPO = process.env.ESCROW_REPO || 'ofir6868/tripi';
const ESCROW_BRANCH = process.env.ESCROW_BRANCH || 'db-rotation-backups';
const LATEST_PATH = 'backups/latest.json.enc';

// Every table, ordered and JSON-typed by Postgres itself (to_jsonb renders dates and
// numerics as strings — no driver-side surprises). Matches what db-restore expects.
async function buildDump() {
  const tables = {};
  for (const name of TABLE_ORDER) {
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [name]
    );
    if (!cols.length) continue; // a table this schema doesn't have — skip it
    const orderBy = cols.some((c) => c.column_name === 'id') ? 'id'
      : cols.slice(0, 2).map((c) => `"${c.column_name}"`).join(', ');
    const { rows } = await pool.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(x.*) ORDER BY ${orderBy}), '[]') AS data FROM "${name}" x`
    );
    tables[name] = rows[0].data;
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return { format: DUMP_FORMAT, dumped_at: new Date().toISOString(), counts, tables };
}

// openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:<key> — the exact bytes db-restore
// (and openssl) decrypt: "Salted__" + 8-byte salt, PBKDF2-HMAC-SHA256 10000 iters → 48.
function encryptDump(plaintext, passphrase) {
  const salt = crypto.randomBytes(8);
  const keyiv = crypto.pbkdf2Sync(passphrase, salt, 10000, 48, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', keyiv.subarray(0, 32), keyiv.subarray(32));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'latin1'), salt, body]);
}

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.ESCROW_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TRIPMAKER-rotation',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return res;
}

// Commit the encrypted dump to the escrow branch (overwrite latest, and a dated copy on
// the 1st of the month so there's a trail). PUT /contents needs the current file sha.
async function pushEscrow(encrypted, log) {
  const b64 = encrypted.toString('base64');
  const put = async (filePath, message) => {
    let sha;
    const cur = await gh(`/repos/${ESCROW_REPO}/contents/${filePath}?ref=${ESCROW_BRANCH}`);
    if (cur.ok) sha = (await cur.json()).sha;
    const res = await gh(`/repos/${ESCROW_REPO}/contents/${filePath}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64, branch: ESCROW_BRANCH, ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
  await put(LATEST_PATH, `Escrow: automated dump ${new Date().toISOString()}`);
  if (new Date().getUTCDate() === 1) {
    await put(`backups/tripi-db-${stamp}.json.enc`, `Escrow: monthly snapshot ${stamp}`);
  }
  log && log(`rotation-backup: escrowed to ${ESCROW_REPO}@${ESCROW_BRANCH}`);
}

async function backupOnce(log = console.log) {
  if (!process.env.DB_BACKUP_KEY || !process.env.ESCROW_GITHUB_TOKEN) return false;
  try {
    const dump = await buildDump();
    // never escrow an empty or seed-only database over a good backup
    if ((dump.counts.users || 0) === 0) { log('rotation-backup: no users yet — skipping (nothing to protect)'); return false; }
    const enc = encryptDump(Buffer.from(JSON.stringify(dump), 'utf8'), process.env.DB_BACKUP_KEY);
    await pushEscrow(enc, log);
    log(`rotation-backup: ${JSON.stringify(dump.counts)}`);
    return true;
  } catch (err) {
    console.error('rotation-backup failed (will retry next interval):', err.message);
    return false;
  }
}

// in-process timer, the same pattern as lib/reminders.js — no cron, no extra dependency
function start() {
  if (!process.env.DB_BACKUP_KEY || !process.env.ESCROW_GITHUB_TOKEN) {
    console.log('rotation-backup: disabled (set DB_BACKUP_KEY and ESCROW_GITHUB_TOKEN to enable in-app backups)');
    return;
  }
  const tick = () => backupOnce().catch(() => {});
  setTimeout(tick, 30 * 1000).unref();        // once shortly after boot
  setInterval(tick, BACKUP_INTERVAL_MS).unref(); // and on the interval after that
  console.log(`rotation-backup: enabled — every ${BACKUP_INTERVAL_MS / 3600000}h to ${ESCROW_REPO}@${ESCROW_BRANCH}`);
}

module.exports = { start, backupOnce, buildDump, encryptDump, DUMP_FORMAT };
