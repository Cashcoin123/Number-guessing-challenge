// Behavioural tests for the mobile chat module (posting + freshness).
//
// Run with `npm test` in mobile/ (node --test). src/chat.js has no React, React
// Native or Expo imports and takes every transport, timer and clock as a
// parameter, so the logic exercised here is byte-identical to the logic the app
// bundles.
//
// Structure: each named test is the SINGLE check that must fail when the
// behaviour it names is broken. The non-vacuity run injects one regression at a
// time and records which named check caught it (RESULT.md holds that table). A
// broad "the message looks fine" test would hide a regression behind an
// unrelated assertion, so the cases are narrow on purpose.
//
// The decisive cases, and why they are written the way they are:
//
//   - The GUEST case (401) is the one that cannot be faked. Reading the room
//     needs no identity; writing does. A client that reported a 401 as sent would
//     show a player a message the room never received, and the player has no way
//     to tell - so the assertion is not just "the status is not success" but "the
//     notice contains no success vocabulary at all".
//   - The BODY case asserts the absence of `username`/`score`/`userId`, not the
//     presence of `message`. Presence alone passes for a body that carries all
//     four keys, which is exactly the impersonation defect ISSUE-4 fixed.
//   - The TRUNCATION case uses text longer than the server's 280-character bound.
//     A client that shortened it and reported it as sent would be displaying text
//     the player did not write, attributed to them.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_MESSAGE_LENGTH,
  CHAT_SEND_ENDPOINT,
  REFRESH_INTERVAL_MS,
  MAX_REFRESH_BACKOFF_MS,
  SEND_STATUS,
  REASONS,
  TONES,
  GUEST_POST_REFUSAL,
  SUCCESS_VOCABULARY,
  validateMessage,
  buildSendBody,
  classifyFailure,
  classifySendResult,
  createChatSender,
  createSharedRefresher,
  formatFreshness,
  describeRefreshFailure,
  composeChatLine,
} = require('../src/chat');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A post transport that records exactly what it was given. */
function stubPost(responder = () => ({ ok: true, status: 200, payload: { ok: true, message: accepted('hello') } })) {
  const calls = [];
  const post = async (body) => {
    calls.push({ body, raw: JSON.stringify(body) });
    return responder(body);
  };
  post.calls = calls;
  return post;
}

function accepted(message, username = 'local-user', score = 0) {
  return { username, message, score, timestamp: '2026-10-24T00:00:00.000Z', userId: 'u1' };
}

function okResult(message, username, score) {
  return { ok: true, status: 200, payload: { ok: true, message: accepted(message, username, score) } };
}

function httpFailure(status, message) {
  return { ok: false, kind: 'http', status, message: message || `rejected ${status}` };
}

/**
 * Deterministic timer harness: nothing waits in real time. `setTimeout` records
 * the pending callback, and `fire()` runs it - which is what lets the interval,
 * the backoff and the no-overlap rule be asserted exactly.
 */
