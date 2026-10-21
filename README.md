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

✅ **Social sharing (web)**
- Share a finished round - a win or a loss - from the web app
- Uses the device share sheet (Web Share API) where the browser provides it,
  otherwise copies the text to the clipboard
- The shared text quotes the server's own numbers only: attempts, points awarded,
  total, best and streak. A guest round says plainly that no points were
  recorded, and a lost round never claims points
- The link is the app's own page address. No shortened link, third-party sharing
  endpoint or tracker is involved
- A browser that offers neither a share sheet nor clipboard access says so in the
  UI instead of appearing to do nothing
- Requires the page to be focused for the clipboard path; mobile Safari and
  Chrome use the native share sheet, which needs no permission

✅ **Cross-Platform**
- Web app (React + Vite)
- Mobile apps (React Native + Expo)
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
npx expo start
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
