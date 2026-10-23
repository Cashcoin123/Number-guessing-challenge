// Number Guessing Challenge - mobile client.
//
// This screen is a client of the shared Express backend (docs/API.md), not a
// game of its own. Two things it used to do itself are now impossible:
//
//   - it no longer picks the secret number (ISSUE-10). `POST /api/game/start`
//     creates a server-side round and returns only a round id and an attempt
//     budget; the number lives on the server until the round is over. Nothing in
//     this file generates a number, and there is no state field that could hold
//     one before the server sends it.
//   - it no longer computes points (ISSUE-24). There is no scoring arithmetic in
//     this file at all: every figure rendered comes from a `scored`/`awarded`/
//     `score`/`bestScore`/`streak` field of a server response, via
//     src/gameClient.js. A console player sees exactly the totals the server
//     stored, which is why the leaderboard and the app can never disagree.
//
// The consequence that matters for the product: a phone player now plays the
// same global rounds as the web player, appears on the same leaderboard, and
// reads the same chat.
//
// Degradation is always visible. If the backend cannot be reached the app says
// so and refuses to start a round rather than inventing one. A guest can still
// play, and is told in as many words that the round is unscored.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Constants from 'expo-constants';

import { detectPlatform, loadConfig } from './src/config';
import {
  IDENTITY_MODES,
  TONES,
  createGameClient,
  describeFailure,
  describeResult,
  formatGlobalStats,
  formatSession,
  playerTotalsFromOutcome,
} from './src/gameClient';
import {
  SHARE_STRATEGIES,
  buildShareText,
  chooseShareStrategy,
  createShareTransports,
  detectShareCapabilities,
  resolveShareOrigin,
  shareResult,
} from './src/share';

const PHASES = {
  LOADING: 'loading',
  FATAL: 'fatal',
  READY: 'ready',
};

function environment() {
  // Expo inlines `process.env.EXPO_PUBLIC_*` at bundle time. Two facts about it,
  // both established by inspecting the built bundle rather than assumed:
  //
  //   1. The static member expression is what gets replaced with the literal
  //      value; this object-literal shape is fine and bundles to e.g.
  //      `{EXPO_PUBLIC_API_URL:"http://127.0.0.1:5082"}`.
  //   2. The value is baked into the bundle, and `expo export` REUSES its .expo
  //      cache. Changing the variable and re-exporting without clearing .expo
  //      produces a bundle that still carries the OLD value - which is exactly how
  //      a configured API address appeared to be ignored during this work. Clear
  //      .expo (or use a fresh checkout) after changing an EXPO_PUBLIC_ variable.
  return {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_DEV_TOKEN: process.env.EXPO_PUBLIC_DEV_TOKEN,
  };
}

