// server/src/fanout.js — one WS server; snapshot on connect, broadcast events.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';
import { CONTROL_TOKEN } from './config.js';

// Control-channel gate: when CONTROL_TOKEN is configured, only clients that present
// the matching token may add/remove streams. Unset → open (demo).
const mayControl = (msg) => !CONTROL_TOKEN || msg.token === CONTROL_TOKEN;

export function startFanout(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  const send = (ws, obj) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch {} };
  const broadcast = (obj) => {
    let s;
    try { s = JSON.stringify(obj); } catch { return; }
    for (const c of wss.clients) {
      // skip slow clients whose send buffer is backing up, so one stuck reader can't OOM us
      if (c.readyState === c.OPEN && c.bufferedAmount < 1024 * 1024) {
        try { c.send(s); } catch {}
      }
    }
  };

  const hub = createHub({
    onMessage: (message) => broadcast({ type: 'message', message }),
    onStats: () => {},
    onStreams: (streams) => broadcast({ type: 'streams', streams }),
  });

  wss.on('connection', (ws) => {
    ws.on('error', () => {}); // malformed frames must not crash the process
    send(ws, { type: 'snapshot', ...hub.snapshot() });
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      // hub.connectStream/disconnectStream are async; run them without blocking the socket
      // but still await internally so errors are caught and not left as unhandled rejections.
      (async () => {
        try {
          if (msg.type === 'connectStream' || msg.type === 'disconnectStream') {
            if (!mayControl(msg)) { send(ws, { type: 'error', error: 'not authorized to control streams' }); return; }
          }
          if (msg.type === 'connectStream') {
            const r = await hub.connectStream(msg.url, msg.streamerLabel);
            if (r.error) send(ws, { type: 'error', error: r.error });
          } else if (msg.type === 'disconnectStream') {
            await hub.disconnectStream(msg.id);
          }
        } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
      })();
    });
  });

  // periodic stats push
  setInterval(() => { try { broadcast({ type: 'stats', stats: hub.statsSnapshot() }); } catch {} }, 1500);
  return { wss, hub };
}
