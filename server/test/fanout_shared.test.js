import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startFanout } from '../src/fanout.js';

const captured = [];
function fakeIngesters() {
  class Fake { constructor(channel, cb) { this.channel = channel; this.cb = cb; captured.push(this); } async start() { this.cb.onStatus('live'); this.cb.onViewers(5); } async stop() {} emit(text) { this.cb.onMessage({ username: 'u', text }); } }
  return { twitch: Fake, kick: Fake, x: Fake, xbroadcast: Fake };
}
const next = (ws, pred) => new Promise((res) => { ws.on('message', function h(b) { const m = JSON.parse(b.toString()); if (pred(m)) { ws.off('message', h); res(m); } }); });

test('fanout: all clients share ONE show; native chat broadcasts to everyone; operator gated', async () => {
  captured.length = 0;
  const server = createServer();
  startFanout(server, { ingesters: fakeIngesters() });
  await new Promise((r) => server.listen(0, r));
  const url = 'ws://127.0.0.1:' + server.address().port;

  const A = new WebSocket(url), B = new WebSocket(url);
  const snapA = await next(A, (m) => m.type === 'snapshot');
  await next(B, (m) => m.type === 'snapshot');
  assert.ok(snapA.guestId.startsWith('guest-'), 'A got a guest id');

  // A native-chats (no token) -> BOTH receive it as mb
  const bGot = next(B, (m) => m.type === 'message' && m.message.text === 'gm');
  A.send(JSON.stringify({ type: 'nativeChat', text: 'gm' }));
  const got = await bGot;
  assert.equal(got.message.platform, 'mb', 'native message is mb');

  // operator control without a token is rejected (CONTROL_TOKEN unset in tests)
  const errP = next(A, (m) => m.type === 'error');
  A.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/foo' }));
  const err = await errP;
  assert.equal(err.error, 'not authorized');

  A.close(); B.close();
  await new Promise((r) => server.close(r));
});
