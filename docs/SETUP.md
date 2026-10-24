# Quick Setup Guide

## Local Development

### Backend
```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

**Expected output:**
```
✅ Server running on http://localhost:5000
📊 Health check: http://localhost:5000/api/health
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

**Expected output:**
```
  VITE v5.4.10  ready in 123 ms
  ➜  Local:   http://localhost:5173/
```

### Mobile
```bash
cd mobile
npm install
npx expo start
```

The mobile app is a client of the same backend as the web app. It creates and
resolves every round on the server and renders only the server's numbers, so it
needs a reachable API — see [Mobile API address](#mobile-api-address) below.

## Mobile API address

The mobile app has **no hardcoded host**. It resolves its API base in this order:

| Priority | Source | Use |
| --- | --- | --- |
| 1 | `expo.extra.apiUrl` in `mobile/app.json` | the documented place to ship an address |
| 2 | `EXPO_PUBLIC_API_URL` in the environment | quick local override |
| 3 | *(web only)* the app's own origin | a single-origin deployment needs no config |

Example `mobile/app.json`:

```json
{
  "expo": {
    "extra": {
      "apiUrl": "https://api.example.com",
      "devToken": ""
    }
  }
}
```

or, without editing the manifest:

```bash
cd mobile
EXPO_PUBLIC_API_URL=http://192.168.1.50:5000 npx expo start
```

Notes that matter in practice:

- A **native** build with neither value set refuses to play and says the API
  address is missing. It does not fall back to `localhost`, because on a phone
  that resolves to the phone itself.
- `EXPO_PUBLIC_*` values are baked into the bundle at transform time, and
  `expo export` reuses its cache. After changing one, clear it:
  `rm -rf .expo dist && npx expo export -p web --clear`.
- The address must be an absolute `http(s)` URL with no credentials, query string
  or fragment; anything else is reported in the UI as a configuration error.

### Identity on mobile (development only)

Scoring is server-authoritative: a round is only credited when the **server**
resolves the caller's identity. Two development paths exist, and both are
server-decided:

- `ALLOW_DEV_AUTH=true` on the backend (and `NODE_ENV` not `production`) — the
  server injects a local development identity into every request. This is how the
  scored path is exercised locally; the app needs no token.
- `expo.extra.devToken` / `EXPO_PUBLIC_DEV_TOKEN` — sent as
  `Authorization: Bearer <token>`. The server still verifies it, so an
  unverifiable token is treated as a guest rather than trusted.

There is deliberately **no** invented native Firebase sign-in flow. Until one is
built, a native build without either mechanism plays as a guest and says so.

## Sharing a result from the mobile app

A finished round — a win or a loss — shows a *Share your result* panel with the
composed text, an optional name field for the post, and one button. Nothing needs
to be installed or configured for this; it is a client-side affordance over the
guess response and makes no extra request.

What happens depends on the platform, and the app **reports what it observed**
rather than assuming:

| Platform | Button | Transport |
| --- | --- | --- |
| iOS / Android | *Share result* | the OS share sheet (React Native `Share`) |
| Mobile web, browser has Web Share | *Share result* | `navigator.share` |
| Mobile web, clipboard only | *Copy result* | `navigator.clipboard.writeText` |
| Neither | *Sharing unavailable* | none — the UI says so and invites manual copy |

Notes that matter when testing by hand:

- **The clipboard path needs the page focused and a secure context.** `localhost`
  and `127.0.0.1` count as secure; a plain-HTTP LAN address does not, so a phone
  opening `http://192.168.x.x` will see the clipboard path fail. That is a browser
  rule, not a bug in the app.
- **Desktop Chrome may have no `navigator.share`.** Observe it rather than assume:
  `typeof navigator.share` in the console. Without it the app offers the clipboard
  and says which it is doing.
- **A native build shares no link.** A phone app has no `window.location.origin`,
  so the text carries no URL instead of a made-up domain. Only the web export
  includes the app's own address.
- **Dismissing the share sheet is a cancel.** The app says "Share cancelled -
  nothing was sent", which is neither a success nor a failure, because a player
  who backed out has not posted anything.
- The mobile share text is covered by `mobile/test/share.test.js` (33 tests, part
  of `npm test`). No device is needed to run them.

## Chat from the mobile app

The phone app both reads and writes the same global room as the web app. There is
no mobile-only chat endpoint.

### Reading needs no identity, posting does

`GET /api/chat/messages` is public. `POST /api/chat/send` requires an identity,
so **a guest can watch the room but cannot post to it** - the composer tells them
so in as many words ("Sign in to join the global chat."), keeps their typed text
in the box, and never presents a refusal as a sent message.

To exercise posting locally, give the app an identity. The backend's development
bypass does that for the whole process:

```bash
cd backend
ALLOW_DEV_AUTH=true PORT=5000 node src/server.js
```

With that running, start the app pointed at it (`EXPO_PUBLIC_API_URL=http://<your-lan-ip>:5000`
for a device, or leave it unset for the web export and use a same-origin proxy),
type into the composer and press **Send to chat**.

What you should observe:

- the sent message appears in the room **under the handle the server derived**,
  which with the dev bypass is `local-user` - not any name the app sent;
- the request body on the wire is exactly `{"message": "..."}`. The app never
  sends `username`, `score`, `userId` or a timestamp, because the server ignores
  them and sending them would be an impersonation attempt (ISSUE-4);
- the composer clears **only** on a confirmed send. Stop the backend and press
  send again: the text stays in the box and the notice says the server cannot be
  reached.

### The 280-character bound is enforced, not applied silently

The server stores at most 280 characters and truncates on the way in. The app
counts the draft against that same bound (in UTF-16 code units, the unit the
server's `slice` cuts on) and **refuses** an over-long message with its real
length, rather than shortening it and reporting it as sent. Type 300 characters
and press send: nothing goes over the wire and the notice quotes `300 characters`
and `at most 280`.

### How often the shared state is refreshed

There is **no socket** on the mobile client - it is REST only - so the leaderboard
and chat are re-read on a **10-second interval** while the screen is visible. This
is an interval, not a live connection, and the app says so: the caption under the
two cards reads e.g. *"Shared state updated 3 s ago. This screen re-reads the
leaderboard and chat every 10 s while it is open."*

To watch it work, open the app and then post a message from somewhere else
without touching it:

```bash
curl -X POST http://localhost:5000/api/chat/send \
  -H 'content-type: application/json' \
  -d '{"message":"posted from another client"}'
```

The message appears in the running app within ~10 seconds, with no interaction.
Behaviour around that interval, all covered by `mobile/test/chat.test.js`:

- only one read is in flight at a time; a tick that arrives during a slow read is
  skipped, not queued;
- a failed read backs the interval off (doubling, up to 120 s) and the first
  success restores 10 s;
- a source that failed keeps its last good data on screen rather than blanking;
- the loop stops on unmount and while the app is backgrounded; resuming re-reads
  at once, and a read still in flight when the screen went away is discarded.

The chat and freshness logic lives in the pure `mobile/src/chat.js` (no React,
React Native or Expo import; transports, timers and clock injected), so its 38
tests run under the ordinary `npm test` in `mobile/` with no device.

## Test the Game

1. Open http://localhost:5173
2. Enter a username
3. Guess a number between 1-100
4. Send a chat message
5. View the leaderboard

## Troubleshooting

**Backend won't start:**
- Check if port 5000 is free: `lsof -i :5000`
- Kill process: `kill -9 <PID>`

**Frontend won't connect to backend:**
- Verify backend is running: `curl http://localhost:5000/api/health`
- Check vite proxy in `vite.config.js`

**Chat not working:**
- The **web** client uses Socket.IO for live updates; ensure it is installed:
  `npm install socket.io`
- The **mobile** client uses no socket at all - it re-reads on a 10-second
  interval, so up to ~10 s of lag is expected behaviour, not a fault
- Posting needs an identity on both clients. A guest gets a clean `401` and is
  told to sign in; that is the server refusing, not a broken client
- Check the browser/app console for errors

## File Structure

```
backend/
├── data/
│   ├── game_data.json
│   ├── chat_messages.json
│   ├── users.json
│   └── leaderboard.json
├── src/
│   └── server.js
└── package.json

frontend/
├── src/
│   ├── App.jsx
│   └── main.jsx
└── package.json

mobile/
├── App.js
└── package.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/game/stats` | Get game statistics |
| POST | `/api/game/start` | Start new game round |
| POST | `/api/game/guess` | Submit a guess |
| POST | `/api/game/bonus` | Claim daily bonus |
| GET | `/api/chat/messages` | Get chat history |
| POST | `/api/chat/send` | Send chat message |
| POST | `/api/users/register` | Register player |
| GET | `/api/users/:id` | Get player profile |
| GET | `/api/leaderboard` | Get global leaderboard |

## Next Steps

- [ ] Read DEPLOYMENT.md for production setup
- [ ] Replace JSON storage with Firebase/Postgres
- [ ] Add user authentication
- [ ] Deploy to production