function fakeTimers() {
  let handle = 0;
  const pending = new Map();
  let nowMs = 0;

  return {
    setTimeout(callback, ms) {
      handle += 1;
      pending.set(handle, { callback, ms, at: nowMs + ms });
      return handle;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    now() {
      return nowMs;
    },
    // --- harness controls -------------------------------------------------
    pendingCount() {
      return pending.size;
    },
    scheduledDelay() {
      const first = [...pending.values()][0];
      return first ? first.ms : null;
    },
    advance(ms) {
      nowMs += ms;
    },
    async fire() {
      const entry = [...pending.entries()][0];
      if (!entry) throw new Error('no timer is pending');
      const [id, timer] = entry;
      pending.delete(id);
      nowMs = Math.max(nowMs, timer.at);
      await timer.callback();
      // Let the cycle's promise chain settle before returning.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    async flush() {
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

/** Collect the snapshots a refresher hands to its caller. */
function recorder() {
  const snapshots = [];
  const record = (snapshot) => snapshots.push(snapshot);
  record.snapshots = snapshots;
  record.chatTexts = () => snapshots.map((s) => (s.chat || []).map((e) => e.message).join('|'));
  return record;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await flush();
}

// ---------------------------------------------------------------------------
// The contract with the backend
// ---------------------------------------------------------------------------

test('the send endpoint and the length bound match the hardened backend', () => {
  // These are duplicated from backend/src/routes/chatRoutes.js and
  // backend/src/utils/helpers.js because the mobile bundle cannot import the
  // backend tree. Pinning them here means a backend change that this client has
  // not followed fails a test instead of silently cutting a player's message.
  assert.equal(CHAT_SEND_ENDPOINT, '/api/chat/send');
  assert.equal(MAX_MESSAGE_LENGTH, 280);
});

test('the body sent to the server has exactly one key: message', async () => {
  const post = stubPost((body) => okResult(body.message));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello room');
  assert.equal(outcome.ok, true);

  assert.equal(post.calls.length, 1);
  assert.deepEqual(Object.keys(post.calls[0].body), ['message']);
  assert.deepEqual(post.calls[0].body, { message: 'hello room' });

  // The absence assertion, not just the presence one: a body that carried
  // username/score/userId/timestamp as well would satisfy a "has message" check
  // and would be the impersonation defect ISSUE-4 exists to prevent.
  const raw = post.calls[0].raw;
  for (const forbidden of ['username', 'score', 'userId', 'timestamp', 'uid', 'email']) {
    assert.ok(
      !raw.includes(`"${forbidden}"`),
      `the request body must not contain "${forbidden}"; it was ${raw}`
    );
  }
});

test('buildSendBody cannot express a body with an identity field in it', () => {
  const body = buildSendBody('hi');
  assert.deepEqual(body, { message: 'hi' });
  // Nothing on the returned object is writable by a caller that got it wrong:
  // the only key is message, so there is no slot for a forged handle.
  assert.deepEqual(Object.keys(body), ['message']);
});

test('surrounding whitespace is trimmed, and the trimmed text is what is posted', async () => {
  const post = stubPost((body) => okResult(body.message));
  const sender = createChatSender({ post });

  await sender.send('   spaced out   ');
  assert.deepEqual(post.calls[0].body, { message: 'spaced out' });
});

// ---------------------------------------------------------------------------
// Length honesty - never cut the player's text
// ---------------------------------------------------------------------------

test('a message at exactly the server bound is posted unchanged', async () => {
  const exact = 'y'.repeat(MAX_MESSAGE_LENGTH);
  const post = stubPost((body) => okResult(body.message));
  const sender = createChatSender({ post });

  const outcome = await sender.send(exact);
  assert.equal(outcome.ok, true);
  assert.equal(post.calls[0].body.message.length, MAX_MESSAGE_LENGTH);
});

test('an over-long message is REFUSED, never silently truncated and reported as sent', async () => {
  const long = 'z'.repeat(MAX_MESSAGE_LENGTH + 40);
  const post = stubPost((body) => okResult(body.message));
  const sender = createChatSender({ post });

  const outcome = await sender.send(long);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.INVALID);
  // The transport was never called: there is no request that could have carried a
  // shortened version of what the player typed.
  assert.equal(post.calls.length, 0);
  assert.match(outcome.notice.headline, new RegExp(`${long.length} characters`));
  assert.match(outcome.notice.headline, new RegExp(`at most ${MAX_MESSAGE_LENGTH}`));
  assert.match(outcome.notice.detail, /will not cut your text/);
  // The refusal must never contain a shortened copy of the text - that would be the
  // truncation it is refusing to perform.
  assert.ok(!outcome.notice.headline.includes('zzzz'));
  assert.ok(!(outcome.notice.detail || '').includes('zzzz'));
});

test('length is counted the way the server cuts it, so emoji cannot slip past', () => {
  // An emoji is one character to a player and two UTF-16 code units to
  // `slice(0, 280)`. Counting code points would accept this and the server would
  // then cut the final emoji in half.
  const emoji = '🙂'.repeat(200); // 200 characters, 400 code units
  assert.equal(emoji.length, 400);

  const check = validateMessage(emoji);
  assert.equal(check.ok, false);
  assert.equal(check.reason, REASONS.TOO_LONG);
  assert.equal(check.length, 400);
});

test('an empty or whitespace-only message is refused before it reaches the network', async () => {
  const post = stubPost();
  const sender = createChatSender({ post });

  for (const value of ['', '   ', '\n\t ']) {
    const outcome = await sender.send(value);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, SEND_STATUS.INVALID);
    assert.match(outcome.notice.headline, /Type a message first/);
  }
  assert.equal(post.calls.length, 0);
});

test('a non-string message is refused, not coerced', async () => {
  const post = stubPost();
  const sender = createChatSender({ post });

  for (const value of [null, undefined, 42, {}, [], true]) {
    const outcome = await sender.send(value);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, SEND_STATUS.INVALID);
  }
  assert.equal(post.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Refusal is never reported as success
// ---------------------------------------------------------------------------

test('a guest refusal (401) is reported as a guest refusal, with NO success wording', async () => {
  const post = stubPost(() => httpFailure(401, 'Authentication required.'));
  const sender = createChatSender({ post });

  const outcome = await sender.send('anyone there?');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.GUEST);
  assert.equal(outcome.notice.headline, GUEST_POST_REFUSAL);
  // Same sentence the web client uses, so the same refusal reads the same way on
  // both platforms.
  assert.equal(outcome.notice.headline, 'Sign in to join the global chat.');
  assertNoSuccessWording(outcome);
});

test('a 403 is treated as "no identity to post with", exactly like a 401', async () => {
  const post = stubPost(() => httpFailure(403));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hi');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.GUEST);
});

test('a 429 is its own outcome and is never reported as success', async () => {
  const post = stubPost(() => httpFailure(429, 'Too many messages.'));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.RATE_LIMITED);
  assert.match(outcome.notice.headline, /rate-limiting/);
  assert.match(outcome.notice.detail, /still in the box/);
  assertNoSuccessWording(outcome);
});

test('a 5xx is its own outcome and is never reported as success', async () => {
  const post = stubPost(() => httpFailure(500));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.SERVER_ERROR);
  assert.match(outcome.notice.headline, /server failed/);
  assertNoSuccessWording(outcome);
});

test('a 400 refusal quotes the server and is never reported as success', async () => {
  const post = stubPost(() => httpFailure(400, 'A non-empty message is required.'));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.REJECTED);
  assert.equal(outcome.notice.headline, 'A non-empty message is required.');
  assertNoSuccessWording(outcome);
});

