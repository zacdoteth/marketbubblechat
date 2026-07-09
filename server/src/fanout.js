// server/src/fanout.js — one WS server attaching every connection to the ONE shared show.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';
import { createShowRoom } from './showRoom.js';
import { createShowStore } from './showStore.js';
import { CONTROL_TOKEN, SHOW_CONFIG_PATH } from './config.js';

// Operator gate: control actions REQUIRE the token. Unset → nobody can control (read-only show).
const mayControl = (msg) => !!CONTROL_TOKEN && msg.token === CONTROL_TOKEN;
const OPERATOR_TYPES = new Set(['connectStream', 'disconnectStream', 'selectFeatured', 'clearChat', 'slowMode']);

export function startFanout(httpServer, hubOptions = {}) {
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createHub(hubOptions);
  const store = createShowStore(SHOW_CONFIG_PATH);
  const showRoom = createShowRoom({ pool: hub.pool, store });

  const send = (ws, obj) => {
    try { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(obj)); } catch {}
  };

  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    const client = showRoom.attach((obj) => send(ws, obj));

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      (async () => {
        try {
          if (OPERATOR_TYPES.has(msg.type) && !mayControl(msg)) {
            send(ws, { type: 'error', error: 'not authorized' }); return;
          }
          switch (msg.type) {
            // The admin door: verifies a password attempt WITHOUT performing any action.
            case 'checkAuth': send(ws, { type: mayControl(msg) ? 'authOk' : 'authBad' }); break;
            case 'nativeChat': { const r = showRoom.nativeChat(client, msg.text); if (r && r.error) send(ws, { type: 'error', error: r.error }); break; }
            case 'connectStream': { const r = await showRoom.connect(msg.url); if (r && r.error) send(ws, { type: 'error', error: r.error }); break; }
            case 'disconnectStream': showRoom.disconnect(msg.id); break;
            case 'selectFeatured': { const r = showRoom.selectFeatured(msg.id); if (r && r.error) send(ws, { type: 'error', error: r.error }); break; }
            case 'clearChat': showRoom.clearChat(); break;
            case 'slowMode': showRoom.setSlowMode(msg.seconds); break;
          }
        } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
      })();
    });

    ws.on('close', () => { try { showRoom.detach(client); } catch {} });
  });

  const statsTick = setInterval(() => { try { showRoom.pushStats(); } catch {} }, 1500);
  statsTick.unref?.();
  return { wss, hub, showRoom };
}
