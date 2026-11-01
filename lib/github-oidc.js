// A GitHub Actions run proving who it is, with no shared secret.
//
// The moments clock (.github/workflows/moments-clock.yml) rings /api/cron/moments every
// five minutes. It could carry CRON_SECRET — but a secret has to be copied into the
// repository's settings, and this repository is public, so one slip puts the doorbell's
// key on the internet. GitHub offers a better proof: a workflow may ask for an OIDC token,
// a JWT GitHub signs with keys it publishes, whose claims name the repository, the
// workflow and the branch the run came from. The server checks the signature against
// those published keys and the claims against the one repository it belongs to; nothing
// is stored anywhere, and a token lives minutes. routes/cron.js accepts either proof.
//
// Rules: the keys are fetched from GitHub and cached in the process for an hour (an
// unknown key id refetches once, since GitHub rotates them); every failure is a null with a
// logged reason, never a throw — a cron doorbell that crashes on a bad token is a cron
// doorbell a stranger can crash.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwks = { keys: new Map(), at: 0 };

async function fetchJwks(fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(JWKS_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const data = await res.json();
    const keys = new Map();
    for (const k of (data && data.keys) || []) {
      if (!k || !k.kid || k.kty !== 'RSA') continue;
      try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* a key we cannot read is a key we do not trust */ }
    }
    jwks = { keys, at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

async function keyFor(kid, fetchImpl) {
  if (!jwks.keys.size || Date.now() - jwks.at > JWKS_TTL_MS) await fetchJwks(fetchImpl);
  if (!jwks.keys.has(kid)) await fetchJwks(fetchImpl); // rotated under us: once more, then no
  return jwks.keys.get(kid) || null;
}

// the token → its claims when it is a live GitHub Actions token for `repository`, with
// `audience` as the audience the workflow asked for; null (with a log line) otherwise
async function verify(token, { repository, audience, fetchImpl = fetch } = {}) {
  try {
    const decoded = jwt.decode(String(token || ''), { complete: true });
    if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) return null;
    if (!decoded.payload || decoded.payload.iss !== ISSUER) return null;
    const key = await keyFor(decoded.header.kid, fetchImpl);
    if (!key) { console.warn('github-oidc: no key for kid', decoded.header.kid); return null; }
    const claims = jwt.verify(token, key, { algorithms: ['RS256'], issuer: ISSUER, audience, clockTolerance: 30 });
    if (!repository || String(claims.repository || '').toLowerCase() !== String(repository).toLowerCase()) {
      console.warn(`github-oidc: token from ${claims.repository} refused — this server answers to ${repository}`);
      return null;
    }
    return claims;
  } catch (err) {
    console.warn('github-oidc: token refused —', err && err.message);
    return null;
  }
}

module.exports = { verify, ISSUER, JWKS_URL, _test: { reset: () => { jwks = { keys: new Map(), at: 0 }; } } };