test('an unreachable server is its own outcome and is never reported as success', async () => {
  const post = stubPost(() => ({ ok: false, kind: 'transport', message: 'fetch failed' }));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.UNREACHABLE);
  assert.match(outcome.notice.headline, /cannot be reached/);
  assertNoSuccessWording(outcome);
});

test('a transport that throws is an unreachable server, not a crash and not a success', async () => {
  const post = async () => {
    throw new Error('socket hang up');
  };
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.UNREACHABLE);
  assertNoSuccessWording(outcome);
});

test('a 200 whose payload is unreadable is not treated as sent', async () => {
  const cases = [
    { ok: true, status: 200, payload: { ok: true } },
    { ok: true, status: 200, payload: { ok: true, message: null } },
    { ok: true, status: 200, payload: { ok: true, message: { message: 'hi' } } }, // no username
    { ok: true, status: 200, payload: { ok: true, message: { username: 'bo', message: '' } } },
    { ok: true, status: 200, payload: 'not an object' },
  ];

  for (const result of cases) {
    const sender = createChatSender({ post: async () => result });
    const outcome = await sender.send('hi');
    assert.equal(outcome.ok, false, `payload ${JSON.stringify(result)} must not count as sent`);
    assert.equal(outcome.status, SEND_STATUS.UNREADABLE);
    assertNoSuccessWording(outcome);
  }
});

