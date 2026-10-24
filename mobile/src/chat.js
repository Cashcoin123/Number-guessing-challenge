// Mobile chat: taking part in the global room, and staying current with it.
//
// Why this file exists. README.md tells a phone player that the mobile app plays
// "the same global game ... Same leaderboard, same chat." At HEAD before this
// change the mobile client could only read the room:
//
//   - `src/gameClient.js` knew `GET /api/chat/messages` and nothing else, so
//     there was no way to post. The backend has had a hardened
//     `POST /api/chat/send` all along (requireAuth, body `{ message }` only,
//     `normaliseMessage` bounds it to 280 characters, the display name comes from
//     `resolveDisplayName(req.user)` and never from the body or the email
//     (ISSUE-22), and the score is read from the stored user record (ISSUE-4)).
//   - `App.js` refreshed the leaderboard and chat only on bootstrap, after a
//     scored round and after a granted bonus. There was no timer and no socket,
//     so what a phone showed went stale the moment the app finished loading and
//     never caught up while it stayed open.
//
// Both halves of the claim were therefore false on mobile. This module holds the
// logic for both, and holds it in one place so the logic under `node --test` is
// byte-identical to the logic that ships: no React, React Native or Expo import
// anywhere in the file, and every transport, timer and clock injected by the
// caller.
//
// The rules that are structural rather than a matter of discipline:
//
//   1. The request body is built here and here only, and it has exactly one key:
//      `message`. The server derives the sender's name and score from the
//      authenticated identity and quietly ignores anything else it is given, so a
//      client that sent `username` or `score` would be re-introducing the
//      impersonation defect ISSUE-4 fixed. `buildSendBody` cannot express such a
//      body, and `createChatSender` refuses to call the transport at all for text
//      it will not post.
//   2. Nothing here invents a number. A row's score is whatever the server sent,
//      and a figure the server did not send is rendered as absent.
//   3. A failure is never reported as success, and the five real failure kinds
//      (no identity, rate-limited, refused, server fault, unreachable) are kept
//      pairwise distinct, because the fix differs for each and collapsing two of
//      them would be a lie the player could act on.
//   4. The player's text is never cut. The server stores at most 280 characters
//      per message and truncates silently on the way in, so a client that trimmed
//      an over-long message and reported it as written would be showing the
//      player text they did not write, with no way to tell. This app refuses
//      instead and says how long the message is - see `validateMessage`.
//   5. What the player typed only leaves the box when the server confirms it
//      stored that exact text. Until then the box keeps it, so a refusal never
//      looks like a delivery.

'use strict';

// The server's own bound, copied from backend/src/utils/helpers.js
// (`MAX_MESSAGE_LENGTH = 280`, applied with `trimmed.slice(0, 280)`). It is
// duplicated rather than imported because the mobile bundle cannot import from
// the backend tree; `test/chat.test.js` pins the value so a backend change that
// forgets this file fails a test instead of silently cutting players' text.
const MAX_MESSAGE_LENGTH = 280;

// The endpoint the web client and the socket path both already use.
const CHAT_SEND_ENDPOINT = '/api/chat/send';

// How often the leaderboard and chat are re-read while the screen is open.
//
// There is no socket on mobile: the web client has Socket.IO and this app talks
// REST only, so "live" here means "re-read on a bounded interval". Ten seconds is
// brisk enough that a conversation reads as a conversation and cheap enough that a
// phone does not hammer the API (twelve requests a minute: two endpoints, six
// reads). It is stated plainly in README.md, docs/API.md and docs/SETUP.md rather
// than being described as realtime, because it is not realtime.
const REFRESH_INTERVAL_MS = 10000;

// When every read fails, the interval doubles each time up to this ceiling and
// snaps back to REFRESH_INTERVAL_MS on the first read that works. Two minutes is
// the point past which a player who reconnects would rather press something than
// wait for the next tick.
const MAX_REFRESH_BACKOFF_MS = 120000;

// The outcome of a post attempt. Every value except SENT means the room did not
// accept the text, and the UI must say so.
const SEND_STATUS = Object.freeze({
  SENT: 'sent',
  INVALID: 'invalid',
  GUEST: 'guest',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate-limited',
  SERVER_ERROR: 'server-error',
  UNREACHABLE: 'unreachable',
  UNREADABLE: 'unreadable',
  ALTERED: 'altered',
});

