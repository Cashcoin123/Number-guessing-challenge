// Behavioural tests for the social-sharing module.
//
// Run with `npm test` in frontend/ (node --test). These import the module
// directly: share.js has no JSX, no Vite-only imports and no top-level browser
// access, so it runs under plain Node.
//
// Non-vacuity: every test below fails when the behaviour it names is broken.
// The cases are deliberately split so that a single regression lands on ONE
// assertion group rather than being masked by a broader "text looks fine" test.
// RESULT.md records the injected regressions and which test each one failed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SHARE_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  SHARE_STRATEGIES,
  SHARE_STATUS,
  SHARE_MESSAGES,
  buildShareText,
  classifyOutcome,
  chooseShareStrategy,
  detectShareCapabilities,
  sanitiseDisplayName,
  sanitiseOrigin,
  shareResult,
} from '../src/share.js';

// The response shape documented in docs/API.md for a scored win.
const SCORED_WIN = Object.freeze({
  ok: true,
  result: 'correct',
  attempts: 3,
  maxAttempts: 10,
  remaining: 7,
  scored: true,
  awarded: 76,
  score: 176,
  bestScore: 200,
  streak: 2,
  newPersonalBest: false,
});

// A guest win: the documented guest shape omits scored/awarded entirely.
const GUEST_WIN = Object.freeze({
  ok: true,
  result: 'correct',
  attempts: 4,
  maxAttempts: 10,
  remaining: 6,
});

const LOSS = Object.freeze({
  ok: true,
  result: 'round-over',
  attempts: 10,
  maxAttempts: 10,
  remaining: 0,
});

const SCORED_LOSS = Object.freeze({
  ok: true,
  result: 'round-over',
  attempts: 10,
  maxAttempts: 10,
  remaining: 0,
  scored: true,
  awarded: 0,
  score: 176,
  bestScore: 200,
  streak: 0,
});

const ORIGIN = 'https://game.example.test';

// A fake scope: navigator.share / navigator.clipboard are only present in the
// tests that opt in, which is what lets us assert the "neither available" path.
function makeScope({ share, clipboard } = {}) {
  const navigator = {};

  if (share) {
    navigator.share = share === true ? async () => {} : share;
  }

  if (clipboard) {
    navigator.clipboard = {
      writeText: clipboard === true ? async () => {} : clipboard,
    };
  }

  return { navigator };
}

test('scored win text quotes the server numbers verbatim and never recomputes them', () => {
  const text = buildShareText({
    outcome: SCORED_WIN,
    username: 'Ada',
    origin: ORIGIN,
  });

  assert.ok(text, 'a completed round must produce share text');
  assert.match(text, /^Ada guessed the number in 3 of 10 attempts/);
  assert.match(text, /scored 76 points/);
  assert.match(text, /total 176/);
  assert.match(text, /best 200/);
  assert.match(text, /streak 2/);
  assert.ok(text.includes(ORIGIN), 'the share link is the page origin');

  // The value the server sent is what appears. The scoring formula
  // (100 - attempts*8 = 76 here) coincidentally equals it, so assert against a
  // number the formula could NOT produce: an award the server reports alone.
  const unusual = buildShareText({
    outcome: { ...SCORED_WIN, awarded: 41, score: 141, bestScore: 141, streak: 9 },
    username: 'Ada',
    origin: ORIGIN,
  });
  assert.match(unusual, /scored 41 points/);
  assert.match(unusual, /total 141/);
  assert.match(unusual, /streak 9/);
  // 100 - 3*8 is 76, so a local recomputation would print 76 here.
  assert.ok(!unusual.includes('76'), 'the text must not recompute points locally');
});

test('guest win never claims points were earned', () => {
  const text = buildShareText({
    outcome: GUEST_WIN,
    username: 'GuestPlayer',
    origin: ORIGIN,
  });

  assert.ok(text);
  assert.match(text, /as a guest/);
  assert.match(text, /no points were recorded/);
  assert.match(text, /in 4 of 10 attempts/);

  // No points language of any kind, in either direction.
  assert.ok(!/scored \d+ points/.test(text), 'a guest round must not claim an award');
  assert.ok(!/total \d+/.test(text), 'a guest round has no authoritative total');
  assert.ok(!/streak \d+/.test(text), 'a guest round has no authoritative streak');
  assert.ok(!/\bscore\b/i.test(text.replace(/no points were recorded/, '')));
});

