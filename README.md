# Number Guessing Challenge

A global multiplayer number guessing game with live chat, scoring, daily bonuses, and social sharing. Available on web, iPhone, and Android.

## 🎮 Features

✅ **Gameplay**
- Guess a random number between 1 and 100
- 10 attempts per round
- Score based on attempts
- Streak tracking and best score
- Daily +50 point bonus every 24 hours

✅ **Multiplayer**
- Global chat room
- Real-time leaderboard
- Player profiles
- Message history

✅ **Social sharing (web and mobile)**
- Share a finished round — a win or a loss — from the web app **and** the mobile app
- Uses the device share sheet (Web Share API on web, the OS share sheet on iOS and
  Android) where the platform provides it, otherwise copies the text to the clipboard
- The shared text quotes the server's own numbers only: attempts, points awarded,
  total, best and streak. A guest round says plainly that no points were
  recorded, and a lost round never claims points
- The link is the app's own address on web. A native build has no page address, so
  it shares the text without a link rather than inventing a domain
- A device that offers neither a share sheet nor clipboard access says so in the
  UI instead of appearing to do nothing
- Requires the page to be focused for the clipboard path on web; the native share
  sheet needs no permission
- Composed by a pure module with its own test suite on both platforms
  (`frontend/src/share.js` + 21 tests, `mobile/src/share.js` + 33 tests)

✅ **Cross-Platform**
- Web app (React + Vite) — full client: sign-in, chat, leaderboard, daily bonus, sharing
- Mobile app (React Native + Expo) — plays the **same global game** against the same API:
  rounds are created and resolved on the server, points are credited by the server, and
  the app renders the server's authoritative totals. Same leaderboard, same chat.
  - A signed-in player's rounds are scored and appear on the global leaderboard.
  - A guest can still play; the app states plainly that guest rounds are **unscored**.
  - If the backend cannot be reached the app says so and refuses to start a round rather
    than inventing a local game.
  - A finished round can be shared from the phone: the OS share sheet on iOS and
    Android, the clipboard where that is all the platform offers, and an explicit
    message when it offers neither. Shares the text only on a native build, since a
    phone app has no page address to link to.
  - Needs `expo.extra.apiUrl` (or `EXPO_PUBLIC_API_URL`) pointing at your backend — see
    [Setup Guide](docs/SETUP.md#mobile-api-address).
- Responsive design for all devices

✅ **Production Ready**
- Local development setup
- Deployment to Vercel, Render, and App Stores
- Socket.IO for real-time features
- Persistent data storage

## 🚀 Quick Start

### Backend
```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Mobile
```bash
cd mobile
npm install
# point the app at your backend (see docs/SETUP.md#mobile-api-address)
npx expo start
```

The mobile app is a client of the same API as the web app: it needs a reachable
backend. With no API address configured on a native build it says so instead of
pretending to play. For a browser preview of the mobile app:

```bash
npx expo export -p web      # writes mobile/dist/
```

Open http://localhost:5173 in your browser.

## 📚 Documentation

- [Setup Guide](docs/SETUP.md) — Local development
- [Deployment Guide](docs/DEPLOYMENT.md) — Production setup
- [API Documentation](docs/API.md) — API endpoints

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│   Frontend (React + Vite)           │
│   Mobile (React Native + Expo)      │
└──────────────┬──────────────────────┘
               │ HTTP/WebSocket
               ↓
┌─────────────────────────────────────┐
│   Backend (Node.js + Express)       │
│   Real-time (Socket.IO)             │
└──────────────┬──────────────────────┘
               │ File System / Firebase / Postgres
               ↓
┌─────────────────────────────────────┐
│   Data Store                        │
│   • game_data.json                  │
│   • chat_messages.json              │
│   • users.json                      │
│   • leaderboard.json                │
└─────────────────────────────────────┘
```

## 📊 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/game/stats` | Game statistics |
| POST | `/api/game/guess` | Submit guess |
| POST | `/api/game/bonus` | Claim daily bonus |
| GET | `/api/chat/messages` | Chat history |
| POST | `/api/chat/send` | Send message |
| GET | `/api/leaderboard` | Global rankings |

## 🌍 Deployment

### Backend
- **Render:** `git push origin main` (auto-deploy)
- **Railway:** Connect GitHub repo
- **Heroku:** `git push heroku main`

### Frontend
- **Vercel:** `vercel --prod`
- **Netlify:** `netlify deploy --prod`

### Mobile
- **iOS:** `eas build --platform ios` → `eas submit --platform ios`
- **Android:** `eas build --platform android` → `eas submit --platform android`

## 🔄 Next Steps

- [ ] Add Firebase/Postgres database
- [ ] Implement user authentication
- [ ] Deploy backend to production
- [ ] Deploy web to production
- [ ] Build and submit mobile apps
- [ ] Native Firebase sign-in for the mobile app (the mobile client currently scores
      through the backend's `ALLOW_DEV_AUTH` development identity or an explicitly
      configured development token — see [Setup Guide](docs/SETUP.md#mobile-api-address))
- [ ] Add push notifications
- [ ] Set up analytics and monitoring

## 📝 License

MIT — See [LICENSE](LICENSE) for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit changes
4. Push to branch
5. Open a pull request

---

Built with ❤️ by **Cashcoin123**
