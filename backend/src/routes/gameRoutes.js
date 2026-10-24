const express = require('express');

const storage = require('../services/storage');
const roundStore = require('../services/roundStore');
const scoring = require('../services/scoring');
const bonus = require('../services/bonus');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { parseIntegerInRange, resolveDisplayName } = require('../utils/helpers');

const router = express.Router();

// Per-source admission control for round creation (ISSUE-23 residual).
//
// POST /api/game/start is open to guests by design, so one anonymous source can
// create rounds far faster than players finish them. The store now refuses new
// rounds instead of terminating rounds in play, but a single source could still
// saturate the capped store and make NEW rounds fail for everyone until idle/TTL
// reclamation caught up. Bounding how many rounds one source may create per
// window removes that trivial single-source denial path while leaving honest play
// (a handful of rounds a minute) untouched.
const startRateLimiter = createRateLimiter({
  windowMs: Number(process.env.ROUNDS_RATE_WINDOW_MS) || undefined,
  max: Number(process.env.ROUNDS_RATE_MAX) || undefined,
});

const CAPACITY_LOG_INTERVAL_MS = 30 * 1000;

// Log capacity refusals at most once per interval. A flood of anonymous
// /api/game/start calls is exactly when the store fills up, so logging every
// refusal would turn a game-capacity condition into a log-spam amplifier.
let lastCapacityLogAtMs = 0;

function logCapacityRefusal(stats) {
  const now = Date.now();
  if (now - lastCapacityLogAtMs < CAPACITY_LOG_INTERVAL_MS) {
    return;
  }
  lastCapacityLogAtMs = now;
  console.warn(
    `game/start refused: round store at capacity (${stats.active}/${stats.maxTracked} active rounds).`
  );
}

function clientRound(round) {
  return {
    roundId: round.roundId,
    maxAttempts: round.maxAttempts,
    startedAt: round.startedAt,
  };
}

// GET /api/game/stats (public, read-only)
router.get('/stats', async (req, res) => {
  const data = await storage.getGameStats();

  res.json({
    ok: true,
    stats: {
      bestScore: Number(data.bestScore || 0),
      streak: Number(data.streak || 0),
      totalGames: Number(data.totalGames || 0),
    },
  });
});

// POST /api/game/start - create a server-side round. The secret number stays on
// the server; only the round id and attempt budget are returned (ISSUE-10).
router.post('/start', startRateLimiter, optionalAuth, (req, res) => {
  // Identity is optional: guests must be able to play, but when the caller IS
  // authenticated the round is bound to them so a win can be scored against
  // them (ISSUE-24). The uid comes from the verified token, never the body.
  const ownerUid = (req.user && req.user.uid) || null;
  const round = roundStore.createRound({ ownerUid });

  // The store refuses new rounds rather than terminating rounds that players are
  // still playing (ISSUE-23). Surface that as a retryable capacity error instead
  // of a generic failure or - worse - silently dropping an in-flight round.
  if (!round) {
    logCapacityRefusal(roundStore.getStoreStats());
    return res.status(503).json({
      ok: false,
      message: 'The game is at capacity right now. Please try again in a moment.',
      retryable: true,
    });
  }

  return res.json({ ok: true, round: clientRound(round) });
});

