const test = require('node:test');
const assert = require('node:assert/strict');

const roundStore = require('../src/services/roundStore');
const { parseIntegerInRange, normaliseMessage, normaliseUsername } = require('../src/utils/helpers');

test('guess helper rejects non-integers and out-of-range values', () => {
  assert.equal(parseIntegerInRange('50', 1, 100), 50);
  assert.equal(parseIntegerInRange(50, 1, 100), 50);
  assert.equal(parseIntegerInRange('abc', 1, 100), null);
  assert.equal(parseIntegerInRange(0, 1, 100), null);
  assert.equal(parseIntegerInRange(101, 1, 100), null);
  assert.equal(parseIntegerInRange(1.5, 1, 100), null);
  assert.equal(parseIntegerInRange(null, 1, 100), null);
  assert.equal(parseIntegerInRange(undefined, 1, 100), null);
  // The important regression: a string that is numerically equal to the secret
  // must not be coerced into a "correct" answer by the client.
  assert.equal(parseIntegerInRange('42abc', 1, 100), null);
});

test('message/username normalisation bounds input', () => {
  assert.equal(normaliseMessage('  hello  '), 'hello');
  assert.equal(normaliseMessage('   '), null);
  assert.equal(normaliseMessage(123), null);
  assert.equal(normaliseMessage('x'.repeat(500)).length, 280);

  assert.equal(normaliseUsername('  Player  One '), 'Player One');
  assert.equal(normaliseUsername('   '), null);
  assert.equal(normaliseUsername(null), null);
});

test('server-side rounds never expose the secret before resolution', () => {
  roundStore._resetForTests();
  const round = roundStore.createRound();

  assert.equal(typeof round.roundId, 'string');
  assert.equal(round.maxAttempts, 10);
  assert.equal(Object.prototype.hasOwnProperty.call(round, 'secretNumber'), false);

  // Guessing against the round is server-authoritative; the client cannot pass a
  // secret. A bounded search will always converge within maxAttempts.
  let outcome = null;
  let treatedAsUnknown = false;
  for (let guess = 1; guess <= 100 && !outcome; guess += 1) {
    const result = roundStore.submitGuess(round.roundId, guess);
    assert.ok(result, 'round should remain resolvable');
    if (result.result === 'correct') {
      outcome = result;
      assert.equal(guess, result.secretNumber);
      assert.ok(result.secretNumber >= 1 && result.secretNumber <= 100);
    } else if (result.result === 'round-over') {
      assert.ok(result.secretNumber >= 1 && result.secretNumber <= 100);
      treatedAsUnknown = true;
      break;
    }
  }

  assert.ok(outcome || treatedAsUnknown, 'round must resolve as correct or round-over');
});

test('unknown round ids are rejected', () => {
  roundStore._resetForTests();
  assert.equal(roundStore.submitGuess('does-not-exist', 10), null);
});

const { resolveDisplayName } = require('../src/utils/helpers');

// ISSUE-22 regression: a decoded Firebase ID token carries no username/name
// claim, so the identity email must never become the public display name.
test('display names never fall back to the identity email', () => {
  const decodedIdToken = {
    uid: 'USER1',
    email: 'kyle@example.com',
    email_verified: true,
    auth_time: 1750000000,
    iat: 1750000000,
    exp: 1750003600,
    firebase: { sign_in_provider: 'password' },
  };

  const name = resolveDisplayName(decodedIdToken);
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0);
  assert.ok(!name.includes('@'), 'display name must not be an email address');
  assert.notEqual(name, decodedIdToken.email);
  assert.ok(name.startsWith('Player-'), 'pseudonym should be uid-derived');
  // Stable across calls so a player keeps one handle.
  assert.equal(resolveDisplayName(decodedIdToken), name);
});

test('display names prefer an explicit handle and never leak email', () => {
  assert.equal(resolveDisplayName({ username: '  Neo  ', email: 'a@b.c' }), 'Neo');
  assert.equal(resolveDisplayName({ name: 'Player One', email: 'a@b.c' }), 'Player One');
  assert.equal(resolveDisplayName({ displayName: 'Ada', email: 'a@b.c' }), 'Ada');
  assert.equal(resolveDisplayName(null), 'Player');
  assert.equal(resolveDisplayName({}), 'Player');
  assert.equal(resolveDisplayName({ email: 'a@b.c' }).includes('@'), false);
});

