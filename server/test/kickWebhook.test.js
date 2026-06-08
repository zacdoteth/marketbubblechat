import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatWebhook } from '../src/ingesters/kickWebhook.js';
test('parses chat.message.sent payload', () => {
  const m = parseChatWebhook({ broadcaster: { user_id: 4599 }, sender: { username: 'kicker' }, content: 'gg', created_at: '2026-06-08T00:00:00Z' });
  assert.equal(m.broadcasterUserId, '4599');
  assert.equal(m.username, 'kicker');
  assert.equal(m.text, 'gg');
  assert.equal(m.ts, Date.parse('2026-06-08T00:00:00Z'));
});
test('handles missing fields gracefully', () => {
  const m = parseChatWebhook({ broadcaster_user_id: 7, content: '' });
  assert.equal(m.broadcasterUserId, '7');
  assert.equal(m.username, 'viewer');
  assert.equal(m.text, '');
});