// Why the composer would not even try to post. Distinct from SEND_STATUS because
// nothing reached the network at all.
const REASONS = Object.freeze({
  NOT_TEXT: 'not-text',
  EMPTY: 'empty',
  TOO_LONG: 'too-long',
});

const TONES = Object.freeze({
  WIN: 'win',
  ERROR: 'error',
  INFO: 'info',
});

// The same sentence the web client shows for this case
// (frontend/src/App.jsx: 'Sign in to join the global chat.'), because the same
// refusal on two platforms should read the same way. Note that it contains no
// success vocabulary at all - see SUCCESS_VOCABULARY below.
const GUEST_POST_REFUSAL = 'Sign in to join the global chat.';

// Wording that would claim a message reached the room. No refusal notice may use
// any of it; `test/chat.test.js` asserts that over every failure status so a
// future edit cannot slip one in. Kept here so the test and the module agree by
// construction rather than by a copied list.
const SUCCESS_VOCABULARY = Object.freeze(['sent', 'posted', 'delivered', 'published', 'submitted']);

function messageOf(error) {
  if (!error) return 'unknown error';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * Check a message the player typed, without changing it.
 *
 * Length is counted in UTF-16 code units (`String.prototype.length`), which is
 * exactly the unit the server's `slice(0, 280)` cuts on. Counting "characters"
 * instead would be a trap: an emoji is one character to a player and two code
 * units to `slice`, so a 280-character draft made of emoji would pass a
 * code-point check and still be cut in half by the server. Measuring the way the
 * server measures is the only way to promise that what is posted is what was
 * typed.
 *
 * Returns `{ ok: true, message }` or `{ ok: false, reason, length }`. It never
 * returns a shortened message: refusing is the point.
 */
function validateMessage(value) {
  if (typeof value !== 'string') {
    return { ok: false, reason: REASONS.NOT_TEXT, length: 0 };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: REASONS.EMPTY, length: 0 };
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, reason: REASONS.TOO_LONG, length: trimmed.length };
  }

  return { ok: true, message: trimmed, length: trimmed.length };
}

/**
 * Build the POST body, or return null when the text must not be posted.
 *
 * Deliberately a fresh one-key object. The server takes `{ message }` only: the
 * display name is `resolveDisplayName(req.user)` and the score is read from the
 * stored user record, so `username`/`score` in a request body are ignored today
 * and would be an impersonation attempt the moment the server stopped ignoring
 * them (ISSUE-4, ISSUE-22). There is no code path here that can add them.
 */
function buildSendBody(value) {
  const check = validateMessage(value);
  if (!check.ok) return null;
  return { message: check.message };
}

function describeInvalid(check) {
  if (check.reason === REASONS.EMPTY) {
    return {
      tone: TONES.ERROR,
      headline: 'Type a message first.',
      detail: 'An empty message is refused by the server, so nothing was attempted.',
    };
  }
  if (check.reason === REASONS.TOO_LONG) {
    return {
      tone: TONES.ERROR,
      headline: `That message is ${check.length} characters. The server stores at most ${MAX_MESSAGE_LENGTH}.`,
      detail: 'Shorten it and press Send again. This app will not cut your text for you.',
    };
  }
  return {
    tone: TONES.ERROR,
    headline: 'That is not text this app can post.',
    detail: 'Nothing was attempted.',
  };
}

/**
 * Turn a failed transport result into something the player can act on.
 *
 * The five significant kinds stay separate: a guest needs an identity, a 429
 * needs a moment, a 400 needs different text, a 5xx needs the operator, and an
 * unreachable host needs the API address checking. Every notice is written
 * WITHOUT success vocabulary, because a player who reads "sent" and sees nothing
 * in the room has been lied to.
 */
