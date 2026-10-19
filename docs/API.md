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
the client address, which honours `TRUST_PROXY` (off by default). The key space
is bounded, so one source cannot buy extra budget by rewording its address:

- a trailing port is ignored, whether the host is bracketed (`[::1]:443`) or not
  (`203.0.113.9:12345`, `::ffff:203.0.113.9:12345`);
- case, surrounding whitespace, a zone suffix and leading-zero octets are
  normalised (`0203.0.113.9` is the same source as `203.0.113.9`);
- `::ffff:`-mapped IPv4 is the same source as the plain IPv4 address, and IPv6
  clients are budgeted per `/64` prefix, so one host cannot mint a budget per
  interface identifier;
- input that is not a valid address is confined to a single shared bucket rather
  than keyed on its raw text, so junk cannot consume the bucket table.

A third refusal also exists for the limiter's own bucket table: when the table is
full of live buckets and nothing has expired, a brand-new source is refused with
the same retryable `429` and the message `Too many distinct sources are starting
rounds right now.`, rather than being served by evicting a live source's bucket.

This bounds *spellings of one address*. It does not bound a caller that presents
a genuinely different valid address each request (real source-address rotation,
or a proxy that forwards a client-controlled address); authenticating
`POST /api/game/start` is the durable fix for that and is intentionally not done,
because the endpoint is open to guests.

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

#### Scoring (server-authoritative)

A round created by an **authenticated** caller is scored on the server. The
player is credited against the identity that created the round; the request body
cannot name the uid to credit and cannot supply the attempt count. The winning
response carries the award and the resulting totals:

```json
{
  "ok": true,
  "result": "correct",
  "attempts": 3,
  "maxAttempts": 10,
  "remaining": 7,
  "secretNumber": 42,
  "scored": true,
  "awarded": 76,
  "score": 76,
  "bestScore": 76,
  "streak": 1,
  "newPersonalBest": true
}
```

Points are `max(20, 100 - attempts * 8)`, so a win is worth at least 20 and a
first-guess win is worth 92. The attempt that ends a losing round is also scored
(`awarded: 0`) because it counts as a played game and resets the streak.

Behaviour that callers can rely on:

- a **guest** round (no token) resolves exactly as before but is never scored;
the response simply omits `scored`/`awarded`;
- a win is awarded **exactly once** - replaying the winning request resolves as
`round-over` with no `scored` field and does not change the stored totals;
- a round bound to a player returns `403` to any other caller, so a leaked
`roundId` cannot be used to burn another player's attempts;
- after a scored round the server pushes a `leaderboard-update` event to the
global chat room.

Errors: `400` when `roundId` is missing or `guess` is not an integer in
`1..100`; `403` when the round belongs to another player; `404` when the round id
is unknown or has expired.

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

### Leaderboard Update (server to client)
Emitted to the `global-chat` room after a scored round, carrying the same shape
as `GET /leaderboard` so a client can replace its table without re-fetching.
```javascript
socket.on('leaderboard-update', (payload) => console.log(payload.leaderboard));
```
```json
{ "leaderboard": [ { "rank": 1, "username": "Player1", "bestScore": 76, "streak": 1, "messagesSent": 0 } ], "at": 1695916800000 }
```

### Send Message
The server derives the sender identity from the authenticated socket; the
payload only carries the message text.
```javascript
socket.emit('send-message', { message: 'Hello everyone!' });
```
