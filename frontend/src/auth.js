// Firebase Authentication wiring for the SPA.
//
// Second half of the ISSUE-1 story: the API became fail-closed, but the browser
// client had no way to obtain an identity at all. It only read a pre-injected
// `ngc-token` localStorage value, which nothing in the product ever set, so in
// production every protected call (register, daily bonus, chat send, profile)
// returned 401 and scoring - which only fires for an authenticated round - never
// happened for a real player.
//
// Design constraints this module exists to satisfy:
//
//  1. The firebase SDK is imported LAZILY, inside the initialiser, and only when a
//     project is configured. A static top-level import would make the module graph
//     require `firebase` at load time; if it were missing or misconfigured, guest
//     mode would die with an import error before any UI rendered. Guest mode is
//     the documented default local/CI case, so it must never depend on it.
//  2. Tokens are fetched FRESH per call via getIdToken(). Firebase ID tokens are
//     short-lived (~1h) and getIdToken() refreshes an expired token against the
//     refresh token, so caching the string would eventually 401 every request.
//  3. The `ngc-token` localStorage escape hatch keeps working: if a token is
//     injected there (local tooling, tests), it is used when no Firebase user is
//     signed in.

import { firebaseConfig, isFirebaseConfigured } from './firebaseConfig';

export const GUEST = Object.freeze({
  mode: 'guest',
  uid: null,
  // Never a display name: the server derives a pseudonym (resolveDisplayName).
  // This is only what the UI shows the player about their own session.
  label: 'Guest',
});

// The legacy escape hatch. Deliberately read at call time, not module load, so a
// value injected after bundle evaluation is still honoured.
export function readInjectedToken() {
  try {
    return localStorage.getItem('ngc-token') || null;
  } catch (error) {
    return null;
  }
}

// Create the auth handle. Returns:
//   { configured: false }                     -> guest mode, no SDK loaded
//   { configured: true, auth, api }           -> ready
//   { configured: true, error }               -> configured but the SDK failed
// Never throws: a broken Firebase setup must degrade to guest mode, not a blank
// page.
export async function createAuthClient() {
  if (!isFirebaseConfigured) {
    return { configured: false };
  }

  try {
    // Lazy so an absent/failed SDK cannot break the guest-mode bundle.
    const [{ initializeApp, getApps }, authApi] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]);

    const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
    const auth = authApi.getAuth(app);

    return { configured: true, auth, api: authApi };
  } catch (error) {
    return {
      configured: true,
      error: (error && error.message) || 'Firebase initialisation failed',
    };
  }
}

/**
 * Subscribe to identity changes.
 *
 * The callback receives a session object:
 *   { mode: 'firebase', uid, label, email }
 *   { mode: 'injected', uid: null, label: 'Injected token' }
 *   GUEST
 *
 * `label` is a SESSION label for the player's own eyes, never a chat handle: the
 * client must not send a display name to the server at all.
 */
export function subscribeToIdentity(client, onChange) {
  if (!client || !client.configured || client.error) {
    // Guest mode. Still report an injected token, if any, so the legacy path is
    // visible rather than silently ignored.
    const token = readInjectedToken();
    onChange(
      token
        ? { mode: 'injected', uid: null, label: 'Injected token' }
        : GUEST
    );
    return () => {};
  }

  const { auth, api } = client;

  return api.onAuthStateChanged(auth, (user) => {
    if (user) {
      onChange({
        mode: 'firebase',
        uid: user.uid,
        // The UID is a public, non-PII identifier the backend itself derives a
        // pseudonym from; showing it tells the player which account is active.
        label: `Player-${String(user.uid).slice(0, 6)}`,
        email: user.email || null,
      });
      return;
    }

    const token = readInjectedToken();
    onChange(token ? { mode: 'injected', uid: null, label: 'Injected token' } : GUEST);
  });
}

/**
 * Resolve a bearer token for an authenticated request.
 *
 * Firebase ID tokens expire, so this asks the SDK for a CURRENT token on every
 * call rather than reusing a cached string. Returns null when the caller has no
 * identity.
 */
export async function getAuthToken(client) {
  if (client && client.configured && !client.error && client.auth) {
    const user = client.auth.currentUser;
    if (user) {
      try {
        // forceRefresh=false still refreshes an expired token; the SDK reuses a
        // still-valid one. Either way the value is fresh enough to use now.
        return await user.getIdToken();
      } catch (error) {
        return null;
      }
    }
  }

  return readInjectedToken();
}

export async function signUpWithEmail(client, email, password) {
  if (!client || !client.configured || client.error) {
    throw new Error('Firebase Authentication is not configured.');
  }
  const credential = await client.api.createUserWithEmailAndPassword(client.auth, email, password);
  return credential.user;
}

export async function signInWithEmail(client, email, password) {
  if (!client || !client.configured || client.error) {
    throw new Error('Firebase Authentication is not configured.');
  }
  const credential = await client.api.signInWithEmailAndPassword(client.auth, email, password);
  return credential.user;
}

export async function signOut(client) {
  if (client && client.configured && !client.error && client.auth) {
    await client.api.signOut(client.auth);
  }

  // Also clear the escape-hatch token: signing out must not leave the app
  // authenticated through a stale injected value.
  try {
    localStorage.removeItem('ngc-token');
  } catch (error) {
    /* ignore storage failures */
  }
}

// Firebase reports errors as codes; a raw code in the UI is unhelpful, and the
// message must never echo the password.
export function describeAuthError(error) {
  const code = (error && error.code) || '';
  const map = {
    'auth/invalid-email': 'That email address is not valid.',
    'auth/missing-password': 'Enter a password.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/email-already-in-use': 'An account already exists for that email. Try signing in.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'Email or password is incorrect.',
    'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this project.',
  };

  if (map[code]) return map[code];
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return 'Sign-in failed.';
}
