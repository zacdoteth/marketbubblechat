// server/test/kickParse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKickEvent } from '../src/ingesters/kick.js';

test('parses a ChatMessageEvent (double-encoded data)', () => {
  const inner = JSON.stringify({ content: 'hello kick', created_at: '2026-06-08T06:29:23Z',
    sender: { username: 'kicker99' } });
  const frame = { event: 'App\\Events\\ChatMessageEvent', data: inner };
  const m = parseKickEvent(frame);
  assert.equal(m.username, 'kicker99');
  assert.equal(m.text, 'hello kick');
  assert.equal(m.ts, Date.parse('2026-06-08T06:29:23Z'));
});
test('ignores non-chat events', () => {
  assert.equal(parseKickEvent({ event: 'pusher:ping', data: '{}' }), null);
});
test('returns null on malformed data', () => {
  assert.equal(parseKickEvent({ event: 'App\\Events\\ChatMessageEvent', data: 'not json' }), null);
});
