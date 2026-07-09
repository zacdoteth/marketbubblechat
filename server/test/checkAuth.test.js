import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';

// CONTROL_TOKEN must be in env BEFORE config.js loads — hence the dynamic import.
process.env.CONTROL_TOKEN = 'testpw123';
const { startFanout } = await import('../src/fanout.js');

function fakeIngesters() {
  class Fake { constructor(channel, cb) { this.channel = channel; this.cb = cb; } async start() { this.cb.onStatus('live'); } async stop() {} }
  return { twitch: Fake, kick: Fake, x: Fake, xbroadcast: Fake };
}
const next = (ws, pred) => new Promise((res) => { ws.on('message', function h(b) { const m = JSON.parse(b.toString()); if (pred(m)) { ws.off('message', h); res(m); } }); });

test('checkAuth: server is the judge — right password authOk, wrong authBad, ops still gated', async () => {
  const server = createServer();
  startFanout(server, { ingesters: fakeIngesters() });
  await new Promise((r) => server.listen(0, r));
  const url = 'ws://127.0.0.1:' + server.address().port;

  const A = new WebSocket(url);
  await next(A, (m) => m.type === 'snapshot');

  // wrong password -> authBad (no error type; the door just stays shut)
  const badP = next(A, (m) => m.type === 'authOk' || m.type === 'authBad');
  A.send(JSON.stringify({ type: 'checkAuth', token: 'wrong' }));
  assert.equal((await badP).type, 'authBad');

  // missing token -> authBad
  const noneP = next(A, (m) => m.type === 'authOk' || m.type === 'authBad');
  A.send(JSON.stringify({ type: 'checkAuth' }));
  assert.equal((await noneP).type, 'authBad');

  // right password -> authOk
  const okP = next(A, (m) => m.type === 'authOk' || m.type === 'authBad');
  A.send(JSON.stringify({ type: 'checkAuth', token: 'testpw123' }));
  assert.equal((await okP).type, 'authOk');

  // authOk grants nothing by itself — operator actions still need the token per message
  const errP = next(A, (m) => m.type === 'error');
  A.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/foo', token: 'wrong' }));
  assert.equal((await errP).error, 'not authorized');

  A.close();
  await new Promise((r) => server.close(r));
});
