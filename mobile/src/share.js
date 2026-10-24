// Social sharing for a completed round - the mobile half.
//
// Background. README line 3 describes the product as a number guessing game
// "with live chat, scoring, daily bonuses, and social sharing. Available on web,
// iPhone, and Android." The web app got a real, tested share affordance in
// db2ddc1 (see frontend/src/share.js). Mobile got none: App.js had no share
// control, no Share import and no share text, so a phone player who finished a
// round - win or loss - had no way to post it. The claim applied to one of the
// three platforms it named.
//
// This module is the mobile equivalent, and it exists for the same reason its
// web counterpart does: the two decisions worth testing are separable from the
// UI.
//
//   1. What the share text SAYS. `buildShareText` composes it from the guess
//      response only. Scoring is server-authoritative (ISSUE-24), so the text
//      quotes `attempts`, `maxAttempts`, `awarded`, `score`, `bestScore` and
//      `streak` exactly as the API returned them and never recomputes points. A
//      value the server did not send is DROPPED, never defaulted to something
//      plausible.
//
//   2. HOW the text is shared. The transport is not this module's business: the
//      caller injects the capabilities the platform really has (`nativeSheet`,
//      `webShare`, `clipboard`) as plain functions, and `shareResult` reports
//      what actually happened. That keeps this file free of React Native and
//      Expo imports, so `node --test` exercises the same bytes that ship.
//
// Three honesty rules, all inherited from the web contract and all tested:
//
//   - a guest win says plainly that no points were recorded - it must never read
//     as a score;
//   - a loss says the round ended and nothing was scored, even though the server
//     sends `awarded: 0` for a scored loss (saying "scored 0 points" would be a
//     score claim, and it is the number a client-side recompute would inflate);
//   - a round that is not finished (a too-low/too-high hint) offers nothing to
//     share at all.
//
// Transport honesty is the third: a dismissed share sheet is a CANCEL - not a
// success and not a failure; a transport that is simply absent is a CAPABILITY
// GAP; and a copy is reported only when the clipboard write really resolved.
// There is deliberately no `document.execCommand('copy')` fallback (it reports
// success on browsers that quietly refuse, turning a failed copy into a lie),
// and nothing here builds HTML or DOM - the text is composed with template
// strings and is only ever rendered as a React Native <Text> child.
//
// CommonJS on purpose, like src/gameClient.js and src/config.js: the same file is
// loaded by `node --test` (no transform step) and by App.js through the normal
// Babel interop.
//
// A NOTE ON THE TWO SHARE-WORTHY DEFECTS THIS FILE MUST NOT REINTRODUCE:
//
//   - Recomputation is INVISIBLE ON A WIN. `Math.max(20, 100 - attempts * 8)` is
//     numerically identical to the server's award for the same attempt count, so
//     a client that recomputes produces byte-identical text on a win. Only a
//     LOSS discriminates: the server sends `awarded: 0` while the formula yields
//     20. The loss case below therefore quotes nothing and claims nothing, and
//     test/share.test.js asserts the loss text carries no computed figure.
//
//   - A guest round must not be dressed up as scored. `scored: true` from the
//     server - not the mere presence of a number - is what permits a points
//     claim, so a stray `awarded` on an unscored payload is discarded.

/** Hard cap on the composed text. Keeps a share inside every target's limit. */
const MAX_SHARE_LENGTH = 280;

/** Usernames come from the player; the backend bounds them the same way. */
const MAX_DISPLAY_NAME_LENGTH = 32;

/** A page/app address longer than this is not a real one; refuse to embed it. */
const MAX_ORIGIN_LENGTH = 100;

const FALLBACK_DISPLAY_NAME = 'A player';

/** Identity modes, mirroring src/gameClient.js. Kept local so this file is standalone. */
const IDENTITY = Object.freeze({
  GUEST: 'guest',
  AUTHENTICATED: 'authenticated',
  UNKNOWN: 'unknown',
});

/** Which transport `shareResult` will use. */
const SHARE_STRATEGIES = Object.freeze({
  NATIVE_SHEET: 'native-sheet',
  WEB_SHARE: 'web-share',
  CLIPBOARD: 'clipboard',
  UNAVAILABLE: 'unavailable',
});

/** What actually happened. `CANCELLED` is neither success nor failure. */
const SHARE_STATUS = Object.freeze({
  SHARED: 'shared',
  COPIED: 'copied',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
});

