import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';

function makeFakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.stopped = false; instances.push(this); }
    async start() { this.cb.onResolved?.('bid-' + this.channel); }
    async stop() { this.stopped = true; }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };

test('hub: routeKickChat delegates to the pool and reaches subscribed rooms', async () => {
  const hub = createHub({ ...makeFakeIngesters(), ...noopSched });
  const got = [];
  const room = { onMessage: (f) => got.push(f), onStatus: () => {}, onViewers: () => {} };
  await hub.pool.subscribe('kick', 'roshtein', room);
  hub.routeKickChat('bid-roshtein', { username: 'u', text: 'gg', ts: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'gg');
  assert.equal(got[0].platform, 'kick');
});

test('hub: stopAll stops pooled ingesters', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const hub = createHub({ ingesters, ...noopSched });
  await hub.pool.subscribe('twitch', 'foo', { onMessage(){}, onStatus(){}, onViewers(){} });
  await hub.stopAll();
  assert.ok(instances.every(i => i.stopped));
});
