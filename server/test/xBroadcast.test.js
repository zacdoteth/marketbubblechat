import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamUrl } from '../src/urlParser.js';
import { createShowRoom } from '../src/showRoom.js';
import { createIngesterPool } from '../src/ingesterPool.js';

function inertIngesters() {
  class Inert { constructor(_c, cb = {}) { this.cb = cb; } async start() { this.cb.onStatus?.('connecting'); } async stop() {} }
  return { twitch: Inert, kick: Inert, x: Inert, xbroadcast: Inert };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };
const mkPool = () => createIngesterPool({ ingesters: inertIngesters(), ...noopSched });
function mkClient() { const sent = []; return { send: (o) => sent.push(o), sent }; }

test('urlParser: x.com/i/broadcasts/{id} → xbroadcast source, case-sensitive id', () => {
  const r = parseStreamUrl('https://x.com/i/broadcasts/1qGoNNwBAzvKv');
  assert.deepEqual(r, { platform: 'x', source: 'xbroadcast', channel: '1qGoNNwBAzvKv' });
  assert.equal(parseStreamUrl('twitter.com/i/broadcasts/1nxnRRzloWdxO').channel, '1nxnRRzloWdxO');
  assert.deepEqual(parseStreamUrl('https://x.com/Elon'), { platform: 'x', source: 'x', channel: 'elon' });
  assert.equal(parseStreamUrl('twitch.tv/Banks').source, 'twitch');
});

test('X broadcast: chat/viewers/status/label reach ALL clients of the shared show', async () => {
  const pool = mkPool();
  const room = createShowRoom({ pool, now: () => 1000 });
  const a = mkClient(), b = mkClient();
  room.attach(a.send); room.attach(b.send);
  const s = (await room.connect('https://x.com/i/broadcasts/ABC123')).stream;

  pool.routeXChat('ABC123', { username: 'zacxbt', displayName: 'zac.eth', text: 'gm', ts: 1 });
  pool.setXViewers('ABC123', 22033);
  pool.setXStatus('ABC123', 'live');
  pool.setXLabel('ABC123', '8Bit');

  for (const c of [a, b]) {
    const m = c.sent.filter(o => o.type === 'message').pop();
    assert.equal(m.message.text, 'gm');
    assert.equal(m.message.platform, 'x');
  }
  const snap = room.snapshotFor({ guestId: 'g' });
  const stream = snap.streams.find(x => x.channel === 'ABC123');
  assert.equal(stream.source, 'xbroadcast');
  assert.equal(stream.platform, 'x');
  assert.equal(stream.status, 'live');
  assert.equal(stream.label, '8Bit');
  assert.equal(snap.stats.perStream[s.id].viewers, 22033, 'real viewer count');
});

test('X broadcast: routing to an unsubscribed broadcast id is a safe no-op', () => {
  const pool = mkPool();
  assert.doesNotThrow(() => pool.routeXChat('NOPE', { username: 'x', text: 'y', ts: 0 }));
  assert.doesNotThrow(() => pool.setXViewers('NOPE', 5));
  assert.doesNotThrow(() => pool.setXStatus('NOPE', 'live'));
  assert.doesNotThrow(() => pool.setXLabel('NOPE', 'whoever'));
});

test('X broadcast: activeXBroadcasts lists subscribed broadcast ids (for the cloud worker)', async () => {
  const pool = mkPool();
  const room = createShowRoom({ pool, now: () => 1000 });
  room.attach(mkClient().send);
  assert.deepEqual(pool.activeXBroadcasts(), []);
  await room.connect('https://x.com/i/broadcasts/ABC123');
  await room.connect('https://twitch.tv/someone'); // non-broadcast must NOT appear
  await room.connect('https://x.com/i/broadcasts/XYZ789');
  assert.deepEqual(pool.activeXBroadcasts().sort(), ['ABC123', 'XYZ789']);
});
