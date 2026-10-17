require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { initFirebase } = require('../config/firebase');

const DATA_DIR = path.resolve(__dirname, '../../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHAT_FILE = path.join(DATA_DIR, 'chat_messages.json');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const GAME_FILE = path.join(DATA_DIR, 'game_data.json');
const BONUS_FILE = path.join(DATA_DIR, 'bonus.json');

const USE_FIREBASE = process.env.USE_FIREBASE === 'true';
const firebaseDb = initFirebase();

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
  }
}

ensureFile(USERS_FILE, {});
ensureFile(CHAT_FILE, []);
ensureFile(LEADERBOARD_FILE, []);
ensureFile(GAME_FILE, {
  bestScore: 0,
  streak: 0,
  totalGames: 0,
  lastBonusTime: 0,
});
// Per-user daily bonus records, keyed by authenticated uid. A single shared
// timestamp (the previous design) let one player's claim block every other
// player (ISSUE-8).
ensureFile(BONUS_FILE, {});

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  // Write to a temp file first and rename over the target so a concurrent
  // reader (or a crash mid-write) can never observe a half-written JSON file
  // (ISSUE-7: non-atomic whole-file read-modify-write).
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

async function getUsers() {
  if (USE_FIREBASE && firebaseDb) {
    const snapshot = await firebaseDb.collection('users').get();
    const users = {};
    snapshot.forEach((doc) => {
      users[doc.id] = doc.data();
    });
    return users;
  }

  return readJson(USERS_FILE, {});
}

async function saveUsers(users) {
  if (USE_FIREBASE && firebaseDb) {
    const batch = firebaseDb.batch();
    Object.entries(users).forEach(([uid, user]) => {
      batch.set(firebaseDb.collection('users').doc(uid), user);
    });
    await batch.commit();
    return;
  }

  writeJson(USERS_FILE, users);
}

async function getChatMessages() {
  if (USE_FIREBASE && firebaseDb) {
    const snapshot = await firebaseDb
      .collection('chat_messages')
      .orderBy('timestamp', 'asc')
      .limit(20)
      .get();

    return snapshot.docs.map((doc) => doc.data());
  }

  return readJson(CHAT_FILE, []);
}

async function saveChatMessages(messages) {
  if (USE_FIREBASE && firebaseDb) {
    const batch = firebaseDb.batch();
    const trimmed = (messages || []).slice(-100);

    trimmed.forEach((entry, index) => {
      const id = entry.id || `${entry.userId || 'guest'}-${entry.timestamp || index}`;
      const ref = firebaseDb.collection('chat_messages').doc(id);
      batch.set(ref, { ...entry, id });
    });

    await batch.commit();
    return;
  }

  writeJson(CHAT_FILE, messages || []);
}

async function getLeaderboard() {
  if (USE_FIREBASE && firebaseDb) {
    const snapshot = await firebaseDb
      .collection('leaderboard')
      .orderBy('bestScore', 'desc')
      .limit(50)
      .get();

    return snapshot.docs.map((doc) => doc.data());
  }

  return readJson(LEADERBOARD_FILE, []);
}

async function saveLeaderboard(entries) {
  if (USE_FIREBASE && firebaseDb) {
    const batch = firebaseDb.batch();
    const trimmed = (entries || []).slice(0, 50);

    trimmed.forEach((entry, index) => {
      batch.set(firebaseDb.collection('leaderboard').doc(String(index + 1)), entry);
    });

    await batch.commit();
    return;
  }

  writeJson(LEADERBOARD_FILE, entries || []);
}

async function getGameStats() {
  if (USE_FIREBASE && firebaseDb) {
    const doc = await firebaseDb.collection('game').doc('stats').get();
    if (!doc.exists) {
      return {
        bestScore: 0,
        streak: 0,
        totalGames: 0,
        lastBonusTime: 0,
      };
    }

    return doc.data();
  }

  return readJson(GAME_FILE, {
    bestScore: 0,
    streak: 0,
    totalGames: 0,
    lastBonusTime: 0,
  });
}

async function saveGameStats(data) {
  if (USE_FIREBASE && firebaseDb) {
    await firebaseDb.collection('game').doc('stats').set(data, { merge: true });
    return;
  }

  writeJson(GAME_FILE, data || {
    bestScore: 0,
    streak: 0,
    totalGames: 0,
    lastBonusTime: 0,
  });
}

// Per-user daily bonus records ---------------------------------------------

async function getBonusRecords() {
  if (USE_FIREBASE && firebaseDb) {
    const snapshot = await firebaseDb.collection('bonuses').get();
    const records = {};
    snapshot.forEach((doc) => {
      records[doc.id] = doc.data();
    });
    return records;
  }

  return readJson(BONUS_FILE, {});
}

async function getBonusRecord(userId) {
  if (!userId) {
    return null;
  }

  const records = await getBonusRecords();
  return records[userId] || null;
}

async function saveBonusRecord(userId, record) {
  if (!userId) {
    return;
  }

  if (USE_FIREBASE && firebaseDb) {
    await firebaseDb.collection('bonuses').doc(userId).set(record, { merge: true });
    return;
  }

  const records = readJson(BONUS_FILE, {});
  records[userId] = { ...(records[userId] || {}), ...record };
  writeJson(BONUS_FILE, records);
}

module.exports = {
  getUsers,
  saveUsers,
  getChatMessages,
  saveChatMessages,
  getLeaderboard,
  saveLeaderboard,
  getGameStats,
  saveGameStats,
  getBonusRecords,
  getBonusRecord,
  saveBonusRecord,
};