function classifyFailure(result) {
  if (!result) {
    return {
      status: SEND_STATUS.UNREADABLE,
      notice: {
        tone: TONES.ERROR,
        headline: 'The send produced no answer at all.',
        detail: 'Treat this as not written to the room. Your text is still in the box.',
      },
    };
  }

  if (result.kind === 'transport') {
    return {
      status: SEND_STATUS.UNREACHABLE,
      notice: {
        tone: TONES.ERROR,
        headline: 'The server cannot be reached, so the message went nowhere.',
        detail:
          'Your text is still in the box. Check the API address in the app configuration and your connection, then try again.',
      },
    };
  }

  if (result.kind === 'malformed') {
    return {
      status: SEND_STATUS.UNREADABLE,
      notice: {
        tone: TONES.ERROR,
        headline: 'The server answered in a way this app could not read.',
        detail:
          'Nothing is confirmed either way, so treat this as not written to the room. Your text is still in the box.',
      },
    };
  }

  const status = typeof result.status === 'number' ? result.status : null;

  if (status === 401 || status === 403) {
    return {
      status: SEND_STATUS.GUEST,
      notice: {
        tone: TONES.ERROR,
        headline: GUEST_POST_REFUSAL,
        detail:
          'Reading the room needs no identity; writing to it does. Your text is still in the box.',
      },
    };
  }

  if (status === 429) {
    return {
      status: SEND_STATUS.RATE_LIMITED,
      notice: {
        tone: TONES.ERROR,
        headline: 'The server is rate-limiting chat right now.',
        detail:
          'Nothing was accepted into the room. Your text is still in the box - wait a moment and try again.',
      },
    };
  }

  if (status !== null && status >= 500) {
    return {
      status: SEND_STATUS.SERVER_ERROR,
      notice: {
        tone: TONES.ERROR,
        headline: 'The server failed while handling that message.',
        detail:
          'This is a server fault, not a judgement on what you wrote. Your text is still in the box; try again shortly.',
      },
    };
  }

  // 400 and anything else the server actively refused. The server's own sentence
  // is preferred when it sent one, because it is more specific than anything this
  // module could invent.
  return {
    status: SEND_STATUS.REJECTED,
    notice: {
      tone: TONES.ERROR,
      headline: result.message || `The server refused that message (HTTP ${status === null ? '?' : status}).`,
      detail: 'Your text is still in the box.',
    },
  };
}

/**
 * Read the server's own idea of the accepted message out of a 200 response.
 *
 * A 200 is not enough on its own: if `payload.message` is missing or shapeless,
 * the app does not know what was stored and must not claim anything.
 */
function readAcceptedEntry(payload) {
  const entry = payload && payload.message;
  if (!entry || typeof entry !== 'object') return null;

  const message = typeof entry.message === 'string' ? entry.message : '';
  const username = typeof entry.username === 'string' ? entry.username.trim() : '';
  if (!message || !username) return null;

  return {
    username,
    message,
    score: Number.isInteger(entry.score) ? entry.score : null,
  };
}

/**
 * Decide what a completed post attempt means, from the transport result and the
 * text that was submitted.
 *
 * `submitted` is compared with what the server says it stored. The client refuses
 * to send over-long text, so a mismatch can only mean the server altered the
 * message (a changed bound, a sanitiser, a proxy); reporting that as success
 * would show the player a message they did not write and call it theirs.
 */
function classifySendResult({ result, submitted } = {}) {
  if (!result || result.ok !== true) {
    return { ok: false, ...classifyFailure(result) };
  }

  const entry = readAcceptedEntry(result.payload || result);
  if (!entry) {
    return {
      ok: false,
      status: SEND_STATUS.UNREADABLE,
      notice: {
        tone: TONES.ERROR,
        headline: 'The server accepted the request but did not say what it stored.',
        detail: 'Treat this as not confirmed. Your text is still in the box.',
      },
    };
  }

  if (entry.message !== submitted) {
    return {
      ok: false,
      status: SEND_STATUS.ALTERED,
      entry,
      notice: {
        tone: TONES.ERROR,
        headline: 'The server stored different text than the one you typed.',
        detail: 'The room now shows what the server stored. Your text is still in the box.',
      },
    };
  }

  return {
    ok: true,
    status: SEND_STATUS.SENT,
    entry,
    // Only reached when the server really did store this exact text, so this is
    // the one place the app is allowed to say so.
    notice: {
      tone: TONES.WIN,
      headline: `Sent as ${entry.username}.`,
      detail: 'The room below is re-read from the server, not echoed locally.',
    },
  };
}

