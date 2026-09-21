#!/usr/bin/env node
// Copy the environment from the old Render service into the Vercel project — without
// anyone reading the secrets on the way through.
//
// The values move machine to machine: this script holds them in memory for as long as one
// HTTP request takes and prints nothing but key names and outcomes. Nothing is written to
// disk, nothing is echoed, and a failed write reports its status code rather than its body,
// because an API that quotes your request back at you is an API that prints your secret.
//
// It only ever fills a blank. Every key already exists on the Vercel project as an empty
// slot with a comment explaining it (created during the migration), so the script reads the
// current values, and writes a key only where Vercel's is empty and Render has something.
// Anything already set by hand stays exactly as it is — running this twice is a no-op, and
// running it after fixing something by hand cannot undo the fix.
//
// Usage:
//   RENDER_API_KEY=... VERCEL_TOKEN=... node tools/migrate-env.js --dry-run
//   RENDER_API_KEY=... VERCEL_TOKEN=... node tools/migrate-env.js
//
// Render API key: https://dashboard.render.com/u/settings#api-keys
// Vercel token:   https://vercel.com/account/tokens
// Both are read from the environment on purpose — a token on the command line ends up in
// the shell history. Revoke them when you are done.

const RENDER_SERVICE = 'srv-d9qgmoijobas7382hu0g';        // the suspended tripmaker web service
const VERCEL_PROJECT = 'prj_6SXOAKIRjRL7C7nTXw2smLjsVC3p';
const VERCEL_TEAM = 'team_gultjoQzTRId1SJJxpxH50Fy';

// Keys that must NOT be carried over, and why. This list is the whole point of the script
// being a script instead of a copy-paste.
const NEVER_COPY = {
  // The one that matters. Render's value is the *internal* connection string
  // (dpg-…-a, no domain), which resolves only inside Render's own network — from Vercel it
  // is ENOTFOUND and every request that touches the database fails. Vercel holds the
  // external URL. Copying this key would take the site down again.
  DATABASE_URL: 'Render holds the internal connection string, unreachable from Vercel',
  // Generated for Vercel's scheduler; Render never had one.
  CRON_SECRET: 'generated for this host, not Render\'s to supply',
  // Deliberately set here, and Render's copy may still name the onrender host.
  CANONICAL_ORIGIN: 'set for this host',
  // The same trap as DATABASE_URL, one layer up. Render's copy names the onrender host
  // (see the README's env table), and an OAuth callback pointing at a host we no longer
  // answer on fails token exchange — the redirect_uri sent to Google has to match the one
  // the flow started from. Left empty, routes/auth.js derives it from the request, which
  // is right on every host including this one. Empty is not a gap here; it is the answer.
  GOOGLE_REDIRECT_URI: 'Render\'s copy names the old host; derived per request when unset',
  // The platform supplies these, and a stale copy is worse than none.
  PORT: 'the platform decides', NODE_ENV: 'the platform decides',
  RENDER: 'names the old host', RENDER_GIT_COMMIT: 'names the old host',
  // One-shot switches. Each one does something irreversible-ish on the next boot (import a
  // database, force a restore, run a backfill); they are set deliberately for one run and
  // must never arrive by inheritance.
  IMPORT_FROM_DATABASE_URL: 'one-shot migration switch',
  RESTORE_FROM_ESCROW: 'one-shot recovery switch',
  RESTORE_SOURCE_URL: 'one-shot recovery switch',
  BOOT_PROBE: 'one-shot diagnostic switch',
  BACKFILL_OSM: 'one-shot backfill switch',
};

const DRY_RUN = process.argv.includes('--dry-run');

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set. See the usage note at the top of this file.`);
    process.exit(1);
  }
  return v;
}

async function renderEnv(key) {
  const out = new Map();
  let cursor = '';
  // cursor-paginated; a service with a handful of variables still gets the loop right
  for (;;) {
    const url = `https://api.render.com/v1/services/${RENDER_SERVICE}/env-vars?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Render API answered ${res.status} listing env vars`);
    const page = await res.json();
    if (!page.length) break;
    for (const row of page) {
      const ev = row.envVar || row;
      if (ev && ev.key) out.set(ev.key, ev.value);
    }
    cursor = page[page.length - 1].cursor;
    if (!cursor) break;
  }
  return out;
}

async function vercelEnv(token) {
  // decrypt=true so "is this slot empty?" can be answered. The values stay in this process.
  const url = `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env?decrypt=true&teamId=${VERCEL_TEAM}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Vercel API answered ${res.status} listing env vars`);
  return (await res.json()).envs || [];
}

async function setVercel(token, id, value) {
  const url = `https://api.vercel.com/v9/projects/${VERCEL_PROJECT}/env/${id}?teamId=${VERCEL_TEAM}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  // deliberately not res.text() — an error body can quote the request back
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function main() {
  const renderKey = need('RENDER_API_KEY');
  const vercelToken = need('VERCEL_TOKEN');

  const [fromRender, onVercel] = await Promise.all([renderEnv(renderKey), vercelEnv(vercelToken)]);
  console.log(`Render: ${fromRender.size} variables · Vercel: ${onVercel.length} slots${DRY_RUN ? ' · dry run, nothing will be written' : ''}\n`);

  const filled = [], kept = [], missing = [], refused = [], failed = [];

  for (const slot of onVercel.slice().sort((a, b) => a.key.localeCompare(b.key))) {
    const { key, id, value } = slot;
    if (NEVER_COPY[key]) { refused.push(`${key} — ${NEVER_COPY[key]}`); continue; }
    if (value) { kept.push(key); continue; }              // already set here, never clobbered
    const incoming = fromRender.get(key);
    if (!incoming) { missing.push(key); continue; }        // Render did not have one either
    if (DRY_RUN) { filled.push(key); continue; }
    try { await setVercel(vercelToken, id, incoming); filled.push(key); }
    catch (err) { failed.push(`${key} — ${err.message}`); }
  }

  const report = (title, list) => list.length && console.log(`${title} (${list.length})\n  ${list.join('\n  ')}\n`);
  report(DRY_RUN ? 'WOULD FILL' : 'FILLED FROM RENDER', filled);
  report('LEFT ALONE — already set on Vercel', kept);
  report('STILL EMPTY — Render had no value either', missing);
  report('NOT COPIED ON PURPOSE', refused);
  report('FAILED', failed);

  if (filled.length && !DRY_RUN) {
    console.log('Vercel binds environment variables at deploy time, so redeploy before these take effect:');
    console.log('  vercel deploy --prod --yes --token "$VERCEL_TOKEN"');
  }
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
