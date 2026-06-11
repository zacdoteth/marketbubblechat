// server/test/reliability_fixes.test.js
// Locks in the reliability fixes that have unit-testable pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';
import { createShowRoom } from '../src/showRoom.js';
import { createIngesterPool } from '../src/ingesterPool.js';

// Shared fakes for the ported room/pool tests
function _fakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.stopped = false; instances.push(this); }
    async start() { this.cb.onResolved?.('bid-' + this.channel); this.cb.onStatus('live'); this.cb.onViewers(1); }
    async stop() { this.stopped = true; }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}
const _noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };

// --- stats.setViewers clamping (Infinity / NaN / negative / float) ---
test('FIX stats.setViewers: clamps Infinity, NaN, null, negative to 0; floors floats', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });

  for (const bad of [Infinity, -Infinity, NaN, null, undefined, -100]) {
    s.setViewers('s1', bad);
    assert.equal(s.snapshot(0).perStream.s1.viewers, 0, `${String(bad)} -> 0`);
  }
  s.setViewers('s1', 50.7);
  assert.equal(s.snapshot(0).perStream.s1.viewers, 50, 'float floored');
  s.setViewers('s1', 4200);
  assert.equal(s.snapshot(0).perStream.s1.viewers, 4200, 'valid passes through');

  // and it stays JSON-safe (Infinity would have serialized to null)
  s.setViewers('s1', Infinity);
  const round = JSON.parse(JSON.stringify(s.snapshot(0)));
  assert.equal(round.perStream.s1.viewers, 0);
});

// --- room: duplicate same platform+channel connect is de-duped (no zombie ingesters) ---
test('FIX room.connect: same platform+channel returns existing stream (dedupe)', async () => {
  const { ingesters, instances } = _fakeIngesters();
  const pool = createIngesterPool({ ingesters, ..._noopSched });
  const room = createShowRoom({ pool, now: () => 0 });
  room.attach(() => {});
  const a = await room.connect('https://x.com/elonmusk');
  const b = await room.connect('https://x.com/elonmusk');
  assert.ok(a.stream, 'first connect creates a stream');
  assert.equal(b.stream.id, a.stream.id, 'second connect reuses the same stream id');
  assert.equal(room.snapshotFor({ guestId: 'g' }).streams.length, 1, 'only one stream registered');
  assert.equal(instances.length, 1, 'only one ingester started');
});

// --- pool: routeKickChat routes to mapped room, drops unknown broadcaster ---
test('FIX pool.routeKickChat: routes to mapped room, drops unknown broadcaster', async () => {
  const { ingesters } = _fakeIngesters();
  const pool = createIngesterPool({ ingesters, ..._noopSched });
  const got = [];
  const room = createShowRoom({ pool, now: () => 0 });
  room.attach((o) => { if (o.type === 'message') got.push(o.message); });
  await room.connect('https://kick.com/somebody'); // resolves 'bid-somebody'
  pool.routeKickChat('999999', { username: 'u', text: 'dropped', ts: 1 }); // unknown -> drop
  assert.equal(got.length, 0, 'unknown broadcaster -> no emit (no crash)');
  pool.routeKickChat('bid-somebody', { username: 'u', text: 'kept', ts: 2 });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'kept');
});

// --- room: disconnect removes stats and a late Kick chat is a guarded no-op ---
test('FIX room.disconnect: removes stats and late Kick chat is a no-op', async () => {
  const { ingesters } = _fakeIngesters();
  const pool = createIngesterPool({ ingesters, ..._noopSched });
  const room = createShowRoom({ pool, now: () => 1000 });
  room.attach(() => {});
  const s = await room.connect('https://kick.com/somebody');
  const id = s.stream.id;
  room.disconnect(id);
  // stats for the removed stream are gone
  assert.equal(room.statsSnapshot().perStream[id], undefined);
  // a late webhook for the now-removed channel must not throw and must not re-add anything
  assert.doesNotThrow(() => pool.routeKickChat('bid-somebody', { username: 'x', text: 'y', ts: 0 }));
  assert.equal(room.snapshotFor({ guestId: 'g' }).streams.length, 0);
});
