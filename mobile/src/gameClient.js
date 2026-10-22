// Mobile client for the shared backend.
//
// Why this file exists: mobile/App.js used to be a self-contained local game. It
// picked its own secret number with Math.random(), and on a "win" it computed its
// own points with Math.max(20, 100 - attempts * 8) and added them to React state.
// It never made a network request, so a phone player could not play the real
// global game, could not appear on the leaderboard, could not send chat, and
// could be shown a score the server had never awarded. That is the same two
// defects the API half of the product already fixed for web:
//
//   - ISSUE-10: the secret number must live on the server (ef32dfc / 0053b89);
//   - ISSUE-24: points must be credited by the server (fbf0ee8 / b7cc5a1).
//
// This module holds everything about talking to the backend that is worth
// testing without a device: URL/base resolution, request construction, response
// validation, and the wording of what the player is told. It is deliberately
// free of React, React Native and Expo imports, and it takes its fetch
// implementation as a parameter, so it runs under plain `node --test` with a
// stubbed server. App.js keeps only rendering and interaction.
//
// Two rules are structural rather than a matter of discipline:
//
//   1. There is no scoring arithmetic anywhere in this file. Every number the
//      player sees comes out of a server response field (`attempts`,
//      `maxAttempts`, `remaining`, `awarded`, `score`, `bestScore`, `streak`).
//      A value that the server did not send is rendered as absent, never
//      derived.
//   2. There is no secret-number generation and no way to obtain one early.
//      `secretNumber` is copied from the response only when the server chose to
//      include it, which it only does once the round is `correct` or
//      `round-over` (see docs/API.md).
//
// Honesty rules, mirroring the web share text:
//
//   - a guest round is playable and is reported as explicitly unscored;
//   - an authenticated round the server failed to score is reported as "the
//     server did not record points", never as a guest round and never as a win
//     that earned points;
//   - an unreachable backend is reported as an unreachable backend, and no
//     round or score is invented in its place.
//
// CommonJS on purpose: the same file is loaded by `node --test` (no transform
// step) and by App.js through the normal Babel interop, so the logic under test
// is byte-identical to the logic that ships.

const ENDPOINTS = Object.freeze({
  stats: '/api/game/stats',
  start: '/api/game/start',
  guess: '/api/game/guess',
  leaderboard: '/api/leaderboard',
  chat: '/api/chat/messages',
  bonus: '/api/game/bonus',
});

const RESULTS = Object.freeze({
  TOO_LOW: 'too-low',
  TOO_HIGH: 'too-high',
  CORRECT: 'correct',
  ROUND_OVER: 'round-over',
});

const RESULT_VALUES = Object.freeze(Object.values(RESULTS));

const IDENTITY_MODES = Object.freeze({
  GUEST: 'guest',
  AUTHENTICATED: 'authenticated',
  UNKNOWN: 'unknown',
});

const TONES = Object.freeze({
  WIN: 'win',
  LOSS: 'loss',
  PROGRESS: 'progress',
  ERROR: 'error',
  INFO: 'info',
});

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_LEADERBOARD_ROWS = 5;
const MAX_CHAT_ROWS = 3;

// The one message used whenever the app could not reach the API at all. Exported
// so tests and the driver assert against the same string instead of a copy.
const UNREACHABLE_MESSAGE =
  'The server cannot be reached, so no round can be played. Check the API address in the app configuration and your connection, then try again.';

const UNREADABLE_MESSAGE =
  'The server sent a response this app could not read. Nothing was scored.';

/**
 * Coerce to an integer or give up. Used for every numeric field so a malformed
 * or hostile payload cannot become NaN on screen.
 */
function toInt(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Validate a configured API base.
 *
 * Accepted: an absolute http(s) URL with no credentials, query or fragment.
 * Rejected with an explanation otherwise, because a base that silently does not
 * work is exactly the "looks fine, does nothing" failure this app must avoid.
 */
function validateApiBase(candidate) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    return 'the API address is not a valid URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'the API address must start with http:// or https://';
  }
  if (parsed.username || parsed.password) {
    return 'the API address must not contain credentials';
  }
  if (parsed.search || parsed.hash) {
    return 'the API address must not contain a query string or fragment';
  }
  return null;
}

