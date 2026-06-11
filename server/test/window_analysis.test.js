import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';

test('RELIABILITY: Window boundary analysis', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  const WINDOW_MS = 60_000;
  const now = 100_000;
  
  // The filter is: now - t < WINDOW_MS
  // For t = now - WINDOW_MS:
  //   100000 - 40000 = 60000
  //   60000 < 60000? NO → excluded (correct)
  
  // For t = now - WINDOW_MS + 1:
  //   100000 - 40001 = 59999
  //   59999 < 60000? YES → included (correct)
  
  s.recordMessage('s1', now - WINDOW_MS);       // t = 40000
  s.recordMessage('s1', now - WINDOW_MS + 1);   // t = 40001
  s.recordMessage('s1', now - 1);                // t = 99999
  
  const snap = s.snapshot(now);
  console.log('Count:', snap.perStream.s1.msgsPerMin);
  
  // This part is working correctly! Boundary is right.
  assert.equal(snap.perStream.s1.msgsPerMin, 2);
});

test('RELIABILITY: Off-by-one in inclusive range', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  const WINDOW_MS = 60_000;
  const now = 100_000;
  
  // What if we want messages from PAST MINUTE (last 60s)?
  // Window should be (now - 60000, now] (exclusive left, inclusive right)
  // Current: now - t < 60000, which is (now - 60000, now] 
  // This is correct!
  
  // But when filling a window from now = 100000:
  // We count messages where: 100000 - t < 60000
  // So: t > 40000, meaning t in (40000, 100000]
  // Message at 40000 is excluded, 40001 is included
  
  // HOWEVER, if we spam 1000 messages very quickly:
  for (let i = 0; i < 1000; i++) {
    s.recordMessage('s1', now - 1000 + i);
  }
  
  const snap1 = s.snapshot(now);
  const snap2 = s.snapshot(now + 100); // 100ms later
  
  console.log('Msgs at t=now:', snap1.perStream.s1.msgsPerMin);
  console.log('Msgs at t=now+100:', snap2.perStream.s1.msgsPerMin);
});

test('RELIABILITY: snapshot mutates internal msgTimes', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  s.recordMessage('s1', 10);
  s.recordMessage('s1', 20);
  s.recordMessage('s1', 30);
  
  // snapshot filters msgTimes IN PLACE! (mutates)
  const snap1 = s.snapshot(100);
  assert.equal(snap1.perStream.s1.msgsPerMin, 3, 'all within window');
  
  // If called with huge now, removes old entries
  const snap2 = s.snapshot(100000000);
  assert.equal(snap2.perStream.s1.msgsPerMin, 0, 'all now outside window');
  
  // But what if snapshot is called twice?
  s.recordMessage('s1', 100000040);
  const snap3 = s.snapshot(100000100);
  // The old messages were already filtered out!
  assert.equal(snap3.perStream.s1.msgsPerMin, 1);
});

test('RELIABILITY: two concurrent snapshots issue', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  
  for (let i = 0; i < 100; i++) {
    s.recordMessage('s1', i);
  }
  
  // In single-threaded JS, this doesn't race, but the pattern is:
  // Snapshot 1 filters msgTimes
  // Snapshot 2 filters the already-filtered msgTimes
  // So repeated snapshots at same time give same result (good)
  
  // But if Frontend keeps calling snapshot without pushing new messages:
  const snap1 = s.snapshot(50000);
  const snap2 = s.snapshot(50000);
  
  assert.equal(snap1.perStream.s1.msgsPerMin, snap2.perStream.s1.msgsPerMin);
});

