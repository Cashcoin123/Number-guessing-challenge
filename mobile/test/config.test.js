// Tests for mobile runtime configuration.
//
// These exist because "the API base is configurable" is only true if the
// precedence and the failure mode are both pinned down. The failure mode that
// matters: a device with no configured address must be told, not silently sent
// to a relative URL that can never resolve on a phone.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig, readManifestConfig, detectPlatform } = require('../src/config');

test('app.json expo.extra.apiUrl is read through an expo-constants shape', () => {
  const constants = { expoConfig: { extra: { apiUrl: 'https://api.example.com', devToken: 't0k' } } };

  assert.deepEqual(readManifestConfig(constants), {
    extraUrl: 'https://api.example.com',
    devToken: 't0k',
  });
});

test('a missing or odd expo-constants object never throws', () => {
  assert.deepEqual(readManifestConfig(null), { extraUrl: null, devToken: null });
  assert.deepEqual(readManifestConfig({}), { extraUrl: null, devToken: null });
  assert.deepEqual(readManifestConfig({ expoConfig: null }), { extraUrl: null, devToken: null });
  // Older manifest shapes nest `extra` under manifest2.extra.expoClient.
  assert.deepEqual(
    readManifestConfig({ manifest2: { extra: { expoClient: { extra: { apiUrl: 'https://legacy.test' } } } } }),
    { extraUrl: 'https://legacy.test', devToken: null }
  );
});

test('config resolves the address and reports where it came from', () => {
  const config = loadConfig({
    constants: { expoConfig: { extra: { apiUrl: 'https://api.example.com' } } },
    env: {},
    platform: 'native',
  });

  assert.equal(config.apiBase, 'https://api.example.com');
  assert.equal(config.apiBaseSource, 'app.json expo.extra.apiUrl');
  assert.equal(config.configError, null);
  assert.equal(config.token, null);
});

test('a native build with nothing configured returns a config error the UI can show', () => {
  const config = loadConfig({ constants: {}, env: {}, platform: 'native' });

  assert.equal(config.apiBase, null);
  assert.match(config.configError, /No API address is configured/);
});

test('web with nothing configured falls back to same origin', () => {
  const config = loadConfig({ constants: {}, env: {}, platform: 'web' });

  assert.equal(config.apiBase, '');
  assert.equal(config.configError, null);
});

test('the environment is honoured and the dev token is labelled as a dev token', () => {
  const config = loadConfig({
    constants: {},
    env: { EXPO_PUBLIC_API_URL: 'https://env.example.com', EXPO_PUBLIC_DEV_TOKEN: 'abc' },
    platform: 'native',
  });

  assert.equal(config.apiBase, 'https://env.example.com');
  assert.equal(config.token, 'abc');
  assert.match(config.tokenSource, /development token/);
});

test('an invalid configured address becomes a config error, not a silent fallback', () => {
  const config = loadConfig({
    constants: { expoConfig: { extra: { apiUrl: 'api.example.com' } } },
    env: { EXPO_PUBLIC_API_URL: 'https://env.example.com' },
    platform: 'native',
  });

  // The bad app.json value is not skipped in favour of the env value: a build
  // that ships a broken address should say so loudly.
  assert.equal(config.apiBase, null);
  assert.match(config.configError, /not a valid URL/);
});

test('the token is blank when unset, never a placeholder', () => {
  const config = loadConfig({ constants: {}, env: { EXPO_PUBLIC_DEV_TOKEN: '   ' }, platform: 'web' });

  assert.equal(config.token, null);
  assert.equal(config.tokenSource, null);
});

// --- platform detection ------------------------------------------------------
// A real bug found by the browser harness: the app used `Constants.platform.web`
// to decide it was on web. In a `npx expo export -p web` bundle that value is
// absent, so the app concluded "native", found no configured API address, and -
// correctly, but uselessly - refused to play. Platform.OS is the right source.

test('Platform.OS wins, so a web export is recognised as web', () => {
  assert.equal(detectPlatform({ platform: { OS: 'web' }, constants: {} }), 'web');
  assert.equal(detectPlatform({ platform: { OS: 'ios' }, constants: {} }), 'ios');
  assert.equal(detectPlatform({ platform: { OS: 'android' }, constants: {} }), 'android');
});

test('Platform.OS is used even when expo-constants disagrees', () => {
  // This is exactly the failing case: no Constants.platform but a real OS.
  assert.equal(
    detectPlatform({ platform: { OS: 'web' }, constants: { expoConfig: { extra: {} } } }),
    'web'
  );
});

test('expo-constants is only a fallback when Platform is unavailable', () => {
  assert.equal(detectPlatform({ platform: null, constants: { platform: { web: true } } }), 'web');
});

test('a missing platform is treated as native, which then demands configuration', () => {
  assert.equal(detectPlatform({}), 'native');
  const config = loadConfig({
    constants: {},
    env: {},
    platform: detectPlatform({ platform: { OS: 'web' }, constants: {} }),
  });
  assert.equal(config.apiBase, '');
  assert.equal(config.configError, null);
});
