const crypto = require('crypto');

// Server-side game rounds. The secret number never leaves the process, so the
// client can no longer supply it and win by construction (ISSUE-10).
//
// Rounds are intentionally kept in memory: they are short-lived play sessions,
// and keeping them out of the JSON storage layer avoids whole-file
// read-modify-write races between concurrent players.
//
// Capacity policy (ISSUE-23): this store is reachable through the unauthenticated
// POST /api/game/start, so an anonymous caller can create rounds far faster than
// players finish them. Reclaiming memory must therefore never destroy a round a
// player is still playing: a round only becomes reclaimable once it is finished,
// has hit its hard TTL, or has been idle for the idle TTL. When live rounds
// alone saturate the cap the store refuses new rounds instead of evicting them.
// The previous "hard cap" dropped the oldest-inserted entries, which are exactly
// the rounds of players who are mid-game.

const DEFAULT_MAX_ATTEMPTS = 10;
const ROUND_TTL_MS = 30 * 60 * 1000; // hard limit: a round never outlives this
const ROUND_IDLE_TTL_MS = Number(process.env.ROUND_IDLE_TTL_MS) > 0
  ? Number(process.env.ROUND_IDLE_TTL_MS)
  : 30 * 60 * 1000; // idle limit: reclaimed only after this long without a guess
const MAX_TRACKED_ROUNDS = 10000;

const rounds = new Map();

function hasExpired(round, now) {
  if (now - round.startedAtMs > ROUND_TTL_MS) {
    return true;
  }

  const lastUsed = Number.isFinite(round.lastUsedAtMs) ? round.lastUsedAtMs : round.startedAtMs;
  return now - lastUsed > ROUND_IDLE_TTL_MS;
}

// A round may only be reclaimed for capacity once it can no longer be resumed by
// its player.
function isReclaimable(round, now) {
  return Boolean(round.finished) || hasExpired(round, now);
}

function sweepExpired(now) {
  for (const [id, round] of rounds) {
    if (hasExpired(round, now)) {
      rounds.delete(id);
    }
  }
}

// Free capacity using only rounds their player can no longer be playing, oldest
// first. Returns the number of rounds reclaimed.
function reclaimEvictable(now, keepAtMost) {
  let removed = 0;

  for (const [id, round] of rounds) {
    if (rounds.size <= keepAtMost) break;

    if (isReclaimable(round, now)) {
      rounds.delete(id);
      removed += 1;
    }
  }

  return removed;
}

/**
 * Create a new round.
 * Returns null when the store cannot admit another round without terminating a
 * round that a player is still actively playing (ISSUE-23).
 */
function createRound(options = {}) {
  const now = Date.now();
  sweepExpired(now);

  if (rounds.size >= MAX_TRACKED_ROUNDS) {
    reclaimEvictable(now, MAX_TRACKED_ROUNDS - 1);
  }

  // Live rounds alone fill the store: refuse rather than evict. The caller turns
  // this into a retryable 503.
  if (rounds.size >= MAX_TRACKED_ROUNDS) {
    return null;
  }

  const maxAttempts = Number.isInteger(options.maxAttempts)
    ? options.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;

  // `ownerUid` binds the round to an authenticated player so a win can be
  // scored against that player and only that player (ISSUE-24). It is null for
  // an anonymous guest round, which stays unscored - the caller cannot name a
  // different player's uid, so a guest cannot mint score for someone else.
  const ownerUid =
    typeof options.ownerUid === 'string' && options.ownerUid.trim()
      ? options.ownerUid.trim()
      : null;

  const round = {
    id: crypto.randomUUID(),
    secretNumber: crypto.randomInt(1, 101), // 1..100 inclusive
    maxAttempts,
    attempts: 0,
    ownerUid,
    startedAtMs: now,
    lastUsedAtMs: now,
    finished: false,
  };

  rounds.set(round.id, round);

  return {
    roundId: round.id,
    maxAttempts: round.maxAttempts,
    startedAt: new Date(now).toISOString(),
  };
}

/**
 * Evaluate a guess against the server-held round.
 * Returns null when the round id is unknown or expired.
 */
function submitGuess(roundId, guess) {
  const now = Date.now();
  const round = rounds.get(roundId);

  if (!round || hasExpired(round, now)) {
    if (round) rounds.delete(roundId);
    return null;
  }

  if (round.finished) {
    return {
      result: 'round-over',
      attempts: round.attempts,
      maxAttempts: round.maxAttempts,
      remaining: 0,
      attemptsUsedNow: 0,
      ownerUid: round.ownerUid,
    };
  }

  // This round is in active use: protect it from idle/capacity reclamation.
  round.lastUsedAtMs = now;
  round.attempts += 1;

  let result;
  if (guess === round.secretNumber) {
    result = 'correct';
    round.finished = true;
  } else if (guess < round.secretNumber) {
    result = 'too-low';
  } else {
    result = 'too-high';
  }

  const outOfAttempts = !round.finished && round.attempts >= round.maxAttempts;
  if (outOfAttempts) {
    round.finished = true;
  }

  const response = {
    result: outOfAttempts && result !== 'correct' ? 'round-over' : result,
    attempts: round.attempts,
    maxAttempts: round.maxAttempts,
    remaining: Math.max(0, round.maxAttempts - round.attempts),
    // Whether THIS call consumed an attempt. The scoring layer awards points
    // exactly once, on the transition to a win, so it must not key off
    // `attempts` alone (a replayed request on a finished round also carries a
    // non-zero attempts count).
    attemptsUsedNow: 1,
    ownerUid: round.ownerUid,
  };

  if (result === 'correct') {
    response.secretNumber = round.secretNumber;
  } else if (outOfAttempts) {
    response.secretNumber = round.secretNumber;
  }

  return response;
}

// Lightweight operational visibility: how much of the cap is in use.
function getStoreStats() {
  const now = Date.now();
  let active = 0;
  for (const round of rounds.values()) {
    if (!isReclaimable(round, now)) active += 1;
  }

  return {
    tracked: rounds.size,
    active,
    maxTracked: MAX_TRACKED_ROUNDS,
  };
}

function _resetForTests() {
  rounds.clear();
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  ROUND_TTL_MS,
  ROUND_IDLE_TTL_MS,
  MAX_TRACKED_ROUNDS,
  createRound,
  submitGuess,
  getStoreStats,
  _resetForTests,
};
