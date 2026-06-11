import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShowRoom } from '../src/showRoom.js';
import { createIngesterPool } from '../src/ingesterPool.js';

// Inert ingesters so nothing hits the network.
function inertIngesters() {
  class Inert { constructor(_c, cb = {}) { this.cb = cb; } async start() { this.cb.onStatus?.('connecting'); } async stop() {} }
  return { twitch: Inert, kick: Inert, x: Inert, xbroadcast: Inert };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };
const mkPool = () => createIngesterPool({ ingesters: inertIngesters(), ...noopSched });
function mkClient() { const sent = []; return { send: (o) => sent.push(o), sent }; }

test('showRoom: attach sends a snapshot with a guestId; broadcasts reach all clients', () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(), b = mkClient();
  const ca = room.attach(a.send); const cb = room.attach(b.send);
  assert.equal(a.sent[0].type, 'snapshot');
  assert.ok(ca.guestId.startsWith('guest-'));
  assert.ok(cb.guestId !== ca.guestId, 'distinct guest ids');
  room.broadcast({ type: 'ping' });
  assert.ok(a.sent.some(o => o.type === 'ping'));
  assert.ok(b.sent.some(o => o.type === 'ping'));
});

test('showRoom: connect adds a stream, sets it featured, and broadcasts to all', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(), b = mkClient();
  room.attach(a.send); room.attach(b.send);
  const r = await room.connect('https://twitch.tv/foo');
  assert.ok(r.stream);
  for (const c of [a, b]) {
    assert.ok(c.sent.some(o => o.type === 'streams' && o.streams.some(s => s.channel === 'foo')));
    assert.ok(c.sent.some(o => o.type === 'featured' && o.id === r.stream.id), 'first stream auto-featured');
  }
});

test('showRoom: pool message fans out to every client', async () => {
  const pool = mkPool();
  const room = createShowRoom({ pool, now: () => 1000 });
  const a = mkClient(), b = mkClient();
  room.attach(a.send); room.attach(b.send);
  await room.connect('https://twitch.tv/foo');
  room.onMessage({ poolKey: 'twitch:foo', platform: 'twitch', username: 'u', text: 'hi', ts: 1 });
  for (const c of [a, b]) {
    const m = c.sent.filter(o => o.type === 'message').pop();
    assert.equal(m.message.text, 'hi');
    assert.equal(m.message.platform, 'twitch');
  }
});

test('showRoom: selectFeatured switches the featured stream', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); room.attach(a.send);
  const s1 = (await room.connect('https://twitch.tv/foo')).stream;
  const s2 = (await room.connect('https://kick.com/bar')).stream;
  assert.equal(room.snapshotFor({ guestId: 'g' }).featuredId, s1.id, 'first stays featured');
  room.selectFeatured(s2.id);
  assert.equal(room.snapshotFor({ guestId: 'g' }).featuredId, s2.id);
  assert.equal(room.selectFeatured('nope').error, 'no such stream');
});

test('showRoom: disconnect of the featured stream reassigns featured', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); room.attach(a.send);
  const s1 = (await room.connect('https://twitch.tv/foo')).stream;
  const s2 = (await room.connect('https://kick.com/bar')).stream;
  room.disconnect(s1.id);
  assert.equal(room.snapshotFor({ guestId: 'g' }).featuredId, s2.id, 'featured falls to the remaining stream');
});

test('showRoom: nativeChat broadcasts as mb under the guest id; rate-limit drops the 2nd', () => {
  let t = 1000;
  const room = createShowRoom({ pool: mkPool(), now: () => t, slowModeMs: 2500 });
  const a = mkClient(), b = mkClient();
  const ca = room.attach(a.send); room.attach(b.send);
  assert.deepEqual(room.nativeChat(ca, 'gm'), { ok: true });
  for (const c of [a, b]) { const m = c.sent.filter(o => o.type === 'message').pop(); assert.equal(m.message.text, 'gm'); assert.equal(m.message.platform, 'mb'); assert.equal(m.message.username, ca.guestId); }
  assert.deepEqual(room.nativeChat(ca, 'spam'), { error: 'slow down' });
  t += 2600;
  assert.deepEqual(room.nativeChat(ca, 'ok now'), { ok: true });
  assert.equal(room.nativeChat(ca, '   '), undefined);
});

test('showRoom: clearChat empties the buffer and broadcasts clear', () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); const ca = room.attach(a.send);
  room.nativeChat(ca, 'hello');
  assert.equal(room.snapshotFor({ guestId: 'g' }).messages.length, 1);
  room.clearChat();
  assert.equal(room.snapshotFor({ guestId: 'g' }).messages.length, 0);
  assert.ok(a.sent.some(o => o.type === 'clear'));
});

test('showRoom: mb viewer count tracks connected clients', () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); room.attach(a.send);
  const b = mkClient(); const cb = room.attach(b.send);
  assert.equal(room.statsSnapshot().perPlatform.mb.viewers, 2);
  room.detach(cb);
  assert.equal(room.statsSnapshot().perPlatform.mb.viewers, 1);
});

test('showRoom: restore re-connects persisted streams and featured', async () => {
  const cfg = { streams: ['https://twitch.tv/foo', 'https://kick.com/bar'], featuredKey: 'kick:bar' };
  const store = { load: async () => cfg, save: async () => {} };
  const room = createShowRoom({ pool: mkPool(), now: () => 1000, store });
  await room.restore();
  const snap = room.snapshotFor({ guestId: 'g' });
  assert.equal(snap.streams.length, 2);
  const bar = snap.streams.find(s => s.channel === 'bar');
  assert.equal(snap.featuredId, bar.id, 'featured restored by poolKey');
});
