
# Production Upgrade Plan

This document describes the next production phase for the game.

## 1. Data Layer

The app currently uses local JSON files for development. The next step is to move to a persistent database layer.

### Recommended choices
- Firebase Firestore for easy setup and realtime syncing
- PostgreSQL for structured, relational data and easier analytics

### Recommended data model
- `users`
  - id
  - username
  - email
  - best_score
  - streak
  - joined_at
  - last_bonus_at
- `scores`
  - id
  - user_id
  - points
  - created_at
- `chat_messages`
  - id
  - username
  - message
  - score
  - created_at
- `leaderboard`
  - ranking snapshot
  - updated_at

## 2. Authentication

Use Firebase Auth or JWT.

### Recommended approach
- Firebase Auth for web and mobile apps
- JWT for backend API flows
- Session data stored securely on server side

## 3. Realtime multiplayer

Use Socket.IO rooms to support:
- global chat room
- challenge rooms
- by-country or by-language chat groups
- room-based live matches

## 4. Deployment pipeline

### Backend
- Render or Railway for Node.js app hosting
- Set NODE_ENV=production
- Set `DATABASE_URL` or Firebase project credentials

### Frontend (web)
- Vercel
- Deploy `frontend` as production build
- Use env vars for backend API URL

### Mobile
- Expo EAS
- Build iOS and Android with store submission pipeline

## 5. Monitoring

Add:
- Sentry
- PostHog or Mixpanel analytics
- uptime monitor
- error logging

## 6. Launch checklist

- [ ] Database migrated from JSON storage
- [ ] Auth active for players
- [ ] Global leaderboard live
- [ ] Real-time chat working
- [ ] Deployment environment live
- [ ] Mobile builds passing
- [ ] Error monitoring active
- [ ] Store metadata ready

## 7. Recommended first production release

For the first live product, keep it simple:
- Firebase Firestore
- Firebase Auth
- Socket.IO chat rooms
- Vercel + Render
- Expo EAS for mobile builds

This gives the fastest launch while keeping the app production-safe.
