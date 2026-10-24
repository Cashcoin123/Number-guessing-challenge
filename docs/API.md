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

Protected endpoints: `POST /game/bonus`, `GET /game/bonus`,
`POST /chat/send`, `POST /users/register`, `GET /users/:id`.

The browser client obtains its identity from Firebase Authentication and sends a
fresh ID token on every authenticated request (tokens expire, so the client asks
the SDK for a current one per call rather than caching the string). The Socket.IO
handshake carries the same token. See `frontend/.env.example`.

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

#### Sharing a result (web and mobile clients, no API involved)

Both clients can share a finished round. There is no sharing endpoint - it is a
client-side affordance over the `POST /game/guess` response, and it adds no
network call of its own.

The shared text quotes these response fields and nothing else:

| Response field | Where it appears |
| --- | --- |
| `attempts`, `maxAttempts` | "in N of M attempts" |
| `awarded` | "scored N points" (scored wins only) |
| `score`, `bestScore`, `streak` | "total N, best N, streak N" |

The ladder's numbers are never recomputed on the client, so the shared text
cannot disagree with the leaderboard. The identity cases are reported
distinctly:

- **scored win** (`scored: true`) - quotes the award and the resulting totals;
- **guest win** (no `scored`, no totals) - states that the round was played as a
  guest and that **no points were recorded**;
- **out of attempts** - states the round ended and that the player **scored
  nothing**, even when the server sends `awarded: 0`.

Transport: `navigator.share` when the browser provides it, otherwise
`navigator.clipboard.writeText`, otherwise the UI states that neither is
available. A rejected clipboard write or a failed share sheet is reported as a
failure - the client never reports a copy that did not happen and never falls
back to `document.execCommand`. The link is `window.location.origin`; no domain is
invented and no third-party sharing service is contacted. The text is bounded to
280 characters and never includes an email address or any identity field other
than the player's own chosen username.

#### Sharing a result from the mobile client

`mobile/src/share.js` implements the same contract, with the transport layer
chosen for the platform rather than the browser:

| Platform | Strategy order | Link |
| --- | --- | --- |
| iOS / Android | React Native `Share.share` → clipboard | none (a phone app has no page address) |
| Mobile web export | `navigator.share` → `navigator.clipboard.writeText` | the app's own origin |

The text is composed from the same response fields and obeys the same three
identity rules. Two differences, both forced by the platform:

- **A native build shares no link.** There is no `window.location.origin` on a
  device, so the link clause is omitted rather than a domain being invented for a
  deployment that may not exist.
- **An unscored win is worded by who the player is.** A genuine guest reads "as a
  guest, so no points were recorded". An authenticated player whose round the
  server failed to score reads "but the server did not record any points for the
  round" - telling a signed-in player they were a guest would be its own lie.

Four transport outcomes are kept distinct, because collapsing any two of them
would be a lie the player could act on: `shared`, `copied`, `cancelled` (a sheet
dismissal - neither success nor failure), `unavailable` (no transport, or a
platform that refuses to provide one), and `failed` (a transport existed, was
attempted, and did not complete). React Native Web's `Share.share` rejects with
`"Share is not supported in this browser"` when the browser has no Web Share API;
that rejection is mapped to `unavailable`, not to `cancelled` or `failed`, because
the player did not cancel anything and nothing was attempted.

The `mobile/src/share.js` module is pure - no React, React Native or Expo import
at module top level, transports injected - so its 33 tests run under the ordinary
`npm test` in `mobile/` without a device.

#### Chat from the mobile client (posting and freshness)

The mobile client both reads and writes the global room. Reading needs no
identity; **writing does**.

```
GET  /chat/messages                          (public)
POST /chat/send   { "message": "..." }       (authenticated)
```

The request body is built in exactly one place (`mobile/src/chat.js`,
`buildSendBody`) and has exactly one key. The display name is
`resolveDisplayName(req.user)` and the score is read from the stored user record,
so `username`/`score`/`userId`/`timestamp` in a request body are ignored by the
server. The client therefore never sends them: doing so is the impersonation
defect ISSUE-4 fixed, and the runtime evidence asserts their **absence** on the
wire rather than merely the presence of `message`.

Client-side rules, covered by `mobile/test/chat.test.js` (38 tests):

- **A 401 is refused, not reported.** A guest cannot post. They are told, in the
  same words the web app uses, *"Sign in to join the global chat."* - and no
  outcome notice for any failure contains the words *sent*, *posted*,
  *delivered*, *published* or *submitted* (asserted over every failure status).
- **The draft is kept on failure.** The composer is cleared **only** when the
  server confirms it stored that exact text, so a refusal never makes the text
  disappear as though it had been delivered.
- **The text is never cut.** The server stores at most 280 characters and
  truncates silently on the way in, so an over-long message is **refused before
  it is sent**, with its real length quoted. Trimming it and reporting it as sent
  would display text the player did not write, attributed to them. Length is
  counted in UTF-16 code units - the unit `slice(0, 280)` cuts on - so a message
  built from emoji cannot slip past a code-point check and be cut in half.
- **A 200 is not enough.** The stored `message` and `username` are read back out
  of the response, and text differing from what was submitted is reported as
  altered rather than accepted.
- **Five failure kinds stay distinct:** no identity (401/403), rate-limited (429),
  refused (400), server fault (5xx), unreachable. Each has its own wording because
  each has its own fix.

Freshness. This client has **no socket** - it talks REST only - so "current" means
"re-read on an interval", and the documentation must not upgrade that into
"realtime". Both the leaderboard and the chat are re-read every **10 seconds**
while the screen is visible:

- one read cycle at a time, re-armed after the previous one finishes, so a slow
  server cannot cause a pile-up;
