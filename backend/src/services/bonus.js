// Server-authoritative daily bonus.
//
// The bonus used to be client-authoritative in exactly the way round scoring was
// before ISSUE-24: POST /api/game/bonus only wrote the cooldown record and
// returned `{ granted: true, bonus: 50 }`, and the SPA added those 50 points to
// React state. Nothing was ever credited to the player's stored record, so the
// bonus vanished on reload and could never appear on the leaderboard. A value
// the client computes is a value the client can set.
//
// Claiming therefore credits the stored `score`/`bestScore` of the uid taken from
// the verified token - never an identity from the request body - and returns the
// authoritative totals for the client to render.
//
// Three properties are enforced here, not by the caller:
//
//  * only a genuinely DUE claim awards (the per-uid 24 hour window that ISSUE-8
//    introduced stays the sole authority for "due");
//  * awarding happens EXACTLY ONCE. The window is claimed before the credit is
//    written, and concurrent claims for one uid are serialised through an
//    in-process lock, so two requests that both observe a due window cannot both
//    award. If the credit write fails the window is rolled back, so a failed
//    claim does not silently consume the player's bonus for 24 hours;
//  * a bonus never changes `streak` - a streak counts consecutive WINS.
//
// Ordering note: the cooldown record is written first and the credit second. The
// alternative order risks a double award (credit succeeds, record write fails),
// which is the worse failure for a leaderboard, so the window is taken first and
// given back on error.

const storage = require('./storage');

const DEFAULT_BONUS = 50;
const BONUS_WINDOW_MS = 24 * 60 * 60 * 1000;

// Per-uid serialisation. Node runs one request's synchronous slice at a time, but
// a claim awaits storage twice (read window, write credit), so two overlapping
// claims could both observe a due window and both award. Chaining per uid closes
// that window without a global lock.
const claimLocks = new Map();

function withUidLock(key, task) {
  const previous = claimLocks.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => {},
    () => {}
  );
  claimLocks.set(key, settled);
  settled.then(() => {
    if (claimLocks.get(key) === settled) {
      claimLocks.delete(key);
    }
  });
  return run;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normaliseUid(uid) {
  return typeof uid === 'string' && uid.trim() ? uid.trim() : null;
}

function displayNameFor(uid, displayName, existing) {
  if (typeof displayName === 'string' && displayName.trim()) {
    return displayName.trim();
  }
  if (existing && typeof existing.username === 'string' && existing.username.trim()) {
    return existing.username.trim();
  }
  return `Player-${uid.slice(0, 6)}`;
}

// Read the cooldown window for one uid. Pure read: never awards.
async function readWindow(uid, now) {
  const record = await storage.getBonusRecord(uid);
  const lastClaim = toNumber(record && record.lastClaim);
  const due = !lastClaim || now - lastClaim >= BONUS_WINDOW_MS;

  return {
    record: record || null,
    lastClaim,
    due,
    nextAvailableAt: due ? now : lastClaim + BONUS_WINDOW_MS,
  };
}

/**
 * Report the bonus state for one uid WITHOUT claiming it.
 *
 * This exists because the SPA used to probe the bonus by POSTing to the claim
 * endpoint on page load, which consumed the bonus as a side effect of rendering.
 * A read-only status endpoint keeps "am I due?" separate from "award me".
 *
 * Returns null when no identity was supplied.
 */
async function getBonusStatus({ uid, now = Date.now() }) {
  const cleanUid = normaliseUid(uid);
  if (!cleanUid) {
    return null;
  }

  const window = await readWindow(cleanUid, now);
  const users = await storage.getUsers();
  const stored = users[cleanUid] || {};

  return {
    available: window.due,
    bonus: DEFAULT_BONUS,
    nextAvailableAt: window.nextAvailableAt,
    score: toNumber(stored.score),
    bestScore: toNumber(stored.bestScore),
    streak: toNumber(stored.streak),
  };
}

/**
 * Claim the daily bonus for one uid.
 *
 * `uid` must come from the verified token. `displayName` is the server-derived
 * pseudonym (ISSUE-22), never an email.
 *
 * Returns null when no identity was supplied, otherwise:
 *   { granted, bonus, score, bestScore, streak, nextAvailableAt, users }
 * where `users` is the post-write user map so the caller can broadcast one
 * consistent leaderboard without re-reading storage.
 */
async function claimDailyBonus({ uid, displayName, now = Date.now() }) {
  const cleanUid = normaliseUid(uid);
  if (!cleanUid) {
    return null;
  }

  return withUidLock(cleanUid, async () => {
    // Re-read the window INSIDE the lock: a queued second claim must observe the
    // window the first claim just wrote.
    const window = await readWindow(cleanUid, now);
    const users = await storage.getUsers();
    const existing = users[cleanUid] || {};

    const previousScore = toNumber(existing.score);
    const previousBest = toNumber(existing.bestScore);
    const previousStreak = toNumber(existing.streak);

    if (!window.due) {
      // Not due: report the authoritative stored totals so the client still
      // renders server numbers rather than keeping its own.
      return {
        granted: false,
        bonus: 0,
        score: previousScore,
        bestScore: previousBest,
        streak: previousStreak,
        nextAvailableAt: window.lastClaim + BONUS_WINDOW_MS,
        users,
      };
    }

    // Take the window first: this is what makes the award exactly-once even if
    // the credit below is retried by the client.
    await storage.saveBonusRecord(cleanUid, {
      lastClaim: now,
      lastBonus: DEFAULT_BONUS,
      totalBonusClaimed: toNumber(window.record && window.record.totalBonusClaimed) + DEFAULT_BONUS,
    });

    const nextScore = previousScore + DEFAULT_BONUS;
    const nextBest = Math.max(previousBest, nextScore);
    const username = displayNameFor(cleanUid, displayName, existing);
    const timestamp = new Date(now).toISOString();

    users[cleanUid] = {
      ...existing,
      uid: cleanUid,
      // Never an email and never a client-supplied handle: either the explicit
      // handle already stored for this player, or the uid-derived pseudonym.
      username,
      joinedAt: existing.joinedAt || timestamp,
      score: nextScore,
      bestScore: nextBest,
      // A bonus is not a win, so the winning streak is carried through unchanged.
      streak: previousStreak,
      lastBonusAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      await storage.saveUsers(users);
    } catch (error) {
      // Give the window back: a bonus that was not credited must remain claimable.
      try {
        if (window.record) {
          await storage.saveBonusRecord(cleanUid, window.record);
        } else {
          await storage.clearBonusRecord(cleanUid);
        }
      } catch (rollbackError) {
        console.error(
          'game/bonus: could not roll back the claim window after a failed credit',
          rollbackError && rollbackError.message
        );
      }
      throw error;
    }

    return {
      granted: true,
      bonus: DEFAULT_BONUS,
      score: nextScore,
      bestScore: nextBest,
      streak: previousStreak,
      nextAvailableAt: now + BONUS_WINDOW_MS,
      username,
      users,
    };
  });
}

module.exports = {
  DEFAULT_BONUS,
  BONUS_WINDOW_MS,
  getBonusStatus,
  claimDailyBonus,
};
