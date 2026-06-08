// server/src/fanout.js — one WS server; snapshot on connect, broadcast events.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';

export function startFanout(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(s); };

  const hub = createHub({
    onMessage: (message) => broadcast({ type: 'message', message }),
    onStats: () => {},
    onStreams: (streams) => broadcast({ type: 'streams', streams }),
  });

  wss.on('connection', (ws) => {
    send(ws, { type: 'snapshot', ...hub.snapshot() });
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      try {
        if (msg.type === 'connectStream') {
          const r = hub.connectStream(msg.url, msg.streamerLabel);
          if (r.error) send(ws, { type: 'error', error: r.error });
        } else if (msg.type === 'disconnectStream') {
          hub.disconnectStream(msg.id);
        }
      } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
    });
  });

  // periodic stats push
  setInterval(() => broadcast({ type: 'stats', stats: hub.statsSnapshot() }), 1500);
  return { wss, hub };
}
