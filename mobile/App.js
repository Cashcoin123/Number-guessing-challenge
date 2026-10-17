import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, TextInput, View, TouchableOpacity } from 'react-native';

export default function App() {
  const [secretNumber, setSecretNumber] = useState(Math.floor(Math.random() * 100) + 1);
  const [guess, setGuess] = useState('');
  const [message, setMessage] = useState('Guess a number between 1 and 100.');
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [attempts, setAttempts] = useState(0);

  const submitGuess = () => {
    const parsedGuess = Number(guess);
    if (!Number.isInteger(parsedGuess) || parsedGuess < 1 || parsedGuess > 100) {
      setMessage('Please enter a valid number from 1 to 100.');
      return;
    }

    setAttempts((prev) => prev + 1);

    if (parsedGuess < secretNumber) {
      setMessage('Too low! Try again.');
    } else if (parsedGuess > secretNumber) {
      setMessage('Too high! Try again.');
    } else {
      const points = Math.max(20, 100 - attempts * 8);
      const nextScore = score + points;
      const nextStreak = streak + 1;
      setScore(nextScore);
      setBestScore(Math.max(bestScore, nextScore));
      setStreak(nextStreak);
      setMessage(`Correct! You earned ${points} points.`);
      setSecretNumber(Math.floor(Math.random() * 100) + 1);
      setGuess('');
      setAttempts(0);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Number Guessing Challenge</Text>

      <View style={styles.statsRow}>
        <Text style={styles.stat}>Score: {score}</Text>
        <Text style={styles.stat}>Best: {bestScore}</Text>
        <Text style={styles.stat}>Streak: {streak}</Text>
      </View>

      <Text style={styles.message}>{message}</Text>

      <TextInput
        value={guess}
        onChangeText={setGuess}
        placeholder="Enter your guess"
        keyboardType="numeric"
        style={styles.input}
      />

      <TouchableOpacity style={styles.button} onPress={submitGuess}>
        <Text style={styles.buttonText}>Guess</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 20,
    justifyContent: 'center',
  },
  title: {
    fontSize: 28,
    color: '#f8fafc',
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 20,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  stat: {
    color: '#f8fafc',
    fontSize: 16,
  },
  message: {
    color: '#e2e8f0',
    fontSize: 18,
    marginBottom: 16,
    textAlign: 'center',
  },
  input: {
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: {
    color: '#fff',
    textAlign: 'center',
    fontWeight: 'bold',
    fontSize: 16,
  },
});
