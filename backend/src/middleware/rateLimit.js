// Per-source rate limiting for the unauthenticated round-creation endpoint.
//
// POST /api/game/start is deliberately unauthenticated so guests can play, which
// also means one anonymous caller can create rounds far faster than any human
// plays them. The round store already refuses new rounds instead of terminating
// rounds that players are still in (ISSUE-23), so a flood can no longer destroy
// an in-flight game - but a single source could still fill the bounded store and
// make NEW rounds fail with 503 for everyone until idle/TTL reclamation caught
// up. This limiter removes that trivial single-source denial path by bounding how
// many rounds one source may create per window.
//
// Keying: the client address is read from `req.ip`, which honours Express's
// `trust proxy` setting. Trusting `X-Forwarded-For` unconditionally would let a
// caller pick its own bucket (and therefore bypass the limit), so proxy trust is
// an explicit, off-by-default opt-in (TRUST_PROXY in server.js).
//
// Memory: the bucket table is pruned and hard-capped, so a caller rotating source
// addresses cannot grow the process without bound - the same class of exhaustion
// this limiter exists to prevent.

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 30;
const MAX_TRACKED_KEYS = 10000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultKeyGenerator(req) {
  if (!req) {
    return 'unknown';
  }

  if (typeof req.ip === 'string' && req.ip) {
    return req.ip;
  }

  if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }

  return 'unknown';
}

/**
 * Create an Express middleware that allows at most `max` requests per `windowMs`
 * for each key produced by `keyGenerator` (default: the client address).
 */
function createRateLimiter(options = {}) {
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const max = positiveInteger(options.max, DEFAULT_MAX);
  const keyGenerator = typeof options.keyGenerator === 'function'
    ? options.keyGenerator
    : defaultKeyGenerator;

  const buckets = new Map();

  function sweepExpired(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAtMs <= now) {
        buckets.delete(key);
      }
    }
  }

  // Hard cap: never let the table grow without bound. Dropping the entries that
  // reset soonest loses the least useful accounting.
  function enforceKeyCap(now) {
    if (buckets.size < MAX_TRACKED_KEYS) {
      return;
    }

    sweepExpired(now);

    while (buckets.size >= MAX_TRACKED_KEYS) {
      let oldestKey = null;
      let oldestReset = Infinity;

      for (const [key, bucket] of buckets) {
        if (bucket.resetAtMs < oldestReset) {
          oldestReset = bucket.resetAtMs;
          oldestKey = key;
        }
      }

      if (oldestKey === null) {
        return;
      }

      buckets.delete(oldestKey);
    }
  }

  function middleware(req, res, next) {
    const now = Date.now();

    enforceKeyCap(now);

    const key = keyGenerator(req);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAtMs <= now) {
      bucket = { count: 0, resetAtMs: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    if (typeof res.setHeader === 'function') {
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAtMs / 1000)));
    }

    if (bucket.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000));

      if (typeof res.setHeader === 'function') {
        res.setHeader('Retry-After', String(retryAfterSeconds));
      }

      return res.status(429).json({
        ok: false,
        message: 'Too many new rounds started from this source. Please wait a moment and try again.',
        retryable: true,
      });
    }

    return next();
  }

  middleware._resetForTests = () => buckets.clear();
  middleware._trackedKeyCount = () => buckets.size;
  middleware.windowMs = windowMs;
  middleware.max = max;

  return middleware;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX,
  MAX_TRACKED_KEYS,
  createRateLimiter,
};
