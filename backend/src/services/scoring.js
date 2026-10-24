// Server-authoritative scoring for completed rounds (ISSUE-24).
//
// Before this module existed the API could start a round and resolve it, but
// nothing ever wrote a score: POST /api/game/guess returned the outcome and the
// SPA computed points locally in React state only. The result was a game whose
// documented centrepiece - the global leaderboard - could never contain a
// non-zero entry, and a player's `bestScore`/`streak` were permanently 0 on the
// server.
//
// Scoring belongs on the server for the same reason the secret number does: a
// score the client computes and owns is a score the client can set. The award is
// derived here from the attempt count the round store observed, and it is only
// ever written against the uid that *created* the round. A caller can neither
// name the uid to credit nor supply the attempt count.
//
// Points: a clean win is worth more than a lucky finish. The formula matches the
// one the SPA used to compute client-side, so the displayed value does not jump:
// 20 points for a win on the last attempt, rising 8 points per attempt saved,
// capped at 92 for a first-guess win. Losing a round scores nothing but still
// counts as a played game.
//
// Replay safety: the round store marks a round finished on the winning guess and
// reports `attemptsUsedNow: 0` for any later request against it, so a replayed or
// duplicated request cannot award a second time. Awarding is therefore keyed off
// the transition to a win, never off a client-supplied value.

const storage = require('./storage');

const MIN_WIN_POINTS = 20;
const BASE_WIN_POINTS = 100;
const POINTS_PER_ATTEMPT = 8;

/**
 * Points for winning a round in `attempts` guesses.
 * Returns 0 for an attempt count that cannot represent a real win, so a bad
 * input can never mint points.
 */
function pointsForWin(attempts) {
  const used = Number(attempts);
  if (!Number.isInteger(used) || used < 1) {
    return 0;
  }

  return Math.max(MIN_WIN_POINTS, BASE_WIN_POINTS - used * POINTS_PER_ATTEMPT);
}

/**
 * Merge a completed round into the player's stored record and the aggregate
 * game stats.
 *
 * `won` decides whether points are awarded; `attempts` is the server-observed
 * attempt count for the round. Returns the resulting player view, or null when
 * no identity was supplied (guest rounds are intentionally unscored - a guest
 * has no stable record to credit and the caller must not be able to choose one).
 */
async function recordRoundResult({ uid, attempts, won, displayName }) {
  if (typeof uid !== 'string' || !uid.trim()) {
    return null;
  }

  const cleanUid = uid.trim();
  const users = await storage.getUsers();
  const existing = users[cleanUid] || {};

  const previousBest = Number.isFinite(Number(existing.bestScore)) ? Number(existing.bestScore) : 0;
  const previousStreak = Number.isFinite(Number(existing.streak)) ? Number(existing.streak) : 0;
  const previousScore = Number.isFinite(Number(existing.score)) ? Number(existing.score) : 0;

  const awarded = won ? pointsForWin(attempts) : 0;
  const nextScore = previousScore + awarded;
  const nextBest = Math.max(previousBest, nextScore);
  // A loss ends the run of consecutive wins; a win extends it.
  const nextStreak = won ? previousStreak + 1 : 0;

  const username =
    (typeof displayName === 'string' && displayName.trim()) ||
    existing.username ||
    `Player-${cleanUid.slice(0, 6)}`;

  users[cleanUid] = {
    ...existing,
    uid: cleanUid,
    username,
    email: existing.email || '',
    joinedAt: existing.joinedAt || new Date().toISOString(),
    score: nextScore,
    bestScore: nextBest,
    streak: nextStreak,
    lastPlayedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await storage.saveUsers(users);

  // Aggregate counters are operational totals, not per-player state.
  const stats = await storage.getGameStats();
  await storage.saveGameStats({
    ...stats,
    bestScore: Math.max(Number(stats.bestScore || 0), nextBest),
    streak: Math.max(Number(stats.streak || 0), nextStreak),
    totalGames: Number(stats.totalGames || 0) + 1,
  });

  return {
    uid: cleanUid,
    username,
    awarded,
    score: nextScore,
    bestScore: nextBest,
    streak: nextStreak,
    newPersonalBest: nextScore > previousBest,
  };
}

/**
 * Build the public leaderboard payload from stored users.
 * Shared by the REST route and the realtime broadcast so both order the same way.
 */
function buildLeaderboard(users, limit = 50) {
  return Object.values(users || {})
    .sort((a, b) => {
      const byBest = Number(b.bestScore || 0) - Number(a.bestScore || 0);
      if (byBest !== 0) return byBest;
      return String(a.username || '').localeCompare(String(b.username || ''));
    })
    .slice(0, limit)
    .map((user, index) => ({
      rank: index + 1,
      username: user.username,
      bestScore: Number(user.bestScore || 0),
      streak: Number(user.streak || 0),
      messagesSent: Number(user.messagesSent || 0),
    }));
}

module.exports = {
  MIN_WIN_POINTS,
  BASE_WIN_POINTS,
  POINTS_PER_ATTEMPT,
  pointsForWin,
  recordRoundResult,
  buildLeaderboard,
};
