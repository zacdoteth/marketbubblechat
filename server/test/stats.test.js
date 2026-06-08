// server/test/stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';

test('aggregates viewers across stream/platform/streamer + site', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  s.registerStream('s2', { platform: 'twitch', streamer: 'Z' });
  s.registerStream('s3', { platform: 'kick', streamer: 'Banks' });
  s.setViewers('s1', 100);
  s.setViewers('s2', 50);
  s.setViewers('s3', 30);
  s.setSiteViewers(7);
  const snap = s.snapshot(10_000);
  assert.equal(snap.combined.viewers, 187);          // 100+50+30+7
  assert.equal(snap.perPlatform.twitch.viewers, 150); // s1+s2
  assert.equal(snap.perPlatform.kick.viewers, 30);
  assert.equal(snap.perStreamer.Banks.viewers, 130);  // s1+s3
  assert.equal(snap.perStreamer.Z.viewers, 50);
  assert.equal(snap.site.viewers, 7);
  assert.equal(snap.perStream.s1.viewers, 100);
});

test('msgsPerMin counts only the last 60s', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'kick', streamer: 'Banks' });
  s.recordMessage('s1', 1_000);    // old (will fall outside window)
  s.recordMessage('s1', 61_500);
  s.recordMessage('s1', 61_800);
  const snap = s.snapshot(62_000); // window = (2000, 62000]; 1000 excluded
  assert.equal(snap.perStream.s1.msgsPerMin, 2);
  assert.equal(snap.combined.msgsPerMin, 2);
});

test('removeStream drops it from aggregates', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'x', streamer: 'Banks' });
  s.setViewers('s1', 9);
  s.removeStream('s1');
  const snap = s.snapshot(0);
  assert.equal(snap.combined.viewers, 0);
  assert.equal(snap.perStream.s1, undefined);
});
