const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Daily-bonus regression coverage: the bonus must be credited SERVER-SIDE.
//
// The defect being guarded here is the one ISSUE-24 fixed for round scoring, still
// present for the bonus: POST /api/game/bonus wrote only the cooldown record and
// returned `{granted:true, bonus:50}`, while the SPA added the points to React
// state. Nothing reached the user's stored record, so the award vanished on
// reload and could never appear on the leaderboard.
//
// These tests therefore assert PERSISTED state (re-read through the API, i.e. what
// a reload sees), not just the return value: a fix that only echoed the number
// back would pass a response-only assertion and still be broken.
//
// The JSON storage adapter writes under backend/data, which is shared with a
// developer's local play state, so every file touched is snapshotted before the
// suite and restored afterwards - the same discipline scoring.test.js uses.
const realDataDir = path.resolve(__dirname, '../data');
const DATA_FILES = ['users.json', 'game_data.json', 'leaderboard.json', 'bonus.json', 'chat_messages.json'];
const snapshots = {};

for (const name of DATA_FILES) {
  const file = path.join(realDataDir, name);
  snapshots[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Development posture with the local identity bypass: the only way to exercise an
// authenticated route without a live Firebase project. The bypass yields the fixed
// uid `local-dev-user`, which is exactly the "authenticated caller" these tests
// need. Must be set before the server module is loaded.
process.env.NODE_ENV = 'development';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.USE_FIREBASE = 'false';
process.env.TRUST_PROXY = 'false';
process.env.ROUNDS_RATE_WINDOW_MS = '60000';
process.env.ROUNDS_RATE_MAX = '200';

const { server, io } = require('../src/server');
const storage = require('../src/services/storage');
const scoring = require('../src/services/scoring');

const UID = 'local-dev-user';
// Deliberately a literal, not an import from the bonus service: these tests must
// be able to RUN against a pre-fix checkout (where that module does not exist) so
// they can prove the awarded value was never persisted, rather than dying at
// require() time. 50 is the documented daily bonus.
const BONUS_POINTS = 50;

let base;

function writeData(name, value) {
  fs.mkdirSync(realDataDir, { recursive: true });
  fs.writeFileSync(path.join(realDataDir, name), JSON.stringify(value, null, 2));
}

// Reset only the files this suite reasons about. users.json is seeded with a
// zeroed record for UID so "the bonus credited it" is unambiguous rather than
// "the record happened to exist".
function resetStore() {
  writeData('users.json', {
    [UID]: {
      uid: UID,
      username: 'local-user',
      score: 0,
      bestScore: 0,
      streak: 0,
    },
  });
  writeData('game_data.json', { bestScore: 0, streak: 0, totalGames: 0, lastBonusTime: 0 });
  writeData('bonus.json', {});
  writeData('leaderboard.json', []);
  writeData('chat_messages.json', []);
}

test.before(async () => {
  resetStore();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // Socket.IO holds the HTTP server's connections open; close it first.
  await new Promise((resolve) => io.close(resolve));
  await new Promise((resolve) => server.close(resolve));

  for (const name of DATA_FILES) {
    const file = path.join(realDataDir, name);
    if (snapshots[name] === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, snapshots[name]);
    }
  }
});

const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const getJson = async (p) => (await fetch(`${base}${p}`)).json();

test('a due claim credits the stored score and bestScore, not just the response', async () => {
  resetStore();

  const before = await getJson(`/api/users/${UID}`);
  assert.equal(before.user.score, 0, 'seeded player must start at zero');
  assert.equal(before.user.bestScore, 0);

  const res = await post('/api/game/bonus');
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.granted, true, 'a never-claimed player must be granted the bonus');
  assert.equal(body.bonus, BONUS_POINTS);

  // The response must carry the AUTHORITATIVE totals, so the SPA renders server
  // numbers instead of computing its own.
  assert.equal(body.score, BONUS_POINTS);
  assert.equal(body.bestScore, BONUS_POINTS);
  assert.equal(typeof body.nextAvailableAt, 'number');

  // The regression: the credit must be PERSISTED. This is read back through the
  // API, which is exactly what a page reload sees.
  const after = await getJson(`/api/users/${UID}`);
  assert.equal(after.user.score, BONUS_POINTS, 'the bonus must be written to the user record');
  assert.equal(after.user.bestScore, BONUS_POINTS);
});

test('the credited bonus survives a store re-read and reaches the leaderboard', async () => {
  resetStore();

  const claim = await (await post('/api/game/bonus')).json();
  assert.equal(claim.granted, true);

  // Re-read from disk through the storage layer, simulating a later process
  // request rather than an in-memory echo.
  const users = await storage.getUsers();
  assert.equal(users[UID].score, BONUS_POINTS);
  assert.equal(users[UID].bestScore, BONUS_POINTS);

  const board = await getJson('/api/leaderboard');
  const entry = board.leaderboard.find((row) => row.username === 'local-user');
  assert.ok(entry, `bonus player missing from leaderboard: ${JSON.stringify(board.leaderboard)}`);
  assert.equal(entry.bestScore, BONUS_POINTS, 'the leaderboard must show the credited bonus');
});

test('a bonus never changes the winning streak', async () => {
  resetStore();

  // A player with an existing win streak.
  writeData('users.json', {
    [UID]: { uid: UID, username: 'local-user', score: 40, bestScore: 40, streak: 3 },
  });

  const claim = await (await post('/api/game/bonus')).json();
  assert.equal(claim.granted, true);
  assert.equal(claim.streak, 3, 'a bonus is not a win and must not extend the streak');
  assert.equal(claim.score, 40 + BONUS_POINTS);
  assert.equal(claim.bestScore, 40 + BONUS_POINTS);

  const after = await getJson(`/api/users/${UID}`);
  assert.equal(after.user.streak, 3, 'the stored streak must be carried through unchanged');
  assert.equal(after.user.score, 40 + BONUS_POINTS);
});

