import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';

// FIXED BUG 1: Infinity/NaN in viewer counts are now clamped to 0 (JSON-safe).
test('BUG 1 FIXED: setViewers clamps Infinity to 0 (JSON-safe)', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });

  s.setViewers('s1', Infinity);
  const snap = s.snapshot(0);

  // Infinity is now coerced to 0 before it can reach JSON.stringify (which would emit null).
  const json = JSON.stringify({ stats: snap });
  const parsed = JSON.parse(json);

  assert.equal(snap.perStream.s1.viewers, 0, 'Infinity clamped to 0');
  assert.equal(parsed.stats.perStream.s1.viewers, 0, 'survives JSON round-trip as 0');
});

// FIXED BUG 2: Negative viewers are now clamped to 0.
test('BUG 2 FIXED: setViewers clamps negative numbers to 0', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });

  s.setViewers('s1', -100);
  const snap = s.snapshot(0);

  assert.equal(snap.perStream.s1.viewers, 0, 'negative clamped to 0');
});

// CRITICAL BUG 3: Malicious streamer label causes XSS
test('BUG 3: Streamer label not escaped in vbreakdown HTML', () => {
  // User input in connectWho field:
  const maliciousLabel = '<img src=x onerror="alert(1)">';
  
  // Flows through: hub.connectStream -> emit -> stats -> snapshot
  // Frontend at line 586:
  // rows.push(`<div class="r"><span>${s.platform}${s.streamer?(' · '+s.streamer):''}</span>...`)
  // NOT ESCAPED!
  
  // Meanwhile, line 521 (chat messages) DOES escape:
  // ${streamer?(' · '+esc(streamer)):''}
  
  console.log('Vulnerable line 586: does not escape s.streamer');
  console.log('Safe line 521: escapes streamer with esc()');
  console.log('This is an XSS vulnerability in the viewer breakdown tooltip');
});

// MEDIUM BUG 4: Empty string vs undefined streamer causes aggregation issue
test('BUG 4: Empty streamer collapses with undefined into same bucket', () => {
  const s = createStats();
  
  // Two streams with same platform but different streamer representation
  s.registerStream('s1', { platform: 'twitch', streamer: '' });        // explicit empty
  s.registerStream('s2', { platform: 'twitch', streamer: undefined }); // becomes empty string
  
  s.setViewers('s1', 100);
  s.setViewers('s2', 50);
  
  const snap = s.snapshot(0);
  
  // Both collapse into perStreamer['']
  console.log('perStreamer keys:', Object.keys(snap.perStreamer));
  console.log('Collapsed viewers:', snap.perStreamer['']);
  
  // This causes incorrect stats - both streams appear as one
  // Frontend cannot distinguish between "no streamer label" and "undefined"
});