- a tick that arrives while a cycle is running is skipped and counted, not queued;
- every entry point (the interval, the read after a send, the read after a scored
  round or a granted bonus, the read on resume) joins **one serialised queue**, so
  two reads are never in flight and a slower older answer cannot land on top of a
  newer one;
- on failure the interval doubles up to 120 s and snaps back on the first success;
- a source that failed returns `null`, which means "keep what is on screen" - a
  failed refresh never blanks the room or the leaderboard;
- the loop is stopped on unmount and while the app is backgrounded, and resuming
  re-reads at once. A read still in flight when the screen goes away is discarded.

The screen states its own freshness in seconds (*"Shared state updated 3 s ago.
This screen re-reads the leaderboard and chat every 10 s while it is open."*)
rather than implying a live connection.

### Claim Daily Bonus
```
POST /game/bonus      (authenticated)
```
The 24-hour cooldown is tracked **per authenticated user**. The award is
**server-authoritative**: the points are credited to the stored `score` and
`bestScore` of the uid in the verified token, so the total survives a reload and
appears on the leaderboard. The response carries the authoritative totals; a
client must render them rather than adding the bonus to local state.

A bonus never changes `streak` (a streak counts consecutive wins).

Response (granted):
```json
{
  "ok": true,
  "granted": true,
  "bonus": 50,
  "score": 250,
  "bestScore": 400,
  "streak": 3,
  "nextAvailableAt": 1695916800000,
  "username": "Player-a7d75d"
}
```

Response (not due - still carries the stored totals):
```json
{
  "ok": true,
  "granted": false,
  "bonus": 0,
  "score": 250,
  "bestScore": 400,
  "streak": 3,
  "nextAvailableAt": 1695916800000
}
```

Awarding is bound to the identity in the token: the uid and the awarded value can
never come from the request body. A claim is granted **exactly once** per window;
concurrent claims for one uid are serialised, and a credit that fails to persist
rolls the window back so the bonus stays claimable. `500` is returned when the
credit could not be written.

After a granted bonus the server emits `leaderboard-update` to the global chat
room, for the same reason a scored round does: the ranking just changed.

### Get Daily Bonus State
```
GET /game/bonus      (authenticated)
```
Reports availability **without claiming**. Reading this must never award
anything, which is why status and claim are separate routes.

Response:
```json
{
  "ok": true,
  "available": true,
  "bonus": 50,
  "nextAvailableAt": 1695916800000,
  "score": 250,
  "bestScore": 400,
  "streak": 3
}
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

## Mobile client

`mobile/` is a client of this API, not a separate game. It uses the same routes as
the web app; there is no mobile-only endpoint.

| Flow | Request | Fields the client renders |
| --- | --- | --- |
| Session probe | `GET /game/bonus` | `score`, `bestScore`, `streak`, `available`; a `401` means **guest** |
| Start a round | `POST /game/start` | `round.roundId`, `round.maxAttempts` |
| Guess | `POST /game/guess` `{ roundId, guess }` | `result`, `attempts`, `maxAttempts`, `remaining`, and on a finished round `secretNumber`, `scored`, `awarded`, `score`, `bestScore`, `streak` |
| Global stats | `GET /game/stats` | `bestScore`, `streak`, `totalGames` |
| Leaderboard | `GET /leaderboard` | `rank`, `username`, `bestScore`, `streak` |
| Chat (read) | `GET /chat/messages` | `username`, `message`, `score` |
| Chat (post) | `POST /chat/send` `{ message }` | the stored `username`, `message`, `score` |
| Daily bonus | `POST /game/bonus` | `granted`, `bonus`, `score`, `bestScore`, `streak` |

Rules the mobile client follows, and that are covered by
`mobile/test/gameClient.test.js`:

- **The secret number comes from the server only.** The client has no
  number-generation code and no field that could hold one; it copies
  `secretNumber` only when the server includes it, which is only once a round is
  `correct` or `round-over`. A start response that smuggled a number would still
  have nowhere to go.
- **Points come from the server only.** There is no scoring arithmetic in the
  client. `awarded`, `score`, `bestScore` and `streak` are rendered exactly as
  received; a response without them is treated as **unscored** rather than
  completed with a plausible number.
- **A loss is quoted, not computed.** On a loss the server sends `awarded: 0`
  while the points formula would yield 20, so the loss screen is the observable
  proof that the client is not recomputing anything.
- **Guests are told the truth.** A guest round is playable, and the UI states
  that no points were recorded — it never shows a guest a stored total.
- **A failure is visible.** An unreachable backend produces an explicit
  "the server cannot be reached" state and no way to start a round; an
  unreadable body is reported as unreadable; an HTTP error surfaces the server's
  own message.
- **Chat is readable and writable.** A signed-in player can post to the global
  room; a guest can read it and is told plainly that posting needs an identity,
  with the draft kept so nothing silently vanishes. Both the chat and the
  leaderboard are re-read every 10 s while the screen is visible (there is no
  socket on this client), with backoff on failure, no overlapping reads, and no
  read after unmount. See
  [Chat from the mobile client](#chat-from-the-mobile-client-posting-and-freshness).

### API base URL

There is no hardcoded host. Resolution order: `expo.extra.apiUrl`, then
`EXPO_PUBLIC_API_URL`, then (web only) the app's own origin. A native build with
none of these is a configuration error the UI reports. Details and examples are
in [SETUP.md](SETUP.md#mobile-api-address).

### Identity

Scoring requires the server to resolve an identity. Locally that is the
`ALLOW_DEV_AUTH=true` bypass (the server injects the identity) or an explicitly
configured development token sent as `Authorization: Bearer <token>`. A token the
server cannot verify is treated as a guest — the client cannot promote itself.

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