test('a guest win stays honest even when the response carries stray score fields', () => {
  const stray = { ...GUEST_WIN, awarded: 92, score: 92, bestScore: 92, streak: 1 };

  // Defensive: if a future server change echoed totals on an unscored round, the
  // classifier must drop them. A guest round has no stored record to quote, so
  // `scored` - not the presence of a number - decides what may be published.
  const classified = classifyOutcome(stray);
  assert.equal(classified.kind, 'guest-win');
  assert.equal(classified.awarded, null, 'stray awarded must not survive classification');
  assert.equal(classified.score, null, 'stray score must not survive classification');
  assert.equal(classified.bestScore, null, 'stray bestScore must not survive classification');
  assert.equal(classified.streak, null, 'stray streak must not survive classification');

  const text = buildShareText({ outcome: stray, username: 'GuestPlayer', origin: ORIGIN });
  assert.match(text, /no points were recorded/);
  assert.ok(!/92/.test(text), 'numbers from an unscored response must not be published');
});

test('out-of-attempts text reports a loss and claims no points', () => {
  const text = buildShareText({ outcome: LOSS, username: 'Ada', origin: ORIGIN });

  assert.ok(text);
  assert.match(text, /ran out of attempts/);
  assert.match(text, /scored nothing/);
  assert.ok(!/points\b(?!.*nothing)/.test(text.replace('scored nothing', '')));
  assert.ok(!/total \d+/.test(text));
  assert.ok(text.includes(ORIGIN));

  // A scored loss (awarded 0) must read the same way - not as a 0-point "score".
  const scoredLoss = buildShareText({
    outcome: SCORED_LOSS,
    username: 'Ada',
    origin: ORIGIN,
  });
  assert.equal(scoredLoss, text);
  assert.ok(!/scored 0 points/.test(scoredLoss));
});

test('an unfinished round produces no share text at all', () => {
  assert.equal(buildShareText({ outcome: { result: 'too-low', attempts: 1 }, origin: ORIGIN }), null);
  assert.equal(buildShareText({ outcome: { result: 'too-high', attempts: 2 }, origin: ORIGIN }), null);
  assert.equal(buildShareText({ outcome: null, origin: ORIGIN }), null);
  assert.equal(buildShareText({ outcome: { ok: false, message: 'nope' } }), null);
  assert.equal(buildShareText({}), null);
  assert.equal(buildShareText(), null);
});

test('an email address is never published as the display name', () => {
  for (const email of ['ada@example.com', 'ADA@EXAMPLE.COM', 'a@b.c']) {
    assert.equal(sanitiseDisplayName(email), null, `${email} must be rejected`);

    const text = buildShareText({
      outcome: SCORED_WIN,
      username: email,
      origin: ORIGIN,
    });
    assert.ok(!text.includes('@'), 'the share text must not contain an email address');
    assert.ok(!text.toLowerCase().includes(email.toLowerCase()));
  }
});

test('the display name is bounded and stripped of control characters', () => {
  const long = 'x'.repeat(200);
  const safe = sanitiseDisplayName(long);
  assert.equal(safe.length, MAX_DISPLAY_NAME_LENGTH);

  // Whitespace is collapsed, so a multi-line "name" cannot forge extra lines.
  assert.equal(sanitiseDisplayName('Ada\n\nLovelace'), 'Ada Lovelace');
  assert.equal(sanitiseDisplayName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(sanitiseDisplayName(''), null);
  assert.equal(sanitiseDisplayName('   '), null);
  assert.equal(sanitiseDisplayName(null), null);
  assert.equal(sanitiseDisplayName(42), null);

  // A long name must not push the text past the cap.
  const text = buildShareText({ outcome: SCORED_WIN, username: long, origin: ORIGIN });
  assert.ok(text.length <= MAX_SHARE_LENGTH, `text was ${text.length} chars`);
});

test('the share text is bounded and markup is preserved as inert text', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const text = buildShareText({ outcome: SCORED_WIN, username: hostile, origin: ORIGIN });

  // The angle brackets survive as characters: this module composes text, and the
  // SPA renders it as a React text child. Nothing here builds DOM or HTML.
  assert.ok(text.includes(hostile));
  assert.ok(!/<script/i.test(text));
  assert.ok(text.length <= MAX_SHARE_LENGTH);
});

