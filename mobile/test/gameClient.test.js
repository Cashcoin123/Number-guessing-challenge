// Behavioural tests for the mobile backend client.
//
// Run with `npm test` in mobile/ (node --test). src/gameClient.js has no React,
// React Native or Expo imports, so it loads under plain Node and the logic under
// test here is the same file the app bundles.
//
// The point of these tests is the two defects this change removes, so the
// assertions are written as invariants that a regression must break:
//
//   - no secret number can reach the UI before the server releases it;
//   - no number is ever computed on the client, so a payload the server did not
//     fully populate renders as unscored instead of as a plausible score.
//
// RESULT.md records the injected regressions and which test each one broke.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RESULTS,
  IDENTITY_MODES,
  TONES,
  UNREACHABLE_MESSAGE,
  UNREADABLE_MESSAGE,
  apiUrl,
  GUEST_SESSION,
  resolveApiBase,
  validateApiBase,
  normaliseRound,
  normaliseGuessOutcome,
  normaliseGlobalStats,
  normaliseLeaderboard,
  normaliseChatMessages,
  normaliseSession,
  playerTotalsFromOutcome,
  describeResult,
  describeFailure,
  formatSession,
  createGameClient,
} = require('../src/gameClient');

const BASE = 'http://api.test';

/**
 * A scripted fetch. `handler(url, options)` returns { status, body } or throws,
 * so transport failures, HTTP errors and malformed bodies are all expressible.
 */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const reply = await handler(url, options);
    if (reply instanceof Error) throw reply;

    const status = reply.status === undefined ? 200 : reply.status;
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(text),
    };
  };
  impl.calls = calls;
  return impl;
}

function gameClient(handler, extra = {}) {
  const fetchImpl = stubFetch(handler);
  return { client: createGameClient({ baseUrl: BASE, fetchImpl, ...extra }), fetchImpl };
}

const START_PAYLOAD = {
  ok: true,
  round: { roundId: 'round-1', maxAttempts: 10, startedAt: '2026-10-22T00:00:00.000Z' },
};

const WIN_SCORED = {
  ok: true,
  result: 'correct',
  attempts: 3,
  maxAttempts: 10,
  remaining: 7,
  secretNumber: 42,
  scored: true,
  awarded: 76,
  score: 96,
  bestScore: 120,
  streak: 2,
  newPersonalBest: false,
};

// ---------------------------------------------------------------------------
// The secret number lives on the server (ISSUE-10)
// ---------------------------------------------------------------------------

test('a started round carries no secret number at all', () => {
  const round = normaliseRound(START_PAYLOAD);

  assert.equal(round.roundId, 'round-1');
  assert.equal(round.maxAttempts, 10);
  // Structural, not stylistic: the view model has no field for a secret.
  assert.equal('secretNumber' in round, false);
  assert.deepEqual(Object.keys(round).sort(), ['maxAttempts', 'roundId', 'startedAt']);
});

test('a start payload that DOES smuggle a secret number is ignored', () => {
  const round = normaliseRound({
    ok: true,
    round: { roundId: 'r', maxAttempts: 10, secretNumber: 7, secret: 7, number: 7 },
  });

  assert.equal(round.secretNumber, undefined);
  assert.equal(JSON.stringify(round).includes('7,'), false);
});

test('an unfinished round never exposes a secret number even if one is sent', () => {
  // The server does not do this; the point is that such a payload cannot make
  // the client's UI display the answer mid-round.
  for (const result of [RESULTS.TOO_LOW, RESULTS.TOO_HIGH]) {
    const outcome = normaliseGuessOutcome({
      ok: true,
      result,
      attempts: 2,
      maxAttempts: 10,
      remaining: 8,
      secretNumber: 42,
    });
    assert.equal(outcome.secretNumber, null, `${result} must not expose the number`);
    assert.equal(outcome.finished, false);
  }
});

test('the secret number is only surfaced once the round is over', () => {
  const won = normaliseGuessOutcome(WIN_SCORED);
  assert.equal(won.secretNumber, 42);
  assert.equal(won.finished, true);

  const over = normaliseGuessOutcome({
    ok: true,
    result: RESULTS.ROUND_OVER,
    attempts: 10,
    maxAttempts: 10,
    remaining: 0,
    secretNumber: 42,
  });
  assert.equal(over.secretNumber, 42);
  assert.equal(over.finished, true);
});

