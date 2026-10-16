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
// A source key is only as good as its canonical form. Two bypasses that need no
// real address rotation are closed here (ISSUE-23 residual):
//   * alternate but equivalent textual forms of one address used to earn a full
//     budget each (`203.0.113.9` vs `::ffff:203.0.113.9`, `2001:DB8::1` vs
//     `2001:0db8:0000:0000:0000:0000:0000:0001`);
//   * one machine is routinely delegated at least a whole IPv6 /64, so a single
//     host could draw 2^64 distinct keys - IPv6 keys are therefore aggregated to
//     their /64 prefix, exactly as general-purpose edge limiters do.
//
// Memory: the bucket table is pruned and hard-capped, and the cap now FAILS
// CLOSED. When the table is full and nothing has expired, a new source is
// refused rather than served by evicting a live bucket: the previous
// evict-the-oldest behaviour handed an already-exhausted source a fresh budget
// (a direct bypass) and cost O(n) work per eviction, amplifying the very flood
// it was meant to bound.

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 30;
const MAX_TRACKED_KEYS = 10000;
const PROXY_WARNING_INTERVAL_MS = 5 * 60 * 1000;

// Throttled operator diagnostics: at most one warning per interval, so a flood
// cannot turn the warning into a log-spam amplifier.
let lastProxyWarningAtMs = 0;

/**
 * A request that arrives carrying `X-Forwarded-For` while proxy trust is off is
 * strong evidence the app is deployed behind a reverse proxy with TRUST_PROXY
 * unset. Express then keys EVERY caller to the proxy's own address, so all users
 * share one budget and an innocent 31st request is throttled (ISSUE-23 residual).
 * That is a silent misconfiguration, so make it visible to operators. This never
 * changes the request's outcome.
 */
function warnIfProxyMisconfigured(req, trustProxy) {
  if (trustProxy) {
    return;
  }

  const forwarded = req && req.headers && req.headers['x-forwarded-for'];
  if (!forwarded) {
    return;
  }

  const now = Date.now();
  if (now - lastProxyWarningAtMs < PROXY_WARNING_INTERVAL_MS) {
    return;
  }

  lastProxyWarningAtMs = now;
  console.warn(
    'game/start rate limiter: request carried X-Forwarded-For but TRUST_PROXY is not "true". '
      + 'Behind a reverse proxy this collapses every caller into one rate-limit bucket; set '
      + 'TRUST_PROXY=true only when the proxy overwrites that header.'
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIpv4(value) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return null;
  }

  const parts = value.split('.').map((part) => Number(part));

  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return parts;
}

// Parse an IPv6 literal into eight 16-bit words. Returns null when the input is
// not a valid address. Both `::` compression and an embedded IPv4 tail
// (`::ffff:203.0.113.9`) are handled.
function parseIpv6(value) {
  if (value.indexOf(':') === -1) {
    return null;
  }

  let text = value;
  let embedded = null;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);

  if (tail.indexOf('.') !== -1) {
    const quad = parseIpv4(tail);
    if (!quad) {
      return null;
    }
    embedded = [(quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const compressionAt = text.indexOf('::');
  if (compressionAt !== -1 && text.indexOf('::', compressionAt + 2) !== -1) {
    return null;
  }

  let groups;

  if (compressionAt === -1) {
    groups = text.split(':');
    if (groups.length !== 8) {
      return null;
    }
  } else {
    const head = text.slice(0, compressionAt);
    const rest = text.slice(compressionAt + 2);
    const headGroups = head ? head.split(':') : [];
    const restGroups = rest ? rest.split(':') : [];
    const missing = 8 - (headGroups.length + restGroups.length);

    if (missing < 1) {
      return null;
    }

    groups = [...headGroups, ...new Array(missing).fill('0'), ...restGroups];
  }

  const words = [];

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
    words.push(parseInt(group, 16));
  }

  if (words.length !== 8) {
    return null;
  }

  if (embedded) {
    words[6] = embedded[0];
    words[7] = embedded[1];
  }

  return words;
}

/**
 * Reduce a client address to the key the limiter budgets against.
 *
 * - IPv4 addresses (including the `::ffff:` mapped and embedded
 *   IPv4-compatible forms) key on the whole address.
 * - IPv6 addresses key on their /64 prefix, so one machine cannot mint a new
 *   budget per interface identifier.
 * - Anything unparseable keeps its own trimmed key rather than collapsing into a
 *   shared bucket; a missing address is a single shared "unknown" bucket, which
 *   fails closed instead of granting an unbounded budget.
 */
function canonicalizeSourceKey(raw) {
  if (typeof raw !== 'string') {
    return 'unknown';
  }

  let value = raw.trim().toLowerCase();

  if (!value) {
    return 'unknown';
  }

  // Tolerate a bracketed host with a port, as some proxies forward it.
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  }

  // Drop a scope/zone suffix (`fe80::1%eth0`): it is link-local decoration, not
  // part of the identity, and leaving it in would let one host present several
  // keys for the same address.
  const zoneAt = value.indexOf('%');
  if (zoneAt !== -1) {
    value = value.slice(0, zoneAt);
  }

  const quad = parseIpv4(value);
  if (quad) {
    return quad.join('.');
  }

  const words = parseIpv6(value);
  if (words) {
    const mappedPrefix = words.slice(0, 5).every((word) => word === 0)
      && words[5] === 0xffff;

    if (mappedPrefix) {
      return [
        words[6] >> 8,
        words[6] & 0xff,
        words[7] >> 8,
        words[7] & 0xff,
      ].join('.');
    }

    return `${words.slice(0, 4).map((word) => word.toString(16)).join(':')}/64`;
  }

  return value;
}

