import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamUrl } from '../src/urlParser.js';
import { createRoom } from '../src/room.js';
import { createIngesterPool } from '../src/ingesterPool.js';

const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };

test('urlParser: x.com/i/broadcasts/{id} → xbroadcast source, case-sensitive id', () => {
  const r = parseStreamUrl('https://x.com/i/broadcasts/1qGoNNwBAzvKv');
  assert.deepEqual(r, { platform: 'x', source: 'xbroadcast', channel: '1qGoNNwBAzvKv' });
  // twitter.com host works too
  assert.equal(parseStreamUrl('twitter.com/i/broadcasts/1nxnRRzloWdxO').channel, '1nxnRRzloWdxO');
  // a normal handle URL is the reply-search source, lowercased
  assert.deepEqual(parseStreamUrl('https://x.com/Elon'), { platform: 'x', source: 'x', channel: 'elon' });
  // twitch/kick carry source === platform
  assert.equal(parseStreamUrl('twitch.tv/Banks').source, 'twitch');
});

test('X broadcast: chat/viewers/status/label route only to the subscribed room', async () => {
  const pool = createIngesterPool({ ...noopSched }); // real ingesters; xbroadcast is inert (no network)
  const sentA = [], sentB = [];
  const roomA = createRoom({ pool, send: (o) => sentA.push(o), now: () => 1000 });
  const roomB = createRoom({ pool, send: (o) => sentB.push(o), now: () => 1000 });
  await roomA.connect('https://x.com/i/broadcasts/ABC123');
  await roomB.connect('https://x.com/i/broadcasts/XYZ789'); // different broadcast

  pool.routeXChat('ABC123', { username: 'zacxbt', displayName: 'zac.eth', text: 'gm', ts: 1 });
  pool.setXViewers('ABC123', 22033);
  pool.setXStatus('ABC123', 'live');
  pool.setXLabel('ABC123', '8Bit');

  const aMsgs = sentA.filter(o => o.type === 'message');
  assert.equal(aMsgs.length, 1, 'room A got the chat message');
  assert.equal(aMsgs[0].message.text, 'gm');
  assert.equal(aMsgs[0].message.platform, 'x', 'display platform is x');
  assert.equal(sentB.filter(o => o.type === 'message').length, 0, 'room B (other broadcast) isolated');

  const aStream = roomA.snapshot().streams[0];
  assert.equal(aStream.source, 'xbroadcast');
  assert.equal(aStream.platform, 'x');
  assert.equal(aStream.channel, 'ABC123', 'case-sensitive id preserved');
  assert.equal(aStream.status, 'live');
  assert.equal(aStream.label, '8Bit', 'broadcaster label set');
  assert.equal(roomA.statsSnapshot().perStream[aStream.id].viewers, 22033, 'real viewer count');
});

test('X broadcast: routing to an unsubscribed broadcast id is a safe no-op', () => {
  const pool = createIngesterPool({ ...noopSched });
  assert.doesNotThrow(() => pool.routeXChat('NOPE', { username: 'x', text: 'y', ts: 0 }));
  assert.doesNotThrow(() => pool.setXViewers('NOPE', 5));
  assert.doesNotThrow(() => pool.setXStatus('NOPE', 'live'));
  assert.doesNotThrow(() => pool.setXLabel('NOPE', 'whoever'));
});