test('a server that stored different text than was typed is not reported as sent', async () => {
  // The client refuses over-long text, so a mismatch can only mean the server
  // altered it. Showing that as the player's own successful message would put
  // words they did not write under their name.
  const post = stubPost(() => okResult('hi there truncated'));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hi there');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, SEND_STATUS.ALTERED);
  assert.match(outcome.notice.headline, /different text/);
  assertNoSuccessWording(outcome);
});

test('every failure status produces a notice free of success vocabulary', async () => {
  const failures = [
    () => httpFailure(401),
    () => httpFailure(403),
    () => httpFailure(429),
    () => httpFailure(400),
    () => httpFailure(500),
    () => httpFailure(503),
    () => ({ ok: false, kind: 'transport' }),
    () => ({ ok: false, kind: 'malformed', status: 200 }),
    () => ({ ok: true, status: 200, payload: {} }),
    () => okResult('different'),
  ];

  const seen = new Set();
  for (const responder of failures) {
    const sender = createChatSender({ post: async () => responder() });
    const outcome = await sender.send('a message');
    assert.equal(outcome.ok, false);
    assertNoSuccessWording(outcome);
    seen.add(outcome.status);
  }

  // The distinct statuses are all distinguishable from each other: collapsing two
  // of them would make the app unable to tell a player what to do.
  assert.ok(seen.size >= 6, `expected at least 6 distinct failure statuses, saw ${[...seen].join(', ')}`);
});

test('a confirmed send is the one case that says "sent", and it names the server handle', async () => {
  const post = stubPost((body) => okResult(body.message, 'local-user'));
  const sender = createChatSender({ post });

  const outcome = await sender.send('hello room');

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, SEND_STATUS.SENT);
  assert.equal(outcome.entry.username, 'local-user');
  assert.equal(outcome.notice.headline, 'Sent as local-user.');
  // The handle shown is the server's, not anything the client made up.
  assert.ok(outcome.notice.headline.includes(outcome.entry.username));
});

test('the accepted score comes from the server, and an absent one is null rather than 0', () => {
  const explicit = classifySendResult({
    result: okResult('hi', 'bo', 41),
    submitted: 'hi',
  });
  assert.equal(explicit.entry.score, 41);

  const absent = classifySendResult({
    result: { ok: true, status: 200, payload: { ok: true, message: { username: 'bo', message: 'hi' } } },
    submitted: 'hi',
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.entry.score, null);
});

test('the sender refuses to be constructed without a transport', () => {
  assert.throws(() => createChatSender({}), /needs a post transport/);
});

// ---------------------------------------------------------------------------
// Rendering - inert text only
// ---------------------------------------------------------------------------

test('a message containing markup stays inert characters', () => {
  const line = composeChatLine({ username: 'bo', message: '<img src=x onerror=alert(1)>', score: 0 });
  assert.equal(line, 'bo: <img src=x onerror=alert(1)>');
  // Byte-for-byte: no escaping, no stripping, no interpretation. React Native
  // renders a <Text> child as text, so this is the shape that must reach it.
  assert.ok(line.includes('<img src=x onerror=alert(1)>'));
});

test('a chat line shows the server score only when the server sent a positive one', () => {
  assert.equal(composeChatLine({ username: 'bo', message: 'hi', score: 0 }), 'bo: hi');
  assert.equal(composeChatLine({ username: 'bo', message: 'hi', score: null }), 'bo: hi');
  assert.equal(composeChatLine({ username: 'bo', message: 'hi', score: 12 }), 'bo (12): hi');
  // A score the server did not send is never defaulted to a number.
  assert.equal(composeChatLine({ username: 'bo', message: 'hi' }), 'bo: hi');
});

test('a chat line never renders a missing username as an empty prefix', () => {
  assert.equal(composeChatLine({ username: '   ', message: 'hi' }), 'Player: hi');
  assert.equal(composeChatLine({ message: 'hi' }), 'Player: hi');
});

// ---------------------------------------------------------------------------
// Freshness - the refresher
// ---------------------------------------------------------------------------

test('the documented refresh interval is a bounded, stated number', () => {
  assert.equal(REFRESH_INTERVAL_MS, 10000);
  assert.ok(MAX_REFRESH_BACKOFF_MS >= REFRESH_INTERVAL_MS);
});

test('starting the refresher arms one timer at the documented interval', () => {
  const timers = fakeTimers();
  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [] }),
    loadChat: async () => ({ ok: true, messages: [] }),
    timers,
  });

  refresher.start();
  assert.equal(timers.pendingCount(), 1);
  assert.equal(timers.scheduledDelay(), REFRESH_INTERVAL_MS);

  refresher.stop();
  assert.equal(timers.pendingCount(), 0, 'stop() must clear the pending timer');
});

