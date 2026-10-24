const admin = require('firebase-admin');

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * The local-development identity bypass.
 *
 * Deliberately opt-in and narrowly scoped: honoured ONLY when ALLOW_DEV_AUTH is
 * exactly "true" AND the process is not running with NODE_ENV=production. The
 * production check wins unconditionally, so the flag can never leak the bypass
 * onto a production deployment even if it is left set.
 *
 * The previous implementation keyed the bypass off `ENABLE_AUTH !== 'true'`,
 * which meant an unset or misspelled ENABLE_AUTH silently injected a fake
 * authenticated user and left every protected endpoint unauthenticated
 * (ISSUE-1). The posture is now fail-closed.
 */
function isDevAuthBypassEnabled() {
  return process.env.ALLOW_DEV_AUTH === 'true' && !isProduction();
}

function devUser() {
  return {
    uid: 'local-dev-user',
    email: 'local@dev.local',
    username: 'local-user',
    dev: true,
  };
}

function extractBearerToken(headerValue) {
  const header = typeof headerValue === 'string' ? headerValue : '';
  if (!header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

async function verifyToken(token) {
  if (!token) {
    return null;
  }

  // Without an initialised Firebase app there is nothing to verify against;
  // returning null keeps the outcome fail-closed.
  if (!admin.apps.length) {
    return null;
  }

  try {
    return await admin.auth().verifyIdToken(token);
  } catch (error) {
    return null;
  }
}

// Fail-closed: a protected route without a valid token is rejected.
async function requireAuth(req, res, next) {
  if (isDevAuthBypassEnabled()) {
    req.user = devUser();
    return next();
  }

  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ ok: false, message: 'Authentication required.' });
  }

  const decoded = await verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ ok: false, message: 'Invalid or expired token.' });
  }

  req.user = decoded;
  return next();
}

// Never rejects: populates req.user when identity is available, otherwise leaves
// it undefined so guest play keeps working while authenticated callers get
// server-derived identity and scoring.
async function optionalAuth(req, res, next) {
  if (isDevAuthBypassEnabled()) {
    req.user = devUser();
    return next();
  }

  const token = extractBearerToken(req.headers.authorization);
  if (token) {
    const decoded = await verifyToken(token);
    if (decoded) {
      req.user = decoded;
    }
  }

  return next();
}

/**
 * Authenticate a Socket.IO handshake with the same rules as the REST layer.
 * Returns the decoded user, or null when the connection must be rejected.
 */
async function authenticateSocket(socket) {
  if (isDevAuthBypassEnabled()) {
    return devUser();
  }

  const handshake = socket.handshake || {};
  const fromAuth = handshake.auth && handshake.auth.token;
  const token =
    fromAuth || extractBearerToken(handshake.headers && handshake.headers.authorization);

  if (!token) {
    return null;
  }

  return verifyToken(token);
}

module.exports = {
  isProduction,
  isDevAuthBypassEnabled,
  extractBearerToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  authenticateSocket,
};