/**
 * A sender bound to one injected transport.
 *
 * `post(body)` is injected (App.js passes gameClient's POST) and must resolve to
 * the gameClient result shape: `{ ok: true, payload }` or
 * `{ ok: false, kind, status, message }`. It is called only for text this module
 * has already agreed to post, and it is always called with exactly the object
 * `buildSendBody` returned.
 */
function createChatSender({ post } = {}) {
  if (typeof post !== 'function') {
    throw new TypeError('createChatSender needs a post transport');
  }

  async function send(value) {
    const body = buildSendBody(value);
    if (!body) {
      const check = validateMessage(value);
      return { ok: false, status: SEND_STATUS.INVALID, notice: describeInvalid(check) };
    }

    let result;
    try {
      result = await post(body);
    } catch (error) {
      // A transport that throws is an unreachable server, never a crash and never
      // a success.
      result = { ok: false, kind: 'transport', cause: messageOf(error) };
    }

    return classifySendResult({ result, submitted: body.message });
  }

  return { send };
}

function summariseFailure(result) {
  if (!result) return { kind: 'unknown', status: null, message: null };
  if (result.kind === 'transport') return { kind: 'transport', status: null, message: null };
  if (result.kind === 'malformed') {
    return { kind: 'malformed', status: typeof result.status === 'number' ? result.status : null, message: null };
  }
  if (result.kind === 'http') {
    return {
      kind: 'http',
      status: typeof result.status === 'number' ? result.status : null,
      message: typeof result.message === 'string' ? result.message : null,
    };
  }
  return { kind: 'unknown', status: null, message: null };
}

function defaultTimers() {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    now: () => Date.now(),
  };
}

/**
 * Keep the shared views (leaderboard + chat) current while the screen is open.
 *
 * The promises, the timer functions and the clock are injected, so the whole
 * schedule is deterministic under `node --test` with no real waiting.
 *
 * The guarantees, each of which has its own test:
 *
 *   - **Bounded interval.** One tick at a time, re-armed after the previous cycle
 *     finishes, so the period is "interval plus however long the read took"
 *     rather than a fixed-rate timer that can pile up.
 *   - **No overlap, and therefore no stale overwrite.** At most one request cycle
 *     is ever in flight: every entry point (`refreshNow` and the timer tick) joins
 *     one serialised queue, and a tick that arrives while the queue is busy is
 *     counted and skipped rather than started. Serialising is what makes a slower,
 *     older response unable to land on top of a newer one - a second read cannot
 *     even begin until the first has been applied. `onSnapshot` is the only place
 *     a caller may take new state, and it is called from inside that queue in
 *     issue order, so the last thing a caller is told is always the newest read.
 *     (`test/chat.test.js` drives a slow read and a fast read and asserts the
 *     applied order, so removing the serialisation fails a named check.)
 *   - **Backoff.** If every source fails, the delay doubles up to
 *     `maxBackoffMs`; the first success snaps it back. A partial success (say, the
 *     chat read worked and the leaderboard did not) counts as a success for the
 *     schedule and is reported per source.
 *   - **Nothing after stop.** `stop()` clears the pending timer, hard-stops the
 *     queue and bumps a generation counter, so a cycle that was already in flight
 *     when the screen went away discards its result instead of setting state on a
 *     dead screen (or on a screen that has since been resumed and re-read).
 *   - **A failed read never clears good data.** Sources that failed come back as
 *     `null`, which the caller treats as "keep what is on screen".
 */
