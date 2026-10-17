const path = require('path');

// Resolve the on-disk data directory used by the local JSON storage layer.
// The same paths are reused by scripts and tests that need to inspect or reset
// persisted game data.
const dataDir = path.resolve(__dirname, '../../data');

module.exports = {
  appName: 'number-guessing-challenge',
  dataDir,
  usersFile: path.join(dataDir, 'users.json'),
  chatFile: path.join(dataDir, 'chat_messages.json'),
  leaderboardFile: path.join(dataDir, 'leaderboard.json'),
  gameFile: path.join(dataDir, 'game_data.json'),
  // Storage mode flag. Kept in one place so the data layer and diagnostics
  // agree on which backend is active.
  useFirebase: process.env.USE_FIREBASE === 'true',
  usePostgres: process.env.USE_POSTGRES === 'true',
};