test('a timer tick re-reads both sources and tells the caller what it found', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [{ rank: 1, username: 'bo', bestScore: 5, streak: 1 }] }),
    loadChat: async () => ({ ok: true, messages: [{ username: 'bo', message: 'third-party', score: 0 }] }),
    onSnapshot,
    timers,
  });

  refresher.start();
  await timers.fire();

  assert.equal(onSnapshot.snapshots.length, 1);
  assert.equal(onSnapshot.snapshots[0].reason, 'interval');
  assert.deepEqual(onSnapshot.snapshots[0].chat, [{ username: 'bo', message: 'third-party', score: 0 }]);
  assert.equal(onSnapshot.snapshots[0].leaderboard.length, 1);

  refresher.stop();
});

test('a third-party message posted between ticks arrives on the next tick', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  const feed = [];

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [] }),
    loadChat: async () => ({ ok: true, messages: feed.slice() }),
    onSnapshot,
    timers,
  });

  refresher.start();
  await timers.fire();
  assert.deepEqual(onSnapshot.snapshots[0].chat, []);

  // A second client posts while the screen sits untouched.
  feed.push({ username: 'someone-else', message: 'posted from another client', score: 0 });

  await timers.fire();
  assert.equal(onSnapshot.snapshots.length, 2);
  assert.deepEqual(
    onSnapshot.snapshots[1].chat.map((entry) => entry.message),
    ['posted from another client']
  );

  refresher.stop();
});

test('nothing at all is read or applied after stop()', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  let calls = 0;
  let release = null;

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ok: true, rows: [{ rank: 1, username: 'late', bestScore: 1, streak: 0 }] };
    },
    loadChat: async () => ({ ok: true, messages: [{ username: 'late', message: 'late', score: 0 }] }),
    onSnapshot,
    timers,
  });

  refresher.start();
  await timers.fire(); // the cycle is now in flight, held by `release`

  refresher.stop();
  assert.equal(timers.pendingCount(), 0);

  release();
  await settle();

  assert.equal(calls, 1, 'the first cycle did run');
  assert.equal(onSnapshot.snapshots.length, 0, 'but a cycle in flight at stop() must not apply its result');
  assert.equal(refresher.stats().staleResponses, 1);
});

test('a slow read cannot overwrite a newer one: applied state is always the newest read', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  const gates = [];
  let issued = 0;

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [] }),
    loadChat: async () => {
      issued += 1;
      const n = issued;
      // The FIRST read is the slow one: it resolves only after the second would
      // have. If the refresher allowed overlap, the slow older answer would land
      // last and the caller would end up displaying older chat.
      await new Promise((resolve) => {
        gates[n] = resolve;
      });
      return { ok: true, messages: [{ username: 'bo', message: `generation-${n}`, score: 0 }] };
    },
    onSnapshot,
    timers,
  });

  refresher.start();
  // Not awaited: serialisation means the second call only starts after the first
  // completes, so awaiting them in order here would deadlock.
  const first = refresher.refreshNow('manual');
  const second = refresher.refreshNow('manual');
  await settle();

  // Exactly one read may have been issued: the second is serialised behind the
  // first rather than racing it.
  assert.equal(issued, 1, 'a second read must not start while the first is in flight');

  gates[1]();
  await first;
  await settle();
  assert.equal(issued, 2, 'the queued read runs once the first finishes');
  gates[2]();
  await second;
  await settle();

  // The caller was told about the reads in issue order, so the state it took from
  // the last callback is unambiguously the newest.
  assert.deepEqual(
    onSnapshot.snapshots.map((snapshot) => snapshot.chat[0].message),
    ['generation-1', 'generation-2']
  );
  const last = onSnapshot.snapshots[onSnapshot.snapshots.length - 1];
  assert.equal(last.chat[0].message, 'generation-2');

  refresher.stop();
});