function defaultKeyGenerator(req) {
  if (!req) {
    return 'unknown';
  }

  if (typeof req.ip === 'string' && req.ip) {
    return canonicalizeSourceKey(req.ip);
  }

  if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) {
    return canonicalizeSourceKey(req.socket.remoteAddress);
  }

  return 'unknown';
}

/**
 * Create an Express middleware that allows at most `max` requests per `windowMs`
 * for each key produced by `keyGenerator` (default: the canonical client
 * address).
 */
function createRateLimiter(options = {}) {
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const max = positiveInteger(options.max, DEFAULT_MAX);
  const maxTrackedKeys = positiveInteger(options.maxTrackedKeys, MAX_TRACKED_KEYS);
  const trustProxy = options.trustProxy === undefined
    ? process.env.TRUST_PROXY === 'true'
    : options.trustProxy === true;
  const keyGenerator = typeof options.keyGenerator === 'function'
    ? options.keyGenerator
    : defaultKeyGenerator;

  const buckets = new Map();

  // Sweeping is O(n); it only runs when the table is at its cap and never more
  // often than once per interval, so a key-rotating flood cannot turn table
  // maintenance into a CPU amplifier.
  const sweepIntervalMs = Math.min(1000, windowMs);
  let lastSweepAtMs = 0;

  function sweepExpired(now) {
    if (now - lastSweepAtMs < sweepIntervalMs) {
      return 0;
    }

    lastSweepAtMs = now;
    let removed = 0;

    for (const [key, bucket] of buckets) {
      if (bucket.resetAtMs <= now) {
        buckets.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  function rejectOverCapacity(res, now) {
    const retryAfterSeconds = Math.max(1, Math.ceil(windowMs / 1000));

    if (typeof res.setHeader === 'function') {
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));
      res.setHeader('Retry-After', String(retryAfterSeconds));
    }

    return res.status(429).json({
      ok: false,
      message: 'Too many distinct sources are starting rounds right now. Please try again in a moment.',
      retryable: true,
    });
  }

  function middleware(req, res, next) {
    const now = Date.now();
    warnIfProxyMisconfigured(req, trustProxy);

    const key = keyGenerator(req);
    let bucket = buckets.get(key);

    if (bucket && bucket.resetAtMs <= now) {
      buckets.delete(key);
      bucket = undefined;
    }

    if (!bucket) {
      // Table full: free only genuinely expired entries. If that yields no room,
      // refuse the new key (fail closed) instead of evicting a live bucket, which
      // would reset an already-exhausted source's budget.
      if (buckets.size >= maxTrackedKeys) {
        const removed = sweepExpired(now);

        if (removed === 0 && buckets.size >= maxTrackedKeys) {
          return rejectOverCapacity(res, now);
        }
      }

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

  middleware._resetForTests = () => {
    buckets.clear();
    lastSweepAtMs = 0;
    lastProxyWarningAtMs = 0;
  };
  middleware._trackedKeyCount = () => buckets.size;
  middleware.windowMs = windowMs;
  middleware.max = max;
  middleware.maxTrackedKeys = maxTrackedKeys;
  middleware.trustProxy = trustProxy;

  return middleware;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX,
  MAX_TRACKED_KEYS,
  canonicalizeSourceKey,
  createRateLimiter,
};