// POST /api/game/guess - the client sends ONLY { roundId, guess }.
//
// optionalAuth (never rejecting) is what makes the result scoreable: a guest
// round is resolved but unscored, an authenticated round is credited to the uid
// that created it.
router.post('/guess', optionalAuth, async (req, res) => {
  const { roundId, guess } = req.body;
  const parsedGuess = parseIntegerInRange(guess, 1, 100);

  if (typeof roundId !== 'string' || !roundId) {
    return res.status(400).json({ ok: false, message: 'A valid roundId is required.' });
  }

  if (parsedGuess === null) {
    return res.status(400).json({ ok: false, message: 'guess must be an integer between 1 and 100.' });
  }

  const outcome = roundStore.submitGuess(roundId, parsedGuess);

  if (!outcome) {
    return res.status(404).json({ ok: false, message: 'Unknown or expired round. Start a new round.' });
  }

  // Ownership: a round bound to a player may only be played by that player, so a
  // leaked round id cannot be used to burn someone else's attempts or finish
  // their round. Guest rounds (no owner) stay playable by anyone, as before.
  const requesterUid = (req.user && req.user.uid) || null;
  if (outcome.ownerUid && outcome.ownerUid !== requesterUid) {
    return res.status(403).json({ ok: false, message: 'This round belongs to another player.' });
  }

  // Score exactly once, on the transition to a win. `attemptsUsedNow` is 0 for
  // any request against an already-finished round, so replaying the winning
  // request cannot award twice.
  const shouldScore = Boolean(outcome.ownerUid) && outcome.attemptsUsedNow === 1;

  if (shouldScore) {
    const won = outcome.result === 'correct';

    try {
      const result = await scoring.recordRoundResult({
        uid: outcome.ownerUid,
        attempts: outcome.attempts,
        won,
        displayName: resolveDisplayName(req.user),
      });

      if (result) {
        Object.assign(outcome, {
          awarded: result.awarded,
          score: result.score,
          bestScore: result.bestScore,
          streak: result.streak,
          newPersonalBest: result.newPersonalBest,
          scored: true,
        });

        // The documented product is a realtime leaderboard; push the new ranking
        // so other clients do not wait for a manual refresh.
        const io = req.app.get('io');
        if (io) {
          const users = await storage.getUsers();
          io.to('global-chat').emit('leaderboard-update', {
            leaderboard: scoring.buildLeaderboard(users),
            at: Date.now(),
          });
        }
      }
    } catch (error) {
      // A scoring failure must never turn a completed round into an error for
      // the player: the guess itself succeeded and is already resolved in the
      // store. Report the round outcome unscored and keep the failure visible.
      console.error('game/guess: failed to record score', error && error.message);
      Object.assign(outcome, { scored: false });
    }
  }

  // The owner binding is internal bookkeeping and is never serialised.
  delete outcome.ownerUid;

  return res.json({ ok: true, ...outcome });
});

// POST /api/game/bonus - per-user daily bonus (ISSUE-8).
//
// The award is server-authoritative. Before this route used the bonus service it
// only wrote the cooldown record and returned `{granted:true, bonus:50}`; the SPA
// added the points to React state, so the bonus vanished on reload and could
// never reach the leaderboard - the same class of defect ISSUE-24 fixed for round
// scoring. The points are now credited to the stored record of the uid taken
// from the verified token, and the response carries the authoritative totals.
router.post('/bonus', requireAuth, async (req, res) => {
  const uid = req.user && req.user.uid;

  if (!uid) {
    return res.status(401).json({ ok: false, message: 'Authentication required.' });
  }

  try {
    const result = await bonus.claimDailyBonus({
      uid,
      // Server-derived pseudonym (ISSUE-22): never an email, never a body value.
      displayName: resolveDisplayName(req.user),
    });

    // Keep the documented realtime leaderboard correct after a granted bonus, for
    // the same reason a scored round broadcasts: the ranking just changed.
    if (result.granted) {
      const io = req.app.get('io');
      if (io) {
        io.to('global-chat').emit('leaderboard-update', {
          leaderboard: scoring.buildLeaderboard(result.users),
          at: Date.now(),
        });
      }
    }

    // `users` is an internal broadcast payload and is never serialised.
    const { users, ...body } = result;
    return res.json({ ok: true, ...body });
  } catch (error) {
    console.error('game/bonus: failed to credit the daily bonus', error && error.message);
    return res.status(500).json({
      ok: false,
      message: 'The bonus could not be credited. Please try again.',
    });
  }
});

// GET /api/game/bonus - read the bonus state WITHOUT claiming it.
//
// The SPA used to discover its bonus state by POSTing to the claim endpoint while
// rendering, which spent the bonus as a side effect of opening the page. Reporting
// status must not award anything, so it lives on its own read-only route.
router.get('/bonus', requireAuth, async (req, res) => {
  const uid = req.user && req.user.uid;

  if (!uid) {
    return res.status(401).json({ ok: false, message: 'Authentication required.' });
  }

  const status = await bonus.getBonusStatus({ uid });
  return res.json({ ok: true, ...status });
});

module.exports = router;
// Exposed so tests can reset the limiter's accounting between cases.
module.exports.startLimiter = startRateLimiter;