/**
 * Resolve the API base URL.
 *
 * Precedence, highest first:
 *   1. `expo.extra.apiUrl` from app.json (read through expo-constants) - the
 *      documented place to point a real device at a deployed backend;
 *   2. `EXPO_PUBLIC_API_URL`, which Expo inlines at bundle time and which `npx
 *      expo start` picks up from the environment;
 *   3. on web only, the empty string: same-origin, so a deployment that serves
 *      the app and the API from one origin needs no configuration at all.
 *
 * A native build with neither (1) nor (2) set gets an explicit error rather than
 * silently issuing relative requests that can never work on a device.
 *
 * Returns { base, source, error }. `base` is null when `error` is set.
 */
function resolveApiBase({ extraUrl, envUrl, platform } = {}) {
  const candidates = [
    { value: extraUrl, source: 'app.json expo.extra.apiUrl' },
    { value: envUrl, source: 'EXPO_PUBLIC_API_URL' },
  ];

  for (const candidate of candidates) {
    const value = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    if (!value) continue;

    const problem = validateApiBase(value);
    if (problem) {
      return { base: null, source: candidate.source, error: problem };
    }
    return { base: value.replace(/\/+$/, ''), source: candidate.source, error: null };
  }

  if (platform === 'web') {
    return { base: '', source: 'same origin (web default)', error: null };
  }

  return {
    base: null,
    source: 'unset',
    error:
      'No API address is configured. Set expo.extra.apiUrl in app.json (or EXPO_PUBLIC_API_URL) to your deployed backend.',
  };
}

function apiUrl(base, pathname) {
  return `${base || ''}${pathname}`;
}

/**
 * Normalise a POST /api/game/start payload.
 *
 * Only `roundId` and `maxAttempts` are taken from the server. There is
 * deliberately no field here that could carry a secret number: the server does
 * not send one and the client would have nowhere to put it.
 */
function normaliseRound(payload) {
  const round = payload && payload.round;
  const roundId = toNonEmptyString(round && round.roundId);
  const maxAttempts = toInt(round && round.maxAttempts);

  if (!roundId || maxAttempts === null || maxAttempts <= 0) {
    return null;
  }

  return {
    roundId,
    maxAttempts,
    startedAt: toNonEmptyString(round && round.startedAt),
  };
}

/**
 * Normalise a POST /api/game/guess payload into the view model the UI renders.
 *
 * `scored` is only true when the server said so AND supplied all four totals.
 * Anything less is treated as unscored, because showing a partial or guessed
 * total would be worse than showing none.
 */
function normaliseGuessOutcome(payload) {
  const result = toNonEmptyString(payload && payload.result);
  if (!RESULT_VALUES.includes(result)) {
    return null;
  }

  const attempts = toInt(payload.attempts);
  const maxAttempts = toInt(payload.maxAttempts);
  const remaining = toInt(payload.remaining);

  if (attempts === null || maxAttempts === null) {
    return null;
  }

  const finished = result === RESULTS.CORRECT || result === RESULTS.ROUND_OVER;

  // The server includes the number only once the round is over. If it were sent
  // earlier the client would still only ever copy it, never use it to play.
  const secretNumber = finished ? toInt(payload.secretNumber) : null;

  const awarded = toInt(payload.awarded);
  const score = toInt(payload.score);
  const bestScore = toInt(payload.bestScore);
  const streak = toInt(payload.streak);

  const totalsPresent =
    awarded !== null && score !== null && bestScore !== null && streak !== null;

  return {
    result,
    attempts,
    maxAttempts,
    remaining,
    secretNumber,
    finished,
    scored: payload.scored === true && totalsPresent,
    awarded,
    score,
    bestScore,
    streak,
    newPersonalBest: payload.newPersonalBest === true,
    totalsPresent,
  };
}

