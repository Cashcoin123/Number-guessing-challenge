require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const storage = require('./services/storage');
const { authenticateSocket } = require('./middleware/auth');
const { normaliseMessage, resolveDisplayName } = require('./utils/helpers');
const gameRoutes = require('./routes/gameRoutes');
const chatRoutes = require('./routes/chatRoutes');
const userRoutes = require('./routes/userRoutes');

const app = express();

// --- Proxy trust -------------------------------------------------------------
// The rate limiter keys its buckets on req.ip. Trusting X-Forwarded-For
// unconditionally would let a caller choose its own bucket (and therefore evade
// the limit), so proxy trust is an explicit, off-by-default opt-in for
// deployments that sit behind a trusted reverse proxy (ISSUE-23 residual).
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// --- CORS -------------------------------------------------------------------
// When CLIENT_URL is configured, restrict browser origins to that allowlist
// (comma-separated) instead of reflecting any origin (ISSUE-5). If it is not
// set we keep the permissive development default so local tooling still works.
function buildOriginSetting() {
  const configured = (process.env.CLIENT_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    return true;
  }

  return configured;
}

const allowedOrigins = buildOriginSetting();
const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
};

const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

const PORT = process.env.PORT || 5000;

app.use(cors(corsOptions));
app.use(express.json({ limit: '32kb' }));

// Reject malformed JSON bodies with a clean 400 instead of a 500.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: 'Malformed JSON body.' });
  }
  return next(err);
});

// The Socket.IO instance is shared with route handlers for realtime broadcasts.
app.set('io', io);

// GET /api/health - liveness only; does not disclose the auth mode or config
// (ISSUE-2).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'API is running.',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/game', gameRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/users', userRoutes);

app.get('/api/leaderboard', async (req, res) => {
  const users = await storage.getUsers();
  const leaderboard = Object.values(users)
    .sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0))
    .slice(0, 50)
    .map((user, index) => ({
      rank: index + 1,
      username: user.username,
      bestScore: user.bestScore || 0,
      streak: user.streak || 0,
      messagesSent: user.messagesSent || 0,
    }));

  res.json({ ok: true, leaderboard });
});

// --- Socket.IO --------------------------------------------------------------
// Every socket is authenticated during the handshake and its identity is bound
// to the connection; clients cannot forge a username and payloads are validated
// and bounded (ISSUE-6).
io.use(async (socket, next) => {
  const user = await authenticateSocket(socket);

  if (!user) {
    return next(new Error('unauthorized'));
  }

  socket.data.user = user;
  // Identity email is PII and must never become a public display name (ISSUE-22).
  socket.data.username = resolveDisplayName(user);
  return next();
});

io.on('connection', (socket) => {
  socket.join('global-chat');

  socket.on('join-chat', () => {
    io.to('global-chat').emit('chat-message', {
      username: socket.data.username,
      message: `${socket.data.username} joined the chat room.`,
      timestamp: new Date().toISOString(),
      system: true,
    });
  });

  socket.on('send-message', async (payload) => {
    const source = payload && typeof payload === 'object' ? payload : {};
    const cleanMessage = normaliseMessage(source.message);

    if (!cleanMessage) {
      return;
    }

    // Identity is taken from the authenticated socket, never from the payload.
    const entry = {
      username: socket.data.username,
      message: cleanMessage,
      score: 0,
      timestamp: new Date().toISOString(),
      userId: socket.data.user.uid || null,
    };

    const messages = await storage.getChatMessages();
    await storage.saveChatMessages([...messages, entry].slice(-100));

    io.to('global-chat').emit('chat-message', entry);
  });

  socket.on('disconnect', () => {
    // no-op: kept for symmetry / observability hooks
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  });
}

module.exports = { app, server, io };