test('a slow older response from before a stop/start is discarded', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  let release = null;
  let n = 0;

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [] }),
    loadChat: async () => {
      n += 1;
      if (n === 1) {
        // The pre-background read: slow, and it will resolve after the app resumes.
        await new Promise((resolve) => {
          release = resolve;
        });
        return { ok: true, messages: [{ username: 'bo', message: 'stale-pre-background', score: 0 }] };
      }
      return { ok: true, messages: [{ username: 'bo', message: 'fresh-after-resume', score: 0 }] };
    },
    onSnapshot,
    timers,
  });

  refresher.start();
  // Deliberately NOT awaited yet: refreshNow is serialised, so awaiting the
  // queued read while the first one is still gated would deadlock (correctly).
  const stale = refresher.refreshNow('manual');
  await settle();
  assert.equal(typeof release, 'function', 'the first read must be in flight');

  // The screen is backgrounded and resumed while that read is still out.
  refresher.stop();
  refresher.start();
  const fresh = refresher.refreshNow('manual');
  await settle();

  // Now the abandoned read finally answers. It is older than the resumed state.
  release();
  await stale;
  await settle();
  await fresh;
  await settle();

  const texts = onSnapshot.chatTexts().filter(Boolean);
  assert.deepEqual(texts, ['fresh-after-resume'], `stale read must be dropped, saw ${JSON.stringify(texts)}`);

  refresher.stop();
});

test('a failed read never clears good data, and a partial read keeps the half that worked', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  let chatOk = true;

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [{ rank: 1, username: 'bo', bestScore: 5, streak: 0 }] }),
    loadChat: async () =>
      chatOk
        ? { ok: true, messages: [{ username: 'bo', message: 'good', score: 0 }] }
        : { ok: false, kind: 'transport' },
    onSnapshot,
    timers,
  });

  refresher.start();
  await timers.fire();
  assert.equal(onSnapshot.snapshots[0].chat.length, 1);

  chatOk = false;
  await timers.fire();

  const failed = onSnapshot.snapshots[1];
  // null means "keep what is on screen"; an empty array would wipe the room.
  assert.equal(failed.chat, null);
  assert.deepEqual(failed.chatFailure, { kind: 'transport', status: null, message: null });
  assert.equal(failed.leaderboard.length, 1, 'the source that worked still updates');

  refresher.stop();
});

test('the interval backs off while every read fails and snaps back on the first success', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  let healthy = false;

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => (healthy ? { ok: true, rows: [] } : { ok: false, kind: 'transport' }),
    loadChat: async () => (healthy ? { ok: true, messages: [] } : { ok: false, kind: 'transport' }),
    onSnapshot,
    timers,
    intervalMs: 1000,
    maxBackoffMs: 8000,
  });

  refresher.start();
  assert.equal(timers.scheduledDelay(), 1000);

  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    await timers.fire();
    delays.push(timers.scheduledDelay());
  }

  assert.deepEqual(delays, [2000, 4000, 8000, 8000, 8000], 'the delay must double and then hold at the ceiling');
  assert.equal(refresher.stats().consecutiveFailures, 5);
  assert.equal(onSnapshot.snapshots[0].chat, null);

  healthy = true;
  await timers.fire();
  assert.equal(timers.scheduledDelay(), 1000, 'the first success must restore the normal interval');
  assert.equal(refresher.stats().consecutiveFailures, 0);

  refresher.stop();
});

