// `npm test`: everything that can be checked with no network, no key and no database, in
// one command. Each check below is a script that exits 1 on a wrong answer, and the first
// thing here is a syntax pass over every JavaScript file in the repo — a build that ships a
// file `node` refuses to parse is the kind of failure nothing else would have caught until
// the page went blank. The paid checks (tools/ai-eval, the probes) stay out on purpose:
// they cost real money or need the live database, and are run by hand (PLAYBOOK §4).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'vendor', '.vercel']);

function jsFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

let failed = 0;
const files = jsFiles(ROOT);
const bad = files.filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
console.log(`syntax: ${files.length - bad.length}/${files.length} files parse`);
for (const f of bad) { failed++; console.log(`  ✗ ${path.relative(ROOT, f)}`); }

const CHECKS = [
  'tools/opening-hours-check.js',
  'tools/travel-fit-check.js',
  'tools/day-recs-plan-check.js',
  'tools/docs-classify-check.js',
  'tools/ai-tools-check.js',
];
for (const script of CHECKS) {
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
  const ok = r.status === 0;
  if (!ok) failed++;
  const tail = (r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  console.log(`${ok ? '✓' : '✗'} ${script} — ${tail}${ok ? '' : '\n' + (r.stdout || '') + (r.stderr || '')}`);
}
process.exit(failed ? 1 : 0);
