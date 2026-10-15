const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../src/middleware/rateLimit');

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
