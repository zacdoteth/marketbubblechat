import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';

test('connectStream rejects unsupported URL and snapshot returns empty arrays', () => {
  const hub = createHub({ onMessage: () => {}, onStats: () => {}, onStreams: () => {}, now: () => 1000 });

  // unsupported platform returns an error object
  const result = hub.connectStream('https://youtube.com/x', 'Banks');
  assert.ok(result.error, 'expected an error for unsupported URL');

  // snapshot shape is correct with no streams connected
  const snap = hub.snapshot();
  assert.ok(Array.isArray(snap.streams), 'streams should be an array');
  assert.ok(Array.isArray(snap.messages), 'messages should be an array');
  assert.ok(snap.stats, 'stats should be present');
  assert.equal(snap.streams.length, 0);
  assert.equal(snap.messages.length, 0);
});
