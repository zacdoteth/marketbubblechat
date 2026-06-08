import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapChannel } from '../src/ingesters/kickApi.js';
test('maps a live channel', () => {
  const r = mapChannel({ broadcaster_user_id: 10, slug: 'x', stream: { is_live: true, viewer_count: 4200 } });
  assert.deepEqual(r, { broadcasterUserId: 10, isLive: true, viewerCount: 4200, slug: 'x' });
});
test('offline channel reports 0 viewers', () => {
  const r = mapChannel({ broadcaster_user_id: 10, slug: 'x', stream: { is_live: false, viewer_count: 0 } });
  assert.equal(r.isLive, false); assert.equal(r.viewerCount, 0);
});
test('null channel -> null', () => { assert.equal(mapChannel(null), null); });
