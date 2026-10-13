// Shared validation and formatting helpers for the Number Guessing Challenge API.

const crypto = require('crypto');

const MAX_MESSAGE_LENGTH = 280;
const MAX_USERNAME_LENGTH = 32;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Parse a value that is expected to be an integer within an inclusive range.
// Returns null when the value is not a usable integer.
function parseIntegerInRange(value, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  if (parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

// Normalise a player-supplied username: trim, collapse whitespace and bound length.
function normaliseUsername(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, MAX_USERNAME_LENGTH);
}

// Bound and trim a chat message.
function normaliseMessage(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, MAX_MESSAGE_LENGTH);
}

// Resolve a safe, public display name from an authenticated identity.
//
// A decoded Firebase ID token is { uid, email, email_verified, auth_time, iat,
// exp, firebase } and carries no `username` or `name` claim. The previous
// `username || name || email` fallback therefore published the player's email
// address as their public chat handle. Email is PII and is never a display name
// (ISSUE-22): when the identity carries no explicit handle we derive a stable
// pseudonym from the uid instead.
function resolveDisplayName(user) {
  if (!user || typeof user !== 'object') {
    return 'Player';
  }

  const explicit = [user.username, user.name, user.displayName]
    .map((value) => normaliseUsername(value))
    .find((value) => value);

  if (explicit) {
    return explicit;
  }

  const uid = typeof user.uid === 'string' ? user.uid.trim() : '';
  if (uid) {
    const digest = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 6);
    return `Player-${digest}`;
  }

  return 'Player';
}

function createResponse(ok, payload = {}) {
  return { ok, ...payload };
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  MAX_USERNAME_LENGTH,
  isNonEmptyString,
  parseIntegerInRange,
  normaliseUsername,
  normaliseMessage,
  resolveDisplayName,
  createResponse,
};
