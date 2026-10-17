const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, canonicalizeSourceKey } = require('../src/middleware/rateLimit');

// Minimal Express-like req/res doubles: enough for the middleware's contract.
function fakeReq(ip, headers) {
  return { ip, headers: headers || {}, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const headers = {};
  return {
    statusCode: null,
    body: null,
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// ISSUE-23 residual (surviving after 16299fd): the limiter key space was still
// UNBOUNDED per real source. A canonical form that is merely "usually the same"
// is not a limit - every extra spelling of ONE address is extra budget, and one
// caller can walk the whole bucket table with a single address. These tests pin
// the key space to a bounded size per source.
// ---------------------------------------------------------------------------

test('every textual spelling of one IPv4 address collapses to one key', () => {
  // A proxy may forward `host:port`. The port is never part of the identity, so
  // the unbounded port space must not be an unbounded budget space.
  const ports = [
    '203.0.113.9',
    '203.0.113.9:10001',
    '203.0.113.9:10002',
    '203.0.113.9:0',
    '203.0.113.9:65535',
    '  203.0.113.9  ',
    '\t203.0.113.9',
    '[203.0.113.9]:44321',
  ];

  for (const spelling of ports) {
    assert.equal(
      canonicalizeSourceKey(spelling),
      '203.0.113.9',
      `${spelling} must key on the plain IPv4 address`
    );
  }

  // A `::ffff:`-mapped IPv4 address is the SAME source as the plain address,
  // with or without a trailing port.
  for (const spelling of [
    '::ffff:203.0.113.9',
    '::FFFF:203.0.113.9',
    '::ffff:203.0.113.9:10001',
    '::ffff:203.0.113.9:10002',
  ]) {
    assert.equal(
      canonicalizeSourceKey(spelling),
      '203.0.113.9',
      `${spelling} must key on the embedded IPv4 address`
    );
  }
});

test('zero-padded and octal-looking octets are the same source as the plain address', () => {
  // Some proxies and clients emit zero-padded octets. If these fell through to
  // the raw text, every padding width would buy a separate budget.
  for (const spelling of ['0203.0.113.9', '203.000.113.009', '0203.000.113.009']) {
    assert.equal(
      canonicalizeSourceKey(spelling),
      '203.0.113.9',
      `${spelling} must normalise to the plain IPv4 address`
    );
  }

  assert.equal(canonicalizeSourceKey('::ffff:0203.0.113.9'), '203.0.113.9');
});

test('text that is not a valid address is confined to a bounded bucket space', () => {
  // Junk must not key on the raw string: otherwise every distinct string a
  // caller invents consumes a bucket, and the fail-closed cap can be walked with
  // text instead of addresses.
  const junk = [
    'evil',
    'evil2',
    '<script>alert(1)</script>',
    '..',
    'x'.repeat(60),
    'nan',
    'undefined',
    'localhost',
    '203.0.113.9 jr',
    '203.0.113.9#1',
    'not-an-ip:abc',
    '[203.0.113.9',
    '203.0.113.9]',
    '[]',
    '[abc]',
    'a:b:c',
    'evil:1234',
  ];

  const keys = new Set(junk.map((value) => canonicalizeSourceKey(value)));

  assert.ok(
    keys.size <= 2,
    `unparseable text must share at most one bucket, saw ${keys.size} distinct keys: ${[...keys].join(', ')}`
  );
  assert.ok(!keys.has('203.0.113.9'), 'junk must never share a real source bucket');
});

test('bracketed and unbracketed IPv6 spellings still collapse to one /64 key', () => {
  const expected = canonicalizeSourceKey('2001:db8:1:2::5');
  assert.equal(expected, '2001:db8:1:2/64');

  for (const spelling of [
    '2001:DB8:1:2::5',
    '2001:0db8:0001:0002:0000:0000:0000:0005',
    '2001:db8:1:2::5%eth0',
    '2001:db8:1:2::5%25eth0',
    '[2001:db8:1:2::5]',
    '[2001:db8:1:2::5]:4321',
    '[2001:db8:1:2::5]:80',
    // A numeric final group is a valid address group, NOT a port to strip.
    '2001:db8:1:2::5:443',
    '[2001:db8:1:2::5:443]',
  ]) {
    assert.equal(
      canonicalizeSourceKey(spelling),
      expected,
      `${spelling} must key on the /64 prefix`
    );
  }
});

test('one source cannot multiply its budget by respelling its address through the limiter', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  const spellings = [
    '203.0.113.9',
    '203.0.113.9:10001',
    '203.0.113.9:10002',
    '0203.0.113.9',
    '::ffff:203.0.113.9',
    '::ffff:203.0.113.9:10003',
    '  203.0.113.9  ',
    '[203.0.113.9]:9000',
  ];

  const statuses = spellings.map((ip) => {
    const res = fakeRes();
    let nextCalled = false;
    limiter(fakeReq(ip), res, () => {
      nextCalled = true;
    });
    return { nextCalled, status: res.statusCode };
  });

  assert.deepEqual(
    statuses.map((s) => s.nextCalled),
    [true, true, true, false, false, false, false, false],
    'the whole spelling family must spend ONE budget of 3'
  );
  assert.deepEqual(
    statuses.slice(3).map((s) => s.status),
    [429, 429, 429, 429, 429],
    'spellings past the budget must be throttled'
  );
  assert.equal(limiter._trackedKeyCount(), 1, 'the family must occupy exactly one bucket');
});

test('junk text cannot consume the bucket table (bounded bucket growth per source)', () => {
  // With the cap deliberately tiny, a flood of DISTINCT junk strings from one
  // caller must not fill the table - otherwise junk alone can produce the
  // fail-closed over-capacity 429 for honest new sources.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5, maxTrackedKeys: 4 });

  for (let i = 0; i < 500; i += 1) {
    limiter(fakeReq(`junk-string-${i}`), fakeRes(), () => {});
  }

  assert.equal(
    limiter._trackedKeyCount(),
    1,
    'all unparseable text must share one bucket, however many distinct strings arrive'
  );

  // A real distinct source still has room, so honest play is not denied.
  const honest = fakeRes();
  let honestNext = false;
  limiter(fakeReq('198.51.100.7'), honest, () => {
    honestNext = true;
  });
  assert.equal(honestNext, true, 'an honest new source must still be admitted');
  assert.equal(limiter._trackedKeyCount(), 2);
});

test('bounded key space does not over-aggregate genuinely distinct sources', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

  // A different IPv4 is a different source.
  for (const ip of ['203.0.113.9', '203.0.113.9']) {
    limiter(fakeReq(ip), fakeRes(), () => {});
  }
  const otherIpv4 = fakeRes();
  let otherIpv4Next = false;
  limiter(fakeReq('198.51.100.7'), otherIpv4, () => {
    otherIpv4Next = true;
  });
  assert.equal(otherIpv4Next, true, 'a different IPv4 must keep its own budget');

  // A different IPv6 /64 is a different source, even with the same suffix.
  const otherSlash64 = fakeRes();
  let otherSlash64Next = false;
  limiter(fakeReq('2001:db8:1:3::9'), otherSlash64, () => {
    otherSlash64Next = true;
  });
  assert.equal(otherSlash64Next, true, 'a different /64 must keep its own budget');

  // ...while the same /64 with different suffixes shares ONE IPv6 budget: with
  // max 2, the third spelling of that /64 is throttled.
  const sameSlash64 = [
    '2001:db8:1:2::2',
    '2001:0db8:0001:0002::dead:beef',
    '2001:db8:1:2:ffff:ffff:ffff:ffff',
  ].map((ip) => {
    const res = fakeRes();
    let nextCalled = false;
    limiter(fakeReq(ip), res, () => {
      nextCalled = true;
    });
    return { ip, nextCalled, status: res.statusCode };
  });

  assert.deepEqual(
    sameSlash64.map((s) => s.nextCalled),
    [true, true, false],
    'all suffixes of one /64 must share a single budget'
  );
  assert.equal(sameSlash64[2].status, 429, 'the third spelling must be throttled');
});

test('the bounded key space preserves the existing 429 and fail-closed contracts', () => {
  // Per-source 429 contract is unchanged.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  limiter(fakeReq('203.0.113.9'), fakeRes(), () => {});
  const over = fakeRes();
  let overNext = false;
  limiter(fakeReq('203.0.113.9:12345'), over, () => {
    overNext = true;
  });

  assert.equal(overNext, false);
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.ok, false);
  assert.equal(over.body.retryable, true);
  assert.match(over.body.message, /Too many new rounds started from this source/);
  assert.ok(over.headers['retry-after'], 'a 429 must carry Retry-After');
  assert.equal(over.headers['x-ratelimit-limit'], '1');
  assert.equal(over.headers['x-ratelimit-remaining'], '0');

  // The cap still fails closed for a genuinely new source once the table is full.
  const capped = createRateLimiter({ windowMs: 60_000, max: 1, maxTrackedKeys: 2 });
  capped(fakeReq('203.0.113.9'), fakeRes(), () => {});
  capped(fakeReq('198.51.100.7'), fakeRes(), () => {});

  const refused = fakeRes();
  let refusedNext = false;
  capped(fakeReq('192.0.2.5'), refused, () => {
    refusedNext = true;
  });

  assert.equal(refusedNext, false, 'a new source must be refused once the table is full');
  assert.equal(refused.statusCode, 429);
  assert.match(refused.body.message, /Too many distinct sources are starting rounds right now/);
  assert.equal(refused.headers['x-ratelimit-remaining'], '0');
  assert.equal(capped._trackedKeyCount(), 2, 'the table must not grow past its cap');
});

test('the TRUST_PROXY diagnostic still never changes a request outcome', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));

  try {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, trustProxy: false });

    // A forwarded header that would be unparseable is still ignored entirely
    // when proxy trust is off: the socket address decides the bucket.
    const res = fakeRes();
    let nextCalled = false;
    limiter(fakeReq('10.0.0.1', { 'x-forwarded-for': 'junk-text' }), res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, 'the diagnostic must not block admitted traffic');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TRUST_PROXY/);
    assert.equal(limiter._trackedKeyCount(), 1);
  } finally {
    console.warn = original;
  }
});