// Player-facing outcomes. Every message states what happened and, when nothing
// happened, what the player can do instead.
const SHARE_MESSAGES = Object.freeze({
  shared: 'Shared.',
  copied: 'Result copied to the clipboard.',
  cancelled: 'Share cancelled - nothing was sent.',
  unavailable:
    'This device offers no share sheet and no clipboard access, so the result cannot be shared from here. Select the text above to copy it manually.',
  failed:
    'Sharing did not complete. Select the text above to copy it manually.',
  nothingToShare: 'Finish a round before sharing a result.',
});

function finiteCountOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pluraliseAttempts(attempts) {
  return attempts === 1 ? '1 attempt' : `${attempts} attempts`;
}

/**
 * Reduce a player-supplied name to something safe to publish.
 *
 * Returns null when there is nothing publishable, so the caller falls back to a
 * neutral label. An email address is PII and is never a display name (the same
 * rule `resolveDisplayName` enforces server-side for chat), so a value that looks
 * like an address is rejected instead of being published at the player's
 * expense. Control characters are stripped and the length is bounded in code
 * points, so clipping cannot leave a broken surrogate pair behind.
 */
function sanitiseDisplayName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const collapsed = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!collapsed) {
    return null;
  }

  if (collapsed.includes('@')) {
    return null;
  }

  const codePoints = Array.from(collapsed);
  if (codePoints.length <= MAX_DISPLAY_NAME_LENGTH) {
    return collapsed;
  }

  return codePoints.slice(0, MAX_DISPLAY_NAME_LENGTH).join('').trim();
}

/**
 * Accept only a real http(s) origin.
 *
 * The web app embeds `window.location.origin`; the exported web build of this app
 * can do the same. A NATIVE build has no origin to embed - a phone app is not
 * served from a URL - so the caller passes null and the link clause is omitted
 * rather than a domain being invented for a deployment that may not exist.
 */
