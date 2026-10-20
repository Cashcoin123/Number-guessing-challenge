// Firebase client configuration for the SPA.
//
// Vite only inlines variables prefixed with VITE_, and only `import.meta.env`
// works in a built bundle (the previous code read process.env.REACT_APP_*, which
// is never defined here). The names below are the standard Firebase web values.
//
// The configuration is OPTIONAL on purpose. The default local/CI case has no
// Firebase project, and the app must still run exactly as it did before: guest
// mode, no crash, no undefined-env exception. isConfigured is therefore a real
// capability check rather than an assumption, and every consumer branches on it.
const env = import.meta.env || {};

const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// A usable Firebase Auth client needs at minimum an API key and a project id:
// without them initializeApp() throws at module load, which would break guest
// mode with an unhandled exception.
export const firebaseConfig = config;

export const isFirebaseConfigured = present(config.apiKey) && present(config.projectId);

// Which required values are missing, for an operator-facing (never secret) hint.
export const missingFirebaseVars = Object.entries({
  VITE_FIREBASE_API_KEY: config.apiKey,
  VITE_FIREBASE_PROJECT_ID: config.projectId,
})
  .filter(([, value]) => !present(value))
  .map(([name]) => name);
