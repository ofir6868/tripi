// Load .env for local development (no dotenv dependency needed).
// Required for its side effect, before anything reads process.env.
try {
  require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8')
    .split('\n').forEach((line) => {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
} catch { /* no .env — fine in production */ }
