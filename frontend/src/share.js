// Social sharing for a completed round.
//
// The product has always described itself as a number guessing game "with live
// chat, scoring, and social sharing" (README line 3), but nothing in the product
// could share anything: there was no share control, no Web Share call and no
// clipboard use anywhere in frontend/, backend/ or docs/. A player who wanted to
// post their result had to retype it by hand, which is also the only way they
// could accidentally invent a score.
//
// This module holds the two decisions that are worth testing on their own:
//
//   1. What the share text SAYS. `buildShareText` composes it from the guess
//      response only. Scoring is server-authoritative (ISSUE-24), so the text
//      must quote `attempts`, `awarded`, `score`, `bestScore` and `streak`
//      exactly as the API returned them and must never recompute points. If a
//      value is absent the corresponding claim is dropped rather than guessed.
//
//   2. HOW to share. `chooseShareStrategy` maps observed capability flags to a
//      strategy, and `shareResult` reports what actually happened. When the
//      browser offers neither a share sheet nor clipboard write access the
//      player is told so; the previous absence of any feedback is exactly the
//      "silently does nothing" failure this avoids. There is deliberately no
//      `document.execCommand('copy')` fallback: it reports success on browsers
//      that quietly refuse, which would turn a failed copy into a lie.
//
// The text is composed with template strings and is only ever rendered as a
// React text child, never through innerHTML or string-built DOM, so a player's
// chosen username cannot inject markup.
//
// Purity: this file has no top-level browser access and imports nothing
// Vite-only (no `import.meta.env`, no JSX), so `node --test` can import it
// directly. Browser objects are read through an injectable `scope` instead of
// being touched at module load.

/** Hard cap on the composed text. Keeps a share inside every target's limit. */
export const MAX_SHARE_LENGTH = 280;

/** Usernames come from the player; the backend bounds them the same way. */
export const MAX_DISPLAY_NAME_LENGTH = 32;

/** A page origin longer than this is not a real origin; refuse to embed it. */
export const MAX_ORIGIN_LENGTH = 100;

export const FALLBACK_DISPLAY_NAME = 'A player';

/** The share sheet was used, or the text was copied; both are honest successes. */
export const SHARE_STRATEGIES = Object.freeze({
  WEB_SHARE: 'web-share',
  CLIPBOARD: 'clipboard',
  UNAVAILABLE: 'unavailable',
});

export const SHARE_STATUS = Object.freeze({
  SHARED: 'shared',
  COPIED: 'copied',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  FAILED: 'failed',
});

// Player-facing outcomes. Every message states what happened and, when nothing
// happened, what the player can do instead.
export const SHARE_MESSAGES = Object.freeze({
  shared: 'Shared.',
  copied: 'Result copied to the clipboard.',
  cancelled: 'Share cancelled - nothing was sent.',
  unavailable:
    'This browser provides neither a share sheet nor clipboard access, so the result cannot be shared from here. Select the text above to copy it manually.',
  failed:
    'The browser would not copy the result. Select the text above to copy it manually.',
  nothingToShare: 'Finish a round before sharing a result.',
});

function currentScope() {
  return typeof globalThis === 'object' && globalThis ? globalThis : {};
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') {
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
 * rule `resolveDisplayName` enforces server-side for chat), so a value that
 * looks like an address is rejected instead of being published at the player's
 * expense. Control characters are stripped and the length is bounded in code
 * points, so clipping cannot leave a broken surrogate pair behind.
 */
