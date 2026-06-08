// server/test/kickResolver.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKick } from '../src/ingesters/kickResolver.js';

test('uses override when present (no network)', async () => {
  const r = await resolveKick('xqc', { fetchImpl: async () => { throw new Error('should not call'); },
    overrideFn: () => 668 });
  assert.equal(r.chatroomId, 668);
  assert.equal(r.source, 'override');
});
test('parses live api response', async () => {
  const body = { chatroom: { id: 12345 }, livestream: { viewer_count: 4800 } };
  const r = await resolveKick('someone', {
    overrideFn: () => null,
    fetchImpl: async () => ({ ok: true, json: async () => body }),
  });
  assert.equal(r.chatroomId, 12345);
  assert.equal(r.viewers, 4800);
  assert.equal(r.isLive, true);
});
test('throws on blocked/non-ok response', async () => {
  await assert.rejects(() => resolveKick('blocked', {
    overrideFn: () => null,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }), /403/);
});