test('a guess request sends only the round id and the guess', async () => {
  const { client, fetchImpl } = gameClient(() => ({ body: WIN_SCORED }));

  await client.submitGuess('round-1', 42);

  const sent = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(sent, { roundId: 'round-1', guess: 42 });
  // The client cannot name a uid, an attempt count or a secret, because the
  // body it builds has no room for them.
  assert.equal('uid' in sent, false);
  assert.equal('attempts' in sent, false);
  assert.equal('secretNumber' in sent, false);
});

// ---------------------------------------------------------------------------
// Points come from the server (ISSUE-24)
// ---------------------------------------------------------------------------

test('a scored win reports the server award and totals verbatim', () => {
  const outcome = normaliseGuessOutcome(WIN_SCORED);

  assert.equal(outcome.scored, true);
  assert.equal(outcome.awarded, 76);
  assert.equal(outcome.score, 96);
  assert.equal(outcome.bestScore, 120);
  assert.equal(outcome.streak, 2);
});

test('the client never recomputes the award from the attempt count', () => {
  // The real formula is max(20, 100 - attempts*8); here the server deliberately
  // reports a different number. A client that did the arithmetic would show 76.
  const outcome = normaliseGuessOutcome({
    ...WIN_SCORED,
    attempts: 3,
    awarded: 5,
    score: 5,
    bestScore: 5,
  });

  assert.equal(outcome.awarded, 5);
  const rendered = describeResult(outcome, { mode: IDENTITY_MODES.AUTHENTICATED });
  assert.match(rendered.detail, /awarded 5 points/);
  assert.doesNotMatch(rendered.detail, /76/);
});

test('an award the server did not send is absent, not invented', () => {
  // `scored: true` with no award fields is not a scoring event we can render.
  const outcome = normaliseGuessOutcome({
    ok: true,
    result: 'correct',
    attempts: 3,
    maxAttempts: 10,
    remaining: 7,
    secretNumber: 42,
    scored: true,
  });

  assert.equal(outcome.awarded, null);
  assert.equal(outcome.scored, false, 'a partial payload must not count as scored');
  assert.equal(playerTotalsFromOutcome(outcome), null);
});

test('an unscoreable payload still renders a win without claiming points', () => {
  const outcome = normaliseGuessOutcome({
    ok: true,
    result: 'correct',
    attempts: 3,
    maxAttempts: 10,
    remaining: 7,
    secretNumber: 42,
  });

  const rendered = describeResult(outcome, { mode: IDENTITY_MODES.AUTHENTICATED });
  assert.equal(rendered.tone, TONES.WIN);
  assert.match(rendered.detail, /did not record points/);
  assert.doesNotMatch(rendered.detail, /\d+ points/);
});

test('a guest win states plainly that no points were recorded', () => {
  const outcome = normaliseGuessOutcome({
    ok: true,
    result: 'correct',
    attempts: 5,
    maxAttempts: 10,
    remaining: 5,
    secretNumber: 42,
  });

  const rendered = describeResult(outcome, GUEST_SESSION);
  assert.equal(rendered.tone, TONES.WIN);
  assert.match(rendered.headline, /Correct/);
  assert.match(rendered.detail, /as a guest/);
  assert.match(rendered.detail, /No points were recorded/);
});

test('a lost round never claims points, even when the server sends awarded: 0', () => {
  const outcome = normaliseGuessOutcome({
    ok: true,
    result: RESULTS.ROUND_OVER,
    attempts: 10,
    maxAttempts: 10,
    remaining: 0,
    secretNumber: 42,
    scored: true,
    awarded: 0,
    score: 96,
    bestScore: 120,
    streak: 0,
  });

  const rendered = describeResult(outcome, { mode: IDENTITY_MODES.AUTHENTICATED });
  assert.equal(rendered.tone, TONES.LOSS);
  assert.match(rendered.detail, /recorded 0 points/);
  assert.match(rendered.detail, /streak 0/);
  assert.match(rendered.headline, /42/);
});

