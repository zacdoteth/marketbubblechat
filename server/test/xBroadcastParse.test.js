import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXFrame } from '../src/ingesters/xBroadcastParse.js';
import { parseXFrame as vendoredParseXFrame } from '../../worker/xBroadcastParse.js';

// Build a real-shaped chat frame the way the wire does: triple-nested JSON.
function buildChatFrame(msg) {
  const body = JSON.stringify(msg);                       // L2 (the message)
  const payload = JSON.stringify({ room: msg.room || 'R', body }); // L1
  return JSON.stringify({ kind: 1, payload });            // L0
}

test('parseXFrame: decodes a chat message (3-layer nesting)', () => {
  const raw = buildChatFrame({
    body: 'gm', displayName: 'zac.eth (ARX MODE) ☂️', username: 'zacxbt',
    type: 1, timestamp: 1781066725114, uuid: '1YLEJdnVDbPKN', room: '1qGoNNwBAzvKv',
  });
  const out = parseXFrame(raw);
  assert.deepEqual(out, { type: 'chat', msg: {
    username: 'zacxbt', displayName: 'zac.eth (ARX MODE) ☂️',
    text: 'gm', ts: 1781066725114, uuid: '1YLEJdnVDbPKN',
  } });
});

test('parseXFrame: falls back displayName→username when username missing', () => {
  const raw = buildChatFrame({ body: 'hi', displayName: 'Cook-m.eth', timestamp: 1, uuid: 'u1' });
  const out = parseXFrame(raw);
  assert.equal(out.type, 'chat');
  assert.equal(out.msg.username, 'Cook-m.eth');
  assert.equal(out.msg.displayName, 'Cook-m.eth');
  assert.equal(out.msg.text, 'hi');
});

test('parseXFrame: decodes occupancy/viewer-count from a real captured frame', () => {
  // Verbatim frame captured from a live broadcast (outer kind 2 → inner kind 4).
  const raw = '{"kind":2,"payload":"{\\"kind\\":4,\\"sender\\":{\\"user_id\\":\\"\\"},\\"body\\":\\"{\\\\\\"room\\\\\\":\\\\\\"1nxnRRzloWdxO\\\\\\",\\\\\\"occupancy\\\\\\":49,\\\\\\"total_participants\\\\\\":49}\\"}"}';
  const out = parseXFrame(raw);
  assert.deepEqual(out, { type: 'viewers', occupancy: 49 });
});

test('parseXFrame: emoji body survives', () => {
  const raw = buildChatFrame({ body: '😀😀', username: 'shellistonnn', displayName: 'Sheliston', timestamp: 2, uuid: 'u2' });
  assert.equal(parseXFrame(raw).msg.text, '😀😀');
});

test('vendored worker parser stays in sync with the canonical server parser', () => {
  // The worker ships a vendored copy of this parser. Guard against drift: identical output.
  const samples = [
    buildChatFrame({ body: 'gm', username: 'zacxbt', displayName: 'zac', timestamp: 5, uuid: 'u', room: 'R' }),
    '{"kind":2,"payload":"{\\"kind\\":4,\\"sender\\":{},\\"body\\":\\"{\\\\\\"room\\\\\\":\\\\\\"R\\\\\\",\\\\\\"occupancy\\\\\\":7}\\"}"}',
    'garbage', '{"kind":9,"payload":"{}"}', '',
  ];
  for (const s of samples) assert.deepEqual(vendoredParseXFrame(s), parseXFrame(s));
});

test('parseXFrame: malformed / non-chat / unknown frames return null', () => {
  assert.equal(parseXFrame('not json'), null);
  assert.equal(parseXFrame('{"kind":1}'), null);                    // no payload
  assert.equal(parseXFrame('{"kind":9,"payload":"{}"}'), null);     // unknown outer kind
  assert.equal(parseXFrame(JSON.stringify({ kind: 1, payload: JSON.stringify({ room: 'R', body: JSON.stringify({ no: 'text' }) }) })), null); // chat w/o text body
  assert.equal(parseXFrame(''), null);
  assert.equal(parseXFrame(null), null);
});
