import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Vite exposes client env vars via import.meta.env and only inlines those with a
// VITE_ prefix. The previous code read process.env.REACT_APP_API_URL, which is
// undefined in a Vite build, so the built app always fell back to localhost.
//
// Dev: base '' (relative URLs) so vite.config.js proxies /api and /socket.io to
// the backend. Prod: set VITE_API_URL at build time for a separate API origin.
const API_URL = import.meta.env.VITE_API_URL ?? '';

const api = (path) => `${API_URL}${path}`;

function readStoredUsername() {
  try {
    return localStorage.getItem('ngc-username') || 'Player';
  } catch (error) {
    return 'Player';
  }
}

function App() {
  const [username, setUsername] = useState(readStoredUsername);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [roundId, setRoundId] = useState(null);
  const [maxAttempts, setMaxAttempts] = useState(10);
  const [guess, setGuess] = useState('');
  const [message, setMessage] = useState('Press "New Round" to start guessing.');
  const [attempts, setAttempts] = useState(0);
  const [chatMessages, setChatMessages] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [dailyBonusText, setDailyBonusText] = useState('Checking bonus...');
  const [tab, setTab] = useState('game');
  const socketRef = useRef(null);

  const primaryButtonStyle = useMemo(
    () => ({
      background: '#3b82f6',
      color: '#fff',
      border: 'none',
      borderRadius: 10,
      padding: '12px 18px',
      cursor: 'pointer',
      fontWeight: 700,
    }),
    []
  );

  const loadChatMessages = useCallback(() => {
    fetch(api('/api/chat/messages'))
      .then((res) => res.json())
      .then((data) => setChatMessages(data.messages || []))
      .catch(() => setChatMessages([{ username: 'system', message: 'Chat is unavailable.' }]));
  }, []);

  const loadLeaderboard = useCallback(() => {
    fetch(api('/api/leaderboard'))
      .then((res) => res.json())
      .then((data) => setLeaderboard(data.leaderboard || []))
      .catch(() => setLeaderboard([]));
  }, []);

  const loadGameStats = useCallback(() => {
    fetch(api('/api/game/stats'))
      .then((res) => res.json())
      .then((data) => {
        const stats = data.stats || {};
        setBestScore(stats.bestScore || 0);
        setStreak(stats.streak || 0);
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(() => {
    loadChatMessages();
    loadLeaderboard();
    loadGameStats();
  }, [loadChatMessages, loadLeaderboard, loadGameStats]);

  // Realtime chat. The socket must carry the same credentials as REST calls;
  // in local development the server-issued bearer token is optional.
  useEffect(() => {
    refresh();

    const token = (() => {
      try {
        return localStorage.getItem('ngc-token') || undefined;
      } catch (error) {
        return undefined;
      }
    })();

    const socket = io(API_URL || undefined, { auth: token ? { token } : {} });
    socketRef.current = socket;

    socket.on('chat-message', (entry) => {
      setChatMessages((current) => [...current, entry].slice(-20));
    });

    return () => {
      socket.disconnect();
    };
  }, [refresh]);

  const newRound = async () => {
    try {
      const res = await fetch(api('/api/game/start'), { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'Could not start a round.');
      setRoundId(data.round.roundId);
      setMaxAttempts(data.round.maxAttempts || 10);
      setAttempts(0);
      setGuess('');
      setMessage('New round started. Enter your guess.');
    } catch (error) {
      setMessage('Could not start a round. Is the API running?');
    }
  };

  // Ask the server what the bonus state is for this identity.
  useEffect(() => {
    let active = true;
    fetch(api('/api/game/bonus'), { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active || !data) {
          setDailyBonusText('Sign in to claim');
          return;
        }
        if (data.granted) {
          setDailyBonusText('Daily bonus available');
        } else {
          const remaining = Math.max(0, Number(data.nextAvailableAt || 0) - Date.now());
          const hours = Math.floor(remaining / 3600000);
          const mins = Math.floor((remaining % 3600000) / 60000);
          setDailyBonusText(`Next bonus in ${hours}h ${mins}m`);
        }
      })
      .catch(() => setDailyBonusText('Bonus unavailable'));
    return () => {
      active = false;
    };
  }, []);

  const saveUsername = () => {
    const trimmed = username.trim();
    if (!trimmed) return;

    try {
      localStorage.setItem('ngc-username', trimmed);
    } catch (error) {
      /* ignore storage failures */
    }

    fetch(api('/api/users/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: trimmed }),
    }).catch(() => {});
  };

  const claimDailyBonus = async () => {
    try {
      const response = await fetch(api('/api/game/bonus'), { method: 'POST' });
      const data = await response.json();

      if (data.granted) {
        const next = score + Number(data.bonus || 0);
        setScore(next);
        setBestScore((current) => Math.max(current, next));
        setMessage(`🎁 Daily bonus claimed: +${data.bonus} points!`);
        setDailyBonusText('Bonus claimed today');
      } else {
        const remaining = Math.max(0, Number(data.nextAvailableAt || 0) - Date.now());
        const hours = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        setMessage(`Bonus not ready. Next in ${hours}h ${mins}m.`);
      }
    } catch (error) {
      setMessage('Bonus service unavailable.');
    }
  };

  const submitGuess = async () => {
    const parsedGuess = Number(guess);

    if (!Number.isInteger(parsedGuess) || parsedGuess < 1 || parsedGuess > 100) {
      setMessage('Enter a valid number between 1 and 100.');
      return;
    }

    if (!roundId) {
      setMessage('Start a new round first.');
      return;
    }

    try {
      const response = await fetch(api('/api/game/guess'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roundId, guess: parsedGuess }),
      });

      const data = await response.json();

      if (!data.ok) {
        setMessage(data.message || 'Guess rejected.');
        return;
      }

      setAttempts(data.attempts || 0);

      if (data.result === 'too-low') {
        setMessage('📉 Too low! Try again.');
      } else if (data.result === 'too-high') {
        setMessage('📈 Too high! Try again.');
      } else if (data.result === 'correct') {
        const points = Math.max(20, 100 - (data.attempts || 1) * 8);
        const nextScore = score + points;
        setScore(nextScore);
        setBestScore((current) => Math.max(current, nextScore));
        setStreak((current) => current + 1);
        setMessage(`✅ Correct! You won ${points} points.`);
        setRoundId(null);
        loadLeaderboard();
      } else if (data.result === 'round-over') {
        setStreak(0);
        setMessage(`❌ Out of attempts! The number was ${data.secretNumber}.`);
        setRoundId(null);
      }

      setGuess('');
    } catch (error) {
      setMessage('Guess service unavailable.');
    }
  };

  const sendChatMessage = async () => {
    const text = window.prompt('Write a message:');
    if (!text || !text.trim()) return;

    const socket = socketRef.current;

    // Prefer the realtime channel when it is connected, otherwise fall back to
    // the REST endpoint.
    if (socket && socket.connected) {
      socket.emit('send-message', { message: text.trim() });
      return;
    }

    try {
      const res = await fetch(api('/api/chat/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        loadChatMessages();
      } else {
        setMessage(data.message || 'Chat message rejected.');
      }
    } catch (error) {
      setMessage('Chat unavailable.');
    }
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: 20, background: '#0f172a', color: '#f8fafc', fontFamily: 'Arial, sans-serif', minHeight: '100vh' }}>
      <h1 style={{ textAlign: 'center', marginBottom: 24 }}>🎮 Number Guessing Challenge</h1>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          style={{ flex: 1, minWidth: 200, borderRadius: 10, padding: '12px 14px', border: '1px solid #334155', background: '#1e293b', color: '#fff' }}
        />
        <button onClick={saveUsername} style={primaryButtonStyle}>Set Username</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
        <StatCard label="Score" value={score} accent="#facc15" />
        <StatCard label="Best" value={bestScore} accent="#86efac" />
        <StatCard label="Streak" value={streak} accent="#93c5fd" />
        <StatCard label="Bonus" value={dailyBonusText} accent="#fca5a5" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #334155', paddingBottom: 12 }}>
        <button onClick={() => setTab('game')} style={{ ...primaryButtonStyle, background: tab === 'game' ? '#3b82f6' : '#1f2937' }}>Game</button>
        <button onClick={() => setTab('chat')} style={{ ...primaryButtonStyle, background: tab === 'chat' ? '#3b82f6' : '#1f2937' }}>Chat</button>
        <button onClick={() => setTab('leaderboard')} style={{ ...primaryButtonStyle, background: tab === 'leaderboard' ? '#3b82f6' : '#1f2937' }}>Leaderboard</button>
      </div>

      {tab === 'game' && (
        <div>
          <div style={{ background: '#111827', borderRadius: 14, padding: 18, marginBottom: 20 }}>
            <strong>{message}</strong>
            {roundId && (
              <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>
                Attempt {attempts + 1} of {maxAttempts}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <input
              type="number"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitGuess()}
              placeholder="Enter your guess"
              style={{ flex: 1, minWidth: 220, borderRadius: 10, padding: '12px 14px', border: '1px solid #334155', background: '#1e293b', color: '#fff' }}
            />
            <button onClick={submitGuess} style={primaryButtonStyle}>Guess</button>
            <button onClick={newRound} style={{ background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 18px', cursor: 'pointer', fontWeight: 700 }}>New Round</button>
            <button onClick={claimDailyBonus} style={{ background: '#22c55e', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 18px', cursor: 'pointer', fontWeight: 700 }}>Daily Bonus</button>
          </div>
        </div>
      )}

      {tab === 'chat' && (
        <div style={{ background: '#111827', borderRadius: 18, padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Global Chat</h3>
          <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 12, background: '#0f172a', borderRadius: 12, padding: 12 }}>
            {chatMessages.map((item, index) => (
              <div key={`${item.username}-${index}`} style={{ padding: '8px 0', borderBottom: '1px solid #1f2937' }}>
                <strong style={{ color: '#93c5fd' }}>{item.username}</strong>
                {item.score > 0 && <span style={{ color: '#facc15' }}> ({item.score})</span>}: {item.message}
              </div>
            ))}
          </div>
          <button onClick={sendChatMessage} style={{ ...primaryButtonStyle, background: '#8b5cf6', width: '100%' }}>Send Chat Message</button>
        </div>
      )}

      {tab === 'leaderboard' && (
        <div style={{ background: '#111827', borderRadius: 18, padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>🏆 Global Leaderboard</h3>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {leaderboard.length === 0 ? (
              <p>No scores yet.</p>
            ) : (
              leaderboard.map((entry) => (
                <div key={`${entry.rank}-${entry.username}`} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 100px 100px', gap: 12, padding: '12px 0', borderBottom: '1px solid #1f2937', alignItems: 'center' }}>
                  <div style={{ fontWeight: 700, color: '#facc15', fontSize: 16 }}>{entry.rank}</div>
                  <div>{entry.username}</div>
                  <div style={{ color: '#86efac' }}>Score: {entry.bestScore}</div>
                  <div style={{ color: '#93c5fd' }}>Streak: {entry.streak}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ background: '#111827', borderRadius: 12, padding: 16, border: `2px solid ${accent}` }}>
      <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 8 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 28, color: accent }}>{value}</div>
    </div>
  );
}

export default App;