test('a guest can never be shown a stored total', () => {
  const guestOutcome = normaliseGuessOutcome({
    ok: true,
    result: 'correct',
    attempts: 4,
    maxAttempts: 10,
    remaining: 6,
    secretNumber: 42,
  });

  assert.equal(playerTotalsFromOutcome(guestOutcome), null);

  // And a guest session object has no totals to display either.
  assert.deepEqual(Object.keys(GUEST_SESSION), ['mode']);
  assert.match(formatSession(GUEST_SESSION), /no points are recorded/);
});

test('server totals are passed through untouched for display', () => {
  const totals = playerTotalsFromOutcome(normaliseGuessOutcome(WIN_SCORED));
  assert.deepEqual(totals, { score: 96, bestScore: 120, streak: 2 });
  assert.match(
    formatSession({ mode: IDENTITY_MODES.AUTHENTICATED, ...totals }),
    /Score 96, best 120, streak 2/
  );
});

// ---------------------------------------------------------------------------
// Request shape and transport
// ---------------------------------------------------------------------------

test('every request goes to the configured base and the documented path', async () => {
  const { client, fetchImpl } = gameClient((url) => {
    if (url.endsWith('/api/game/start')) return { body: START_PAYLOAD };
    if (url.endsWith('/api/game/stats')) {
      return { body: { ok: true, stats: { bestScore: 5, streak: 1, totalGames: 9 } } };
    }
    if (url.endsWith('/api/leaderboard')) return { body: { ok: true, leaderboard: [] } };
    if (url.endsWith('/api/chat/messages')) return { body: { ok: true, messages: [] } };
    return { body: { ok: true, score: 0, bestScore: 0, streak: 0 } };
  });

  await client.startRound();
  await client.getGlobalStats();
  await client.getLeaderboard();
  await client.getChatMessages();
  await client.getSession();

  const paths = fetchImpl.calls.map((call) => call.url.replace(BASE, ''));
  assert.deepEqual(paths, [
    '/api/game/start',
    '/api/game/stats',
    '/api/leaderboard',
    '/api/chat/messages',
    '/api/game/bonus',
  ]);

  // The assertions above deliberately strip the base, so on their own they also
  // pass when the base is IGNORED (a relative '/api/game/start' strips to itself).
  // This was a real vacuum found by injecting the "ignore the configured base"
  // regression: every URL must actually begin with the configured base.
  for (const call of fetchImpl.calls) {
    assert.ok(
      call.url.startsWith(`${BASE}/api/`),
      `request URL ${call.url} does not start with the configured base ${BASE}`
    );
  }
});

test('a same-origin web base produces relative URLs', async () => {
  const fetchImpl = stubFetch(() => ({ body: START_PAYLOAD }));
  const client = createGameClient({ baseUrl: '', fetchImpl });

  await client.startRound();
  assert.equal(fetchImpl.calls[0].url, '/api/game/start');
});

test('a configured base is actually applied to the request URL', () => {
  // Direct, non-stripping assertion on the URL builder itself.
  assert.equal(apiUrl('http://api.test', '/api/game/start'), 'http://api.test/api/game/start');
  assert.equal(apiUrl('', '/api/game/start'), '/api/game/start');
  // A base with a path prefix is honoured rather than discarded.
  assert.equal(apiUrl('https://example.com/game', '/api/leaderboard'), 'https://example.com/game/api/leaderboard');
});

test('an identity token is sent as a bearer header, and omitted without one', async () => {
  const withToken = gameClient(() => ({ body: START_PAYLOAD }), { token: 'dev-token-abc' });
  await withToken.client.startRound();
  assert.equal(withToken.fetchImpl.calls[0].options.headers.authorization, 'Bearer dev-token-abc');

  const withoutToken = gameClient(() => ({ body: START_PAYLOAD }));
  await withoutToken.client.startRound();
  assert.equal('authorization' in withoutToken.fetchImpl.calls[0].options.headers, false);
});

test('an unreachable server is reported as unreachable, never as a game', async () => {
  const { client } = gameClient(() => new Error('ECONNREFUSED'));

  const result = await client.startRound();
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transport');

  const rendered = describeFailure(result);
  assert.equal(rendered.headline, UNREACHABLE_MESSAGE);
  assert.match(rendered.headline, /server cannot be reached/);
  assert.equal(rendered.tone, TONES.ERROR);
});

