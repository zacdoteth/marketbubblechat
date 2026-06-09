// server/src/fanout.js — one WS server; each connection is its own isolated Room.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';
import { createRoom } from './room.js';
import { CONTROL_TOKEN } from './config.js';

// Control gate: with CONTROL_TOKEN set, only clients presenting it may add/remove
// streams (guards paid-API cost abuse). Unset → open (demo). Isolation is per-room
// regardless: a client can only ever affect its own room.
const mayControl = (msg) => !CONTROL_TOKEN || msg.token === CONTROL_TOKEN;

export function startFanout(httpServer, hubOptions = {}) {
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createHub(hubOptions);
  const rooms = new Set();

  const send = (ws, obj) => {
    try {
      // skip a backed-up client so one stuck reader can't OOM us
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(obj));
    } catch {}
  };

  wss.on('connection', (ws) => {
    ws.on('error', () => {}); // malformed frames must not crash the process
    const room = createRoom({ pool: hub.pool, send: (obj) => send(ws, obj) });
    rooms.add(room);
    send(ws, { type: 'snapshot', ...room.snapshot() }); // empty -> blank dashboard

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      (async () => {
        try {
          if (msg.type === 'connectStream' || msg.type === 'disconnectStream') {
            if (!mayControl(msg)) { send(ws, { type: 'error', error: 'not authorized to control streams' }); return; }
          }
          if (msg.type === 'connectStream') {
            const r = await room.connect(msg.url);
            if (r.error) send(ws, { type: 'error', error: r.error });
          } else if (msg.type === 'disconnectStream') {
            room.disconnect(msg.id);
          }
        } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
      })();
    });

    ws.on('close', () => { try { room.destroy(); } catch {} rooms.delete(room); });
  });

  // periodic per-room stats push. unref so it never keeps the process (or a test) alive
  // on its own — the listening socket is what keeps a real server running.
  const statsTick = setInterval(() => { for (const room of rooms) { try { room.pushStats(); } catch {} } }, 1500);
  statsTick.unref?.();
  return { wss, hub };
}
