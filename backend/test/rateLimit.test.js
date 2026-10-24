const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, canonicalizeSourceKey } = require('../src/middleware/rateLimit');

// Minimal Express-like req/res doubles: enough for the middleware's contract.
function fakeReq(ip) {
  return { ip, socket: { remoteAddress: ip } };
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

test('rate limiter admits up to the limit then rejects with a retryable 429', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  const decisions = [];

  for (let i = 0; i < 5; i += 1) {
    const req = fakeReq('10.0.0.1');
    const res = fakeRes();
    let nextCalled = false;
    limiter(req, res, () => {
      nextCalled = true;
    });
    decisions.push({ nextCalled, status: res.statusCode, body: res.body, headers: res.headers });
  }

  assert.equal(decisions[0].nextCalled, true);
  assert.equal(decisions[1].nextCalled, true);
  assert.equal(decisions[2].nextCalled, true);

  // Over the limit: no next(), a 429, and an explicit retry hint.
  assert.equal(decisions[3].nextCalled, false);
  assert.equal(decisions[3].status, 429);
  assert.equal(decisions[3].body.ok, false);
  assert.equal(decisions[3].body.retryable, true);
  assert.equal(decisions[3].headers['retry-after'], '1');
  assert.equal(decisions[4].status, 429);

  // The first request advertised the budget, and it decrements per request.
  assert.equal(decisions[0].headers['x-ratelimit-limit'], '3');
  assert.equal(decisions[2].headers['x-ratelimit-remaining'], '0');
  assert.equal(decisions[3].headers['x-ratelimit-remaining'], '0');
});

test('rate limiter gives each source its own bucket', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });

  const first = fakeRes();
  let firstNext = false;
  limiter(fakeReq('10.0.0.1'), first, () => {
    firstNext = true;
  });

  // A different source is unaffected by the first source's spend.
  const second = fakeRes();
  let secondNext = false;
  limiter(fakeReq('10.0.0.2'), second, () => {
    secondNext = true;
  });

  assert.equal(firstNext, true);
  assert.equal(secondNext, true);
  assert.equal(limiter._trackedKeyCount(), 2);
});

test('rate limiter budgets reset after the window elapses', async () => {
  const limiter = createRateLimiter({ windowMs: 60, max: 1 });

  const first = fakeRes();
  let firstNext = false;
  limiter(fakeReq('10.0.0.9'), first, () => {
    firstNext = true;
  });
  assert.equal(firstNext, true);

  const blocked = fakeRes();
  let blockedNext = false;
  limiter(fakeReq('10.0.0.9'), blocked, () => {
    blockedNext = true;
  });
  assert.equal(blockedNext, false);
  assert.equal(blocked.statusCode, 429);

  await new Promise((resolve) => setTimeout(resolve, 80));

  const afterWindow = fakeRes();
  let afterWindowNext = false;
  limiter(fakeReq('10.0.0.9'), afterWindow, () => {
    afterWindowNext = true;
  });
  assert.equal(afterWindowNext, true, 'a new window must admit the source again');
});

test('rate limiter table is hard-capped so rotating sources cannot grow it without bound', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

  for (let i = 0; i < 12_000; i += 1) {
    limiter(fakeReq(`10.1.${Math.floor(i / 256)}.${i % 256}`), fakeRes(), () => {});
  }

  const tracked = limiter._trackedKeyCount();
  assert.ok(tracked <= 10_000, `tracked keys must stay capped, saw ${tracked}`);
});

test('a full bucket table fails closed: new sources are refused, not served by evicting a live bucket', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, maxTrackedKeys: 2 });

  for (const ip of ['10.0.0.1', '10.0.0.2']) {
    limiter(fakeReq(ip), fakeRes(), () => {});
  }
  assert.equal(limiter._trackedKeyCount(), 2);

  // The table is full and nothing has expired: the third source must be refused
  // rather than causing a live bucket to be dropped.
  const refused = fakeRes();
  let refusedNext = false;
  limiter(fakeReq('10.0.0.3'), refused, () => {
    refusedNext = true;
  });

  assert.equal(refusedNext, false, 'a new source must not be admitted once the table is full');
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.retryable, true);
  assert.ok(refused.headers['retry-after'], 'a table-full refusal must carry Retry-After');
  assert.equal(limiter._trackedKeyCount(), 2, 'the table must not grow past its cap');

  // Existing sources keep their own accounting unchanged.
  const stillTracked = fakeRes();
  let stillTrackedNext = false;
  limiter(fakeReq('10.0.0.1'), stillTracked, () => {
    stillTrackedNext = true;
  });
  assert.equal(stillTrackedNext, false);
  assert.equal(stillTracked.statusCode, 429, 'an exhausted source stays exhausted');
});

