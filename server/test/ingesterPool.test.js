import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngesterPool } from '../src/ingesterPool.js';

// A fake ingester that records lifecycle and lets tests push events.
function makeFakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.started = false; this.stopped = false; instances.push(this); }
    async start() { this.started = true; this.cb.onStatus('live'); this.cb.onViewers(42); this.cb.onResolved?.('bid-' + this.channel); }
    async stop() { this.stopped = true; }
    emit(text) { this.cb.onMessage({ username: 'u', text }); }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}

// A controllable scheduler so linger does not depend on wall-clock.
function makeScheduler() {
  const jobs = [];
  return {
    setTimer: (fn) => { const j = { fn, cancelled: false }; jobs.push(j); return j; },
    clearTimer: (j) => { if (j) j.cancelled = true; },
    fireAll: () => { for (const j of jobs.splice(0)) if (!j.cancelled) j.fn(); },
  };
}

function fakeRoom() {
  return { msgs: [], statuses: [], viewers: [],
    onMessage(f) { this.msgs.push(f); },
    onStatus(k, s) { this.statuses.push([k, s]); },
    onViewers(k, n) { this.viewers.push([k, n]); } };
}

test('pool: two rooms on same channel share ONE ingester; stops only after last leaves + linger', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer, lingerMs: 1000 });
  const a = fakeRoom(), b = fakeRoom();

  await pool.subscribe('twitch', 'foo', a);
  await pool.subscribe('twitch', 'foo', b);
  assert.equal(instances.length, 1, 'one shared ingester');

  pool.unsubscribe('twitch:foo', a);
  sch.fireAll();
  assert.equal(instances[0].stopped, false, 'still has a subscriber -> not stopped');

  pool.unsubscribe('twitch:foo', b);
  assert.equal(instances[0].stopped, false, 'linger not fired yet');
  sch.fireAll();
  assert.equal(instances[0].stopped, true, 'stopped after last leaves + linger');
});

test('pool: a room joining an existing channel gets status+viewers replayed', async () => {
  const { ingesters } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  const a = fakeRoom(), b = fakeRoom();
  await pool.subscribe('twitch', 'foo', a);
  await pool.subscribe('twitch', 'foo', b);
  // b joined after the ingester already reported live/42 -> it must be replayed.
  assert.deepEqual(b.statuses.at(-1), ['twitch:foo', 'live']);
  assert.deepEqual(b.viewers.at(-1), ['twitch:foo', 42]);
});

test('pool: linger reuse — re-subscribing within the window keeps the SAME ingester', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  const a = fakeRoom();
  await pool.subscribe('twitch', 'foo', a);
  pool.unsubscribe('twitch:foo', a);    // schedules linger
  await pool.subscribe('twitch', 'foo', a); // rejoin before firing
  sch.fireAll();                          // cancelled timer must be a no-op
  assert.equal(instances.length, 1, 'no second ingester created');
  assert.equal(instances[0].stopped, false, 'warm ingester reused, not stopped');
});

test('pool: routeKickChat reaches only the resolved broadcaster’s rooms; unknown bid dropped', async () => {
  const { ingesters } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  const a = fakeRoom(), b = fakeRoom();
  await pool.subscribe('kick', 'roshtein', a); // Fake.start resolves 'bid-roshtein'
  await pool.subscribe('kick', 'someone', b);  // resolves 'bid-someone'
  pool.routeKickChat('bid-roshtein', { username: 'x', text: 'hi', ts: 1 });
  assert.equal(a.msgs.length, 1);
  assert.equal(a.msgs[0].text, 'hi');
  assert.equal(a.msgs[0].platform, 'kick');
  assert.equal(b.msgs.length, 0, 'other channel’s room untouched');
  pool.routeKickChat('does-not-exist', { username: 'x', text: 'drop', ts: 2 });
  assert.equal(a.msgs.length, 1, 'unknown broadcaster dropped');
});

test('pool: stopAll stops every ingester', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  await pool.subscribe('twitch', 'foo', fakeRoom());
  await pool.subscribe('kick', 'bar', fakeRoom());
  await pool.stopAll();
  assert.ok(instances.every(i => i.stopped), 'all ingesters stopped');
});
