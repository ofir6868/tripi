// Tiny in-memory per-IP rate limiter (fixed window). In-memory is fine here for
// the same reason the AI quotas are: a single process, and a restart resetting
// the counters is harmless.
//
// Two usage shapes:
//   limiter.middleware        — counts every request (e.g. auth attempts)
//   limiter.blocked / .hit    — count only *failures*, checked manually, so
//                               legitimate traffic is never throttled (e.g.
//                               share-code lookups: only misses count, which is
//                               exactly the enumeration pattern)

function rateLimiter({ windowMs, max, error }) {
  const hits = new Map(); // key → {count, resetAt}

  function entry(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || now >= e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
      // opportunistic cleanup so the map tracks active windows, not every IP ever seen
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
      }
    }
    return e;
  }

  return {
    blocked: (key) => entry(key).count >= max,
    hit: (key) => { entry(key).count++; },
    middleware: (req, res, next) => {
      const e = entry(req.ip);
      if (e.count >= max) return res.status(429).json({ error });
      e.count++;
      next();
    },
  };
}

module.exports = { rateLimiter };
