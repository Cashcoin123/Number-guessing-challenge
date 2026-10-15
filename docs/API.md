# API Documentation

## Base URL
```
http://localhost:5000/api
```

All responses are JSON with an `ok` boolean.

## Authentication

Protected endpoints expect a Firebase ID token:

```
Authorization: Bearer <firebase-id-token>
```

The API is **fail-closed**: a protected endpoint without a valid token returns
`401`. For local development only, setting `ALLOW_DEV_AUTH=true` (and
`NODE_ENV` != `production`) injects a local development identity so the web app
works without Firebase. See `backend/.env.example`.

Protected endpoints: `POST /game/bonus`, `POST /chat/send`,
`POST /users/register`, `GET /users/:id`.

## Game Routes

### Get Game Stats
```
GET /game/stats
```
Response:
```json
{
  "ok": true,
  "stats": { "bestScore": 1200, "streak": 5, "totalGames": 42 }
}
```

### Start New Round
```
POST /game/start
```
The secret number is generated and stored **server-side**; it is never returned
to the client.

Response:
```json
{
  "ok": true,
  "round": { "roundId": "3f1c...", "maxAttempts": 10, "startedAt": "2024-01-01T12:00:00.000Z" }
}
```

Rounds are held in memory and the store is bounded. When every tracked slot is held
by a round a player is still playing, the API refuses to admit another round rather
than terminating one that is in progress. The refusing response is retryable:

```json
{
  "ok": false,
  "message": "The game is at capacity right now. Please try again in a moment.",
  "retryable": true
}
```
HTTP status `503`. Finished, expired and idle rounds are reclaimed automatically, so
this only occurs when live rounds alone saturate the store.

The endpoint is also admitted through a per-source rate limit, because it is
intentionally open to guests. A single source may create a bounded number of
rounds per window (`ROUNDS_RATE_MAX` per `ROUNDS_RATE_WINDOW_MS`, default 30 per
minute); going over returns a retryable `429`:

```json
{
  "ok": false,
  "message": "Too many new rounds started from this source. Please wait a moment and try again.",
  "retryable": true
}
```
Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`, and a `Retry-After` header on the `429`. The limiter keys on
the client address, which honours `TRUST_PROXY` (off by default).

### Submit Guess
```
POST /game/guess
```
Body — the client sends only the round id and its guess. It cannot supply the
secret number.
```json
{ "roundId": "3f1c...", "guess": 50 }
```

Response:
```json
{
  "ok": true,
  "result": "too-high" | "too-low" | "correct" | "round-over",
  "attempts": 3,
  "maxAttempts": 10,
  "remaining": 7,
  "secretNumber": 42
}
```
`secretNumber` is only included once the round is `correct` or `round-over`.

Errors: `400` when `roundId` is missing or `guess` is not an integer in
`1..100`; `404` when the round id is unknown or has expired.

### Claim Daily Bonus
```
POST /game/bonus      (authenticated)
```
The 24-hour cooldown is tracked **per authenticated user**.

Response:
```json
{ "ok": true, "granted": true, "bonus": 50, "nextAvailableAt": 1695916800000 }
```

## Chat Routes

### Get Chat Messages
```
GET /chat/messages
```
Response:
```json
{
  "ok": true,
  "messages": [
    { "username": "Player1", "message": "Just won 100 points!", "score": 100, "timestamp": "2024-01-01T12:00:00.000Z" }
  ]
}
```

### Send Chat Message
```
POST /chat/send      (authenticated)
```
Body — the username is taken from the authenticated identity; any client-supplied
`username` is ignored. Messages are bounded to 280 characters.
```json
{ "message": "Great game!" }
```
Response:
```json
{
  "ok": true,
  "message": { "username": "Player1", "message": "Great game!", "score": 0, "timestamp": "2024-01-01T12:00:00.000Z" }
}
```

## User Routes

### Register / Update User
```
POST /users/register      (authenticated)
```
Body:
```json
{ "username": "Player1" }
```

### Get User Profile
```
GET /users/:id      (authenticated, owner only)
```
Returns `403` unless `:id` matches the authenticated user's uid. Private fields
(email) are only returned to the owner.

## Leaderboard Routes

### Get Global Leaderboard
```
GET /leaderboard
```
Response:
```json
{
  "ok": true,
  "leaderboard": [
    { "rank": 1, "username": "TopPlayer", "bestScore": 5000, "streak": 15, "messagesSent": 45 }
  ]
}
```

## WebSocket Events

The Socket.IO handshake is authenticated with the same token:
```javascript
const socket = io(API_URL, { auth: { token: firebaseIdToken } });
```

### Join Chat
```javascript
socket.emit('join-chat');
socket.on('chat-message', (message) => console.log(message));
```

### Send Message
The server derives the sender identity from the authenticated socket; the
payload only carries the message text.
```javascript
socket.emit('send-message', { message: 'Hello everyone!' });
```