function createSharedRefresher(options = {}) {
  const {
    loadLeaderboard,
    loadChat,
    onSnapshot = () => {},
    timers = defaultTimers(),
    intervalMs = REFRESH_INTERVAL_MS,
    maxBackoffMs = MAX_REFRESH_BACKOFF_MS,
  } = options;

  if (typeof loadLeaderboard !== 'function' || typeof loadChat !== 'function') {
    throw new TypeError('a refresher needs loadLeaderboard and loadChat');
  }
  if (!(intervalMs > 0)) {
    throw new TypeError('intervalMs must be a positive number');
  }
  if (!(maxBackoffMs >= intervalMs)) {
    throw new TypeError('maxBackoffMs must be at least intervalMs');
  }

  let timer = null;
  let stopped = true;
  // Bumped on stop(). A cycle carries the generation it started in, and applies
  // its result only if that generation is still current - so a response that
  // arrives after the screen went away is dropped, and so is one that outlived a
  // stop/start and would otherwise land on fresher state.
  let generation = 0;
  let inFlight = 0;
  let queued = 0;
  let tail = Promise.resolve(null);

  let delay = intervalMs;
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastAttemptAt = null;
  let skippedTicks = 0;
  let staleResponses = 0;
  let cycles = 0;
  let applied = 0;

  function clearTimer() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    if (stopped) return;
    clearTimer();
    timer = timers.setTimeout(() => {
      timer = null;
      onTimer();
    }, delay);
  }

  function onTimer() {
    if (stopped) return;
    if (inFlight > 0 || queued > 0) {
      // Never overlap. Not "queue it anyway": a backlog of ticks against a slow or
      // failing server is exactly how a fixed-rate timer piles up. Skip and come
      // back on the next interval.
      skippedTicks += 1;
      schedule();
      return;
    }

    refreshNow('interval').then(
      () => schedule(),
      () => schedule()
    );
  }

  async function execute(reason) {
    const startedIn = generation;
    const seq = (cycles += 1);
    inFlight += 1;
    lastAttemptAt = timers.now();

    let board;
    let messages;
    try {
      // Independent reads: one failing must not take the other down, and neither
      // may reject the cycle.
      const settled = await Promise.all([
        Promise.resolve()
          .then(() => loadLeaderboard())
          .catch((error) => ({ ok: false, kind: 'transport', cause: messageOf(error) })),
        Promise.resolve()
          .then(() => loadChat())
          .catch((error) => ({ ok: false, kind: 'transport', cause: messageOf(error) })),
      ]);
      board = settled[0];
      messages = settled[1];
    } finally {
      inFlight -= 1;
    }

    if (stopped || startedIn !== generation) {
      // The screen is gone, or was restarted while this read was in flight. The
      // result is older than current state and must not be applied.
      staleResponses += 1;
      return null;
    }

    const at = timers.now();
    const snapshot = {
      at,
      reason,
      sequence: seq,
      leaderboard: board && board.ok === true ? board.rows : null,
      chat: messages && messages.ok === true ? messages.messages : null,
      leaderboardFailure: board && board.ok === true ? null : summariseFailure(board),
      chatFailure: messages && messages.ok === true ? null : summariseFailure(messages),
    };

    const anyOk = snapshot.leaderboard !== null || snapshot.chat !== null;
    if (anyOk) {
      consecutiveFailures = 0;
      delay = intervalMs;
      lastSuccessAt = at;
    } else {
      consecutiveFailures += 1;
      delay = Math.min(maxBackoffMs, delay * 2);
    }

    // The delay that is now armed, carried on the snapshot so the caller can say
    // "retrying in N s" without reaching back into this object (which would make
    // the caller's render depend on mutable state it does not own).
    snapshot.nextDelayMs = delay;
    snapshot.consecutiveFailures = consecutiveFailures;
    snapshot.skippedTicks = skippedTicks;

    // Applied while still holding the queue, in issue order: the caller is told
    // about reads in the order they were issued, so it can never be handed an
    // older answer after a newer one.
    applied = seq;
    onSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Serialised entry point. Every read - timer or manual - joins this one chain,
   * so two cycles can never be in flight at the same time.
   */
  function refreshNow(reason = 'manual') {
    if (stopped) return Promise.resolve(null);

    queued += 1;
    const run = tail.then(
      () => {
        queued -= 1;
        if (stopped) return null;
        return execute(reason);
      },
      () => {
        queued -= 1;
        return null;
      }
    );
    // The chain must survive a rejected cycle: a single failure cannot disable the
    // schedule.
    tail = run.then(
      () => null,
      () => null
    );
    return run;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      delay = intervalMs;
      consecutiveFailures = 0;
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      clearTimer();
    },
    isRunning() {
      return !stopped;
    },
    /** Read both sources now, serialised behind anything already running. */
    refreshNow,
    nextDelayMs() {
      return delay;
    },
    lastSuccessAt() {
      return lastSuccessAt;
    },
    stats() {
      return {
        cycles,
        applied,
        inFlight,
        queued,
        skippedTicks,
        staleResponses,
        consecutiveFailures,
        delayMs: delay,
        lastSuccessAt,
        lastAttemptAt,
        running: !stopped,
        generation,
      };
    },
  };
}

