const express = require('express');

const storage = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const { normaliseUsername } = require('../utils/helpers');

const router = express.Router();

// Fields that are never returned to anyone other than the owner.
const PRIVATE_FIELDS = ['email'];

function publicUser(user, isOwner) {
  if (!user) {
    return null;
  }

  const copy = { ...user };
  if (!isOwner) {
    PRIVATE_FIELDS.forEach((field) => delete copy[field]);
  }

  return copy;
}

// POST /api/users/register
router.post('/register', requireAuth, async (req, res) => {
  const { username } = req.body || {};
  const cleanUsername = normaliseUsername(username);

  if (!cleanUsername) {
    return res.status(400).json({ ok: false, message: 'Username is required.' });
  }

  const uid = (req.user && req.user.uid) || cleanUsername;
  const users = await storage.getUsers();
  const existing = users[uid] || {};

  const user = {
    ...existing,
    uid,
    username: cleanUsername,
    email: existing.email || (req.user && req.user.email) || '',
    joinedAt: existing.joinedAt || new Date().toISOString(),
    score: existing.score || 0,
    bestScore: existing.bestScore || 0,
    streak: existing.streak || 0,
    messagesSent: existing.messagesSent || 0,
    updatedAt: new Date().toISOString(),
  };

  users[uid] = user;
  await storage.saveUsers(users);

  return res.json({ ok: true, user: publicUser(user, true) });
});

// GET /api/users/:id
// Authenticated and owner-scoped: a caller may only read their own profile, and
// private fields (email) are stripped, preventing enumeration / PII disclosure
// (ISSUE-9).
router.get('/:id', requireAuth, async (req, res) => {
  const requesterId = (req.user && req.user.uid) || null;

  if (!requesterId || requesterId !== req.params.id) {
    return res.status(403).json({ ok: false, message: 'You may only view your own profile.' });
  }

  const users = await storage.getUsers();
  const user = users[req.params.id];

  if (!user) {
    return res.status(404).json({ ok: false, message: 'User not found.' });
  }

  return res.json({ ok: true, user: publicUser(user, true) });
});

module.exports = router;
