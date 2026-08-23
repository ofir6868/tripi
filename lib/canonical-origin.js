const { SITE } = require('./seo');

// One host, one scheme, one URL per page.
//
// The same app answers on tripmaker.co.il over http *and* https, on www., and on the
// onrender.com host that Render keeps directly reachable — four doors into byte-identical
// HTML. Search Console's coverage export from 2026-08-21 is what that costs: the homepage
// listed twice, http://tripmaker.co.il/ and https://tripmaker.co.il/, both parked under
// "crawled — currently not indexed". The page was competing with itself.
//
// index.html has carried <link rel="canonical"> all along, and that wasn't enough: a
// canonical tag is a hint Google weighs against everything else it sees, and it only
// speaks for URLs a crawler already fetched and rendered. A 301 removes the question —
// every duplicate collapses into the branded https origin before anything gets indexed,
// and the link equity of anyone who typed http:// or www. arrives with it.
const CANONICAL = new URL(process.env.CANONICAL_ORIGIN || SITE);
const ORIGIN = CANONICAL.origin;

// Local development and Render's own by-IP probes must pass through untouched: nothing
// on this list is a name a crawler can reach, so there is no duplicate to collapse.
const isLocalHost = (host) => host === 'localhost'
  || host === '127.0.0.1'
  || host === '::1'
  || host.endsWith('.local')
  || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

function canonicalOrigin(req, res, next) {
  // Pages only. A crawler never sends anything but GET/HEAD, and a 301 on an API call
  // would be actively harmful: browsers replay a redirected POST as a GET and drop the
  // body. /api/ is skipped for a second reason as well — the Google OAuth callback lands
  // on whichever host started the flow (see publicOrigin in routes/auth.js), and moving
  // it mid-flight makes the redirect_uri at token exchange stop matching the one sent to
  // Google, so the login fails. /api/health sits behind the same skip, which is what
  // keeps a Render health check pointed at it answering 200 instead of 301.
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();

  const host = req.hostname || '';
  if (!host || isLocalHost(host)) return next();
  if (host === CANONICAL.hostname && req.protocol === 'https') return next();

  // Build the target by concatenation, never with new URL(originalUrl, ORIGIN): a request
  // for //evil.com/ is a protocol-relative URL that the parser would resolve to a *foreign*
  // origin, turning this into an open redirect. Collapsing the leading slashes keeps the
  // path a path.
  res.redirect(301, ORIGIN + req.originalUrl.replace(/^\/+/, '/'));
}

module.exports = { canonicalOrigin, ORIGIN };
