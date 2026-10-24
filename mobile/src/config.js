// Runtime configuration for the mobile app.
//
// This is the one place that decides which backend the app talks to, so a real
// device can be pointed at a deployed API without editing code.
//
// How to set it (documented in docs/SETUP.md and README.md):
//
//   1. app.json -> expo.extra.apiUrl   (recommended; ships with the build and is
//      readable at runtime through expo-constants)
//   2. EXPO_PUBLIC_API_URL in the environment when starting/exporting
//   3. web only: leave both unset and the app uses its own origin, which is what
//      a single-origin deployment needs.
//
// There is deliberately no fallback to a guessed host such as localhost:5000 on
// a native build: a device that silently talked to the wrong machine, or to
// nothing, is the failure mode this whole change exists to remove. With no
// address configured the app says so instead of pretending to play.
//
// The dev-token path: the backend's ALLOW_DEV_AUTH bypass is an explicitly
// local-development-only flag and, when it is on, the server injects the identity
// itself, so no token is needed here. When the backend does NOT inject an
// identity, an explicit EXPO_PUBLIC_DEV_TOKEN can be supplied and is sent as a
// bearer token. Whatever the value, it comes from the operator's own
// configuration and is never invented by the app.
//
// Purity: no React/Expo import is required to compute any of this, so the logic
// is testable under plain Node. The expo-constants lookup is injected by App.js.

const {
  resolveApiBase,
} = require('./gameClient');

/**
 * Work out which platform we are running on.
 *
 * `Platform.OS` from react-native is the authoritative source ('web', 'ios',
 * 'android'). `Constants.platform` is NOT a reliable substitute: it is absent in
 * some web exports, and an early version of this app used it, concluded "native"
 * in the browser, and then - correctly - refused to play because no API address
 * was configured. The fallback order below is deliberate and tested.
 */
function detectPlatform({ platform, constants } = {}) {
  const os = platform && typeof platform.OS === 'string' ? platform.OS.trim() : '';
  if (os) return os;

  // Fallback only, for a caller that passes expo-constants without Platform.
  if (constants && constants.platform && constants.platform.web) return 'web';
  return 'native';
}

/**
 * Read `expo.extra.apiUrl` (and the dev token) from an expo-constants-shaped
 * object. Kept defensive: expo-constants returns undefined in some web builds and
 * older manifests nest things differently.
 */
function readManifestConfig(constants) {
  if (!constants || typeof constants !== 'object') {
    return { extraUrl: null, devToken: null };
  }

  const fromExpoConfig =
    (constants.expoConfig && constants.expoConfig.extra) ||
    (constants.manifest && constants.manifest.extra) ||
    (constants.manifest2 &&
      constants.manifest2.extra &&
      constants.manifest2.extra.expoClient &&
      constants.manifest2.extra.expoClient.extra) ||
    null;

  const extra = fromExpoConfig || {};

  return {
    extraUrl: typeof extra.apiUrl === 'string' ? extra.apiUrl : null,
    devToken: typeof extra.devToken === 'string' ? extra.devToken : null,
  };
}

/**
 * Resolve the full configuration.
 *
 * `env` and `platform` are injected rather than read globally so this can be
 * tested without a device or a bundler.
 */
function loadConfig({ constants, env, platform } = {}) {
  const environment = env || {};
  const manifest = readManifestConfig(constants);

  const resolved = resolveApiBase({
    extraUrl: manifest.extraUrl,
    envUrl: environment.EXPO_PUBLIC_API_URL,
    platform,
  });

  const envToken = environment.EXPO_PUBLIC_DEV_TOKEN;
  const token = (manifest.devToken || (typeof envToken === 'string' ? envToken : '') || '').trim();

  return {
    apiBase: resolved.base,
    apiBaseSource: resolved.source,
    configError: resolved.error,
    token: token || null,
    // Labelled as a dev token wherever it is surfaced, so nobody mistakes it for
    // a real sign-in.
    tokenSource: token
      ? manifest.devToken
        ? 'app.json expo.extra.devToken (development token)'
        : 'EXPO_PUBLIC_DEV_TOKEN (development token)'
      : null,
    platform: platform || 'unknown',
  };
}

module.exports = { loadConfig, readManifestConfig, detectPlatform };