function sanitiseOrigin(origin) {
  if (typeof origin !== 'string') {
    return null;
  }

  const trimmed = origin.trim().replace(/\/+$/, '');

  // `window.location.origin` is scheme + host + optional port and nothing else:
  // no path, no query, no fragment. Rejecting those keeps a caller-supplied
  // string from smuggling a path or parameters into the share link.
  if (!/^https?:\/\/[^\s/?#]+$/i.test(trimmed)) {
    return null;
  }

  if (trimmed.length > MAX_ORIGIN_LENGTH) {
    return null;
  }

  return trimmed;
}

/**
 * Classify a guess response.
 *
 * Returns null for any response that is not a COMPLETED round - a too-low or
 * too-high hint is mid-round, and offering to "share" it would be nonsense.
 *
 * The three cases the product has to describe honestly:
 *
 *   scored-win - the round was bound to an authenticated player and the server
 *                returned authoritative `awarded`/`score`/`bestScore`/`streak`.
 *   guest-win  - the round was never scored (`scored` absent or false), so
 *                nothing was recorded. The text must not imply points.
 *   loss       - the round ended out of attempts. `awarded` is 0 for a scored
 *                loss, but quoting "0 points" would still be a score claim - and
 *                it is exactly the field a client-side recompute inflates to 20 -
 *                so no award is carried at all.
 *
 * Only `scored: true` unlocks the totals. A number that arrives on an unscored
 * payload is discarded here rather than trusted downstream.
 */
function classifyOutcome(outcome) {
  const source = outcome && typeof outcome === 'object' ? outcome : {};
  const result = typeof source.result === 'string' ? source.result : null;

  // Belt and braces: a caller that explicitly marks the round unfinished is
  // refused even if it also carries a terminal `result`.
  if (source.finished === false) {
    return null;
  }

  const attempts = finiteCountOrNull(source.attempts);
  const maxAttempts = finiteCountOrNull(source.maxAttempts);
  const scored = source.scored === true;

  if (result === 'correct') {
    return {
      kind: scored ? 'scored-win' : 'guest-win',
      scored,
      attempts,
      maxAttempts,
      // Only a scored round has totals; an unscored round has none to quote.
      awarded: scored ? finiteCountOrNull(source.awarded) : null,
      score: scored ? finiteCountOrNull(source.score) : null,
      bestScore: scored ? finiteCountOrNull(source.bestScore) : null,
      streak: scored ? finiteCountOrNull(source.streak) : null,
    };
  }

  if (result === 'round-over') {
    return {
      kind: 'loss',
      scored,
      attempts,
      maxAttempts,
      // Deliberately nothing, even when the server sent `awarded: 0`.
      awarded: null,
      score: null,
      bestScore: null,
      streak: null,
    };
  }

  return null;
}

function attemptClause(classified) {
  if (classified.attempts !== null && classified.maxAttempts !== null) {
    return `${classified.attempts} of ${classified.maxAttempts} attempts`;
  }
  if (classified.attempts !== null) {
    return pluraliseAttempts(classified.attempts);
  }
  return null;
}

function composeShareText(classified, displayName, origin, identity) {
  const who = displayName || FALLBACK_DISPLAY_NAME;
  const link = origin ? ` Play at ${origin} (this app's address).` : '';
  const effort = attemptClause(classified);

  if (classified.kind === 'scored-win') {
    // The attempt clause quotes the server's own count. When the server did not
    // report a budget we say "in N attempts" rather than invent a maximum.
    const clause = effort
      ? `guessed the number in ${effort}`
      : 'guessed the number';

    const parts = [`${who} ${clause}`];

    // Every remaining clause is conditional on the server having sent the value:
    // an absent number is dropped, never recomputed from the attempt count.
    if (classified.awarded !== null) {
      parts.push(`and scored ${classified.awarded} points`);
    }

    const totals = [];
    if (classified.score !== null) totals.push(`total ${classified.score}`);
    if (classified.bestScore !== null) totals.push(`best ${classified.bestScore}`);
    if (classified.streak !== null) totals.push(`streak ${classified.streak}`);

    let sentence = parts.join(' ');
    if (totals.length > 0) {
      sentence += ` (${totals.join(', ')})`;
    }

    return `${sentence}.${link}`;
  }

  if (classified.kind === 'guest-win') {
    // Honesty constraint: an unscored round has no stored record, so the text
    // says plainly that no points were recorded. The wording distinguishes a
    // genuine guest from an authenticated player the server failed to score,
    // because telling a signed-in player they were "a guest" is its own lie.
    const clause = effort ? `guessed the number in ${effort}` : 'guessed the number';
    const suffix =
      identity === IDENTITY.GUEST
        ? 'as a guest, so no points were recorded'
        : 'but the server did not record any points for the round';

    return `${who} ${clause} ${suffix}.${link}`;
  }

  // loss - the round ended out of attempts. No points claimed, quoted or implied.
  const detail = effort ? ` (${effort})` : '';

  return `${who} ran out of attempts${detail} and scored nothing.${link}`;
}

/**
 * Compose the text a player shares. Pure: no transport, no fetch, no globals.
 *
 * `outcome` is the guess response (or the normalised subset gameClient keeps).
 * `displayName` is the player's own chosen name - never an email, and an
 * email-shaped value is rejected. `origin` is the app's own address, passed in by
 * the caller (null on native). `identity` is the session mode, used only to word
 * an unscored win correctly.
 *
 * Returns null when there is nothing shareable (round not finished).
 */
function buildShareText({ outcome, displayName, username, origin, identity } = {}) {
  const classified = classifyOutcome(outcome);

  if (!classified) {
    return null;
  }

  const mode = typeof identity === 'string' ? identity : IDENTITY.UNKNOWN;
  const safeOrigin = sanitiseOrigin(origin);
  // `username` is accepted as an alias so a caller carrying the web app's naming
  // convention cannot accidentally publish an unsanitised name.
  const safeName = sanitiseDisplayName(
    typeof displayName === 'string' ? displayName : username
  );

  let text = composeShareText(classified, safeName, safeOrigin, mode);

  if (text.length > MAX_SHARE_LENGTH) {
    // Only reachable with a pathological name or totals, but the bound is
    // enforced here rather than trusted: rebuild with the neutral label first so
    // a clipped sentence does not swallow the app address.
    text = composeShareText(classified, FALLBACK_DISPLAY_NAME, safeOrigin, mode);
  }

  if (text.length > MAX_SHARE_LENGTH) {
    text = `${text.slice(0, MAX_SHARE_LENGTH - 1).trimEnd()}\u2026`;
  }

  return text;
}

/**
 * Read share capabilities from injected transports.
 *
 * Nothing is touched at module load and no global is read: on web the caller
 * passes `navigator.share` / `navigator.clipboard.writeText` wrappers, on native
 * it passes React Native's `Share.share`. A transport that is absent is simply
 * not a key - which is what makes "no transport" testable without a device.
 */
function detectShareCapabilities(transports) {
  const source = transports && typeof transports === 'object' ? transports : {};

  return {
    nativeSheet: typeof source.nativeSheet === 'function',
    webShare: typeof source.webShare === 'function',
    clipboard: typeof source.clipboard === 'function',
  };
}

/**
 * Prefer the platform's real share sheet, then the web share sheet, then the
 * clipboard, then admit defeat.
 *
 * The native sheet comes first because on iOS/Android it is the OS share UI the
 * player expects; on web there is no `nativeSheet` key, so `webShare` wins.
 */
function chooseShareStrategy(capabilities) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};

  if (caps.nativeSheet === true) return SHARE_STRATEGIES.NATIVE_SHEET;
  if (caps.webShare === true) return SHARE_STRATEGIES.WEB_SHARE;
  if (caps.clipboard === true) return SHARE_STRATEGIES.CLIPBOARD;
  return SHARE_STRATEGIES.UNAVAILABLE;
}