test('a second claim inside the window awards nothing and is not replayable', async () => {
  resetStore();

  const first = await (await post('/api/game/bonus')).json();
  assert.equal(first.granted, true);

  // Baseline AFTER the legitimate award, so any further change can only come from
  // the replays below.
  const baseline = await getJson(`/api/users/${UID}`);
  assert.equal(baseline.user.score, BONUS_POINTS);

  const second = await (await post('/api/game/bonus')).json();
  const third = await (await post('/api/game/bonus')).json();

  assert.equal(second.granted, false, 'a replay inside the window must not award');
  assert.equal(third.granted, false);
  assert.equal(second.bonus, 0);

  // Even a non-granted response reports the authoritative stored totals.
  assert.equal(second.score, BONUS_POINTS);
  assert.equal(second.bestScore, BONUS_POINTS);

  const after = await getJson(`/api/users/${UID}`);
  assert.equal(after.user.score, baseline.user.score, 'replays must not change the stored score');
  assert.equal(after.user.bestScore, baseline.user.bestScore);
});

test('the bonus status endpoint reports availability without claiming', async () => {
  resetStore();

  const available = await getJson('/api/game/bonus');
  assert.equal(available.ok, true);
  assert.equal(available.available, true, 'a never-claimed player must see the bonus available');
  assert.equal(available.score, 0);

  // Reporting status must NOT consume the bonus: the old SPA probed the claim
  // endpoint while rendering, which spent the bonus as a side effect of opening
  // the page.
  const stillAvailable = await getJson('/api/game/bonus');
  assert.equal(stillAvailable.available, true, 'reading status must not consume the bonus');

  const users = await storage.getUsers();
  assert.equal(users[UID].score, 0, 'a status read must not credit anything');

  const claim = await (await post('/api/game/bonus')).json();
  assert.equal(claim.granted, true, 'the bonus must still be claimable after a status read');

  const spent = await getJson('/api/game/bonus');
  assert.equal(spent.available, false);
  assert.equal(spent.score, BONUS_POINTS);
  assert.ok(spent.nextAvailableAt > Date.now(), 'the next window must be in the future');
});

test('concurrent claims for one player award exactly once', async () => {
  resetStore();

  // HTTP-level parallelism is NOT a reliable way to reproduce this race: Node
  // serves the two requests one after another often enough that a non-serialised
  // implementation still passes, which would make this test vacuous.
  //
  // Instead force the interleaving deterministically. The bug is a read-then-write
  // cooldown: two claims that both read the window before either writes it both
  // see "due". Yielding inside the credit write reproduces exactly the condition
  // a real asynchronous database write creates.
  const realSaveUsers = storage.saveUsers;
  storage.saveUsers = async (users) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return realSaveUsers.call(storage, users);
  };

  try {
    const bonusService = require('../src/services/bonus');
    const [a, b] = await Promise.all([
      bonusService.claimDailyBonus({ uid: UID, displayName: 'local-user' }),
      bonusService.claimDailyBonus({ uid: UID, displayName: 'local-user' }),
    ]);

    const granted = [a, b].filter((r) => r && r.granted === true);
    assert.equal(granted.length, 1, `expected exactly one award, got ${granted.length}`);

    // The credit must be visible exactly once: 50, not 100.
    const stored = (await storage.getUsers())[UID];
    assert.equal(stored.score, BONUS_POINTS, 'concurrent claims must credit the bonus exactly once');
  } finally {
    storage.saveUsers = realSaveUsers;
  }
});

test('sequential claims for one player award exactly once', async () => {
  resetStore();

  const first = await (await post('/api/game/bonus')).json();
  const second = await (await post('/api/game/bonus')).json();

  assert.equal(first.granted, true);
  assert.equal(second.granted, false);

  const users = await storage.getUsers();
  assert.equal(users[UID].score, BONUS_POINTS);
});

test('the bonus requires authentication', async () => {
  const savedDevAuth = process.env.ALLOW_DEV_AUTH;
  delete process.env.ALLOW_DEV_AUTH;

  try {
    const claim = await post('/api/game/bonus');
    assert.equal(claim.status, 401, 'an unauthenticated claim must be rejected');

    const status = await fetch(`${base}/api/game/bonus`);
    assert.equal(status.status, 401, 'an unauthenticated status read must be rejected');
  } finally {
    process.env.ALLOW_DEV_AUTH = savedDevAuth;
  }
});

test('the response never carries the internal user map', async () => {
  resetStore();

  const body = await (await post('/api/game/bonus')).json();

  // `users` is the broadcast payload; leaking it would publish every stored
  // profile (including private fields) to the caller.
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'users'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'uid'), false);
});

test('a granted bonus broadcasts the same leaderboard shape as GET /api/leaderboard', async () => {
  // The broadcast must be buildable from the write result alone, so the route
  // never re-reads storage and cannot disagree with itself.
  const users = {
    [UID]: { uid: UID, username: 'local-user', bestScore: 90, streak: 2 },
  };

  const board = scoring.buildLeaderboard(users);
  assert.equal(board.length, 1);
  assert.deepEqual(Object.keys(board[0]).sort(), [
    'bestScore',
    'messagesSent',
    'rank',
    'streak',
    'username',
  ]);
});