// ---------------------------------------------------------------------------
// ISSUE-23 regression: capacity pressure from the unauthenticated
// POST /api/game/start must never terminate a round a player is still playing.
// ---------------------------------------------------------------------------
const MAX_TRACKED_ROUNDS = roundStore.MAX_TRACKED_ROUNDS;

test('capacity pressure never destroys an in-flight round (ISSUE-23)', () => {
  roundStore._resetForTests();

  const victim = roundStore.createRound();
  const first = roundStore.submitGuess(victim.roundId, 50);
  assert.ok(first, 'victim round must be playable');
  assert.equal(first.attempts, 1);

  // The attacker floods the store exactly the way an anonymous caller floods
  // /api/game/start.
  let refused = 0;
  for (let i = 0; i < MAX_TRACKED_ROUNDS * 3; i += 1) {
    if (roundStore.createRound() === null) refused += 1;
  }

  assert.ok(refused > 0, 'the store must refuse new rounds when live rounds fill it');

  // The regression: the victim is still mid-round and can still play.
  const second = roundStore.submitGuess(victim.roundId, 51);
  assert.ok(second, 'in-flight round must survive a flood of anonymous rounds');
  assert.equal(second.attempts, 2, 'the victim\'s own attempt history is preserved');
});

test('the store never exceeds its cap while refusing new rounds (ISSUE-23)', () => {
  roundStore._resetForTests();

  for (let i = 0; i < MAX_TRACKED_ROUNDS; i += 1) {
    assert.ok(roundStore.createRound(), 'rounds below the cap must be admitted');
  }

  assert.equal(roundStore.createRound(), null, 'a full store of live rounds refuses new rounds');
  assert.equal(roundStore.getStoreStats().tracked, MAX_TRACKED_ROUNDS, 'cap is respected');
});

test('finished rounds are reclaimed before new rounds are refused (ISSUE-23)', () => {
  roundStore._resetForTests();

  const live = roundStore.createRound();

  // Fill the rest of the store with rounds that are already over (maxAttempts=1
  // resolves on the first guess), i.e. memory a player can no longer need.
  const finished = [];
  for (let i = 0; i < MAX_TRACKED_ROUNDS - 1; i += 1) {
    finished.push(roundStore.createRound({ maxAttempts: 1 }));
  }
  finished.forEach((round) => roundStore.submitGuess(round.roundId, 1));

  // Capacity is reclaimed from finished rounds, so the live round is untouched.
  assert.ok(roundStore.createRound(), 'a finished round should be reclaimed for capacity');
  const stillLive = roundStore.submitGuess(live.roundId, 50);
  assert.ok(stillLive, 'the live round must not be reclaimed');
  assert.equal(stillLive.attempts, 1);
});

test('an idle round is reclaimable, an actively played one is not (ISSUE-23)', () => {
  const script = `
    process.env.ROUND_IDLE_TTL_MS = '150';
    const store = require('./src/services/roundStore');
    store._resetForTests();
    const idle = store.createRound();
    const active = store.createRound();
    // Keep 'active' in use with intervals shorter than the idle TTL, and never
    // touch 'idle'.
    setTimeout(() => store.submitGuess(active.roundId, 50), 60);
    setTimeout(() => store.submitGuess(active.roundId, 51), 120);
    setTimeout(() => {
      const idleReclaimed = store.submitGuess(idle.roundId, 50) === null;
      const activeResumed = store.submitGuess(active.roundId, 52) !== null;
      console.log(JSON.stringify({ idleReclaimed, activeResumed }));
    }, 200);
  `;

  const output = require('node:child_process').execFileSync('node', ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env },
    encoding: 'utf8',
  });

  const result = JSON.parse(output.trim().split('\n').pop());
  assert.equal(result.idleReclaimed, true, 'an idle round must become reclaimable');
  assert.equal(result.activeResumed, true, 'a round still being played must survive');
});