/**
 * Say, in words, how current what is on screen is.
 *
 * A screen that claims to be live must be able to say when it last read, so this
 * is rendered next to the two shared cards.
 */
function formatFreshness({ lastSuccessAt, now, intervalMs = REFRESH_INTERVAL_MS } = {}) {
  const seconds = Math.max(1, Math.round(intervalMs / 1000));

  // Explicitly null/undefined, not falsy: a real timestamp of 0 (the epoch) is a
  // successful read, and treating it as "never read" would be wrong.
  if (lastSuccessAt === null || lastSuccessAt === undefined || !Number.isFinite(lastSuccessAt)) {
    return `Shared state has not been read yet; this screen re-reads it every ${seconds} s.`;
  }

  const ageMs = Math.max(0, now - lastSuccessAt);
  const age = ageMs < 1000 ? 'just now' : `${Math.round(ageMs / 1000)} s ago`;
  return `Shared state updated ${age}. This screen re-reads the leaderboard and chat every ${seconds} s while it is open.`;
}

/**
 * Explain a refresh that did not fully work, or return null when it did.
 *
 * The distinction that matters to a player is unreachable vs refused vs
 * unreadable, and the message says explicitly that the old data is still on
 * screen - otherwise "could not refresh" reads as "there is nothing there".
 */
function describeRefreshFailure(snapshot, { nextDelayMs = null } = {}) {
  if (!snapshot) return null;

  const failures = [snapshot.leaderboardFailure, snapshot.chatFailure].filter(Boolean);
  if (failures.length === 0) return null;

  const both = failures.length === 2;
  const subject = both ? 'The leaderboard and chat' : snapshot.chatFailure ? 'The chat' : 'The leaderboard';

  const anyTransport = failures.some((failure) => failure.kind === 'transport');
  const anyUnreadable = failures.some(
    (failure) => failure.kind === 'malformed' || failure.kind === 'unknown'
  );
  const statuses = failures
    .map((failure) => failure.status)
    .filter((status) => typeof status === 'number');

  let reason;
  if (anyTransport) {
    reason = 'the server cannot be reached';
  } else if (statuses.includes(429)) {
    reason = 'the server is rate-limiting this app';
  } else if (anyUnreadable) {
    reason = 'the server answered in a way this app could not read';
  } else if (statuses.length) {
    reason = `the server refused the read (HTTP ${statuses[0]})`;
  } else {
    reason = 'the read failed';
  }

  const retry =
    typeof nextDelayMs === 'number' && nextDelayMs > 0
      ? ` Retrying in ${Math.round(nextDelayMs / 1000)} s.`
      : '';

  return `${subject} could not be refreshed because ${reason}, so what is on screen is the last good read.${retry}`;
}

/**
 * One chat row as a single string, for rendering as a React Native <Text> child.
 *
 * A <Text> child is text and never markup, so a message containing
 * `<img onerror=...>` is displayed as those characters. The score shown is the
 * server's own `score` field and is omitted when the server sent none or sent
 * zero, so the app never invents a figure.
 */
function composeChatLine(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const username = typeof source.username === 'string' && source.username.trim() ? source.username.trim() : 'Player';
  const message = typeof source.message === 'string' ? source.message : '';
  const score = Number.isInteger(source.score) && source.score > 0 ? ` (${source.score})` : '';
  return `${username}${score}: ${message}`;
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  CHAT_SEND_ENDPOINT,
  REFRESH_INTERVAL_MS,
  MAX_REFRESH_BACKOFF_MS,
  SEND_STATUS,
  REASONS,
  TONES,
  GUEST_POST_REFUSAL,
  SUCCESS_VOCABULARY,
  validateMessage,
  buildSendBody,
  classifyFailure,
  classifySendResult,
  createChatSender,
  createSharedRefresher,
  formatFreshness,
  describeRefreshFailure,
  composeChatLine,
};