test('equivalent textual forms of one address collapse to a single key', () => {
  // IPv4 keeps the whole address.
  assert.equal(canonicalizeSourceKey('203.0.113.9'), '203.0.113.9');
  assert.equal(canonicalizeSourceKey('  203.0.113.9  '), '203.0.113.9');
  assert.equal(canonicalizeSourceKey('[203.0.113.9]:44321'), '203.0.113.9');

  // An IPv4-mapped IPv6 address is the SAME source as the plain IPv4 address,
  // otherwise `::ffff:203.0.113.9` would be a free second budget.
  assert.equal(canonicalizeSourceKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(canonicalizeSourceKey('::FFFF:203.0.113.9'), '203.0.113.9');

  // Compressed vs fully expanded, and upper vs lower case, are one source.
  const short = canonicalizeSourceKey('2001:db8::1');
  assert.equal(short, '2001:db8:0:0/64');
  assert.equal(canonicalizeSourceKey('2001:0db8:0000:0000:0000:0000:0000:0001'), short);
  assert.equal(canonicalizeSourceKey('2001:DB8::1'), short);
  assert.equal(canonicalizeSourceKey('[2001:db8::1]:5000'), short);

  // A missing address fails closed into one shared bucket.
  assert.equal(canonicalizeSourceKey(undefined), 'unknown');
  assert.equal(canonicalizeSourceKey(''), 'unknown');
  assert.equal(canonicalizeSourceKey(null), 'unknown');
});

test('IPv6 sources are aggregated by /64 so one host cannot mint a budget per suffix', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

  // 2001:db8:1:2::/64 is one delegated network: the first two creates spend the
  // budget and the rest are throttled, even though every suffix differs.
  const suffixes = [
    '2001:db8:1:2::1',
    '2001:db8:1:2::dead:beef',
    '2001:0db8:0001:0002:0000:0000:0000:0001',
    '2001:db8:1:2:ffff:ffff:ffff:ffff',
  ];

  const statuses = suffixes.map((ip) => {
    const res = fakeRes();
    limiter(fakeReq(ip), res, () => {});
    return res.statusCode;
  });

  assert.deepEqual(statuses, [null, null, 429, 429]);
  assert.equal(limiter._trackedKeyCount(), 1, 'all /64 variants share one bucket');

  // A genuinely different /64 is unaffected.
  const other = fakeRes();
  let otherNext = false;
  limiter(fakeReq('2001:db8:1:3::1'), other, () => {
    otherNext = true;
  });
  assert.equal(otherNext, true);
  assert.equal(limiter._trackedKeyCount(), 2);
});

test('an exhausted source cannot regain a fresh budget while its window is live', async () => {
  const limiter = createRateLimiter({ windowMs: 200, max: 1, maxTrackedKeys: 3 });

  // Exhaust one source, then fill the remaining room with other sources.
  limiter(fakeReq('10.0.0.1'), fakeRes(), () => {});
  limiter(fakeReq('10.0.0.1'), fakeRes(), () => {});
  limiter(fakeReq('10.0.0.2'), fakeRes(), () => {});
  limiter(fakeReq('10.0.0.3'), fakeRes(), () => {});

  // Repeated attempts from the exhausted source must not evict its own bucket
  // (or anyone else's) to buy it a new budget.
  for (let i = 0; i < 5; i += 1) {
    const res = fakeRes();
    let nextCalled = false;
    limiter(fakeReq('10.0.0.1'), res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false, 'exhausted source must stay throttled');
    assert.equal(res.statusCode, 429);
  }

  assert.equal(limiter._trackedKeyCount(), 3);

  // After the window, capacity is genuinely reclaimed and the source is admitted.
  await new Promise((resolve) => setTimeout(resolve, 260));
  const afterWindow = fakeRes();
  let afterWindowNext = false;
  limiter(fakeReq('10.0.0.4'), afterWindow, () => {
    afterWindowNext = true;
  });
  assert.equal(afterWindowNext, true, 'expired buckets must be reclaimed so new sources can be admitted');
});
