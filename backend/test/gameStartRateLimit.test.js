const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app, server } = require('../src/server');
const roundStore = require('../src/services/roundStore');
const gameRoutes = require('../src/routes/gameRoutes');

// Integration coverage through the REAL Express app: this is what proves the
// limiter is actually mounted on POST /api/game/start, not merely exported.
function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen() {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close() {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('POST /api/game/start is rate limited per source through the real route (ISSUE-23 residual)', async (t) => {
  const port = await listen();
  t.after(close);

  roundStore._resetForTests();
  gameRoutes.startLimiter._resetForTests();

  const limit = gameRoutes.startLimiter.max;
  assert.ok(Number.isInteger(limit) && limit > 0, 'limiter must expose a positive limit');

  const statuses = [];
  for (let i = 0; i < limit + 2; i += 1) {
    const res = await post(port, '/api/game/start');
    statuses.push(res.status);
  }

  const admitted = statuses.filter((code) => code === 200).length;
  const throttled = statuses.filter((code) => code === 429).length;

  assert.equal(admitted, limit, `exactly ${limit} rounds admitted, saw ${admitted}`);
  assert.equal(throttled, 2, `requests over the limit are throttled, saw ${throttled}`);

  // The throttled response must be an explicit, retryable signal - not a silent
  // failure and not a capacity (503) refusal.
  const over = await post(port, '/api/game/start');
  assert.equal(over.status, 429);
  assert.equal(over.body.ok, false);
  assert.equal(over.body.retryable, true);
  assert.ok(over.headers['retry-after'], 'a 429 must carry Retry-After');
  assert.equal(over.headers['x-ratelimit-limit'], String(limit));

  // Throttling must not have cost the store a round it should have kept.
  assert.equal(roundStore.getStoreStats().tracked, limit);
});

test('rate limiting round creation does not disturb in-flight play through the real route (ISSUE-23)', async (t) => {
  const port = await listen();
  t.after(close);

  roundStore._resetForTests();
  gameRoutes.startLimiter._resetForTests();

  // A player starts and plays a round.
  const started = await post(port, '/api/game/start');
  assert.equal(started.status, 200);
  const roundId = started.body.round.roundId;

  const firstGuess = await post(port, '/api/game/guess', { roundId, guess: 50 });
  assert.equal(firstGuess.status, 200);
  assert.equal(firstGuess.body.attempts, 1);

  // A single source now hammers round creation far past the limit.
  const limit = gameRoutes.startLimiter.max;
  const codes = [];
  for (let i = 0; i < limit * 3; i += 1) {
    const res = await post(port, '/api/game/start');
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), 'the flood must be throttled');
  assert.equal(codes.filter((code) => code === 503).length, 0, 'throttling must prevent a capacity 503');

  // The player's round is untouched and still resumable.
  const secondGuess = await post(port, '/api/game/guess', { roundId, guess: 51 });
  assert.equal(secondGuess.status, 200, 'in-flight round must survive the throttled flood');
  assert.equal(secondGuess.body.attempts, 2, 'attempt history must be preserved');
});
