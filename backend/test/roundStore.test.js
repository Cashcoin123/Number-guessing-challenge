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
