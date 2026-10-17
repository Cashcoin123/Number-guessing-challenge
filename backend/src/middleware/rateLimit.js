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
// A source key is only as good as its canonical form. Several bypasses that need
// no real address rotation are closed here (ISSUE-23 residual):
//   * alternate but equivalent textual forms of one address used to earn a full
//     budget each (`203.0.113.9` vs `::ffff:203.0.113.9`, `2001:DB8::1` vs
//     `2001:0db8:0000:0000:0000:0000:0000:0001`);
//   * one machine is routinely delegated at least a whole IPv6 /64, so a single
//     host could draw 2^64 distinct keys - IPv6 keys are therefore aggregated to
//     their /64 prefix, exactly as general-purpose edge limiters do.
//
// The key space is now also BOUNDED by construction, because a canonical form
// that is merely "usually the same" is not a limit: any *family* of textual
// variants of one address still mints one bucket per variant. A caller that can
// present its own address text (TRUST_PROXY on, behind a proxy that does not
// overwrite the header - see below) could therefore multiply its own budget and
// walk the whole bucket table with a single machine, at which point the
// fail-closed cap denied honest new sources. `canonicalizeSourceKey` now:
//   * strips a trailing port from an UNBRACKETED host too (`203.0.113.9:12345`,
//     `::ffff:203.0.113.9:12345`), not just from a bracketed one;
//   * accepts leading-zero / octal-looking octets and normalises them, so
//     `0203.0.113.9` and `203.000.113.009` are the same source as `203.0.113.9`;
//   * maps anything that is not a valid address into ONE shared bucket instead
//     of keying on raw attacker-controlled text, so junk input consumes exactly
//     one slot instead of one slot per string.
//
// Note on scope: a source picks only its *text*, never its address, unless a
// deployment trusts a header the client can also set. Genuine source-address
// rotation (a different OS-level address, or a spoofable proxy header carrying a
// different valid address) remains unbounded by design; this limiter can bind
// only the spellings of one address. Authenticating the endpoint is the durable
// alternative and is deliberately out of scope.
//
// Memory: the bucket table is pruned and hard-capped, and the cap FAILS
// CLOSED. When the table is full and nothing has expired, a new source is
// refused rather than served by evicting a live bucket: the previous
// evict-the-oldest behaviour handed an already-exhausted source a fresh budget
// (a direct bypass) and cost O(n) work per eviction, amplifying the very flood
// it was meant to bound.

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 30;
const MAX_TRACKED_KEYS = 10000;
const PROXY_WARNING_INTERVAL_MS = 5 * 60 * 1000;

// A missing address fails closed into one shared bucket, and so does text that is
// not a valid address. They are separate fixed keys purely so that a deployment
// with no usable socket address is not charged for remote junk; both are single
// buckets, so neither can be multiplied by caller-controlled text.
const MISSING_SOURCE_KEY = 'unknown';
const UNPARSEABLE_SOURCE_KEY = 'unparseable';

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

