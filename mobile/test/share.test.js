// Behavioural tests for the mobile social-sharing module.
//
// Run with `npm test` in mobile/ (node --test). src/share.js has no React, React
// Native or Expo imports, so it loads under plain Node, and the logic under test
// here is the same file the app bundles.
//
// Structure, and why it is split this finely: every named test below is the
// SINGLE check that must fail when the behaviour it names is broken. The
// non-vacuity run injects one regression at a time and records which named check
// caught it (RESULT.md holds that table). A broad "the text looks fine" test
// would mask a regression behind an unrelated assertion, so the cases are kept
// narrow on purpose.
//
// The decisive case is the LOSS. A client that recomputes
// `Math.max(20, 100 - attempts * 8)` produces byte-identical text on a WIN,
// because the client formula and the server formula agree for the same attempt
// count. On a LOSS the server sends `awarded: 0` while the formula yields 20, so
// only a loss can prove the text quotes rather than computes. The loss tests
// below therefore carry the discriminating assertions.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SHARE_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
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
} = require('../src/share');

// --- fixtures: the response shapes documented in docs/API.md -----------------

// A scored win. `awarded` is deliberately a number the local formula could NOT
// produce for 3 attempts (100 - 3*8 = 76), so a recomputation is visible here too.
const SCORED_WIN = Object.freeze({
  ok: true,
  result: 'correct',
  attempts: 3,
  maxAttempts: 10,
  remaining: 7,
  scored: true,
  awarded: 41,
  score: 141,
  bestScore: 141,
  streak: 9,
  newPersonalBest: true,
});

// The ordinary case where server and formula agree. Kept so the loss test can
// point at the pair and explain why a win alone proves nothing.
const SCORED_WIN_FORMULA_AGREES = Object.freeze({
  ok: true,
  result: 'correct',
  attempts: 3,
  maxAttempts: 10,
  remaining: 7,
  scored: true,
  awarded: 76,
  score: 76,
  bestScore: 76,
  streak: 1,
});

// A guest win: the documented guest shape omits scored/awarded entirely.
const GUEST_WIN = Object.freeze({
  ok: true,
  result: 'correct',
  attempts: 4,
  maxAttempts: 10,
  remaining: 6,
});

// A guest loss.
const LOSS = Object.freeze({
  ok: true,
  result: 'round-over',
  attempts: 10,
  maxAttempts: 10,
  remaining: 0,
});

// A SCORED loss: the server says awarded 0. This is the discriminator.
const SCORED_LOSS = Object.freeze({
  ok: true,
  result: 'round-over',
  attempts: 10,
  maxAttempts: 10,
  remaining: 0,
  scored: true,
  awarded: 0,
  score: 141,
  bestScore: 141,
  streak: 0,
});

const ORIGIN = 'https://game.example.test';

// --- transport fakes --------------------------------------------------------

/**
 * A fake transports object. Only the keys a test opts into exist, which is what
 * makes "no transport at all" expressible without touching any global.
 */
function makeTransports({ nativeSheet, webShare, clipboard } = {}) {
  const transports = {};
  if (nativeSheet) transports.nativeSheet = nativeSheet;
  if (webShare) transports.webShare = webShare;
  if (clipboard) transports.clipboard = clipboard;
  return transports;
}

function abortError() {
  const error = new Error('Share canceled');
  error.name = 'AbortError';
  return error;
}

// The exact rejection react-native-web's Share.share produces when the browser
// has no Web Share API (verified against the installed react-native-web source).
function notSupportedError() {
  return new Error('Share is not supported in this browser');
}

// ===========================================================================
// 1. What the text says - scored win
// ===========================================================================

test('a scored win quotes every server figure verbatim and never recomputes the award', () => {
  const text = buildShareText({ outcome: SCORED_WIN, displayName: 'Ada', origin: ORIGIN });

  assert.ok(text, 'a completed round must produce share text');
  assert.match(text, /^Ada guessed the number in 3 of 10 attempts/);
  assert.match(text, /scored 41 points/);
  assert.match(text, /total 141/);
  assert.match(text, /best 141/);
  assert.match(text, /streak 9/);
  assert.ok(text.includes(ORIGIN), 'the share link is the app address');

  // 100 - 3*8 = 76. A local recomputation would print 76 and 76 for the totals.
  assert.ok(!text.includes('76'), 'the text must not contain a computed award');
});