/**
 * Build the transports object for the running platform.
 *
 * Pure and injectable: `scope` is the global-ish object that holds `navigator`
 * (on web: `globalThis`), and `nativeShare` is React Native's `Share.share`
 * passed in by App.js. Neither is touched at module load, so this is testable
 * off-device and App.js stays a thin adapter.
 *
 * What the platform really has is what gets reported - there is no "assume web
 * has a share sheet" step:
 *
 *   web    - `navigator.share` and/or `navigator.clipboard.writeText`, each only
 *            when it is genuinely a function. React Native Web's `Share` is
 *            deliberately NOT used here: it delegates to `navigator.share`
 *            anyway and, when that is absent, rejects with
 *            "Share is not supported in this browser", which would hide the real
 *            capability state from `detectShareCapabilities`.
 *   native - the OS share sheet, via React Native's `Share.share`. Only when a
 *            function was supplied.
 *
 * An empty object is a legitimate result and is what makes the honest
 * "this device cannot share" path reachable.
 */
function createShareTransports({ platform, scope, nativeShare } = {}) {
  const transports = {};

  if (platform === 'web') {
    const nav = scope && scope.navigator;

    if (nav && typeof nav.share === 'function') {
      transports.webShare = (text) => nav.share({ text });
    }

    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      transports.clipboard = (text) => nav.clipboard.writeText(text);
    }

    return transports;
  }

  // Native: iOS/Android share sheet. Resolves to `{ action }` where a dismissal
  // is `dismissedAction` - shareResult maps that to CANCELLED.
  if (typeof nativeShare === 'function') {
    transports.nativeSheet = (text) => nativeShare({ message: text });
  }

  return transports;
}

/**
 * The address to embed in the share text, or null.
 *
 * A web build is served from a URL, so its own origin is a real, working link. A
 * native build is not: a phone app has no browser origin, and inventing a domain
 * for a deployment that may not exist would be worse than sharing no link at all.
 */
function resolveShareOrigin({ platform, scope } = {}) {
  if (platform !== 'web') {
    return null;
  }

  const location = scope && scope.location;
  const origin = location && typeof location.origin === 'string' ? location.origin : null;
  return sanitiseOrigin(origin);
}

/** A share sheet the player closed. Not a success, and not a failure. */
function isCancellation(error) {
  const name = (error && error.name) || '';
  return name === 'AbortError' || name === 'CancelError';
}

/**
 * react-native-web's `Share.share` delegates to `window.navigator.share` and
 * REJECTS with `Error('Share is not supported in this browser')` when the
 * browser has no Web Share API. That rejection means "this platform cannot
 * share", not "the player cancelled" and not "the player's action failed" - the
 * message the player gets must reflect a capability gap.
 */
function isUnsupportedShareError(error) {
  const name = (error && error.name) || '';
  const message = (error && error.message) || '';

  if (name === 'NotSupportedError') return true;
  return /not supported in this browser/i.test(String(message));
}

