const express = require('express');

const storage = require('../services/storage');
const roundStore = require('../services/roundStore');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { parseIntegerInRange } = require('../utils/helpers');

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

const BONUS_WINDOW_MS = 24 * 60 * 60 * 1000;
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
const DEFAULT_BONUS = 50;

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
router.post('/start', startRateLimiter, (req, res) => {
  const round = roundStore.createRound();

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
router.post('/guess', (req, res) => {
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

  return res.json({ ok: true, ...outcome });
});

// POST /api/game/bonus - per-user daily bonus (ISSUE-8).
router.post('/bonus', requireAuth, async (req, res) => {
  const uid = req.user && req.user.uid;

  if (!uid) {
    return res.status(401).json({ ok: false, message: 'Authentication required.' });
  }

  const now = Date.now();
  const record = await storage.getBonusRecord(uid);
  const lastClaim = Number((record && record.lastClaim) || 0);

  if (!lastClaim || now - lastClaim >= BONUS_WINDOW_MS) {
    await storage.saveBonusRecord(uid, { lastClaim: now });
    return res.json({
      ok: true,
      granted: true,
      bonus: DEFAULT_BONUS,
      nextAvailableAt: now + BONUS_WINDOW_MS,
    });
  }

  return res.json({
    ok: true,
    granted: false,
    bonus: 0,
    nextAvailableAt: lastClaim + BONUS_WINDOW_MS,
  });
});

module.exports = router;
// Exposed so tests can reset the limiter's accounting between cases.
module.exports.startLimiter = startRateLimiter;
