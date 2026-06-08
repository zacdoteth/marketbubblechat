// server/src/ingesters/kick.js
export function parseKickEvent(frame) {
  if (!frame || frame.event !== 'App\\Events\\ChatMessageEvent') return null;
  let d;
  try { d = JSON.parse(frame.data); } catch { return null; }
  const username = d?.sender?.username;
  const text = d?.content;
  if (!username || text == null) return null;
  return { username, text, ts: Date.parse(d?.created_at) || 0 };
}

import WebSocket from 'ws';
import { KICK_WS_URL } from '../config.js';
import { resolveKick } from './kickResolver.js';

export class KickIngester {
  constructor(channel, { onMessage, onViewers, onStatus }) {
    this.channel = String(channel).toLowerCase();
    this.cb = { onMessage, onViewers, onStatus };
    this.ws = null; this.viewersTimer = null; this.chatroomId = null; this.closed = false;
  }
  async start() {
    try {
      const info = await resolveKick(this.channel);
      this.chatroomId = info.chatroomId;
      if (!this.chatroomId) { this.cb.onStatus('error'); return; }
      if (info.viewers != null) this.cb.onViewers(info.viewers);
      this._connect();
      this.viewersTimer = setInterval(() => this._pollViewers(), 20_000);
    } catch (e) { this.cb.onStatus('error'); }
  }
  _connect() {
    try {
      const ws = new WebSocket(KICK_WS_URL);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` } }));
        this.cb.onStatus('live');
      });
      ws.on('message', (buf) => {
        let frame; try { frame = JSON.parse(buf.toString()); } catch { return; }
        if (frame.event === 'pusher:ping') { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); return; }
        const m = parseKickEvent(frame);
        if (m) this.cb.onMessage(m);
      });
      ws.on('error', () => this.cb.onStatus('error'));
      ws.on('close', () => { if (!this.closed) setTimeout(() => this._connect(), 2000); });
    } catch { this.cb.onStatus('error'); }
  }
  async _pollViewers() {
    try {
      const info = await resolveKick(this.channel);
      if (info.viewers != null) this.cb.onViewers(info.viewers);
      if (info.isLive === false) this.cb.onStatus('offline');
    } catch { /* non-fatal */ }
  }
  stop() {
    this.closed = true;
    clearInterval(this.viewersTimer);
    try { this.ws?.close(); } catch {}
  }
}