test('a pathologically long result is truncated to the cap and stays one bounded string', () => {
  // A maximally long name, a maximum-length origin and absurd totals compose a
  // string well past the cap, so the bound has to be enforced rather than
  // assumed. Verified by counting the untruncated composition first.
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

  const text = buildShareText({ outcome, username: longName, origin: longOrigin });
  assert.equal(text.length, MAX_SHARE_LENGTH, `expected truncation to ${MAX_SHARE_LENGTH}`);

  // Truncation is visible, not silent: the ellipsis marks the cut.
  assert.ok(text.endsWith('\u2026'), 'a truncated share must be marked as truncated');

  // The composed text really was longer before the bound was applied - this is
  // what makes the assertion above meaningful rather than incidental.
  const untruncated = `${longName} guessed the number in ${huge} of ${huge} attempts and scored ${huge} points (total ${huge}, best ${huge}, streak ${huge}). Play at ${longOrigin} (this app's address).`;
  assert.ok(
    untruncated.length > MAX_SHARE_LENGTH,
    `the fixture must exceed the cap (was ${untruncated.length})`
  );
});

test('the link is the given origin, and an invalid or invented origin is refused', () => {
  assert.equal(sanitiseOrigin('https://game.example.test'), 'https://game.example.test');
  assert.equal(sanitiseOrigin('https://game.example.test/'), 'https://game.example.test');
  assert.equal(sanitiseOrigin('http://localhost:5173'), 'http://localhost:5173');

  for (const bad of [
    'game.example.test', // no scheme
    'javascript:alert(1)',
    'https://game.example.test/path', // a path is not an origin
    'https://game.example.test?x=1',
    'ftp://game.example.test',
    '',
    '   ',
    null,
    42,
  ]) {
    assert.equal(sanitiseOrigin(bad), null, `${String(bad)} must be refused`);
  }

  // With no usable origin the text still composes, but without a fabricated URL.
  const noOrigin = buildShareText({
    outcome: SCORED_WIN,
    username: 'Ada',
    origin: 'javascript:alert(1)',
  });
  assert.ok(noOrigin);
  assert.ok(!noOrigin.includes('javascript:'));
  assert.ok(!noOrigin.includes('Play at'));
});

test('strategy selection prefers the share sheet, then clipboard, then admits defeat', () => {
  assert.equal(
    chooseShareStrategy({ webShare: true, clipboard: true }),
    SHARE_STRATEGIES.WEB_SHARE
  );
  assert.equal(
    chooseShareStrategy({ webShare: true, clipboard: false }),
    SHARE_STRATEGIES.WEB_SHARE
  );
  assert.equal(
    chooseShareStrategy({ webShare: false, clipboard: true }),
    SHARE_STRATEGIES.CLIPBOARD
  );
  assert.equal(
    chooseShareStrategy({ webShare: false, clipboard: false }),
    SHARE_STRATEGIES.UNAVAILABLE
  );

  // Junk must not be treated as a capability.
  assert.equal(chooseShareStrategy(undefined), SHARE_STRATEGIES.UNAVAILABLE);
  assert.equal(chooseShareStrategy(null), SHARE_STRATEGIES.UNAVAILABLE);
  assert.equal(chooseShareStrategy({}), SHARE_STRATEGIES.UNAVAILABLE);
  assert.equal(
    chooseShareStrategy({ webShare: 'yes', clipboard: 1 }),
    SHARE_STRATEGIES.UNAVAILABLE,
    'only real booleans count as capabilities'
  );
});

test('capability detection reads the scope and needs no browser at module load', () => {
  assert.deepEqual(detectShareCapabilities(makeScope()), {
    webShare: false,
    clipboard: false,
  });
  assert.deepEqual(detectShareCapabilities(makeScope({ share: true })), {
    webShare: true,
    clipboard: false,
  });
  assert.deepEqual(detectShareCapabilities(makeScope({ clipboard: true })), {
    webShare: false,
    clipboard: true,
  });
  // A navigator object that exists but lacks usable methods is not a capability.
  assert.deepEqual(detectShareCapabilities({ navigator: { share: 'nope', clipboard: {} } }), {
    webShare: false,
    clipboard: false,
  });
  assert.deepEqual(detectShareCapabilities({}), { webShare: false, clipboard: false });
});

test('sharing uses the native sheet and reports a real share', async () => {
  const calls = [];
  const scope = makeScope({
    share: async (payload) => {
      calls.push(payload);
    },
    clipboard: true,
  });

  const result = await shareResult({ text: 'a result', scope });

  assert.equal(result.status, SHARE_STATUS.SHARED);
  assert.equal(result.message, SHARE_MESSAGES.shared);
  assert.deepEqual(calls, [{ text: 'a result' }]);
});

test('the clipboard fallback actually receives the composed text', async () => {
  const written = [];
  const scope = makeScope({
    clipboard: async (value) => {
      written.push(value);
    },
  });

  const text = buildShareText({ outcome: SCORED_WIN, username: 'Ada', origin: ORIGIN });
  const result = await shareResult({ text, scope });

  assert.equal(result.status, SHARE_STATUS.COPIED);
  assert.equal(result.message, SHARE_MESSAGES.copied);
  assert.equal(written.length, 1);
  assert.equal(written[0], text);
  assert.match(written[0], /scored 76 points/);
});