test('a tick that arrives during a slow read is skipped, not stacked', async () => {
  const timers = fakeTimers();
  const onSnapshot = recorder();
  let release = null;
  let calls = 0;

  const refresher = createSharedRefresher({
    loadLeaderboard: async () => ({ ok: true, rows: [] }),
    loadChat: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, messages: [{ username: 'bo', message: `read-${calls}`, score: 0 }] };
    },
    onSnapshot,
    timers,
    intervalMs: 1000,
  });

  refresher.start();
  const manual = refresher.refreshNow('manual');
  await settle();
  assert.equal(typeof release, 'function', 'the first read must be in flight');
  assert.equal(calls, 1);

  // The interval fires while that read is still out. A fixed-rate timer that
  // started a second read here is how a slow server turns into a request pile-up.
  await timers.fire();

  assert.equal(calls, 1, 'the tick must NOT start a second read while one is in flight');
  assert.equal(refresher.stats().skippedTicks, 1, 'the skipped tick must be counted');
  assert.equal(timers.pendingCount(), 1, 'the next tick must still be armed');
  assert.equal(timers.scheduledDelay(), 1000);

  release();
  await manual;
  await settle();

  assert.equal(onSnapshot.snapshots.length, 1, 'exactly one snapshot, from the one read that ran');
  assert.equal(refresher.stats().inFlight, 0);

  refresher.stop();
});

test('a refresher needs both loaders and a sane interval', () => {
  assert.throws(() => createSharedRefresher({ loadLeaderboard: async () => ({}) }), /loadLeaderboard and loadChat/);
  assert.throws(
    () => createSharedRefresher({ loadLeaderboard: async () => ({}), loadChat: async () => ({}), intervalMs: 0 }),
    /intervalMs/
  );
  assert.throws(
    () =>
      createSharedRefresher({
        loadLeaderboard: async () => ({}),
        loadChat: async () => ({}),
        intervalMs: 1000,
        maxBackoffMs: 500,
      }),
    /maxBackoffMs/
  );
});

// ---------------------------------------------------------------------------
// Freshness wording
// ---------------------------------------------------------------------------

test('the freshness caption states the interval plainly and never claims realtime', () => {
  const before = formatFreshness({ lastSuccessAt: null, now: 0 });
  assert.match(before, /every 10 s/);

  const after = formatFreshness({ lastSuccessAt: 0, now: 3000 });
  assert.match(after, /updated 3 s ago/);
  assert.match(after, /every 10 s/);

  for (const text of [before, after]) {
    assert.ok(!/real-?time|live|instant/i.test(text), `freshness caption must not claim immediacy: ${text}`);
  }
});

test('a failed refresh says the old data is still on screen, and why', () => {
  const transport = describeRefreshFailure(
    {
      chat: null,
      leaderboard: null,
      chatFailure: { kind: 'transport', status: null, message: null },
      leaderboardFailure: { kind: 'transport', status: null, message: null },
    },
    { nextDelayMs: 20000 }
  );
  assert.match(transport, /cannot be reached/);
  assert.match(transport, /last good read/);
  assert.match(transport, /Retrying in 20 s/);

  const limited = describeRefreshFailure({
    chat: null,
    leaderboard: [],
    chatFailure: { kind: 'http', status: 429, message: 'slow down' },
    leaderboardFailure: null,
  });
  assert.match(limited, /^The chat could not be refreshed/);
  assert.match(limited, /rate-limiting/);

  assert.equal(
    describeRefreshFailure({
      chat: [],
      leaderboard: [],
      chatFailure: null,
      leaderboardFailure: null,
    }),
    null
  );
});

// ---------------------------------------------------------------------------
// local helpers
// ---------------------------------------------------------------------------

function assertNoSuccessWording(outcome) {
  const text = `${outcome.notice.headline} ${outcome.notice.detail || ''}`.toLowerCase();
  for (const word of SUCCESS_VOCABULARY) {
    // "still in the box" wording must not accidentally include a success claim.
    assert.ok(
      !new RegExp(`\\b${word}\\b`).test(text),
      `a failure notice must not contain "${word}": ${outcome.notice.headline}`
    );
  }
  assert.notEqual(outcome.notice.tone, TONES.WIN);
}
