// One version, stamped onto every stylesheet and script URL the HTML asks for.
//
// Why this exists: a deploy used to be able to arrive styled by the PREVIOUS deploy.
// The pages come back fresh (HTML is not in Cloudflare's cached-extension list) while
// /css/style.css sat in the visitor's browser under an expiry Cloudflare had handed
// out — so new markup met a stylesheet with no rules for it, and a new control
// rendered as a bare browser button. Cache headers alone could not settle it: the
// edge is free to override a max-age, and the copies already handed out keep their
// expiry no matter what the origin says afterwards. A URL nobody has seen before is
// the one thing no cache can answer from memory.
//
// The version is the deployed commit (Vercel sets VERCEL_GIT_COMMIT_SHA, Render set
// RENDER_GIT_COMMIT), so it changes exactly when the code does. Without it — locally,
// or on any host that doesn't set one — it falls back to process start, which on an
// always-on host still changes on exactly every deploy. On Vercel it would change on
// every cold start instead, which is why reading the commit there matters more than it
// did: a version that moves on its own would hand every visitor a fresh copy of the CSS
// for nothing. Either way there is nothing to bump by hand, and no second copy of a
// version number to drift out of sync with sw.js.
const COMMIT = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || '';
const VERSION = COMMIT.slice(0, 8) || Date.now().toString(36);

// Only same-origin asset paths, and only ones that don't already carry a query.
// The service worker registers '/sw.js' unstamped on purpose: the browser compares
// that file byte for byte to decide there is a new worker, and a URL that changed
// every boot would look like a new worker on every restart.
const ASSET_URL = /(\s(?:href|src)=")(\/(?:css|js|vendor)\/[^"?#]+)"/g;
const stampAssets = (html) => String(html).replace(ASSET_URL, `$1$2?v=${VERSION}"`);

module.exports = { VERSION, stampAssets };
