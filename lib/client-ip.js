// Which address is "the visitor"?
//
// Every rate limiter keys on req.ip — login brute force, registration, Google sign-in
// and share-code guessing all count per address. With `trust proxy` set to a hop count
// of 1, Express takes req.ip from the last X-Forwarded-For entry, i.e. whoever opened
// the connection to Render's proxy. Behind a grey-cloud DNS record that is the visitor.
// Behind Cloudflare's proxy (orange cloud) it is a Cloudflare edge — one address for
// every visitor in that region, one shared bucket, and every limit above quietly off.
//
// Cloudflare sends the real visitor in CF-Connecting-IP and always overwrites that
// header itself, so it cannot be forged *through* Cloudflare. It can be forged trivially
// by anyone talking to the onrender.com host directly, which stays reachable. So the
// header is believed only when the hop that reached us is a genuine Cloudflare address:
//
//   visitor → Render                 req.ip = visitor        (header ignored)
//   visitor → Cloudflare → Render    req.ip = CF-Connecting-IP
//   attacker → Render, header forged req.ip = attacker       (peer is not Cloudflare)
//
// The ranges below are Cloudflare's published list (https://www.cloudflare.com/ips/).
// They change rarely, but they do change, so the list is also refreshed from the public
// API at boot and daily; a refresh that fails keeps the last good list and says so in
// the log. A new edge range appearing before a refresh would fall back to the grey-cloud
// behaviour for that edge — coarse, never a hole.
const net = require('net');

const BAKED_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const BAKED_IPV6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const IPS_URL = 'https://api.cloudflare.com/client/v4/ips';
const REFRESH_MS = 24 * 60 * 60 * 1000;

function buildList(v4, v6) {
  const list = new net.BlockList();
  for (const cidr of v4) {
    const [addr, bits] = cidr.split('/');
    list.addSubnet(addr, Number(bits), 'ipv4');
  }
  for (const cidr of v6) {
    const [addr, bits] = cidr.split('/');
    list.addSubnet(addr, Number(bits), 'ipv6');
  }
  return list;
}

let ranges = buildList(BAKED_IPV4, BAKED_IPV6);

// Node reports an IPv4 peer of a dual-stack socket as ::ffff:a.b.c.d; the ranges are
// IPv4, so look it up as one.
function normalize(ip) {
  if (typeof ip !== 'string') return null;
  const s = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return mapped ? mapped[1] : s;
}

function isCloudflare(ip) {
  const addr = normalize(ip);
  const family = net.isIP(addr);
  if (!family) return false;
  return ranges.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

function clientIp(req, res, next) {
  if (isCloudflare(req.ip)) {
    const real = normalize(req.get('cf-connecting-ip'));
    if (real && net.isIP(real)) {
      // req.ip is a getter on Express's request prototype; an own property shadows it
      // for this request only, so every req.ip below — the limiters included — sees
      // the visitor.
      Object.defineProperty(req, 'ip', { value: real, enumerable: true, configurable: true });
    }
  }
  next();
}

async function refresh() {
  const res = await fetch(IPS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const v4 = body?.result?.ipv4_cidrs;
  const v6 = body?.result?.ipv6_cidrs;
  if (!Array.isArray(v4) || !v4.length || !Array.isArray(v6) || !v6.length) {
    throw new Error('unexpected shape');
  }
  ranges = buildList(v4, v6);
  return { v4: v4.length, v6: v6.length };
}

function start() {
  const tick = () => refresh()
    .then((n) => console.log(`cloudflare-ips: refreshed (${n.v4} v4 ranges, ${n.v6} v6)`))
    .catch((err) => console.warn(`cloudflare-ips: refresh failed (${err.message}) — keeping the last good list`));
  tick();
  setInterval(tick, REFRESH_MS).unref();
}

module.exports = { clientIp, isCloudflare, start, _test: { normalize, refresh } };
