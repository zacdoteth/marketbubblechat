// server/test/streamRegistry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/streamRegistry.js';

test('add returns unique id and connecting status', () => {
  const r = createRegistry();
  const a = r.add({ platform: 'twitch', channel: 'banks', streamerLabel: 'Banks', url: 'u' });
  assert.equal(a.status, 'connecting');
  assert.ok(a.id);
});
test('allows two streams on the same platform (collab)', () => {
  const r = createRegistry();
  const a = r.add({ platform: 'twitch', channel: 'banks', streamerLabel: 'Banks' });
  const b = r.add({ platform: 'twitch', channel: 'zee', streamerLabel: 'Z' });
  assert.notEqual(a.id, b.id);
  assert.equal(r.list().length, 2);
});
test('setStatus and remove work', () => {
  const r = createRegistry();
  const a = r.add({ platform: 'kick', channel: 'x' });
  r.setStatus(a.id, 'live');
  assert.equal(r.get(a.id).status, 'live');
  assert.equal(r.remove(a.id), true);
  assert.equal(r.get(a.id), undefined);
});