// Parse a dotted-quad IPv4 literal. Leading zeros are accepted and normalised
// (`0203.0.113.9` -> `203.0.113.9`) because some proxies and clients emit
// zero-padded octets; if they were rejected they would fall through to the raw
// text and every padding width would buy a separate budget.
function parseIpv4(value) {
  if (!/^\d+(\.\d+){3}$/.test(value)) {
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
 * Map one address literal (no port, no zone) to its limiter key, or `null` when
 * the text is not a valid address.
 *
 * - IPv4 keys on the whole address (`0203.0.113.9` -> `203.0.113.9`).
 * - `::ffff:`-mapped IPv4 keys on the embedded IPv4 address, so the mapped and
 *   plain spellings of one host share one budget.
 * - Every other IPv6 address keys on its /64 prefix, so one machine cannot mint
 *   a new budget per interface identifier. (The deprecated IPv4-compatible
 *   forms `::a.b.c.d` are distinct addresses and get their own /64 key; every
 *   spelling of each still collapses to that one key.)
 */
function addressKey(value) {
  const quad = parseIpv4(value);
  if (quad) {
    return quad.join('.');
  }

  const words = parseIpv6(value);
  if (!words) {
    return null;
  }

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

/**
 * Key one host text, tolerating a scope/zone suffix (`fe80::1%eth0`, or the
 * percent-encoded `%25` form). The zone is link-local decoration, not part of
 * the identity, and leaving it in would let one host present several keys for
 * the same address. Returns `null` when no address can be recognised.
 */
function hostKey(text) {
  let value = text;
  const zoneAt = value.search(/%25|%/);

  if (zoneAt !== -1) {
    value = value.slice(0, zoneAt);
  }

  if (!value) {
    return null;
  }

  return addressKey(value);
}

/**
 * Reduce a client address to the key the limiter budgets against.
 *
 * The key space must be BOUNDED for any one real source: varying only the
 * textual spelling of an address must not mint additional buckets. A canonical
 * form that is merely "usually the same" is not a limit, because every extra
 * variant is extra budget and one caller can walk the whole bucket table with a
 * single address. Accordingly:
 *
 * - A trailing port is dropped from both bracketed hosts (`[::1]:443`) and
 *   unbracketed ones (`203.0.113.9:12345`, `::ffff:203.0.113.9:12345`). The port
 *   is never part of the identity: one address is one source whatever port it
 *   speaks from. An unbracketed string is parsed as an address FIRST, so a
 *   genuinely numeric final IPv6 group (`2001:db8::1:443`) stays an address.
 * - Case, surrounding whitespace, a zone suffix, bracket style, and
 *   leading-zero octets are all normalised away.
 * - IPv6 keys on its /64 and `::ffff:IPv4` on the embedded IPv4 address, as
 *   before.
 * - A missing address is ONE shared bucket (`unknown`) and text that is not a
 *   valid address is ONE shared bucket (`unparseable`). Neither keys on
 *   attacker-controlled text, so junk input can consume at most one table slot
 *   in total rather than one per distinct string.
 *
 * What this cannot bound: a source that presents a genuinely different valid
 * address each request (real OS-level rotation, or a proxy topology where the
 * caller controls the forwarded address). That is inherent to source-keyed
 * limiting; see the note in the file header.
 */
function canonicalizeSourceKey(raw) {
  if (typeof raw !== 'string') {
    return MISSING_SOURCE_KEY;
  }

  const value = raw.trim().toLowerCase();

  if (!value) {
    return MISSING_SOURCE_KEY;
  }

  // Bracketed form: the brackets delimit the host, so a trailing port is
  // unambiguous even for IPv6. (`[::1]:443`, `[fe80::1%eth0]:80`.)
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    return hostKey(bracketed[1]) || UNPARSEABLE_SOURCE_KEY;
  }

  // A stray bracket means this is not a host we can interpret; do not key on it.
  if (value.indexOf('[') !== -1 || value.indexOf(']') !== -1) {
    return UNPARSEABLE_SOURCE_KEY;
  }

  const direct = hostKey(value);
  if (direct) {
    return direct;
  }

  // Not an address on its own. A proxy may have forwarded `host:port`, which
  // would otherwise make the unbounded port space an unbounded budget space.
  const lastColon = value.lastIndexOf(':');
  if (lastColon !== -1 && /^\d*$/.test(value.slice(lastColon + 1))) {
    const withoutPort = hostKey(value.slice(0, lastColon));
    if (withoutPort) {
      return withoutPort;
    }
  }

  return UNPARSEABLE_SOURCE_KEY;
}

function defaultKeyGenerator(req) {
  if (!req) {
    return MISSING_SOURCE_KEY;
  }

  if (typeof req.ip === 'string' && req.ip) {
    return canonicalizeSourceKey(req.ip);
  }

  if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) {
    return canonicalizeSourceKey(req.socket.remoteAddress);
  }

  return MISSING_SOURCE_KEY;
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
