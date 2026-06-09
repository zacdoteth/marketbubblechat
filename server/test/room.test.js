import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../src/room.js';
import { createIngesterPool } from '../src/ingesterPool.js';

function makeFakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.stopped = false; instances.push(this); }
    async start() { this.cb.onStatus('live'); this.cb.onViewers(7); this.cb.onResolved?.('bid-' + this.channel); }
    async stop() { this.stopped = true; }
    emit(text) { this.cb.onMessage({ username: 'u', text }); }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };

test('room.connect: rejects unsupported url; snapshot empty before any connect', () => {
  const pool = createIngesterPool({ ...makeFakeIngesters(), ...noopSched });
  const sent = [];
  const room = createRoom({ pool, send: (o) => sent.push(o), now: () => 1000 });
  const snap = room.snapshot();
  assert.deepEqual(snap.streams, []);
  assert.deepEqual(snap.messages, []);
  assert.ok(snap.stats);
});

test('room.connect: bad url returns error and adds nothing', async () => {
  const pool = createIngesterPool({ ...makeFakeIngesters(), ...noopSched });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  const r = await room.connect('https://youtube.com/x');
  assert.ok(r.error);
  assert.equal(room.snapshot().streams.length, 0);
});

test('room.connect: de-dupes same platform+channel within the room', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const pool = createIngesterPool({ ingesters, ...noopSched });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  const a = await room.connect('https://x.com/elonmusk');
  const b = await room.connect('https://x.com/elonmusk');
  assert.equal(a.stream.id, b.stream.id, 'same stream returned');
  assert.equal(room.snapshot().streams.length, 1);
  assert.equal(instances.length, 1, 'one ingester');
});

test('room: isolation — a fanned-out message lands only in the subscribing room', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const pool = createIngesterPool({ ingesters, ...noopSched });
  const sentA = [], sentB = [];
  const roomA = createRoom({ pool, send: (o) => sentA.push(o), now: () => 1000 });
  const roomB = createRoom({ pool, send: (o) => sentB.push(o), now: () => 1000 });
  await roomA.connect('https://twitch.tv/foo'); // instance[0] = twitch:foo
  await roomB.connect('https://twitch.tv/bar'); // instance[1] = twitch:bar
  instances.find(i => i.channel === 'foo').emit('hello-foo');
  const aMsgs = sentA.filter(o => o.type === 'message');
  const bMsgs = sentB.filter(o => o.type === 'message');
  assert.equal(aMsgs.length, 1);
  assert.equal(aMsgs[0].message.text, 'hello-foo');
  assert.equal(aMsgs[0].message.streamId, roomA.snapshot().streams[0].id);
  assert.equal(bMsgs.length, 0, 'room B never sees room A’s channel');
});

test('room.destroy: releases pool refs so the ingester stops after linger', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const jobs = [];
  const pool = createIngesterPool({ ingesters,
    setTimer: (fn) => { const j = { fn }; jobs.push(j); return j; }, clearTimer: () => {} });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  await room.connect('https://twitch.tv/foo');
  room.destroy();
  jobs.splice(0).forEach(j => j.fn());     // fire linger
  assert.equal(instances[0].stopped, true);
});