test('with neither capability the player is told, not silently ignored', async () => {
  const result = await shareResult({ text: 'a result', scope: makeScope() });

  assert.equal(result.status, SHARE_STATUS.UNAVAILABLE);
  assert.equal(result.message, SHARE_MESSAGES.unavailable);
  // The message must actually explain the situation rather than be empty.
  assert.ok(result.message.length > 40);
  assert.match(result.message, /neither/i);
});

test('a clipboard write that rejects is reported as a failure, never as a copy', async () => {
  const scope = makeScope({
    clipboard: async () => {
      throw new Error('denied');
    },
  });

  const result = await shareResult({ text: 'a result', scope });

  assert.equal(result.status, SHARE_STATUS.FAILED);
  assert.equal(result.message, SHARE_MESSAGES.failed);
  assert.notEqual(result.status, SHARE_STATUS.COPIED);
});

test('cancelling the native sheet is reported as cancelled, not as a share', async () => {
  const scope = makeScope({
    share: async () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    },
    clipboard: true,
  });

  const result = await shareResult({ text: 'a result', scope });

  assert.equal(result.status, SHARE_STATUS.CANCELLED);
  assert.equal(result.message, SHARE_MESSAGES.cancelled);
});

test('a failed share sheet falls back to the clipboard only when a copy really happens', async () => {
  const written = [];
  const withClipboard = makeScope({
    share: async () => {
      throw new Error('no targets');
    },
    clipboard: async (value) => {
      written.push(value);
    },
  });

  const fallback = await shareResult({ text: 'a result', scope: withClipboard });
  assert.equal(fallback.status, SHARE_STATUS.COPIED);
  assert.deepEqual(written, ['a result']);

  // Without a usable clipboard the outcome is a failure, not a pretended copy.
  const noClipboard = makeScope({
    share: async () => {
      throw new Error('no targets');
    },
  });
  const failed = await shareResult({ text: 'a result', scope: noClipboard });
  assert.equal(failed.status, SHARE_STATUS.FAILED);
});

test('sharing an empty or non-string payload is refused', async () => {
  for (const value of ['', '   ', null, undefined, 42]) {
    const result = await shareResult({ text: value, scope: makeScope({ clipboard: true }) });
    assert.equal(result.status, SHARE_STATUS.FAILED);
    assert.equal(result.message, SHARE_MESSAGES.nothingToShare);
  }
});

test('classifyOutcome distinguishes the three identity cases', () => {
  assert.equal(classifyOutcome(SCORED_WIN).kind, 'scored-win');
  assert.equal(classifyOutcome(SCORED_WIN).awarded, 76);
  assert.equal(classifyOutcome(SCORED_WIN).score, 176);
  assert.equal(classifyOutcome(SCORED_WIN).streak, 2);

  assert.equal(classifyOutcome(GUEST_WIN).kind, 'guest-win');
  assert.equal(classifyOutcome(GUEST_WIN).awarded, null);
  assert.equal(classifyOutcome(GUEST_WIN).score, null);
  assert.equal(classifyOutcome(GUEST_WIN).bestScore, null);
  assert.equal(classifyOutcome(GUEST_WIN).streak, null);

  assert.equal(classifyOutcome(LOSS).kind, 'loss');
  assert.equal(classifyOutcome(LOSS).awarded, null);

  assert.equal(classifyOutcome({ result: 'too-low' }), null);
  assert.equal(classifyOutcome({}), null);
  assert.equal(classifyOutcome(null), null);
});

test('the characteristic markers of the three cases are mutually exclusive', () => {
  const scored = buildShareText({ outcome: SCORED_WIN, username: 'Ada', origin: ORIGIN });
  const guest = buildShareText({ outcome: GUEST_WIN, username: 'Ada', origin: ORIGIN });
  const loss = buildShareText({ outcome: LOSS, username: 'Ada', origin: ORIGIN });

  assert.ok(scored.includes('scored 76 points'));
  assert.ok(!scored.includes('as a guest'));
  assert.ok(!scored.includes('ran out of attempts'));

  assert.ok(guest.includes('as a guest'));
  assert.ok(!guest.includes('scored 76 points'));
  assert.ok(!guest.includes('ran out of attempts'));

  assert.ok(loss.includes('ran out of attempts'));
  assert.ok(!loss.includes('as a guest'));
  assert.ok(!/\bscored \d+/.test(loss));
});
