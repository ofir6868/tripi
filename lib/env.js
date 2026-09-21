// Load .env for local development (no dotenv dependency needed).
// Required for its side effect, before anything reads process.env.
try {
  require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8')
    .split('\n').forEach((line) => {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
} catch { /* no .env — fine in production */ }

// One name for "this is the real thing".
//
// Render announced itself twice — NODE_ENV=production and RENDER=true — and the code grew
// used to asking about either. Vercel announces itself as VERCEL and leaves NODE_ENV to
// the build, so a check written against Render's hints reads "not production" on a host
// that is serving the public. That is not a cosmetic difference: the guard in lib/auth.js
// refuses to start with the known dev secret in production, and on a host it does not
// recognise it simply lets the app run with a secret anyone can read off GitHub and forge
// an admin token with. So the hints are normalised here, once, before anything reads them.
if (!process.env.NODE_ENV && (process.env.VERCEL || process.env.RENDER)) {
  process.env.NODE_ENV = 'production';
}