export function sanitiseDisplayName(value) {
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
 * Accept only a real http(s) origin, since the share link is the page the player
 * is already on. Anything else is refused rather than guessed at: inventing a
 * domain for a deployment that does not exist would be worse than no link.
 */
export function sanitiseOrigin(origin) {
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
 * Returns null for any response that is not a COMPLETED round (a too-low or
 * too-high hint is mid-round, and offering to "share" it would be nonsense).
 *
 * The three cases the product has to describe honestly:
 *
 *   scored-win - the round was bound to an authenticated player, so the server
 *                returned authoritative `awarded`/`score`/`bestScore`/`streak`.
 *   guest-win  - the round was never bound to a player (`scored` absent), so
 *                nothing was recorded. The text must not imply points.
 *   loss       - the round ended out of attempts. `awarded` is 0 for a scored
 *                loss, and claiming points here would be a lie.
 */
export function classifyOutcome(outcome) {
  const source = outcome && typeof outcome === 'object' ? outcome : {};
  const attempts = finiteNumberOrNull(source.attempts);
  const maxAttempts = finiteNumberOrNull(source.maxAttempts);
  const scored = source.scored === true;

  if (source.result === 'correct') {
    return {
      kind: scored ? 'scored-win' : 'guest-win',
      scored,
      attempts,
      maxAttempts,
      // Only a scored round has totals; a guest round has none to quote.
      awarded: scored ? finiteNumberOrNull(source.awarded) : null,
      score: scored ? finiteNumberOrNull(source.score) : null,
      bestScore: scored ? finiteNumberOrNull(source.bestScore) : null,
      streak: scored ? finiteNumberOrNull(source.streak) : null,
    };
  }

  if (source.result === 'round-over') {
    return {
      kind: 'loss',
      scored,
      attempts,
      maxAttempts,
      awarded: null,
      score: null,
      bestScore: null,
      streak: null,
    };
  }

  return null;
}

function composeShareText(classified, displayName, origin) {
  const who = displayName || FALLBACK_DISPLAY_NAME;
  const link = origin ? ` Play at ${origin} (this app's address).` : '';
  const ofBudget =
    classified.attempts !== null && classified.maxAttempts !== null
      ? `${classified.attempts} of ${classified.maxAttempts}`
      : null;

  if (classified.kind === 'scored-win') {
    // The attempt clause quotes the server's own attempt count. When the server
    // did not report a budget we still say "in N attempts" rather than invent a
    // maximum.
    const clause = ofBudget
      ? `guessed the number in ${ofBudget} attempts`
      : `guessed the number in ${pluraliseAttempts(classified.attempts)}`;

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
    // Honesty constraint: a guest round has no stored record, so the text says
    // plainly that no points were recorded. It must never read as a score.
    const effort = ofBudget
      ? `in ${ofBudget} attempts`
      : classified.attempts !== null
        ? `in ${pluraliseAttempts(classified.attempts)}`
        : 'without signing in';

    return `${who} guessed the number ${effort} as a guest, so no points were recorded.${link}`;
  }

  // loss - the round ended out of attempts. No points claim of any kind.
  const effort = ofBudget
    ? ` (${ofBudget})`
    : classified.attempts !== null
      ? ` after ${pluraliseAttempts(classified.attempts)}`
      : '';

  return `${who} ran out of attempts${effort} and scored nothing.${link}`;
}

/**
 * Compose the text a player shares. Pure: no browser objects, no fetch.
 *
 * `outcome` is the guess response (or the subset the SPA kept). `username` is
 * the player's own chosen name - never an email, and an email-shaped value is
 * rejected. `origin` is `window.location.origin`, passed in by the caller so
 * this module stays testable outside a browser.
 *
 * Returns null when there is nothing shareable (round not finished).
 */
export function buildShareText({ outcome, username, origin } = {}) {
  const classified = classifyOutcome(outcome);

  if (!classified) {
    return null;
  }

  const safeOrigin = sanitiseOrigin(origin);
  let text = composeShareText(
    classified,
    sanitiseDisplayName(username),
    safeOrigin
  );

  if (text.length > MAX_SHARE_LENGTH) {
    // Only reachable with a pathological name, but the bound is enforced here
    // rather than trusted: rebuild with the neutral label first so a clipped
    // sentence does not swallow the app address.
    text = composeShareText(classified, FALLBACK_DISPLAY_NAME, safeOrigin);
  }

  if (text.length > MAX_SHARE_LENGTH) {
    text = `${text.slice(0, MAX_SHARE_LENGTH - 1).trimEnd()}\u2026`;
  }

  return text;
}

/**
 * Read share capabilities from a scope (the real `globalThis` in a browser, or a
 * fake object in a test). Nothing is touched at module load.
 */
export function detectShareCapabilities(scope = currentScope()) {
  const nav = scope && scope.navigator;

  return {
    webShare: Boolean(nav) && typeof nav.share === 'function',
    clipboard: Boolean(nav) && Boolean(nav.clipboard) && typeof nav.clipboard.writeText === 'function',
  };
}

/** Prefer the native share sheet, then clipboard, then admit defeat. */
export function chooseShareStrategy(capabilities) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};

  if (caps.webShare === true) return SHARE_STRATEGIES.WEB_SHARE;
  if (caps.clipboard === true) return SHARE_STRATEGIES.CLIPBOARD;
  return SHARE_STRATEGIES.UNAVAILABLE;
}

async function copyToClipboard(navigatorObject, text) {
  try {
    await navigatorObject.clipboard.writeText(text);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Perform the share and report what happened.
 *
 * Resolves to `{ status, message }` where status is one of SHARE_STATUS. A user
 * cancelling the native sheet is reported as `cancelled` and is NOT reported as
 * a success or as a failure. A defensive clipboard attempt is made only when the
 * share sheet exists but errors; the player is never told a copy happened unless
 * `writeText` actually resolved.
 */
export async function shareResult({ text, scope = currentScope() } = {}) {
  const value = typeof text === 'string' ? text.trim() : '';

  if (!value) {
    return { status: SHARE_STATUS.FAILED, message: SHARE_MESSAGES.nothingToShare };
  }

  const navigatorObject = scope && scope.navigator;
  const capabilities = detectShareCapabilities(scope);
  const strategy = chooseShareStrategy(capabilities);

  if (strategy === SHARE_STRATEGIES.WEB_SHARE) {
    try {
      await navigatorObject.share({ text: value });
      return { status: SHARE_STATUS.SHARED, message: SHARE_MESSAGES.shared };
    } catch (error) {
      const name = (error && error.name) || '';

      if (name === 'AbortError') {
        return { status: SHARE_STATUS.CANCELLED, message: SHARE_MESSAGES.cancelled };
      }

      // The sheet was offered but refused (often "not allowed without a user
      // gesture" or no share targets). Fall back to the clipboard when it is
      // genuinely usable, and say which one succeeded.
      if (capabilities.clipboard && (await copyToClipboard(navigatorObject, value))) {
        return { status: SHARE_STATUS.COPIED, message: SHARE_MESSAGES.copied };
      }

      return { status: SHARE_STATUS.FAILED, message: SHARE_MESSAGES.failed };
    }
  }

  if (strategy === SHARE_STRATEGIES.CLIPBOARD) {
    if (await copyToClipboard(navigatorObject, value)) {
      return { status: SHARE_STATUS.COPIED, message: SHARE_MESSAGES.copied };
    }

    return { status: SHARE_STATUS.FAILED, message: SHARE_MESSAGES.failed };
  }

  return { status: SHARE_STATUS.UNAVAILABLE, message: SHARE_MESSAGES.unavailable };
}
