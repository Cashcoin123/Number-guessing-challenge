const express = require('express');

const storage = require('../services/storage');
const { requireAuth } = require('../middleware/auth');
const { normaliseMessage, resolveDisplayName } = require('../utils/helpers');

const router = express.Router();

// GET /api/chat/messages (public read of the global room)
router.get('/messages', async (req, res) => {
  const messages = await storage.getChatMessages();
  res.json({ ok: true, messages: messages.slice(-20) });
});

// POST /api/chat/send
// Identity (username) and score are server-derived; any client-supplied
// username or score is ignored so players cannot impersonate others or inflate
// their score, and the message length is bounded (ISSUE-4).
router.post('/send', requireAuth, async (req, res) => {
  const { message } = req.body || {};

  const cleanMessage = normaliseMessage(message);
  if (!cleanMessage) {
    return res.status(400).json({ ok: false, message: 'A non-empty message is required.' });
  }

  const uid = (req.user && req.user.uid) || null;

  // Score is never taken from the request body. It is read from the stored user
  // record when one exists, otherwise it stays 0.
  let score = 0;
  if (uid) {
    const users = await storage.getUsers();
    const stored = users[uid];
    if (stored && Number.isFinite(Number(stored.bestScore))) {
      score = Math.max(0, Math.trunc(Number(stored.bestScore)));
    }
  }

  // Never fall back to the identity email: a decoded Firebase ID token has no
  // username/name claim, so that fallback published player PII in public chat
  // (ISSUE-22). resolveDisplayName derives a pseudonym instead.
  const username = resolveDisplayName(req.user);

  const entry = {
    username,
    message: cleanMessage,
    score,
    timestamp: new Date().toISOString(),
    userId: uid,
  };

  const messages = await storage.getChatMessages();
  const nextMessages = [...messages, entry].slice(-100);
  await storage.saveChatMessages(nextMessages);

  const io = req.app.get('io');
  if (io) {
    io.to('global-chat').emit('chat-message', entry);
  }

  return res.json({ ok: true, message: entry });
});

module.exports = router;
