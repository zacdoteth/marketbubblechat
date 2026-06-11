import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';

// BUG: Infinity not properly coerced
test('RELIABILITY: setViewers Infinity edge case', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  s.setViewers('s1', Infinity);
  const snap = s.snapshot(0);
  console.log('Infinity coercion result:', snap.perStream.s1.viewers);
  // Number(Infinity) === Infinity, so Infinity || 0 = Infinity
  // This will break toLocaleString() and JSON serialization
});

// BUG: Frontend receives Infinity/NaN in JSON
test('RELIABILITY: JSON.stringify with Infinity', () => {
  const obj = { viewers: Infinity, msgsPerMin: 0 };
  const json = JSON.stringify(obj);
  console.log('JSON with Infinity:', json);
  // JSON.stringify converts Infinity to null!
});

// BUG: negative viewers possible
test('RELIABILITY: setViewers with negative', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  s.setViewers('s1', -100);
  const snap = s.snapshot(0);
  console.log('Negative viewers:', snap.perStream.s1.viewers);
  // Should not allow negative viewers
});

// BUG: msgsPerMin is rate per second not per minute
test('RELIABILITY: msgsPerMin naming mismatch', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  const WINDOW_MS = 60_000;
  const now = 100_000;
  
  // Record 60 messages in the last minute
  for (let i = 0; i < 60; i++) {
    s.recordMessage('s1', now - WINDOW_MS + i * 1000);
  }
  
  const snap = s.snapshot(now);
  // Counts messages in the trailing 60s window (strict `now - t < WINDOW_MS`).
  // The message recorded exactly 60_000ms ago (i=0, t=40_000) sits ON the boundary
  // and is correctly excluded, so 60 recorded → 59 counted.
  assert.equal(snap.perStream.s1.msgsPerMin, 59);
});