test('the scenario where the formula and the server agree is recorded as NON-discriminating', () => {
  // This test exists to pin the reasoning, not to catch a regression: on this
  // payload a recomputing client is indistinguishable from a quoting one. It is
  // the reason the loss tests below are the ones that must be trusted.
  const agreed = buildShareText({
    outcome: SCORED_WIN_FORMULA_AGREES,
    displayName: 'Ada',
    origin: ORIGIN,
  });
  assert.match(agreed, /scored 76 points/);

  // Both the server award and the formula yield 76 here - state it explicitly so
  // nobody mistakes this case for proof of quoting.
  assert.equal(SCORED_WIN_FORMULA_AGREES.awarded, 100 - SCORED_WIN_FORMULA_AGREES.attempts * 8);
});

test('an absent server figure is dropped, never defaulted to a plausible number', () => {
  // Only `awarded` present: no score/best/streak clause may be invented.
  const partial = buildShareText({
    outcome: { result: 'correct', scored: true, attempts: 5, maxAttempts: 10, awarded: 60 },
    displayName: 'Ada',
    origin: ORIGIN,
  });
  assert.match(partial, /scored 60 points/);
  assert.ok(!/total \d+/.test(partial), 'no total was sent, so none may be claimed');
  assert.ok(!/best \d+/.test(partial), 'no best was sent, so none may be claimed');
  assert.ok(!/streak \d+/.test(partial), 'no streak was sent, so none may be claimed');
  // No EMPTY totals parenthesis: the link clause legitimately contains "(this
  // app's address)", so the assertion targets the totals group specifically.
  assert.ok(!/\(\s*\)/.test(partial), 'no empty totals parenthesis may be rendered');
  assert.ok(!/\(total|\(best|\(streak/.test(partial), 'no totals group may open');

  // A scored win with NO award at all still must not invent one.
  const noAward = buildShareText({
    outcome: { result: 'correct', scored: true, attempts: 5, maxAttempts: 10 },
    displayName: 'Ada',
    origin: ORIGIN,
  });
  assert.ok(noAward);
  assert.ok(!/scored \d+ points/.test(noAward), 'no award was sent, so none may be claimed');
  assert.ok(!/60/.test(noAward), 'the award is absent rather than guessed');
});

// ===========================================================================
// 2. What the text says - guest win
// ===========================================================================

test('a guest win states plainly that no points were recorded', () => {
  const text = buildShareText({
    outcome: GUEST_WIN,
    displayName: 'GuestPlayer',
    origin: ORIGIN,
    identity: IDENTITY.GUEST,
  });

  assert.ok(text);
  assert.match(text, /as a guest/);
  assert.match(text, /no points were recorded/);
  assert.match(text, /in 4 of 10 attempts/);

  // No points language of any kind, in either direction.
  assert.ok(!/scored \d+ points/.test(text), 'a guest round must not claim an award');
  assert.ok(!/total \d+/.test(text), 'a guest round has no authoritative total');
  assert.ok(!/streak \d+/.test(text), 'a guest round has no authoritative streak');
});

test('a guest-shaped response that carries stray totals publishes none of them', () => {
  const stray = { ...GUEST_WIN, awarded: 92, score: 92, bestScore: 92, streak: 1 };

  // `scored` - not the presence of a number - decides what may be published.
  const classified = classifyOutcome(stray);
  assert.equal(classified.kind, 'guest-win');
  assert.equal(classified.awarded, null, 'stray awarded must not survive classification');
  assert.equal(classified.score, null, 'stray score must not survive classification');
  assert.equal(classified.bestScore, null, 'stray bestScore must not survive classification');
  assert.equal(classified.streak, null, 'stray streak must not survive classification');

  const text = buildShareText({
    outcome: stray,
    displayName: 'GuestPlayer',
    origin: ORIGIN,
    identity: IDENTITY.GUEST,
  });
  assert.match(text, /no points were recorded/);
  assert.ok(!/92/.test(text), 'numbers from an unscored response must not be published');
});

test('an unscored win for a signed-in player does not call them a guest', () => {
  // The server can fail to score an authenticated round (a scoring error keeps
  // the round playable). Telling that player they were "a guest" is its own lie,
  // so the wording differs - and both wordings refuse to claim points.
  const text = buildShareText({
    outcome: GUEST_WIN,
    displayName: 'Ada',
    origin: ORIGIN,
    identity: IDENTITY.AUTHENTICATED,
  });

  assert.ok(text);
  assert.ok(!/as a guest/.test(text), 'a signed-in player must not be called a guest');
  assert.match(text, /did not record any points/);
  assert.ok(!/scored \d+ points/.test(text));
});

// ===========================================================================
// 3. What the text says - loss (the decisive case)
// ===========================================================================

test('a loss says the round ended and nothing was scored, and quotes no award', () => {
  const text = buildShareText({ outcome: LOSS, displayName: 'Ada', origin: ORIGIN });

  assert.ok(text);
  assert.match(text, /ran out of attempts/);
  assert.match(text, /scored nothing/);
  assert.ok(!/total \d+/.test(text), 'a loss claims no total');
  assert.ok(text.includes(ORIGIN));
});

test('a SCORED loss never quotes awarded 0 as a score, and never prints the formula value', () => {
  // THE discriminating check for "quotes rather than computes":
  //
  //   server said      awarded: 0
  //   the formula says max(20, 100 - 10*8) = 20
  //
  // A client that recomputes would print "20" here. A client that quotes would
  // print "0" - and, correctly, refuses to present 0 as a score at all.
  const text = buildShareText({ outcome: SCORED_LOSS, displayName: 'Ada', origin: ORIGIN });

  assert.ok(text);
  assert.ok(!/scored 0 points/.test(text), 'awarded 0 must not be dressed up as a score');
  assert.ok(!text.includes('20'), 'the loss text must not carry the locally computed 20');
  assert.ok(!/total \d+/.test(text), 'a loss claims no total, even a scored one');
  assert.ok(!/streak \d+/.test(text), 'a loss claims no streak');

  // The scored and unscored losses must read identically: the player lost either
  // way, and the server's 0 must not change what is published.
  const unscored = buildShareText({ outcome: LOSS, displayName: 'Ada', origin: ORIGIN });
  assert.equal(text, unscored);

  // The formula really would produce 20 for this attempt count - so the
  // assertion above is meaningful rather than incidental.
  assert.equal(Math.max(20, 100 - SCORED_LOSS.attempts * 8), 20);
});

// ===========================================================================
// 4. An unfinished round is not shareable
// ===========================================================================

test('a round that is not finished produces no share text at all', () => {
  assert.equal(buildShareText({ outcome: { result: 'too-low', attempts: 1 } }), null);
  assert.equal(buildShareText({ outcome: { result: 'too-high', attempts: 2 } }), null);
  assert.equal(
    buildShareText({ outcome: { result: 'too-low', attempts: 1, finished: false } }),
    null
  );
  assert.equal(buildShareText({ outcome: null }), null);
  assert.equal(buildShareText({ outcome: { ok: false, message: 'nope' } }), null);
  assert.equal(buildShareText({}), null);
  assert.equal(buildShareText(), null);
});

test('a terminal result flagged unfinished is refused by the finished guard alone', () => {
  // This is a SEPARATE named check from the result-name test above on purpose.
  // The app's normalised outcome carries `finished: false` for a hint, so the
  // classifier refuses a mid-round twice over: once because the result name is
  // not terminal, and once because the payload says it is unfinished. Two layers
  // means one mutation cannot disarm the behaviour - which is exactly what the
  // integration non-vacuity run found (an I3 mutation that removed only the
  // result-name branch ESCAPED, because this guard still refused). To prove THIS
  // layer is load-bearing, the payload here carries a terminal `result`.
  assert.equal(
    classifyOutcome({ result: 'correct', finished: false, scored: true, attempts: 1, awarded: 99 }),
    null,
    'a payload that says it is unfinished must never be shareable, whatever its result field'
  );
  assert.equal(
    buildShareText({
      outcome: { result: 'round-over', finished: false, attempts: 1, maxAttempts: 10 },
      displayName: 'Ada',
      origin: ORIGIN,
    }),
    null,
    'an unfinished round must produce no text even if it looks terminal'
  );
  // And the guard is what did it, not the result name: `correct` alone is terminal.
  assert.ok(classifyOutcome({ result: 'correct', attempts: 1, maxAttempts: 10, scored: true }));
});

test('classifyOutcome refuses everything that is not a completed round', () => {
  assert.equal(classifyOutcome({ result: 'too-low', attempts: 1, maxAttempts: 10 }), null);
  assert.equal(classifyOutcome({ result: 'too-high', attempts: 2, maxAttempts: 10 }), null);
  assert.equal(classifyOutcome({ result: 'started' }), null);
  assert.equal(classifyOutcome({}), null);
  assert.equal(classifyOutcome(null), null);
  assert.equal(classifyOutcome('correct'), null);

  // A terminal result explicitly flagged unfinished is still refused.
  assert.equal(classifyOutcome({ result: 'correct', finished: false, scored: true }), null);
});

// ===========================================================================
// 5. The display name and the link
// ===========================================================================

test('an email address is never published as the display name', () => {
  for (const email of ['ada@example.com', 'ADA@EXAMPLE.COM', 'a@b.c']) {
    assert.equal(sanitiseDisplayName(email), null, `${email} must be rejected`);

    const text = buildShareText({
      outcome: SCORED_WIN,
      displayName: email,
      origin: ORIGIN,
    });
    assert.ok(!text.includes('@'), 'the share text must not contain an email address');
    assert.ok(!text.toLowerCase().includes(email.toLowerCase()));
  }
});

test('the display name is bounded, whitespace-collapsed and control-character-free', () => {
  const long = 'x'.repeat(200);
  const safe = sanitiseDisplayName(long);
  assert.equal(safe.length, MAX_DISPLAY_NAME_LENGTH);

  // Whitespace is collapsed, so a multi-line "name" cannot forge extra lines.
  assert.equal(sanitiseDisplayName('Ada\n\nLovelace'), 'Ada Lovelace');
  assert.equal(sanitiseDisplayName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(sanitiseDisplayName('\u0000Ada\u0007'), 'Ada');
  assert.equal(sanitiseDisplayName(''), null);
  assert.equal(sanitiseDisplayName('   '), null);
  assert.equal(sanitiseDisplayName(null), null);
  assert.equal(sanitiseDisplayName(42), null);
});

test('a missing display name falls back to a neutral label instead of an empty sentence', () => {
  const text = buildShareText({ outcome: SCORED_WIN, displayName: null, origin: ORIGIN });
  assert.ok(text.startsWith(`${FALLBACK_DISPLAY_NAME} guessed the number`));
});

test('the share text is bounded, and markup stays inert text', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const text = buildShareText({ outcome: SCORED_WIN, displayName: hostile, origin: ORIGIN });

  // Angle brackets survive as characters: this module composes text and App.js
  // renders it as a React Native <Text> child. Nothing here builds DOM or HTML,
  // so the payload cannot execute - and shortening the name must not create an
  // unclosed tag that a future HTML renderer would swallow the rest of the text
  // into.
  assert.ok(text.includes('<img src=x onerror="alert(1)">'));
  assert.ok(!/<script/i.test(text));
  assert.ok(text.length <= MAX_SHARE_LENGTH, `text was ${text.length} chars`);
});

test('a pathologically long composition is truncated to the cap and marked as truncated', () => {
  const huge = 123456789012345680;
  const longOrigin = `https://${'a'.repeat(92)}`; // exactly MAX_ORIGIN_LENGTH
  const longName = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH);

  const outcome = {
    result: 'correct',
    scored: true,
    attempts: huge,
    maxAttempts: huge,
    awarded: huge,
    score: huge,
    bestScore: huge,
    streak: huge,
  };

  // The untruncated composition really is longer than the cap - otherwise the
  // assertion below could pass for the wrong reason.
  const withName = `${longName} guessed the number in ${huge} of ${huge} attempts and scored ${huge} points (total ${huge}, best ${huge}, streak ${huge}). Play at ${longOrigin} (this app's address).`;
  assert.ok(withName.length > MAX_SHARE_LENGTH, 'fixture must exceed the cap');

  const text = buildShareText({ outcome, displayName: longName, origin: longOrigin });
  assert.equal(text.length, MAX_SHARE_LENGTH, `expected truncation to ${MAX_SHARE_LENGTH}`);
  assert.ok(text.endsWith('\u2026'), 'a truncated share must be marked as truncated');
});

test('only a real http(s) origin is embedded - a path, query or fragment is refused', () => {
  assert.equal(sanitiseOrigin('https://game.example.test'), 'https://game.example.test');
  assert.equal(sanitiseOrigin('http://127.0.0.1:4090/'), 'http://127.0.0.1:4090');
  assert.equal(sanitiseOrigin(null), null);
  assert.equal(sanitiseOrigin(''), null);
  assert.equal(sanitiseOrigin('game.example.test'), null);
  assert.equal(sanitiseOrigin('file:///etc/passwd'), null);
  assert.equal(sanitiseOrigin('javascript:alert(1)'), null);
  assert.equal(sanitiseOrigin('https://game.example.test/path'), null);
  assert.equal(sanitiseOrigin('https://game.example.test?x=1'), null);
  assert.equal(sanitiseOrigin('https://game.example.test#f'), null);
  assert.equal(sanitiseOrigin(`https://${'a'.repeat(200)}`), null);
});

test('a native build with no origin omits the link clause rather than inventing a domain', () => {
  const text = buildShareText({ outcome: SCORED_WIN, displayName: 'Ada', origin: null });

  assert.ok(text);
  assert.ok(!/Play at/.test(text), 'no invented link may appear');
  assert.ok(!/https?:\/\//.test(text), 'no URL at all may appear on a native build');
  assert.ok(text.endsWith('.'), 'the sentence is still well formed');
});

// ===========================================================================
// 6. Transport selection
// ===========================================================================

test('capabilities are read only from injected transports, never from a global', () => {
  // In Node there is no navigator.share and no React Native Share: the module
  // must not have reached for either.
  assert.deepEqual(detectShareCapabilities(undefined), {
    nativeSheet: false,
    webShare: false,
    clipboard: false,
  });
  assert.deepEqual(detectShareCapabilities({}), {
    nativeSheet: false,
    webShare: false,
    clipboard: false,
  });
  // A non-function value is not a usable transport.
  assert.deepEqual(detectShareCapabilities({ nativeSheet: true, webShare: 'yes', clipboard: {} }), {
    nativeSheet: false,
    webShare: false,
    clipboard: false,
  });
  // Extra keys are ignored rather than treated as capabilities.
  assert.deepEqual(detectShareCapabilities({ execCommand: () => {} }), {
    nativeSheet: false,
    webShare: false,
    clipboard: false,
  });
});

test('the native sheet is preferred, then the web share sheet, then the clipboard, then nothing', () => {
  assert.equal(
    chooseShareStrategy({ nativeSheet: true, webShare: true, clipboard: true }),
    SHARE_STRATEGIES.NATIVE_SHEET
  );
  assert.equal(
    chooseShareStrategy({ nativeSheet: false, webShare: true, clipboard: true }),
    SHARE_STRATEGIES.WEB_SHARE
  );
  assert.equal(
    chooseShareStrategy({ nativeSheet: false, webShare: false, clipboard: true }),
    SHARE_STRATEGIES.CLIPBOARD
  );
  assert.equal(
    chooseShareStrategy({ nativeSheet: false, webShare: false, clipboard: false }),
    SHARE_STRATEGIES.UNAVAILABLE
  );
  assert.equal(chooseShareStrategy(null), SHARE_STRATEGIES.UNAVAILABLE);
});

// ===========================================================================
// 6b. Platform -> transport wiring
// ===========================================================================

test('web transports are built only from capabilities that really exist', () => {
  // navigator.share present, no clipboard.
  const shareOnly = createShareTransports({
    platform: 'web',
    scope: { navigator: { share: async () => ({}) } },
  });
  assert.deepEqual(Object.keys(shareOnly).sort(), ['webShare']);
  assert.equal(typeof shareOnly.webShare, 'function');

  // clipboard present, no share sheet.
  const clipboardOnly = createShareTransports({
    platform: 'web',
    scope: { navigator: { clipboard: { writeText: async () => {} } } },
  });
  assert.deepEqual(Object.keys(clipboardOnly).sort(), ['clipboard']);

  // neither -> an empty transports object, which is the honest answer.
  assert.deepEqual(createShareTransports({ platform: 'web', scope: { navigator: {} } }), {});
  assert.deepEqual(createShareTransports({ platform: 'web', scope: {} }), {});

  // A `navigator.clipboard` whose writeText is not a function is NOT a capability
  // (some browsers expose the object but not the method without a permission).
  assert.deepEqual(
    createShareTransports({ platform: 'web', scope: { navigator: { clipboard: { writeText: 'x' } } } }),
    {}
  );
});

test('an injected web transport really calls the underlying browser object', async () => {
  const calls = [];
  const transports = createShareTransports({
    platform: 'web',
    scope: {
      navigator: {
        share: async (payload) => {
          calls.push(payload);
          return undefined;
        },
      },
    },
  });

  const result = await shareResult({ text: 'Ada guessed the number.', transports });
  assert.equal(result.status, SHARE_STATUS.SHARED);
  assert.deepEqual(calls, [{ text: 'Ada guessed the number.' }]);
});

test('a native build uses React Native Share.share, and never the web clipboard', async () => {
  const calls = [];
  const nativeShare = async (payload) => {
    calls.push(payload);
    return { action: 'sharedAction' };
  };

  const transports = createShareTransports({ platform: 'native', nativeShare });

  // A scope that DOES have navigator.share must not leak into a native build.
  assert.deepEqual(Object.keys(transports), ['nativeSheet']);

  const result = await shareResult({ text: 'Ada ran out of attempts.', transports });
  assert.equal(result.status, SHARE_STATUS.SHARED);
  assert.equal(result.strategy, SHARE_STRATEGIES.NATIVE_SHEET);
  assert.deepEqual(calls, [{ message: 'Ada ran out of attempts.' }]);
});

test('a native build with no Share module reports a capability gap, not a share', async () => {
  const transports = createShareTransports({ platform: 'native', nativeShare: undefined });
  assert.deepEqual(transports, {});

  const result = await shareResult({ text: 'result text', transports });
  assert.equal(result.status, SHARE_STATUS.UNAVAILABLE);
});

test('the share origin is the page origin on web and nothing at all on native', () => {
  const webScope = { location: { origin: 'https://game.example.test' } };
  assert.equal(resolveShareOrigin({ platform: 'web', scope: webScope }), 'https://game.example.test');

  // A native app has no origin. Even if the caller hands a location-like object,
  // a native build must not embed it.
  assert.equal(resolveShareOrigin({ platform: 'native', scope: webScope }), null);
  assert.equal(resolveShareOrigin({ platform: 'ios' }), null);

  // An unusable web origin degrades to no link rather than a broken one.
  assert.equal(resolveShareOrigin({ platform: 'web', scope: { location: {} } }), null);
  assert.equal(
    resolveShareOrigin({ platform: 'web', scope: { location: { origin: 'https://x.test/a/b' } } }),
    null
  );
});

// ===========================================================================
// 7. What is reported back to the player
// ===========================================================================

test('a completed native share is reported as shared and the text really crossed', async () => {
  const seen = [];
  const result = await shareResult({
    text: 'Ada guessed the number in 3 of 10 attempts.',
    transports: makeTransports({
      nativeSheet: async (value) => {
        seen.push(value);
        return { action: 'sharedAction' };
      },
    }),
  });

  assert.equal(result.status, SHARE_STATUS.SHARED);
  assert.equal(result.message, SHARE_MESSAGES.shared);
  assert.equal(result.strategy, SHARE_STRATEGIES.NATIVE_SHEET);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Ada guessed the number/);
});

test('a dismissed sheet is reported as cancelled, not as a share and not as a failure', async () => {
  // React Native reports the dismissal through the result object...
  const viaAction = await shareResult({
    text: 'result text',
    transports: makeTransports({ nativeSheet: async () => ({ action: 'dismissedAction' }) }),
  });
  assert.equal(viaAction.status, SHARE_STATUS.CANCELLED);
  assert.equal(viaAction.message, SHARE_MESSAGES.cancelled);

  // ...and a web-style sheet rejects with AbortError instead.
  const viaError = await shareResult({
    text: 'result text',
    transports: makeTransports({
      webShare: async () => {
        throw abortError();
      },
    }),
  });
  assert.equal(viaError.status, SHARE_STATUS.CANCELLED);
  assert.equal(viaError.message, SHARE_MESSAGES.cancelled);

  // A cancel must never be described as a copy or a share.
  assert.notEqual(viaAction.message, SHARE_MESSAGES.shared);
  assert.notEqual(viaError.message, SHARE_MESSAGES.copied);
});

test('no usable transport is reported as UNAVAILABLE, never as a share or a copy', async () => {
  const result = await shareResult({ text: 'result text', transports: makeTransports() });

  assert.equal(result.status, SHARE_STATUS.UNAVAILABLE);
  assert.equal(result.message, SHARE_MESSAGES.unavailable);
  assert.equal(result.strategy, SHARE_STRATEGIES.UNAVAILABLE);
  assert.match(result.message, /no share sheet and no clipboard/);
});

test("react-native-web's \"Share is not supported\" rejection is a capability gap, not a cancel", async () => {
  // This is the exact failure the web export of this app produces when the
  // browser has no navigator.share. Callers that treated it as a cancel would
  // tell the player "you cancelled" when in fact the platform cannot share.
  const result = await shareResult({
    text: 'result text',
    transports: makeTransports({
      nativeSheet: async () => {
        throw notSupportedError();
      },
    }),
  });

  assert.equal(result.status, SHARE_STATUS.UNAVAILABLE);
  assert.equal(result.message, SHARE_MESSAGES.unavailable);
  assert.notEqual(result.status, SHARE_STATUS.CANCELLED);
  assert.notEqual(result.message, SHARE_MESSAGES.cancelled);
});

test('a sheet that fails for a real reason is reported as a failure, and only a real copy rescues it', async () => {
  // No clipboard: an honest failure.
  const failed = await shareResult({
    text: 'result text',
    transports: makeTransports({
      webShare: async () => {
        throw new Error('NotAllowedError: permission denied');
      },
    }),
  });
  assert.equal(failed.status, SHARE_STATUS.FAILED);
  assert.equal(failed.message, SHARE_MESSAGES.failed);

  // A clipboard write that rejects must NOT be reported as a copy.
  const copyFailed = await shareResult({
    text: 'result text',
    transports: makeTransports({
      webShare: async () => {
        throw new Error('boom');
      },
      clipboard: async () => {
        throw new Error('denied');
      },
    }),
  });
  assert.equal(copyFailed.status, SHARE_STATUS.FAILED);
  assert.notEqual(copyFailed.message, SHARE_MESSAGES.copied);

  // A clipboard write that resolves IS a copy, and the strategy says so.
  const copied = await shareResult({
    text: 'result text',
    transports: makeTransports({
      webShare: async () => {
        throw new Error('boom');
      },
      clipboard: async () => {},
    }),
  });
  assert.equal(copied.status, SHARE_STATUS.COPIED);
  assert.equal(copied.message, SHARE_MESSAGES.copied);
  assert.equal(copied.strategy, SHARE_STRATEGIES.CLIPBOARD);
});

test('the clipboard alone is used when it is the only transport, and its failure is a failure', async () => {
  const seen = [];
  const ok = await shareResult({
    text: 'result text',
    transports: makeTransports({
      clipboard: async (value) => {
        seen.push(value);
      },
    }),
  });
  assert.equal(ok.status, SHARE_STATUS.COPIED);
  assert.deepEqual(seen, ['result text']);

  const bad = await shareResult({
    text: 'result text',
    transports: makeTransports({
      clipboard: async () => {
        throw new Error('no');
      },
    }),
  });
  assert.equal(bad.status, SHARE_STATUS.FAILED);
  assert.equal(bad.message, SHARE_MESSAGES.failed);
});

test('sharing an empty or non-string payload is refused, not performed', async () => {
  let touched = false;
  const transports = makeTransports({
    nativeSheet: async () => {
      touched = true;
      return { action: 'sharedAction' };
    },
  });

  for (const text of ['', '   ', null, undefined, 42, {}]) {
    const result = await shareResult({ text, transports });
    assert.equal(result.status, SHARE_STATUS.FAILED, `text ${JSON.stringify(text)}`);
    assert.equal(result.message, SHARE_MESSAGES.nothingToShare);
  }

  assert.equal(touched, false, 'no transport may be invoked for an empty payload');
});

test('shareResult never throws, whatever the transport does', async () => {
  // A transport that throws a non-Error is a real hazard on React Native bridge
  // failures; the player must still get a message.
  const outcome = await shareResult({
    text: 'result text',
    transports: makeTransports({
      nativeSheet: async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'bridge exploded';
      },
    }),
  });

  assert.equal(outcome.status, SHARE_STATUS.FAILED);
  assert.equal(outcome.message, SHARE_MESSAGES.failed);
});
