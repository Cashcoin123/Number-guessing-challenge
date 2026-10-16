const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../src/middleware/rateLimit');

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

// The TRUST_PROXY footgun (ISSUE-23 residual weakness c): when the app runs
// behind a reverse proxy with TRUST_PROXY unset, Express keys every caller to the
// proxy's own address, so all players share ONE budget. The limiter cannot fix
// the topology, but it must make the misconfiguration visible and must never
// change a request's outcome because of the warning.
test('diagnostic: X-Forwarded-For without TRUST_PROXY warns without changing outcomes', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));

  try {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, trustProxy: false });
    const res = fakeRes();
    let admitted = 0;

    // Spend the whole budget from a "proxied" request.
    for (let i = 0; i < 2; i += 1) {
      limiter(fakeReq('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), res, () => {
        admitted += 1;
      });
    }

    assert.equal(admitted, 2, 'the diagnostic must not block admitted traffic');
    assert.equal(warnings.length, 1, 'exactly one warning for the first proxied request');
    assert.match(warnings[0], /TRUST_PROXY/);

    // The warning is throttled: further proxied requests in the interval stay quiet.
    for (let i = 0; i < 5; i += 1) {
      limiter(fakeReq('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), fakeRes(), () => {});
    }
    assert.equal(warnings.length, 1, 'warnings must be throttled, not per request');

    // The limiter still behaves exactly as before: the third request is throttled.
    const over = fakeRes();
    let overNext = false;
    limiter(fakeReq('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), over, () => {
      overNext = true;
    });
    assert.equal(overNext, false);
    assert.equal(over.statusCode, 429);
  } finally {
    console.warn = original;
  }
});

test('diagnostic: no warning when TRUST_PROXY is enabled or no forwarded header is present', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));

  try {
    const trusted = createRateLimiter({ windowMs: 60_000, max: 2, trustProxy: true });
    trusted(fakeReq('10.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), fakeRes(), () => {});

    const untrusted = createRateLimiter({ windowMs: 60_000, max: 2, trustProxy: false });
    untrusted(fakeReq('10.0.0.1', {}), fakeRes(), () => {});

    assert.equal(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});