test('a missing fetch implementation degrades instead of throwing', async () => {
  const client = createGameClient({ baseUrl: BASE, fetchImpl: null });
  const result = await client.startRound();

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transport');
  assert.equal(describeFailure(result).headline, UNREACHABLE_MESSAGE);
});

test('a server error surfaces its own message and keeps retryable distinct', async () => {
  const { client } = gameClient(() => ({
    status: 503,
    body: { ok: false, message: 'The game is at capacity right now.', retryable: true },
  }));

  const result = await client.startRound();
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'http');
  assert.equal(result.status, 503);
  assert.equal(result.retryable, true);

  const rendered = describeFailure(result);
  assert.match(rendered.headline, /capacity/);
  assert.match(rendered.detail, /retryable/);
});

test('an unreadable body is reported as unreadable, not as a scored round', async () => {
  const { client } = gameClient(() => ({ body: 'not json at all' }));

  const result = await client.submitGuess('round-1', 50);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'malformed');
  assert.equal(describeFailure(result).headline, UNREADABLE_MESSAGE);
});

test('a 200 with ok:false is treated as a failure', async () => {
  const { client } = gameClient(() => ({ status: 200, body: { ok: false, message: 'nope' } }));

  const result = await client.startRound();
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'malformed');
});

test('an unknown result vocabulary is rejected rather than rendered', async () => {
  const { client } = gameClient(() => ({
    body: { ok: true, result: 'you-definitely-won', attempts: 1, maxAttempts: 10, remaining: 9 },
  }));

  const result = await client.submitGuess('round-1', 5);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'malformed');
});

test('a start payload without a round id is rejected', () => {
  assert.equal(normaliseRound({ ok: true, round: { maxAttempts: 10 } }), null);
  assert.equal(normaliseRound({ ok: true, round: { roundId: 'r', maxAttempts: 'ten' } }), null);
  assert.equal(normaliseRound({ ok: true, round: { roundId: '   ', maxAttempts: 10 } }), null);
});

// ---------------------------------------------------------------------------
// Identity: the server decides, not the client
// ---------------------------------------------------------------------------

test('a 401 on the session probe means guest, and guest is a success', async () => {
  const { client } = gameClient(() => ({
    status: 401,
    body: { ok: false, message: 'Authentication required.' },
  }));

  const result = await client.getSession();
  assert.equal(result.ok, true);
  assert.equal(result.session.mode, IDENTITY_MODES.GUEST);
});

test('an authenticated session carries the server totals', async () => {
  const { client } = gameClient(() => ({
    body: {
      ok: true,
      available: false,
      bonus: 50,
      nextAvailableAt: 1695916800000,
      score: 250,
      bestScore: 400,
      streak: 3,
    },
  }));

  const result = await client.getSession();
  assert.equal(result.ok, true);
  assert.equal(result.session.mode, IDENTITY_MODES.AUTHENTICATED);
  assert.equal(result.session.score, 250);
  assert.equal(result.session.bestScore, 400);
  assert.equal(result.session.streak, 3);
  assert.equal(result.session.bonusAvailable, false);
});

test('an unreachable server during the session probe is fatal, not "guest"', async () => {
  const { client } = gameClient(() => new Error('network down'));

  const result = await client.getSession();
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'transport');
  // A guest verdict here would let the app play a round it cannot score.
  assert.notEqual(result.session, GUEST_SESSION);
});

test('a malformed session body does not become a guest session', async () => {
  const { client } = gameClient(() => ({ body: { ok: true, score: 'lots' } }));
  const result = await client.getSession();

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'malformed');
});

// ---------------------------------------------------------------------------
// Bonus: server-authoritative credit
// ---------------------------------------------------------------------------

test('a granted bonus renders the server post-credit totals', async () => {
  const { client } = gameClient(() => ({
    body: {
      ok: true,
      granted: true,
      bonus: 50,
      score: 300,
      bestScore: 400,
      streak: 3,
      nextAvailableAt: 1695916800000,
    },
  }));

  const result = await client.claimBonus();
  assert.equal(result.ok, true);
  assert.equal(result.granted, true);
  assert.equal(result.bonus, 50);
  assert.deepEqual(
    { score: result.session.score, bestScore: result.session.bestScore, streak: result.session.streak },
    { score: 300, bestScore: 400, streak: 3 }
  );
});

