// server/test/xParse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResponse } from '../src/ingesters/x.js';

const RESP = {
  data: [
    { id: '2', author_id: '10', text: 'second', created_at: '2026-06-08T00:00:02Z' },
    { id: '1', author_id: '11', text: 'first', created_at: '2026-06-08T00:00:01Z' },
  ],
  includes: { users: [
    { id: '10', username: 'alice', name: 'Alice' },
    { id: '11', username: 'bob', name: 'Bob' },
  ] },
};

test('maps tweets + resolves author usernames', () => {
  const out = parseSearchResponse(RESP);
  assert.equal(out.length, 2);
  const byId = Object.fromEntries(out.map(m => [m.id, m]));
  assert.equal(byId['2'].username, 'alice');
  assert.equal(byId['2'].displayName, 'Alice');
  assert.equal(byId['1'].username, 'bob');
  assert.equal(byId['1'].text, 'first');
  assert.equal(byId['1'].ts, Date.parse('2026-06-08T00:00:01Z'));
});
test('handles empty result', () => {
  assert.deepEqual(parseSearchResponse({ meta: { result_count: 0 } }), []);
});
test('falls back to author_id when user not in includes', () => {
  const out = parseSearchResponse({ data: [{ id: '9', author_id: '99', text: 't', created_at: '2026-06-08T00:00:00Z' }] });
  assert.equal(out[0].username, '99');
});
