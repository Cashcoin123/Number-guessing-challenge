const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Scoring regression coverage (ISSUE-24).
//
// The API could already start and resolve a round, but nothing ever WROTE a
// score: a winning guess returned `correct` and left `bestScore`, `streak` and
// the global leaderboard at zero forever. These tests play real rounds through
// the real Express surface and assert the persisted result, so the gap cannot
// silently return.
//
// The JSON storage adapter writes under backend/data, which is shared with a
// developer's local play state. Every file it touches is snapshotted before the
// suite and restored afterwards, so running the suite neither pollutes that
// directory nor races another suite.
const realDataDir = path.resolve(__dirname, '../data');
const DATA_FILES = [
  'users.json',
  'game_data.json',
  'leaderboard.json',
  'bonus.json',
  'chat_messages.json',
];
const snapshots = {};

for (const name of DATA_FILES) {
  const file = path.join(realDataDir, name);
  snapshots[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Development posture with the local identity bypass: the only way to exercise a
// scored (authenticated) round without a live Firebase project, and the posture
// the SPA uses locally. Must be set before the server module is loaded.
process.env.NODE_ENV = 'development';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.USE_FIREBASE = 'false';
process.env.TRUST_PROXY = 'false';
process.env.ROUNDS_RATE_WINDOW_MS = '60000';
process.env.ROUNDS_RATE_MAX = '200';

const { server, io } = require('../src/server');
const scoring = require('../src/services/scoring');
const roundStore = require('../src/services/roundStore');

let base;

function resetStore() {
  fs.mkdirSync(realDataDir, { recursive: true });
  fs.writeFileSync(path.join(realDataDir, 'users.json'), '{}');
  fs.writeFileSync(
    path.join(realDataDir, 'game_data.json'),
    JSON.stringify({ bestScore: 0, streak: 0, totalGames: 0, lastBonusTime: 0 })
  );
}

test.before(async () => {
  resetStore();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
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

// Resolve a round by binary search and return the winning response body.
async function winRound(roundId) {
  let low = 1;
  let high = 100;

  for (let i = 0; i < 10; i += 1) {
    const guess = Math.floor((low + high) / 2);
    const body = await (await post('/api/game/guess', { roundId, guess })).json();

    if (body.result === 'correct') return body;
    if (body.result === 'too-low') low = guess + 1;
    else if (body.result === 'too-high') high = guess - 1;
    else return body;
  }

  throw new Error('round did not resolve to a win');
}

test('the points formula rewards fewer attempts and never mints points from junk', () => {
  assert.equal(scoring.pointsForWin(1), 92);
  assert.equal(scoring.pointsForWin(2), 84);
  assert.equal(scoring.pointsForWin(10), 20);

  // A loss cannot be expressed as a win, and junk cannot award anything.
  assert.equal(scoring.pointsForWin(0), 0);
  assert.equal(scoring.pointsForWin(-3), 0);
  assert.equal(scoring.pointsForWin(null), 0);
  assert.equal(scoring.pointsForWin('many'), 0);

  // The formula never falls below the floor no matter how many attempts are used.
  assert.equal(scoring.pointsForWin(999), 20);
});

test('winning an authenticated round persists score, best and streak', async () => {
  const start = await (await post('/api/game/start')).json();
  assert.equal(start.ok, true);

  // The owner binding is internal and must never be serialised to the client.
  assert.equal(Object.prototype.hasOwnProperty.call(start.round, 'ownerUid'), false);

  const win = await winRound(start.round.roundId);

  // The regression: a win must report and persist an award.
  assert.equal(win.scored, true, 'a win by an authenticated player must be scored');
  assert.equal(typeof win.awarded, 'number');
  assert.ok(win.awarded > 0, `expected a positive award, got ${win.awarded}`);
  assert.equal(win.awarded, scoring.pointsForWin(win.attempts));
  assert.equal(win.score, win.awarded);
  assert.equal(win.bestScore, win.awarded);
  assert.equal(win.streak, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(win, 'ownerUid'), false);

  // The stored state must agree with the response.
  const profile = await getJson('/api/users/local-dev-user');
  assert.equal(profile.user.bestScore, win.awarded);
  assert.equal(profile.user.streak, 1);

  const stats = await getJson('/api/game/stats');
  assert.equal(stats.stats.bestScore, win.awarded);
  assert.ok(stats.stats.totalGames >= 1);
});

test('the global leaderboard actually contains the scored player', async () => {
  const board = await getJson('/api/leaderboard');
  assert.equal(board.ok, true);

  // Before the fix this array could only ever hold zero scores, which left the
  // documented global leaderboard permanently empty of meaning.
  const entry = board.leaderboard.find((row) => row.username === 'local-user');
  assert.ok(entry, `scored player missing from leaderboard: ${JSON.stringify(board.leaderboard)}`);
  assert.ok(entry.bestScore > 0, 'leaderboard entry must carry the scored total');
  assert.equal(entry.rank, 1);
});

test('a replayed winning request cannot award a second time', async () => {
  const start = await (await post('/api/game/start')).json();

  let low = 1;
  let high = 100;
  let winningGuess = null;
  let winningBody = null;

  for (let i = 0; i < 10 && winningGuess === null; i += 1) {
    const guess = Math.floor((low + high) / 2);
    const body = await (await post('/api/game/guess', { roundId: start.round.roundId, guess })).json();

    if (body.result === 'correct') {
      winningGuess = guess;
      winningBody = body;
    } else if (body.result === 'too-low') {
      low = guess + 1;
    } else if (body.result === 'too-high') {
      high = guess - 1;
    }
  }

  assert.notEqual(winningGuess, null);
  // The win that resolves the round is the one that may award, exactly once.
  assert.equal(winningBody.scored, true);

  // Baseline is taken AFTER the legitimate award, so any further change can only
  // come from the replays below.
  const before = await getJson('/api/users/local-dev-user');

  const first = await (await post('/api/game/guess', { roundId: start.round.roundId, guess: winningGuess })).json();
  const second = await (await post('/api/game/guess', { roundId: start.round.roundId, guess: winningGuess })).json();

  // Replays against a finished round resolve as round-over and are never scored.
  assert.equal(first.scored, undefined);
  assert.equal(first.result, 'round-over');
  assert.equal(second.scored, undefined);
  assert.equal(second.result, 'round-over');

  const after = await getJson('/api/users/local-dev-user');
  assert.equal(after.user.score, before.user.score, 'a replay must not change the stored score');
  assert.equal(after.user.streak, before.user.streak, 'a replay must not extend the streak');
});

test('a guest round stays playable but is never scored', async () => {
  // Guests are the documented audience for POST /game/start, so this path must
  // keep working; it simply has no identity to credit.
  const savedDevAuth = process.env.ALLOW_DEV_AUTH;
  delete process.env.ALLOW_DEV_AUTH;

  try {
    const start = await (await post('/api/game/start')).json();
    assert.equal(start.ok, true);

    const win = await winRound(start.round.roundId);

    assert.equal(win.ok, true);
    assert.equal(win.result, 'correct');
    assert.equal(win.scored, undefined, 'a guest win must not be scored');
    assert.equal(win.awarded, undefined);
  } finally {
    process.env.ALLOW_DEV_AUTH = savedDevAuth;
  }
});

test('a round bound to one player cannot be played by another', async () => {
  // Bind a round to a uid the current request cannot match: this is the leaked
  // round id case.
  const round = roundStore.createRound({ ownerUid: 'someone-else' });

  const res = await post('/api/game/guess', { roundId: round.roundId, guess: 50 });
  assert.equal(res.status, 403, 'another player must not be able to play a bound round');
});
