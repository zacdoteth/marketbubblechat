// server/test/normalize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMessage } from '../src/normalize.js';

test('maps fields and applies platform color fallback', () => {
  const m = makeMessage({ streamId: 's1', platform: 'twitch', streamer: 'Banks',
    username: 'viewer1', text: 'gm', ts: 1000 });
  assert.equal(m.platform, 'twitch');
  assert.equal(m.streamer, 'Banks');
  assert.equal(m.username, 'viewer1');
  assert.equal(m.displayName, 'viewer1');
  assert.equal(m.color, '#A571FF');  // twitch fallback
  assert.equal(m.text, 'gm');
  assert.equal(m.ts, 1000);
  assert.equal(m.seq, 0);            // assigned later by aggregator
});
test('keeps provided color and displayName', () => {
  const m = makeMessage({ platform: 'kick', username: 'u', displayName: 'U', color: '#123456', text: 'x', ts: 1 });
  assert.equal(m.color, '#123456');
  assert.equal(m.displayName, 'U');
});
test('coerces missing username to anon and stringifies text', () => {
  const m = makeMessage({ platform: 'x', text: 42, ts: 3 });
  assert.equal(m.username, 'anon');
  assert.equal(m.text, '42');
});
