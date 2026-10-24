import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE } from './env';
import {
  createAuthClient,
  subscribeToIdentity,
  getAuthToken,
  signUpWithEmail,
  signInWithEmail,
  signOut as signOutOfFirebase,
  describeAuthError,
  GUEST,
} from './auth';
import { isFirebaseConfigured } from './firebaseConfig';
import {
  buildShareText,
  detectShareCapabilities,
  chooseShareStrategy,
  shareResult,
  SHARE_STRATEGIES,
} from './share';

// Vite exposes client env vars via import.meta.env and only inlines those with a
// VITE_ prefix. Dev: '' (relative URLs) so vite.config.js proxies /api and
// /socket.io to the backend. Prod: set VITE_API_URL at build time.
const API_URL = API_BASE;

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
  const [bonusAvailable, setBonusAvailable] = useState(false);
  const [tab, setTab] = useState('game');
  // The last COMPLETED round, kept so its result can be shared. Only the guess
  // response itself is stored, and the share text quotes its numbers; sharing is
  // never offered for a hint, because a mid-round hint is not a result.
  const [completedRound, setCompletedRound] = useState(null);
  const [shareNotice, setShareNotice] = useState('');
  const socketRef = useRef(null);

  // --- Authentication state --------------------------------------------------
  // `session.mode`: 'guest' | 'injected' | 'firebase'. The app is fully usable in
  // guest mode (that is the default local/CI case with no Firebase project), but
  // protected actions then correctly report that a sign-in is required instead of
  // failing with an opaque 401.
  const [session, setSession] = useState(GUEST);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const authClientRef = useRef(null);

  // Identity generation counter: bumped on every identity change so an in-flight
  // socket connect for a stale identity cannot install itself.
  const identitySeq = useRef(0);

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

  const isSignedIn = session.mode !== 'guest';

  /**
   * Authenticated fetch.
   *
   * The token is resolved per request: Firebase ID tokens expire (~1h), so a
   * cached string would eventually 401 every call. Requests with no identity are
   * still sent, unauthenticated, so public routes and guest play are unaffected.
   */
  const authFetch = useCallback(async (path, options = {}) => {
    const token = await getAuthToken(authClientRef.current);
    const headers = { ...(options.headers || {}) };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return fetch(api(path), { ...options, headers });
  }, []);

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

  // The player's own HUD. This is identity-scoped, so it is read from the stored
  // profile (authenticated) rather than the global aggregate stats: a signed-in
  // player must see THEIR totals, and a guest must see zeros rather than someone
  // else's numbers.
  const loadGameStats = useCallback(async () => {
    if (session.mode !== 'firebase' || !session.uid) {
      setBestScore(0);
      setStreak(0);
      setScore(0);
      return;
    }

    try {
      const res = await authFetch(`/api/users/${session.uid}`);
      if (!res.ok) return;
      const data = await res.json();
      const user = (data && data.user) || {};
      setScore(Number(user.score || 0));
      setBestScore(Number(user.bestScore || 0));
      setStreak(Number(user.streak || 0));
    } catch (error) {
      /* leave the HUD as-is on a transient failure */
    }
  }, [session.mode, session.uid, authFetch]);

  // Bonus state is READ, never claimed, while rendering. The previous code POSTed
  // to the claim endpoint on mount, which spent the player's daily bonus as a side
  // effect of opening the page.
  //
  // This runs for the injected-token escape hatch too, not just for a real Firebase
  // session: the route derives the uid from the token itself, so the client needs
  // no uid to read or claim the bonus. Gating it on a Firebase-only session would
  // leave the escape hatch unable to use a fully server-authoritative feature.
  const loadBonusState = useCallback(async () => {
    if (session.mode === 'guest') {
      setBonusAvailable(false);
      setDailyBonusText('Sign in to claim');
      return;
    }

    try {
      const res = await authFetch('/api/game/bonus');
      if (!res.ok) {
        setBonusAvailable(false);
        setDailyBonusText('Bonus unavailable');
        return;
      }
      const data = await res.json();
      setBonusAvailable(Boolean(data.available));

      if (data.available) {
        setDailyBonusText('Daily bonus available');
      } else {
        const remaining = Math.max(0, Number(data.nextAvailableAt || 0) - Date.now());
        const hours = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        setDailyBonusText(`Next bonus in ${hours}h ${mins}m`);
      }

      // Render the server's authoritative totals.
      if (typeof data.score === 'number') setScore(data.score);
      if (typeof data.bestScore === 'number') setBestScore(data.bestScore);
      if (typeof data.streak === 'number') setStreak(data.streak);
    } catch (error) {
      setDailyBonusText('Bonus unavailable');
    }
  }, [session.mode, authFetch]);

  const refresh = useCallback(() => {
    loadChatMessages();
    loadLeaderboard();
    loadGameStats();
    loadBonusState();
  }, [loadChatMessages, loadLeaderboard, loadGameStats, loadBonusState]);

  // --- Boot auth once --------------------------------------------------------
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;

    createAuthClient().then((client) => {
      if (cancelled) return;
      authClientRef.current = client;

      if (client.error) {
        // Configured but broken: stay in guest mode and say so plainly.
        setAuthError(`Authentication unavailable: ${client.error}`);
      }

      unsubscribe = subscribeToIdentity(client, (next) => {
        identitySeq.current += 1;
        setSession(next);
        setAuthReady(true);
      });

      // No SDK / no project: subscribeToIdentity has already reported guest (or an
      // injected token) synchronously, but make sure the UI leaves its loading
      // state even if that path ever changes.
      if (!client.configured) setAuthReady(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Refresh the player's data whenever the identity changes, so the HUD shows the
  // signed-in player's totals instead of guest zeros (and reverts on sign-out).
  useEffect(() => {
    if (!authReady) return;
    loadGameStats();
    loadBonusState();
    loadLeaderboard();
  }, [authReady, session.mode, session.uid, loadGameStats, loadBonusState, loadLeaderboard]);

  // --- Realtime -------------------------------------------------------------
  // The socket must carry the SAME identity as REST. It is rebuilt whenever the
  // identity changes, because a persistent socket would otherwise keep the old
  // uid bound server-side: signing out (or switching accounts) would leave the
  // connection authenticated as the previous player, which is a real
  // impersonation hazard for chat.
  useEffect(() => {
    if (!authReady) return undefined;

    let cancelled = false;
    let socket = null;
    const seq = identitySeq.current;

    (async () => {
      const token = await getAuthToken(authClientRef.current);

      // A newer identity appeared while the token was being fetched.
      if (cancelled || seq !== identitySeq.current) return;

      socket = io(API_URL || undefined, {
        auth: token ? { token } : {},
        // Do not queue sends across an auth change; a stale identity's message
        // must not be delivered under the new session.
        reconnection: true,
      });

      socketRef.current = socket;

      socket.on('chat-message', (entry) => {
        setChatMessages((current) => [...current, entry].slice(-20));
      });

      // The leaderboard is documented as realtime; the server pushes the new
      // ranking after a scored round or a granted bonus.
      socket.on('leaderboard-update', (payload) => {
        if (payload && Array.isArray(payload.leaderboard)) {
          setLeaderboard(payload.leaderboard);
        }
      });

      socket.on('connect_error', (error) => {
        // Guests have no token, so the server rejects the handshake by design. That
        // is expected, not an error worth showing: REST reads (chat, leaderboard)
        // are public and keep working.
        if (token && identitySeq.current === seq) {
          setMessage(`Realtime connection failed: ${(error && error.message) || 'unauthorized'}`);
        }
      });
    })();

    return () => {
      cancelled = true;
      if (socket) socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [authReady, session.mode, session.uid]);

  const newRound = async () => {
    try {
      // Authenticated when possible: a round created with a token is bound to the
      // player, which is what makes the eventual win scoreable (ISSUE-24).
      const res = await authFetch('/api/game/start', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'Could not start a round.');
      setRoundId(data.round.roundId);
      setMaxAttempts(data.round.maxAttempts || 10);
      setAttempts(0);
      setGuess('');
      // A new round invalidates the previous result: offering to share a score
      // that is no longer the round on screen would be misleading.
      setCompletedRound(null);
      setShareNotice('');
      setMessage(
        isSignedIn
          ? 'New round started. Enter your guess.'
          : 'New round started (guest round - sign in to score). Enter your guess.'
      );
    } catch (error) {
      setMessage('Could not start a round. Is the API running?');
    }
  };

  const saveUsername = async () => {
    const trimmed = username.trim();
    if (!trimmed) return;

    try {
      localStorage.setItem('ngc-username', trimmed);
    } catch (error) {
      /* ignore storage failures */
    }

    if (!isSignedIn) {
      setMessage('Username saved locally. Sign in to register it on the server.');
      return;
    }

    try {
      const res = await authFetch('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = await res.json();

      if (data.ok) {
        setMessage(`Username registered as ${data.user.username}.`);
        loadLeaderboard();
      } else {
        setMessage(data.message || 'Could not register that username.');
      }
    } catch (error) {
      setMessage('Registration unavailable.');
    }
  };

  const claimDailyBonus = async () => {
    if (!isSignedIn) {
      setMessage('Sign in to claim the daily bonus.');
      return;
    }

    try {
      const response = await authFetch('/api/game/bonus', { method: 'POST' });
      const data = await response.json();

      if (data.granted) {
        // Server-authoritative: render the authoritative totals rather than
        // adding the bonus to local state, which is what made the award vanish on
        // reload and never reach the leaderboard.
        if (typeof data.score === 'number') setScore(data.score);
        if (typeof data.bestScore === 'number') setBestScore(data.bestScore);
        if (typeof data.streak === 'number') setStreak(data.streak);

        setBonusAvailable(false);
        setMessage(`🎁 Daily bonus claimed: +${data.bonus} points!`);
        setDailyBonusText('Bonus claimed today');
        loadLeaderboard();
      } else {
        if (typeof data.score === 'number') setScore(data.score);
        if (typeof data.bestScore === 'number') setBestScore(data.bestScore);

        const remaining = Math.max(0, Number(data.nextAvailableAt || 0) - Date.now());
        const hours = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        setBonusAvailable(false);
        setMessage(`Bonus not ready. Next in ${hours}h ${mins}m.`);
        setDailyBonusText(`Next bonus in ${hours}h ${mins}m`);
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
      const response = await authFetch('/api/game/guess', {
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
        // The server owns scoring and returns the authoritative totals; the SPA
        // renders those rather than computing its own, or the HUD and the
        // leaderboard drift apart. A guest round is explicitly unscored.
        const points = data.scored ? Number(data.awarded || 0) : 0;
        const nextScore = data.scored ? Number(data.score || 0) : score;
        setScore(nextScore);
        if (data.scored) {
          setBestScore(Number(data.bestScore || nextScore));
          setStreak(Number(data.streak || 0));
        }
        setMessage(
          data.scored
            ? `You won ${points} points!`
            : 'Correct! Sign in to record your score on the leaderboard.'
        );
        setRoundId(null);
        loadLeaderboard();
        // Keep the server's own numbers for the share text. A guest win carries
        // no totals and this record does not manufacture any.
        setCompletedRound(data);
        setShareNotice('');
      } else if (data.result === 'round-over') {
        setStreak(0);
        setMessage(`❌ Out of attempts! The number was ${data.secretNumber}.`);
        setRoundId(null);
        setCompletedRound(data);
        setShareNotice('');
      }

      setGuess('');
    } catch (error) {
      setMessage('Guess service unavailable.');
    }
  };

  const sendChatMessage = async () => {
    const text = window.prompt('Write a message:');
    if (!text || !text.trim()) return;

    if (!isSignedIn) {
      setMessage('Sign in to join the global chat.');
      return;
    }

    const socket = socketRef.current;

    // The payload carries ONLY the message text. The server derives the sender's
    // display name (a uid pseudonym) and score from the authenticated identity, so
    // the client must not send username or score: sending the player's email as a
    // handle is exactly the PII leak ISSUE-22 fixed.
    if (socket && socket.connected) {
      socket.emit('send-message', { message: text.trim() });
      return;
    }

    try {
      const res = await authFetch('/api/chat/send', {
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

  // --- Social sharing --------------------------------------------------------
  // The share text is composed from the guess response that the server returned,
  // so it can only ever quote numbers the server produced. The origin is read
  // here (the only browser object involved) and handed to the pure module, which
  // is what keeps share.js testable under `node --test`.
  const shareText = useMemo(() => {
    if (!completedRound) return null;

    let pageOrigin = '';
    try {
      pageOrigin = window.location.origin;
    } catch (error) {
      pageOrigin = '';
    }

    return buildShareText({ outcome: completedRound, username, origin: pageOrigin });
  }, [completedRound, username]);

  // Reported so the player is never left guessing: the three honest outcomes are
  // "shared", "copied" and "this browser provides neither". Nothing here writes
  // to the DOM directly, and no request or third-party endpoint is involved.
  // Not memoised: it is a couple of typeof checks, and re-reading them on each
  // render keeps the UI honest if a capability appears after first paint.
  const shareCapability = chooseShareStrategy(detectShareCapabilities());

  const handleShare = async () => {
    if (!shareText) {
      setShareNotice('Finish a round before sharing a result.');
      return;
    }

    const outcome = await shareResult({ text: shareText });
    setShareNotice(outcome.message);
  };

  const submitAuth = async (mode) => {
    const client = authClientRef.current;

    if (!client || !client.configured) {
      setAuthError('Firebase Authentication is not configured for this build.');
      return;
    }

    setAuthBusy(true);
    setAuthError('');

    try {
      if (mode === 'signup') {
        await signUpWithEmail(client, email.trim(), password);
      } else {
        await signInWithEmail(client, email.trim(), password);
      }
      // onAuthStateChanged drives the rest; the identity effect reloads data.
      setPassword('');
      setMessage('Signed in. Your rounds, bonus and chat are now scored.');
    } catch (error) {
      setAuthError(describeAuthError(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy(true);
    try {
      await signOutOfFirebase(authClientRef.current);
      setScore(0);
      setBestScore(0);
      setStreak(0);
      // The completed round belonged to the identity that just signed out, so its
      // result must not remain shareable as if it were the new session's.
      setCompletedRound(null);
      setShareNotice('');
      setMessage('Signed out. You are now playing as a guest.');
    } catch (error) {
      setAuthError('Sign-out failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const sessionLabel = useMemo(() => {
    if (session.mode === 'firebase') return `Signed in as ${session.label}`;
    if (session.mode === 'injected') return 'Signed in with an injected token';
    return 'Guest - not signed in';
  }, [session]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: 20, background: '#0f172a', color: '#f8fafc', fontFamily: 'Arial, sans-serif', minHeight: '100vh' }}>
      <h1 style={{ textAlign: 'center', marginBottom: 12 }}>🎮 Number Guessing Challenge</h1>

      {/* Session bar. The signed-out state is stated plainly rather than left
          implicit, because a signed-out player silently scores nothing. */}
      <div style={{ background: '#111827', border: '1px solid #334155', borderRadius: 12, padding: 14, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <strong style={{ color: isSignedIn ? '#86efac' : '#fca5a5' }}>{sessionLabel}</strong>
            {!isFirebaseConfigured && (
              <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>
                Firebase is not configured for this build, so sign-in is unavailable and the
                game runs in guest mode. Set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID
                (see frontend/.env.example) to enable accounts.
              </div>
            )}
            {isFirebaseConfigured && authError && (
              <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 6 }}>{authError}</div>
            )}
          </div>
          {isSignedIn && (
            <button onClick={handleSignOut} disabled={authBusy} style={{ ...primaryButtonStyle, background: '#475569' }}>
              Sign out
            </button>
          )}
        </div>

        {!isSignedIn && isFirebaseConfigured && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              style={{ flex: 1, minWidth: 180, borderRadius: 10, padding: '10px 12px', border: '1px solid #334155', background: '#1e293b', color: '#fff' }}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              onKeyDown={(e) => e.key === 'Enter' && submitAuth('signin')}
              style={{ flex: 1, minWidth: 180, borderRadius: 10, padding: '10px 12px', border: '1px solid #334155', background: '#1e293b', color: '#fff' }}
            />
            <button onClick={() => submitAuth('signin')} disabled={authBusy} style={primaryButtonStyle}>
              Sign in
            </button>
            <button onClick={() => submitAuth('signup')} disabled={authBusy} style={{ ...primaryButtonStyle, background: '#22c55e' }}>
              Create account
            </button>
          </div>
        )}
      </div>

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
        <StatCard label="Bonus" value={dailyBonusText} accent={bonusAvailable ? '#22c55e' : '#fca5a5'} />
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

          {/* Share panel. Rendered only once a round has actually finished, so
              there is never a share affordance for a hint. The text is a React
              text child (never innerHTML), it quotes the server's numbers only,
              and the button states exactly what will happen. */}
          {completedRound && (
            <div
              data-testid="share-panel"
              style={{ background: '#111827', borderRadius: 14, padding: 18, marginBottom: 20, border: '1px solid #334155' }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Share your result</div>
              <div
                data-testid="share-text"
                style={{ background: '#0f172a', borderRadius: 10, padding: 12, color: '#e2e8f0', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {shareText}
              </div>
              <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>
                {shareCapability === SHARE_STRATEGIES.WEB_SHARE
                  ? 'Uses your device share sheet; the link is this app\u2019s address.'
                  : shareCapability === SHARE_STRATEGIES.CLIPBOARD
                    ? 'Copies the text to your clipboard; the link is this app\u2019s address.'
                    : 'This browser provides neither a share sheet nor clipboard access, so copy the text above manually.'}
              </div>
              <button
                onClick={handleShare}
                data-testid="share-button"
                style={{ ...primaryButtonStyle, background: '#a855f7', marginTop: 12 }}
              >
                {shareCapability === SHARE_STRATEGIES.WEB_SHARE
                  ? 'Share result'
                  : shareCapability === SHARE_STRATEGIES.CLIPBOARD
                    ? 'Copy result'
                    : 'Share unavailable'}
              </button>
              {shareNotice && (
                <div data-testid="share-notice" style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>
                  {shareNotice}
                </div>
              )}
            </div>
          )}

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
            <button
              onClick={claimDailyBonus}
              disabled={!isSignedIn || !bonusAvailable}
              style={{
                background: !isSignedIn || !bonusAvailable ? '#334155' : '#22c55e',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '12px 18px',
                cursor: !isSignedIn || !bonusAvailable ? 'not-allowed' : 'pointer',
                fontWeight: 700,
              }}
            >
              Daily Bonus
            </button>
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
          <button onClick={sendChatMessage} style={{ ...primaryButtonStyle, background: isSignedIn ? '#8b5cf6' : '#334155', width: '100%' }}>
            {isSignedIn ? 'Send Chat Message' : 'Sign in to chat'}
          </button>
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
      {/* data-stat is a stable hook so tests and operators can read the rendered
          value without scraping presentational text. */}
      <div data-stat={label} style={{ fontWeight: 700, fontSize: 28, color: accent }}>{value}</div>
    </div>
  );
}

export default App;
