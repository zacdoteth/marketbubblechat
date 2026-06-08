import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';
import { createAggregator } from '../src/aggregator.js';
import { makeMessage } from '../src/normalize.js';

// BUG 1: Empty streamer label collapses with undefined
test('RELIABILITY: perStreamer with empty string vs undefined', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: '' });
  s.registerStream('s2', { platform: 'twitch', streamer: undefined });
  s.setViewers('s1', 100);
  s.setViewers('s2', 50);
  
  const snap = s.snapshot(0);
  assert.equal(snap.perStreamer[''].viewers, 150, 'should aggregate both empty and undefined into one bucket');
});

// BUG 2: Window correctness - boundary conditions
test('RELIABILITY: msgTimes window boundary (off-by-one)', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'kick', streamer: 'Banks' });
  
  // Test boundary: exactly at WINDOW_MS edge
  const WINDOW_MS = 60_000;
  const now = 100_000;
  
  s.recordMessage('s1', now - WINDOW_MS);       // exactly WINDOW_MS ago - should be EXCLUDED
  s.recordMessage('s1', now - WINDOW_MS + 1);   // just inside window
  s.recordMessage('s1', now - 1);                 // recent
  
  const snap = s.snapshot(now);
  assert.equal(snap.perStream.s1.msgsPerMin, 2, 'oldest should be excluded by boundary');
});

// BUG 3: removeStream + re-register
test('RELIABILITY: removeStream + re-register clears old messages', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  s.recordMessage('s1', 1000);
  s.recordMessage('s1', 2000);
  
  // Remove and re-register same ID
  s.removeStream('s1');
  s.registerStream('s1', { platform: 'twitch', streamer: 'NewStreamer' });
  
  // Old msgTimes should be gone
  const snap = s.snapshot(3000);
  assert.equal(snap.perStream.s1.msgsPerMin, 0, 'old messages should not persist after removeStream');
});

// BUG 4: setViewers type coercion edge case
test('RELIABILITY: setViewers with non-numeric input', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  // Try to set viewers with edge cases
  s.setViewers('s1', NaN);
  const snap1 = s.snapshot(0);
  assert.equal(snap1.perStream.s1.viewers, 0, 'should coerce NaN to 0');
  
  s.setViewers('s1', Infinity);
  const snap2 = s.snapshot(0);
  assert.equal(snap2.perStream.s1.viewers, 0, 'should coerce Infinity to 0');
  
  s.setViewers('s1', null);
  const snap3 = s.snapshot(0);
  assert.equal(snap3.perStream.s1.viewers, 0, 'should coerce null to 0');
});

// BUG 5: Empty platform in platform-based stats
test('RELIABILITY: stats with undefined platform', () => {
  const s = createStats();
  s.registerStream('s1', { platform: undefined, streamer: 'Banks' });
  s.setViewers('s1', 100);
  
  const snap = s.snapshot(0);
  assert.ok(snap.perPlatform.undefined, 'undefined platform becomes a string key');
  assert.equal(snap.perPlatform.undefined.viewers, 100);
});