/**
 * The player's own totals, taken from a server response and nowhere else.
 *
 * Returns null when the server did not report a scored round, which is the
 * correct answer for a guest: a guest has no stored record to read back, so the
 * UI must not display a total as if it had one.
 */
function playerTotalsFromOutcome(outcome) {
  if (!outcome || outcome.scored !== true) {
    return null;
  }
  return {
    score: outcome.score,
    bestScore: outcome.bestScore,
    streak: outcome.streak,
  };
}

function normaliseGlobalStats(payload) {
  const stats = payload && payload.stats;
  if (!stats || typeof stats !== 'object') {
    return null;
  }

  const bestScore = toInt(stats.bestScore);
  const streak = toInt(stats.streak);
  const totalGames = toInt(stats.totalGames);

  if (bestScore === null || streak === null || totalGames === null) {
    return null;
  }
  return { bestScore, streak, totalGames };
}

function normaliseLeaderboard(payload, limit = MAX_LEADERBOARD_ROWS) {
  const rows = payload && payload.leaderboard;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const username = toNonEmptyString(row && row.username);
      const bestScore = toInt(row && row.bestScore);
      if (!username || bestScore === null) {
        return null;
      }
      return {
        rank: toInt(row.rank) ?? 0,
        username,
        bestScore,
        streak: toInt(row.streak) ?? 0,
        messagesSent: toInt(row.messagesSent) ?? 0,
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function normaliseChatMessages(payload, limit = MAX_CHAT_ROWS) {
  const messages = payload && payload.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((entry) => {
      const message = toNonEmptyString(entry && entry.message);
      if (!message) return null;
      return {
        username: toNonEmptyString(entry.username) || 'Player',
        message: message.length > 120 ? `${message.slice(0, 117)}...` : message,
      };
    })
    .filter(Boolean)
    .slice(-limit);
}

/**
 * Normalise the GET /api/game/bonus response, which doubles as the identity
 * probe: it is the one cheap authenticated read that returns the caller's stored
 * totals. A 401 there means "this client is a guest", which is a fact the server
 * decided, not one the client assumes from its own configuration.
 */
function normaliseSession(payload) {
  const score = toInt(payload && payload.score);
  const bestScore = toInt(payload && payload.bestScore);
  const streak = toInt(payload && payload.streak);

  if (score === null || bestScore === null || streak === null) {
    return null;
  }

  return {
    mode: IDENTITY_MODES.AUTHENTICATED,
    score,
    bestScore,
    streak,
    bonusAvailable: payload.available === true,
    bonus: toInt(payload.bonus),
    nextAvailableAt: toInt(payload.nextAvailableAt),
  };
}

const GUEST_SESSION = Object.freeze({ mode: IDENTITY_MODES.GUEST });

/**
 * What the player is told about a completed guess.
 *
 * Every figure interpolated here is read straight off the outcome. Nothing is
 * recomputed, so the sentence cannot disagree with the leaderboard.
 */
function describeResult(outcome, session) {
  const mode = (session && session.mode) || IDENTITY_MODES.UNKNOWN;
  const isGuest = mode === IDENTITY_MODES.GUEST;

  const unscoredDetail = isGuest
    ? 'No points were recorded: this round was played as a guest.'
    : 'The server did not record points for this round.';

  if (outcome.result === RESULTS.TOO_LOW) {
    return {
      tone: TONES.PROGRESS,
      headline: 'Too low - try a higher number.',
      detail: `${outcome.attempts} of ${outcome.maxAttempts} attempts used.`,
    };
  }

  if (outcome.result === RESULTS.TOO_HIGH) {
    return {
      tone: TONES.PROGRESS,
      headline: 'Too high - try a lower number.',
      detail: `${outcome.attempts} of ${outcome.maxAttempts} attempts used.`,
    };
  }

  if (outcome.result === RESULTS.CORRECT) {
    const headline = `Correct! You found the number in ${outcome.attempts} of ${outcome.maxAttempts} attempts.`;

    if (outcome.scored) {
      const personalBest = outcome.newPersonalBest ? ' That is a new personal best.' : '';
      return {
        tone: TONES.WIN,
        headline,
        detail: `The server awarded ${outcome.awarded} points. Total ${outcome.score}, best ${outcome.bestScore}, streak ${outcome.streak}.${personalBest}`,
      };
    }

    return { tone: TONES.WIN, headline, detail: unscoredDetail };
  }

  // round-over: the attempt budget is spent.
  const secret =
    outcome.secretNumber === null ? null : ` The number was ${outcome.secretNumber}.`;
  const headline = `Out of attempts.${secret || ''}`;

  if (outcome.scored) {
    return {
      tone: TONES.LOSS,
      headline,
      detail: `The server recorded ${outcome.awarded} points for this round. Total ${outcome.score}, best ${outcome.bestScore}, streak ${outcome.streak}.`,
    };
  }

  return { tone: TONES.LOSS, headline, detail: unscoredDetail };
}

/**
 * Describe the caller's identity for the player's own eyes.
 *
 * Never an email, never a uid: only what the server's answer supports.
 */
function formatSession(session) {
  const mode = (session && session.mode) || IDENTITY_MODES.UNKNOWN;

  if (mode === IDENTITY_MODES.AUTHENTICATED) {
    return `Signed in - the server keeps your score. Score ${session.score}, best ${session.bestScore}, streak ${session.streak}.`;
  }
  if (mode === IDENTITY_MODES.GUEST) {
    return 'Guest - you can play, but no points are recorded for guest rounds.';
  }
  return 'Checking your session with the server...';
}

function formatGlobalStats(global) {
  if (!global) return null;
  return `Global best ${global.bestScore} across ${global.totalGames} recorded games.`;
}

/**
 * Turn any failed request into something the player can act on. The three cases
 * are kept distinct on purpose: "the server is unreachable", "the server refused
 * this request" and "the server's answer was unreadable" have different fixes.
 */
function describeFailure(failure) {
  if (!failure) {
    return { tone: TONES.ERROR, headline: 'Something went wrong.', detail: '' };
  }

  if (failure.kind === 'transport') {
    return { tone: TONES.ERROR, headline: UNREACHABLE_MESSAGE, detail: 'No round is in progress.' };
  }
  if (failure.kind === 'malformed') {
    return { tone: TONES.ERROR, headline: UNREADABLE_MESSAGE, detail: '' };
  }
  if (failure.kind === 'config') {
    return { tone: TONES.ERROR, headline: failure.message, detail: 'No round can be played until this is fixed.' };
  }

  return {
    tone: TONES.ERROR,
    headline: failure.message || `The server rejected the request (HTTP ${failure.status}).`,
    detail: failure.retryable ? 'This is retryable - try again in a moment.' : '',
  };
}

function messageOf(error) {
  if (!error) return 'unknown error';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * Build a client bound to one base URL.
 *
 * `fetchImpl` is injected so tests can supply a stub and so a platform without a
 * global fetch can pass its own. `token` is optional; when absent every request
 * is a guest request and the server decides what that means.
 */
function createGameClient({ baseUrl, token, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);

  async function request(pathname, { method = 'GET', body } = {}) {
    if (!doFetch) {
      return {
        ok: false,
        kind: 'transport',
        message: UNREACHABLE_MESSAGE,
        cause: 'no fetch implementation available',
      };
    }

    const headers = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    let timer = null;
    let controller = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response;
    try {
      response = await doFetch(apiUrl(baseUrl, pathname), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } catch (error) {
      return { ok: false, kind: 'transport', message: UNREACHABLE_MESSAGE, cause: messageOf(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }

    let payload = null;
    let readable = false;
    try {
      payload = await response.json();
      readable = true;
    } catch (error) {
      readable = false;
    }

    if (!response.ok) {
      const serverMessage = readable ? toNonEmptyString(payload && payload.message) : null;
      return {
        ok: false,
        kind: 'http',
        status: response.status,
        retryable: Boolean(readable && payload && payload.retryable),
        message: serverMessage || `The server rejected the request (HTTP ${response.status}).`,
      };
    }

    if (!readable || !payload || payload.ok !== true) {
      return { ok: false, kind: 'malformed', status: response.status };
    }

    return { ok: true, status: response.status, payload };
  }

  async function startRound() {
    const response = await request(ENDPOINTS.start, { method: 'POST', body: {} });
    if (!response.ok) return response;

    const round = normaliseRound(response.payload);
    if (!round) {
      return { ok: false, kind: 'malformed', status: response.status };
    }
    return { ok: true, round };
  }

  async function submitGuess(roundId, guess) {
    const response = await request(ENDPOINTS.guess, {
      method: 'POST',
      body: { roundId, guess },
    });
    if (!response.ok) return response;

    const outcome = normaliseGuessOutcome(response.payload);
    if (!outcome) {
      return { ok: false, kind: 'malformed', status: response.status };
    }
    return { ok: true, outcome };
  }

  async function getGlobalStats() {
    const response = await request(ENDPOINTS.stats);
    if (!response.ok) return response;

    const global = normaliseGlobalStats(response.payload);
    if (!global) {
      return { ok: false, kind: 'malformed', status: response.status };
    }
    return { ok: true, global };
  }

  /**
   * Ask the server who we are. A 401 is a valid answer - it means guest - and is
   * reported as success so the UI can say so plainly.
   */
  async function getSession() {
    const response = await request(ENDPOINTS.bonus);
    if (response.ok) {
      const session = normaliseSession(response.payload);
      if (!session) {
        return { ok: false, kind: 'malformed', status: response.status };
      }
      return { ok: true, session };
    }

    if (response.kind === 'http' && (response.status === 401 || response.status === 403)) {
      return { ok: true, session: GUEST_SESSION };
    }

    return response;
  }

  async function getLeaderboard() {
    const response = await request(ENDPOINTS.leaderboard);
    if (!response.ok) return response;
    return { ok: true, rows: normaliseLeaderboard(response.payload) };
  }

  async function getChatMessages() {
    const response = await request(ENDPOINTS.chat);
    if (!response.ok) return response;
    return { ok: true, messages: normaliseChatMessages(response.payload) };
  }

  async function claimBonus() {
    const response = await request(ENDPOINTS.bonus, { method: 'POST', body: {} });
    if (!response.ok) return response;

    const granted = response.payload && response.payload.granted === true;
    const bonus = toInt(response.payload && response.payload.bonus);
    const score = toInt(response.payload && response.payload.score);
    const bestScore = toInt(response.payload && response.payload.bestScore);
    const streak = toInt(response.payload && response.payload.streak);

    if (score === null || bestScore === null || streak === null) {
      return { ok: false, kind: 'malformed', status: response.status };
    }

    return {
      ok: true,
      granted,
      bonus,
      session: {
        mode: IDENTITY_MODES.AUTHENTICATED,
        score,
        bestScore,
        streak,
        bonusAvailable: false,
        bonus: toInt(response.payload && response.payload.bonus),
        nextAvailableAt: toInt(response.payload && response.payload.nextAvailableAt),
      },
    };
  }

  return {
    baseUrl,
    hasToken: Boolean(token),
    startRound,
    submitGuess,
    getGlobalStats,
    getSession,
    getLeaderboard,
    getChatMessages,
    claimBonus,
  };
}

module.exports = {
  ENDPOINTS,
  RESULTS,
  RESULT_VALUES,
  IDENTITY_MODES,
  TONES,
  DEFAULT_TIMEOUT_MS,
  MAX_LEADERBOARD_ROWS,
  MAX_CHAT_ROWS,
  UNREACHABLE_MESSAGE,
  UNREADABLE_MESSAGE,
  GUEST_SESSION,
  apiUrl,
  validateApiBase,
  resolveApiBase,
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
  formatGlobalStats,
  createGameClient,
};
