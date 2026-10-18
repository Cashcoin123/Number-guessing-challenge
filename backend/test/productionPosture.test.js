const test = require('node:test');
const assert = require('node:assert/strict');

// These values must be set BEFORE the server module is required: the CORS
// allowlist and the round-creation limiter config are both read at module load.
//
// The point of this file is to assert the *deployed* posture, not unit-test an
// isolated middleware. Every security fix on this branch lives in middleware and
// route wiring, and the existing tests exercise those pieces in isolation. This
// file boots the real HTTP surface in a production-like configuration and proves
// the documented posture actually holds when the pieces are wired together.
//
// NODE_ENV=production and no ALLOW_DEV_AUTH is deliberate: the local-development
// identity bypass must be unreachable here, so the fail-closed path is what gets
// exercised.
process.env.NODE_ENV = 'production';
delete process.env.ALLOW_DEV_AUTH;
process.env.CLIENT_URL = 'https://app.example.com';
process.env.TRUST_PROXY = 'false';
process.env.ROUNDS_RATE_WINDOW_MS = '60000';
process.env.ROUNDS_RATE_MAX = '30';
process.env.USE_FIREBASE = 'false';
process.env.USE_POSTGRES = 'false';

const { server, io } = require('../src/server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // The production check must actually be in force, otherwise this whole file is
  // testing the development posture by accident.
  assert.equal(process.env.NODE_ENV, 'production');
  assert.equal(process.env.ALLOW_DEV_AUTH, undefined);
});

test.after(async () => {
  // Close Socket.IO first: it keeps the HTTP server's connections alive.
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

function post(path, body, headers) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('health reports liveness without disclosing authentication configuration', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);

  // ISSUE-2: the endpoint used to report the active auth mode to anonymous
  // callers. Nothing about auth configuration may appear in the payload.
  const serialised = JSON.stringify(body).toLowerCase();
  for (const leak of ['authmode', 'enable_auth', 'allow_dev_auth', 'firebase']) {
    assert.ok(
      !serialised.includes(leak),
      `health disclosed authentication configuration (${leak}): ${serialised}`
    );
  }
});

test('protected routes are fail-closed without a token in production', async () => {
  // ISSUE-1: the previous middleware failed open whenever ENABLE_AUTH was not
  // exactly "true". With no token these must be 401, never 200 or 403.
  const cases = [
    ['GET', '/api/users/someuid'],
    ['POST', '/api/game/bonus'],
    ['POST', '/api/users/register'],
    ['POST', '/api/chat/send'],
  ];

  for (const [method, path] of cases) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.equal(
      res.status,
      401,
      `${method} ${path} returned ${res.status} without a token; expected 401 (fail-closed)`
    );
  }
});

test('guest play still works and round start never discloses the secret', async () => {
  // Guests must be able to play - /api/game/start is open by design.
  const started = await post('/api/game/start');
  assert.equal(started.status, 200);

  const body = await started.json();
  assert.equal(body.ok, true);
  assert.ok(body.round && typeof body.round.roundId === 'string');

  // ISSUE-10: the secret number must never leave the server before resolution.
  assert.equal(
    body.round.secretNumber,
    undefined,
    'round start disclosed the secret number'
  );
  assert.ok(
    !JSON.stringify(body).includes('secretNumber'),
    `round start body mentioned the secret: ${JSON.stringify(body)}`
  );

  // Guess validation rejects out-of-range input and unknown rounds with the
  // documented status codes rather than 500s or silent acceptance.
  const outOfRange = await post('/api/game/guess', { roundId: body.round.roundId, guess: 0 });
  assert.equal(outOfRange.status, 400);

  const unknown = await post('/api/game/guess', { roundId: 'does-not-exist', guess: 50 });
  assert.equal(unknown.status, 404);

  // A caller-supplied secretNumber must be ignored entirely: the request is
  // still resolved against the server-held round, so an unknown id stays 404.
  const injected = await post('/api/game/guess', {
    roundId: 'does-not-exist',
    guess: 50,
    secretNumber: 50,
  });
  assert.equal(injected.status, 404);
});

test('malformed JSON is a clean 400 rather than a 500', async () => {
  const res = await fetch(`${base}/api/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('CORS does not reflect an origin outside CLIENT_URL', async () => {
  // ISSUE-5: the API previously reflected any origin. With CLIENT_URL set, a
  // foreign origin must not be echoed back in Access-Control-Allow-Origin.
  const foreign = await fetch(`${base}/api/game/start`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
    },
  });
  const reflected = foreign.headers.get('access-control-allow-origin');
  assert.ok(
    reflected !== 'https://attacker.example',
    `CORS reflected a foreign origin: ${reflected}`
  );

  // The configured origin must still be allowed, so the real frontend works.
  const allowed = await fetch(`${base}/api/game/start`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(
    allowed.headers.get('access-control-allow-origin'),
    'https://app.example.com'
  );
});

test('the round-creation rate limiter engages within its configured bound', async () => {
  // ISSUE-23 residual: /api/game/start is open to guests, so one source could
  // otherwise saturate the capped round store. Run last: it spends the budget
  // this same source has left in the window.
  let allowed = 0;
  let limitedAt = null;

  for (let i = 1; i <= 60; i += 1) {
    const res = await post('/api/game/start');
    if (res.status === 429) {
      limitedAt = i;

      // A throttled caller must be told when to retry, and the refusal must be
      // marked retryable so clients do not treat it as a permanent failure.
      assert.ok(res.headers.get('retry-after'), '429 omitted Retry-After');
      assert.equal(res.headers.get('x-ratelimit-limit'), '30');
      assert.equal(res.headers.get('x-ratelimit-remaining'), '0');

      const body = await res.json();
      assert.equal(body.retryable, true);
      break;
    }

    assert.equal(res.status, 200, `unexpected status ${res.status} at request ${i}`);
    allowed += 1;
  }

  assert.ok(limitedAt !== null, 'the rate limiter never engaged within 60 requests');

  // Honest play (a few rounds a minute) must never be throttled.
  assert.ok(allowed >= 20, `limiter engaged after only ${allowed} rounds`);
  // And it must not be effectively unlimited.
  assert.ok(allowed <= 35, `limiter allowed ${allowed} rounds in one window`);
});