test('a not-due bonus still reports stored totals and adds nothing', async () => {
  const { client } = gameClient(() => ({
    body: { ok: true, granted: false, bonus: 0, score: 250, bestScore: 400, streak: 3 },
  }));

  const result = await client.claimBonus();
  assert.equal(result.ok, true);
  assert.equal(result.granted, false);
  assert.equal(result.session.score, 250);
});

test('a bonus response without totals is not rendered as a credit', async () => {
  const { client } = gameClient(() => ({ body: { ok: true, granted: true, bonus: 50 } }));
  const result = await client.claimBonus();

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'malformed');
});

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

test('leaderboard rows are read from the server and bounded', () => {
  const rows = normaliseLeaderboard({
    ok: true,
    leaderboard: [
      { rank: 1, username: 'A', bestScore: 500, streak: 3, messagesSent: 2 },
      { rank: 2, username: 'B', bestScore: 400, streak: 1, messagesSent: 0 },
      { rank: 3, username: 'C', bestScore: 300, streak: 0, messagesSent: 0 },
      { rank: 4, username: 'D', bestScore: 200, streak: 0, messagesSent: 0 },
      { rank: 5, username: 'E', bestScore: 100, streak: 0, messagesSent: 0 },
      { rank: 6, username: 'F', bestScore: 50, streak: 0, messagesSent: 0 },
    ],
  });

  assert.equal(rows.length, 5);
  assert.equal(rows[0].username, 'A');
  assert.equal(rows[0].bestScore, 500);
});

test('malformed leaderboard and chat payloads degrade to empty, not to junk rows', () => {
  assert.deepEqual(normaliseLeaderboard({ ok: true, leaderboard: 'nope' }), []);
  assert.deepEqual(normaliseLeaderboard({ ok: true, leaderboard: [{ username: '', bestScore: 5 }] }), []);
  assert.deepEqual(normaliseChatMessages({ ok: true, messages: {} }), []);
  assert.deepEqual(normaliseChatMessages({ ok: true, messages: [{ message: '  ' }] }), []);
});

test('global stats are parsed from the documented shape', () => {
  assert.deepEqual(
    normaliseGlobalStats({ ok: true, stats: { bestScore: 1200, streak: 5, totalGames: 42 } }),
    { bestScore: 1200, streak: 5, totalGames: 42 }
  );
  assert.equal(normaliseGlobalStats({ ok: true, stats: { bestScore: 1 } }), null);
});

// ---------------------------------------------------------------------------
// API base resolution
// ---------------------------------------------------------------------------

test('an invalid API base is rejected with a reason, never used', () => {
  assert.match(validateApiBase('not a url'), /not a valid URL/);
  assert.match(validateApiBase('ftp://example.com'), /http/);
  assert.match(validateApiBase('https://user:pw@example.com'), /credentials/);
  assert.match(validateApiBase('https://example.com/?a=1'), /query/);
  assert.equal(validateApiBase('https://api.example.com'), null);
  assert.equal(validateApiBase('http://127.0.0.1:5000'), null);
});

test('expo.extra wins over the environment, and a trailing slash is normalised', () => {
  const resolved = resolveApiBase({
    extraUrl: 'https://api.example.com/',
    envUrl: 'https://env.example.com',
    platform: 'native',
  });

  assert.equal(resolved.base, 'https://api.example.com');
  assert.equal(resolved.source, 'app.json expo.extra.apiUrl');
  assert.equal(resolved.error, null);
});

test('the environment is used when app.json has no address', () => {
  const resolved = resolveApiBase({
    extraUrl: '',
    envUrl: 'https://env.example.com',
    platform: 'native',
  });

  assert.equal(resolved.base, 'https://env.example.com');
  assert.equal(resolved.source, 'EXPO_PUBLIC_API_URL');
});

test('a native build with no configured address says so rather than guessing', () => {
  const resolved = resolveApiBase({ extraUrl: '', envUrl: '', platform: 'native' });

  assert.equal(resolved.base, null);
  assert.match(resolved.error, /No API address is configured/);
});

test('web with no configured address uses its own origin', () => {
  const resolved = resolveApiBase({ extraUrl: '', envUrl: '', platform: 'web' });

  assert.equal(resolved.base, '');
  assert.equal(resolved.error, null);
});
