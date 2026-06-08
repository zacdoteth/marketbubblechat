import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';

test('native post flows into messages + rejects bad url', () => {
  const msgs = [];
  const hub = createHub({ onMessage: m => msgs.push(m), onStats: () => {}, onStreams: () => {}, now: () => 1000 });
  assert.equal(hub.postNative('c1', 'you', 'hello').ok, true);
  assert.equal(msgs.at(-1).platform, 'mb');
  assert.equal(msgs.at(-1).text, 'hello');
  assert.ok(hub.connectStream('https://youtube.com/x', 'Banks').error); // unsupported
});
