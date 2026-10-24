// Env resolution note:
// - In dev, App.jsx uses relative URLs ('' base) so the Vite dev-server proxy
//   forwards /api and /socket.io to http://localhost:5000.
// - For a production build served from a different origin than the API, set
//   VITE_API_URL at build time, e.g. VITE_API_URL=https://api.example.com npm run build
//
// The previous code read process.env.REACT_APP_API_URL, which is never defined
// in a Vite build. Vite only inlines import.meta.env.VITE_* variables.
export const API_BASE = import.meta.env.VITE_API_URL ?? '';