export default function App() {
  const config = useMemo(() => {
    // Platform.OS is the authoritative runtime platform in Expo ('web', 'ios',
    // 'android'). Constants.platform exists too but is not populated in every web
    // export, and relying on it made the app claim "native" in the browser - which
    // the config layer then correctly refused to play. Use the right source.
    const platform = detectPlatform({ platform: Platform, constants: Constants });
    return loadConfig({ constants: Constants, env: environment(), platform });
  }, []);

  const client = useMemo(
    () => createGameClient({ baseUrl: config.apiBase, token: config.token }),
    [config.apiBase, config.token]
  );

  const [phase, setPhase] = useState(PHASES.LOADING);
  const [session, setSession] = useState({ mode: IDENTITY_MODES.UNKNOWN });
  const [global, setGlobal] = useState(null);
  const [round, setRound] = useState(null);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [guess, setGuess] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);
  const [chat, setChat] = useState([]);
  const [bonusNote, setBonusNote] = useState(null);

  // The completed round that is currently shareable.
  //
  // This holds the guess response EXACTLY as the server sent it (normalised by
  // gameClient), because the share text may only quote server figures. Only a
  // FINISHED round is ever stored here - a too-low/too-high hint is mid-round and
  // has nothing to share - and it is cleared when a new round starts, so a stale
  // result can never be shared as if it were the current one.
  //
  // It deliberately carries no share text of its own: the text is composed from
  // this object each render by the pure module in src/share.js.
  const [completedRound, setCompletedRound] = useState(null);
  const [shareNotice, setShareNotice] = useState(null);
  const [sharing, setSharing] = useState(false);
  // The name that may be published in a share. Free text the player types here
  // and nothing else: it is never sent to the server, never persisted, and never
  // derived from an identity field (src/share.js rejects an email-shaped value
  // outright, so an address cannot end up in a public post).
  const [shareName, setShareName] = useState('');

  // Totals are only ever taken from a server response. `null` means "the server
  // has not told us", which is rendered as no total rather than as zero.
  const [totals, setTotals] = useState(null);

  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const refreshShared = useCallback(async () => {
    const [board, messages] = await Promise.all([
      client.getLeaderboard(),
      client.getChatMessages(),
    ]);
    if (!mounted.current) return;
    if (board.ok) setLeaderboard(board.rows);
    if (messages.ok) setChat(messages.messages);
  }, [client]);

  // Initial load: who am I, and what does the shared game look like right now?
  useEffect(() => {
    let active = true;

    async function bootstrap() {
      if (config.configError) {
        if (!active) return;
        setPhase(PHASES.FATAL);
        setFeedback(describeFailure({ kind: 'config', message: config.configError }));
        return;
      }

      const [sessionResult, statsResult] = await Promise.all([
        client.getSession(),
        client.getGlobalStats(),
      ]);

      if (!active) return;

      if (!sessionResult.ok) {
        setPhase(PHASES.FATAL);
        setFeedback(describeFailure(sessionResult));
        return;
      }
      if (!statsResult.ok) {
        setPhase(PHASES.FATAL);
        setFeedback(describeFailure(statsResult));
        return;
      }

      setSession(sessionResult.session);
      setGlobal(statsResult.global);
      setTotals(
        playerTotalsFromOutcome({
          scored: sessionResult.session.mode === IDENTITY_MODES.AUTHENTICATED,
          score: sessionResult.session.score,
          bestScore: sessionResult.session.bestScore,
          streak: sessionResult.session.streak,
        })
      );
      setPhase(PHASES.READY);
      setFeedback({
        tone: TONES.INFO,
        headline: 'Start a round to play the global game.',
        detail: 'The winning number is generated and kept on the server.',
      });
      await refreshShared();
    }

    bootstrap();
    return () => {
      active = false;
    };
  }, [client, config.configError, refreshShared]);

  const startRound = useCallback(async () => {
    setBusy(true);
    setBonusNote(null);
    try {
      const result = await client.startRound();
      if (!mounted.current) return;

      if (!result.ok) {
        // The round is gone and nothing is invented in its place.
        setRound(null);
        setFeedback(describeFailure(result));
        return;
      }

      setRound(result.round);
      setAttemptsUsed(0);
      setGuess('');
      // A new round makes any previously completed result stale. Clearing it here
      // is what stops a player sharing last round's score as this round's.
      setCompletedRound(null);
      setShareNotice(null);
      setFeedback({
        tone: TONES.INFO,
        headline: `Round started - you have ${result.round.maxAttempts} attempts.`,
        detail:
          session.mode === IDENTITY_MODES.AUTHENTICATED
            ? 'This round is scored: the server will credit the points.'
            : 'This round is unscored because you are playing as a guest.',
      });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client, session.mode]);

  const submitGuess = useCallback(async () => {
    if (!round || busy) return;

    const parsed = Number(guess);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      setFeedback({
        tone: TONES.ERROR,
        headline: 'Enter a whole number from 1 to 100.',
        detail: 'The server only accepts guesses in that range.',
      });
      return;
    }

    setBusy(true);
    try {
      const result = await client.submitGuess(round.roundId, parsed);
      if (!mounted.current) return;

      if (!result.ok) {
        setFeedback(describeFailure(result));
        // An expired or foreign round cannot be continued; do not pretend it can.
        if (result.kind === 'http' && (result.status === 404 || result.status === 403)) {
          setRound(null);
        }
        return;
      }

      const outcome = result.outcome;
      setAttemptsUsed(outcome.attempts);
      setGuess('');
      setFeedback(describeResult(outcome, session));

      if (outcome.finished) {
        // Only a finished round becomes shareable, and what is stored is the
        // server's own response - the share text is composed from it, never from
        // React state that could drift.
        setCompletedRound(outcome);
        setShareNotice(null);
      } else {
        // A too-low/too-high hint replaces nothing: mid-round is not a result.
        setCompletedRound(null);
      }

      const serverTotals = playerTotalsFromOutcome(outcome);
      if (serverTotals) {
        setTotals(serverTotals);
      }

      if (outcome.finished) {
        setRound(null);
        // The ranking just changed on the server; read it back instead of
        // predicting it locally.
        if (outcome.scored) {
          await refreshShared();
          const stats = await client.getGlobalStats();
          if (mounted.current && stats.ok) setGlobal(stats.global);
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, client, guess, refreshShared, round, session]);

  const claimBonus = useCallback(async () => {
    setBusy(true);
    try {
      const result = await client.claimBonus();
      if (!mounted.current) return;

      if (!result.ok) {
        setBonusNote(describeFailure(result));
        return;
      }

      // The totals are the server's post-credit totals, rendered as returned.
      setTotals({
        score: result.session.score,
        bestScore: result.session.bestScore,
        streak: result.session.streak,
      });
      setBonusNote({
        tone: result.granted ? TONES.WIN : TONES.INFO,
        headline: result.granted
          ? `Daily bonus claimed: the server credited ${result.bonus} points.`
          : 'The daily bonus is not available yet.',
        detail: `Total ${result.session.score}, best ${result.session.bestScore}.`,
      });
      if (result.granted) await refreshShared();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [client, refreshShared]);

  const isGuest = session.mode === IDENTITY_MODES.GUEST;

  // --- social sharing -------------------------------------------------------
  //
  // What really exists on this platform, observed rather than assumed. On web
  // this reads `navigator.share` / `navigator.clipboard.writeText`; on native it
  // uses React Native's own Share module. The result is an object of functions,
  // so "no transport at all" is representable and reaches the UI as an honest
  // capability gap.
  //
  // Not memoised on purpose: it is a handful of typeof checks, and re-reading
  // them each render means a capability that appears after first paint (or a
  // share sheet that appears once the page is focused) is reflected.
  const shareTransports = createShareTransports({
    platform: config.platform,
    scope: typeof globalThis === 'object' && globalThis ? globalThis : undefined,
    nativeShare: Share && typeof Share.share === 'function' ? (content) => Share.share(content) : undefined,
  });
  const shareCapability = chooseShareStrategy(detectShareCapabilities(shareTransports));

  // Whether the composed text will actually carry a link. A native build has no
  // page address, so it shares the text alone; the caption must say so rather
  // than promising a link that is not there.
  const shareOrigin = resolveShareOrigin({
    platform: config.platform,
    scope: typeof globalThis === 'object' && globalThis ? globalThis : undefined,
  });

  // Composed from the server's response only. Null for a round that is not
  // finished, which is what makes the panel disappear mid-round instead of
  // offering a nonsense share.
  const shareText = useMemo(
    () =>
      completedRound
        ? buildShareText({
            outcome: completedRound,
            displayName: shareName,
            origin: shareOrigin,
            identity: session.mode,
          })
        : null,
    [completedRound, shareName, shareOrigin, session.mode]
  );

  const handleShare = useCallback(async () => {
    if (!shareText) {
      setShareNotice('Finish a round before sharing a result.');
      return;
    }

    setSharing(true);
    try {
      // `shareResult` reports what actually happened: a dismissal is a CANCELLED
      // (neither success nor failure), an absent transport is UNAVAILABLE, and a
      // copy is claimed only when the write really resolved.
      const outcome = await shareResult({ text: shareText, transports: shareTransports });
      if (mounted.current) setShareNotice(outcome.message);
    } finally {
      if (mounted.current) setSharing(false);
    }
  }, [shareText, shareTransports]);

  // --- render helpers -------------------------------------------------------

  const feedbackColor =
    feedback && feedback.tone === TONES.WIN
      ? '#22c55e'
      : feedback && feedback.tone === TONES.LOSS
        ? '#f97316'
        : feedback && feedback.tone === TONES.ERROR
          ? '#ef4444'
          : '#e2e8f0';

  if (phase === PHASES.LOADING) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centre}>
          <ActivityIndicator color="#3b82f6" />
          <Text style={styles.message}>Contacting the server...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Number Guessing Challenge</Text>

        {/* Identity and totals: entirely server-derived. */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Your session</Text>
          <Text style={styles.cardBody}>{formatSession(session)}</Text>
          {totals ? (
            <Text style={styles.totals}>
              Score {totals.score}  ·  Best {totals.bestScore}  ·  Streak {totals.streak}
            </Text>
          ) : (
            <Text style={styles.totalsMuted}>
              No stored total for this session - the server keeps scores only for signed-in players.
            </Text>
          )}
          {config.tokenSource ? (
            <Text style={styles.devNote}>Development token in use ({config.tokenSource}).</Text>
          ) : null}
        </View>

        {global ? (
          <Text style={styles.globalLine}>{formatGlobalStats(global)}</Text>
        ) : null}

        {/* Feedback - including the unreachable-backend state. */}
        {feedback ? (
          <View style={styles.feedbackBox}>
            <Text style={[styles.feedbackHeadline, { color: feedbackColor }]}>
              {feedback.headline}
            </Text>
            {feedback.detail ? <Text style={styles.feedbackDetail}>{feedback.detail}</Text> : null}
          </View>
        ) : null}

        {/* Play controls. A round only exists if the server created one. */}
        {phase === PHASES.READY ? (
          round ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>
                Round in progress - {attemptsUsed} of {round.maxAttempts} attempts used
              </Text>
              <TextInput
                value={guess}
                onChangeText={setGuess}
                placeholder="Enter your guess (1-100)"
                placeholderTextColor="#64748b"
                keyboardType="number-pad"
                editable={!busy}
                style={styles.input}
              />
              <TouchableOpacity
                accessibilityRole="button"
                testID="submit-guess"
                style={[styles.button, busy && styles.buttonDisabled]}
                onPress={submitGuess}
                disabled={busy}
              >
                <Text style={styles.buttonText}>{busy ? 'Sending...' : 'Submit guess'}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              testID="start-round"
              style={[styles.button, busy && styles.buttonDisabled]}
              onPress={startRound}
              disabled={busy}
            >
              <Text style={styles.buttonText}>{busy ? 'Starting...' : 'Start a round'}</Text>
            </TouchableOpacity>
          )
        ) : null}

        {/* Social sharing - a finished round only.
            The panel exists exactly when the last guess was terminal (win or
            loss). It is absent mid-round, so a too-low/too-high hint never
            offers to "share" a result that does not exist yet. */}
        {phase === PHASES.READY && completedRound && shareText ? (
          <View style={styles.card} testID="share-panel">
            <Text style={styles.cardLabel}>Share your result</Text>

            <TextInput
              value={shareName}
              onChangeText={setShareName}
              placeholder="Your name for the post (optional)"
              placeholderTextColor="#64748b"
              maxLength={32}
              editable={!sharing}
              testID="share-name"
              style={styles.input}
            />

            {/* Rendered as a plain text child, never as markup, so a name with
                angle brackets stays inert text. */}
            <Text style={styles.shareText} testID="share-text">
              {shareText}
            </Text>

            <Text style={styles.shareCapability} testID="share-capability">
              {shareCapability === SHARE_STRATEGIES.UNAVAILABLE
                ? 'This device provides neither a share sheet nor clipboard access, so copy the text above manually.'
                : shareCapability === SHARE_STRATEGIES.CLIPBOARD
                  ? `Copies the text to your clipboard.${shareOrigin ? ' The link is this app\u2019s address.' : ''}`
                  : `Uses your device share sheet.${shareOrigin ? ' The link is this app\u2019s address.' : ''}`}
            </Text>

            <TouchableOpacity
              accessibilityRole="button"
              testID="share-result"
              style={[styles.buttonShare, sharing && styles.buttonDisabled]}
              onPress={handleShare}
              disabled={sharing}
            >
              <Text style={styles.buttonText}>
                {sharing
                  ? 'Sharing...'
                  : shareCapability === SHARE_STRATEGIES.UNAVAILABLE
                    ? 'Sharing unavailable'
                    : shareCapability === SHARE_STRATEGIES.CLIPBOARD
                      ? 'Copy result'
                      : 'Share result'}
              </Text>
            </TouchableOpacity>

            {shareNotice ? (
              <Text style={styles.shareNotice} testID="share-notice">
                {shareNotice}
              </Text>
            ) : null}
          </View>
        ) : null}

        {phase === PHASES.READY && !isGuest ? (
          <TouchableOpacity
            accessibilityRole="button"
            testID="claim-bonus"
            style={[styles.buttonSecondary, busy && styles.buttonDisabled]}
            onPress={claimBonus}
            disabled={busy}
          >
            <Text style={styles.buttonSecondaryText}>Claim the daily bonus</Text>
          </TouchableOpacity>
        ) : null}

        {bonusNote ? (
          <View style={styles.feedbackBox}>
            <Text style={[styles.feedbackHeadline, { color: '#e2e8f0' }]}>
              {bonusNote.headline}
            </Text>
            {bonusNote.detail ? (
              <Text style={styles.feedbackDetail}>{bonusNote.detail}</Text>
            ) : null}
          </View>
        ) : null}

        {/* Shared state, read from the server. */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Global leaderboard</Text>
          {leaderboard.length === 0 ? (
            <Text style={styles.cardBody}>
              Nobody has been scored yet. A scored win appears here.
            </Text>
          ) : (
            leaderboard.map((row) => (
              <Text key={`${row.rank}-${row.username}`} style={styles.row}>
                #{row.rank} {row.username} - best {row.bestScore}, streak {row.streak}
              </Text>
            ))
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Global chat</Text>
          {chat.length === 0 ? (
            <Text style={styles.cardBody}>No messages yet.</Text>
          ) : (
            chat.map((entry, index) => (
              <Text key={`${index}-${entry.username}`} style={styles.row}>
                {entry.username}: {entry.message}
              </Text>
            ))
          )}
        </View>

        <Text style={styles.footer}>
          API: {config.apiBase || 'same origin'}
          {config.apiBaseSource ? ` (${config.apiBaseSource})` : ''}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 20, paddingBottom: 40, gap: 14 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  title: {
    fontSize: 26,
    color: '#f8fafc',
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 4,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  cardLabel: { color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' },
  cardBody: { color: '#e2e8f0', fontSize: 14 },
  totals: { color: '#f8fafc', fontSize: 16, fontWeight: 'bold' },
  totalsMuted: { color: '#94a3b8', fontSize: 13, fontStyle: 'italic' },
  devNote: { color: '#fbbf24', fontSize: 12 },
  globalLine: { color: '#94a3b8', fontSize: 13, textAlign: 'center' },
  feedbackBox: { gap: 4 },
  feedbackHeadline: { fontSize: 17, fontWeight: 'bold', textAlign: 'center' },
  feedbackDetail: { color: '#cbd5e1', fontSize: 13, textAlign: 'center' },
  input: {
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    color: '#0f172a',
  },
  button: { backgroundColor: '#3b82f6', paddingVertical: 14, borderRadius: 10 },
  buttonDisabled: { backgroundColor: '#1d4ed8', opacity: 0.6 },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: 'bold', fontSize: 16 },
  // Sharing: purple to match the web app's share affordance, so the same action
  // looks like the same action on both platforms.
  buttonShare: { backgroundColor: '#a855f7', paddingVertical: 14, borderRadius: 10 },
  shareText: {
    color: '#e2e8f0',
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 12,
  },
  shareCapability: { color: '#94a3b8', fontSize: 12 },
  shareNotice: { color: '#cbd5e1', fontSize: 12 },
  buttonSecondary: {
    borderColor: '#3b82f6',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonSecondaryText: { color: '#93c5fd', textAlign: 'center', fontWeight: '600' },
  row: { color: '#e2e8f0', fontSize: 13 },
  message: { color: '#e2e8f0', fontSize: 16, textAlign: 'center' },
  footer: { color: '#475569', fontSize: 11, textAlign: 'center', marginTop: 6 },
});
