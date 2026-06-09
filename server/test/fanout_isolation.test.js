import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startFanout } from '../src/fanout.js';

// Fake ingesters captured so the test can emit a message on demand.
const captured = [];
function makeFakeIngesters() {
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; captured.push(this); }
    async start() { this.cb.onStatus('live'); this.cb.onViewers(5); this.cb.onResolved?.('bid-' + this.channel); }
    async stop() {}
    emit(text) { this.cb.onMessage({ username: 'u', text }); }
  }
  return { twitch: Fake, kick: Fake, x: Fake };
}

const next = (ws, pred) => new Promise((resolve) => {
  ws.on('message', function h(buf) {
    const m = JSON.parse(buf.toString());
    if (pred(m)) { ws.off('message', h); resolve(m); }
  });
});

test('fanout: per-session isolation + blank snapshot on connect', async () => {
  captured.length = 0;
  const server = createServer();
  startFanout(server, { ingesters: makeFakeIngesters() });
  await new Promise((r) => server.listen(0, r));
  const url = 'ws://127.0.0.1:' + server.address().port;

  const A = new WebSocket(url), B = new WebSocket(url);
  const snapA = await next(A, (m) => m.type === 'snapshot');
  const snapB = await next(B, (m) => m.type === 'snapshot');
  assert.deepEqual(snapA.streams, [], 'A starts blank');
  assert.deepEqual(snapB.streams, [], 'B starts blank');

  // A connects a twitch channel; B connects a different one.
  A.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/foo' }));
  B.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/bar' }));
  await next(A, (m) => m.type === 'streams' && m.streams.some(s => s.channel === 'foo'));
  await next(B, (m) => m.type === 'streams' && m.streams.some(s => s.channel === 'bar'));

  // Emit on A's channel; only A must receive the chat message.
  const bGotForeign = next(B, (m) => m.type === 'message' && m.message.text === 'hello-foo');
  const aGot = next(A, (m) => m.type === 'message' && m.message.text === 'hello-foo');
  captured.find(i => i.channel === 'foo').emit('hello-foo');
  await aGot; // A receives it
  const race = await Promise.race([bGotForeign.then(() => 'leaked'),
    new Promise((r) => setTimeout(() => r('isolated'), 150))]);
  assert.equal(race, 'isolated', 'B must NOT receive A’s channel message');

  A.close(); B.close();
  await new Promise((r) => server.close(r));
});
