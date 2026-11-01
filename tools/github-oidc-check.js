// The cron doorbell's second key, checked with no network: a GitHub Actions OIDC token
// (lib/github-oidc.js) signed by a key pair minted here and served by a fake JWKS, accepted
// for this repository and refused for another, for another audience, for an expired run,
// and for a key GitHub never published. Then routes/cron.js cronAuth with both proofs.
// Part of `npm test` (tools/check.js).
process.env.DATABASE_URL = '';
process.env.CRON_SECRET = 'test-cron-secret';

const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const oidc = require('../lib/github-oidc');

let failed = 0;
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`); }
};

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', use: 'sig', alg: 'RS256' };
let fetches = 0;
const fakeFetch = async (url) => {
  assert.strictEqual(url, oidc.JWKS_URL);
  fetches++;
  return { ok: true, json: async () => ({ keys: [jwk] }) };
};
const REPO = 'ofir6868/tripi';
const AUD = 'tripmaker-cron';
const sign = (claims, key = privateKey, kid = 'kid-1') => jwt.sign(
  { iss: oidc.ISSUER, aud: AUD, repository: REPO, ref: 'refs/heads/main', workflow: 'moments-clock', ...claims },
  key, { algorithm: 'RS256', keyid: kid, expiresIn: claims.expiresIn || '5m' }
);
const warn = console.warn;
console.warn = () => {}; // the refusals below log on purpose; the check reads the verdicts

(async () => {
  await checkAsync('oidc: a token from this repository, for our audience, is accepted', async () => {
    oidc._test.reset();
    const claims = await oidc.verify(sign({}), { repository: REPO, audience: AUD, fetchImpl: fakeFetch });
    assert(claims && claims.repository === REPO && claims.ref === 'refs/heads/main');
    assert.strictEqual(fetches, 1);
  });
  await checkAsync('oidc: the keys are cached — a second token costs no fetch', async () => {
    await oidc.verify(sign({}), { repository: REPO, audience: AUD, fetchImpl: fakeFetch });
    assert.strictEqual(fetches, 1);
  });
  await checkAsync('oidc: another repository is refused, so is another audience', async () => {
    assert.strictEqual(await oidc.verify(sign({ repository: 'someone/else' }), { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    assert.strictEqual(await oidc.verify(sign({ aud: 'other' }), { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    assert.strictEqual(await oidc.verify(sign({}), { repository: 'someone/else', audience: AUD, fetchImpl: fakeFetch }), null);
  });
  await checkAsync('oidc: an expired run, a foreign key and garbage are refused', async () => {
    assert.strictEqual(await oidc.verify(sign({ expiresIn: '-1m' }), { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    assert.strictEqual(await oidc.verify(sign({}, stranger.privateKey, 'kid-1'), { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    const before = fetches;
    assert.strictEqual(await oidc.verify(sign({}, stranger.privateKey, 'kid-unknown'), { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    assert.strictEqual(fetches, before + 1); // an unknown kid refetches once, in case GitHub rotated
    assert.strictEqual(await oidc.verify('not.a.jwt', { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    assert.strictEqual(await oidc.verify('', { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
    // HS256 with the public key as the secret — the classic confusion — is not RS256 and dies at the header
    const hs = jwt.sign({ iss: oidc.ISSUER, aud: AUD, repository: REPO }, publicKey.export({ type: 'spki', format: 'pem' }), { algorithm: 'HS256', keyid: 'kid-1' });
    assert.strictEqual(await oidc.verify(hs, { repository: REPO, audience: AUD, fetchImpl: fakeFetch }), null);
  });
  await checkAsync('cron: the shared secret still opens the door, a wrong one does not', async () => {
    const cron = require('../routes/cron');
    const auth = cron._test.cronAuth;
    const run = (header) => new Promise((resolve) => {
      const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
      auth({ headers: { authorization: header } }, res, () => resolve({ code: 200 }));
    });
    assert.strictEqual((await run('Bearer test-cron-secret')).code, 200);
    assert.strictEqual((await run('Bearer wrong')).code, 401);
    assert.strictEqual((await run('')).code, 401);
    assert.strictEqual((await run('Bearer a.b.c')).code, 401); // a JWT-shaped string that is not one
  });
  console.warn = warn;
  console.log(failed ? `${failed} check(s) failed` : 'github-oidc: all checks pass');
  process.exit(failed ? 1 : 0);
})();