async function copyToClipboard(clipboard, text) {
  try {
    await clipboard(text);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Perform the share and report what happened.
 *
 * Resolves to `{ status, message, strategy }` where status is one of
 * SHARE_STATUS. Never throws.
 *
 * The four outcomes are kept strictly distinct because collapsing any two of them
 * would be a lie the player could act on:
 *
 *   shared     - the sheet reported a real share
 *   copied     - `writeText` actually resolved
 *   cancelled  - the player dismissed the sheet (AbortError or dismissedAction)
 *   unavailable- no transport, or the sheet exists but the platform refuses to
 *                provide one - a capability gap, not a cancel
 *   failed     - a transport existed, was attempted, and did not complete
 *
 * A defensive clipboard attempt is made only when the share sheet errors, and the
 * player is told a copy happened only when the write really resolved.
 */
async function shareResult({ text, transports } = {}) {
  const value = typeof text === 'string' ? text.trim() : '';

  if (!value) {
    return {
      status: SHARE_STATUS.FAILED,
      message: SHARE_MESSAGES.nothingToShare,
      strategy: SHARE_STRATEGIES.UNAVAILABLE,
    };
  }

  const capabilities = detectShareCapabilities(transports);
  const strategy = chooseShareStrategy(capabilities);
  const clipboard = capabilities.clipboard ? transports.clipboard : null;

  if (strategy === SHARE_STRATEGIES.NATIVE_SHEET) {
    try {
      const result = await transports.nativeSheet(value);
      const action = result && typeof result === 'object' ? result.action : null;

      if (action === 'dismissedAction') {
        return {
          status: SHARE_STATUS.CANCELLED,
          message: SHARE_MESSAGES.cancelled,
          strategy,
        };
      }

      return { status: SHARE_STATUS.SHARED, message: SHARE_MESSAGES.shared, strategy };
    } catch (error) {
      if (isCancellation(error)) {
        return {
          status: SHARE_STATUS.CANCELLED,
          message: SHARE_MESSAGES.cancelled,
          strategy,
        };
      }

      if (isUnsupportedShareError(error)) {
        if (clipboard && (await copyToClipboard(clipboard, value))) {
          return {
            status: SHARE_STATUS.COPIED,
            message: SHARE_MESSAGES.copied,
            strategy: SHARE_STRATEGIES.CLIPBOARD,
          };
        }

        return {
          status: SHARE_STATUS.UNAVAILABLE,
          message: SHARE_MESSAGES.unavailable,
          strategy: SHARE_STRATEGIES.UNAVAILABLE,
        };
      }

      // The sheet was offered but refused (often "not allowed without a user
      // gesture", or no share targets). Fall back to the clipboard only when it
      // is genuinely usable, and say which one succeeded.
      if (clipboard && (await copyToClipboard(clipboard, value))) {
        return {
          status: SHARE_STATUS.COPIED,
          message: SHARE_MESSAGES.copied,
          strategy: SHARE_STRATEGIES.CLIPBOARD,
        };
      }

      return { status: SHARE_STATUS.FAILED, message: SHARE_MESSAGES.failed, strategy };
    }
  }

  if (strategy === SHARE_STRATEGIES.WEB_SHARE) {
    try {
      await transports.webShare(value);
      return { status: SHARE_STATUS.SHARED, message: SHARE_MESSAGES.shared, strategy };
    } catch (error) {
      if (isCancellation(error)) {
        return {
          status: SHARE_STATUS.CANCELLED,
          message: SHARE_MESSAGES.cancelled,
          strategy,
        };
      }

      if (isUnsupportedShareError(error)) {
        if (clipboard && (await copyToClipboard(clipboard, value))) {
          return {
            status: SHARE_STATUS.COPIED,
            message: SHARE_MESSAGES.copied,
            strategy: SHARE_STRATEGIES.CLIPBOARD,
          };
        }

        return {
          status: SHARE_STATUS.UNAVAILABLE,
          message: SHARE_MESSAGES.unavailable,
          strategy: SHARE_STRATEGIES.UNAVAILABLE,
        };
      }

      if (clipboard && (await copyToClipboard(clipboard, value))) {
        return {
          status: SHARE_STATUS.COPIED,
          message: SHARE_MESSAGES.copied,
          strategy: SHARE_STRATEGIES.CLIPBOARD,
        };
      }

      return { status: SHARE_STATUS.FAILED, message: SHARE_MESSAGES.failed, strategy };
    }
  }

  if (strategy === SHARE_STRATEGIES.CLIPBOARD) {
    if (await copyToClipboard(clipboard, value)) {
      return { status: SHARE_STATUS.COPIED, message: SHARE_MESSAGES.copied, strategy };
    }

    return { status: SHARE_STATUS.FAILED, message: SHARE_MESSAGES.failed, strategy };
  }

  return {
    status: SHARE_STATUS.UNAVAILABLE,
    message: SHARE_MESSAGES.unavailable,
    strategy: SHARE_STRATEGIES.UNAVAILABLE,
  };
}

module.exports = {
  MAX_SHARE_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ORIGIN_LENGTH,
  FALLBACK_DISPLAY_NAME,
  IDENTITY,
  SHARE_STRATEGIES,
  SHARE_STATUS,
  SHARE_MESSAGES,
  sanitiseDisplayName,
  sanitiseOrigin,
  classifyOutcome,
  buildShareText,
  detectShareCapabilities,
  chooseShareStrategy,
  createShareTransports,
  resolveShareOrigin,
  shareResult,
};
