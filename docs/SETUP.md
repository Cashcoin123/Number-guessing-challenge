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
- Ensure Socket.IO is installed: `npm install socket.io`
- Check browser console for errors

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
