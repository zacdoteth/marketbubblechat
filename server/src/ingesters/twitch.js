// server/src/ingesters/twitch.js
export function parsePrivmsg(line) {
  const m = line.match(/^(?:@(\S+) )?:(\w+)!\w+@[\w.]+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return null;
  const tags = {};
  if (m[1]) for (const kv of m[1].split(';')) {
    const i = kv.indexOf('=');
    tags[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const username = m[2];
  const display = (tags['display-name'] || '').replace(/\\s/g, ' ').trim() || username;
  return { username, displayName: display, color: tags.color || '', text: m[3] };
}

import WebSocket from 'ws';
import { TWITCH_IRC_URL, TWITCH_GQL_CLIENT_ID } from '../config.js';

export class TwitchIngester {
  constructor(channel, { onMessage, onViewers, onStatus }) {
    this.channel = String(channel).toLowerCase();
    this.cb = { onMessage, onViewers, onStatus };
    this.ws = null; this.viewersTimer = null; this.closed = false;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;        // start at 1s
    this.maxReconnectDelay = 60_000;   // cap at 60s
    this.controller = new AbortController();
  }
  start() {
    this._connect();
    this._pollViewers();
    this.viewersTimer = setInterval(() => this._pollViewers(), 20_000);
  }
  _connect() {
    try {
      const ws = new WebSocket(TWITCH_IRC_URL);
      this.ws = ws;
      ws.on('open', () => {
        try {
          this.reconnectDelay = 1000; // reset backoff on a successful connect
          ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
          ws.send('PASS SCHMOOPIIE');
          ws.send('NICK justinfan' + Math.floor(Math.random() * 1e5));
          ws.send('JOIN #' + this.channel);
          this.cb.onStatus('live');
        } catch { this.cb.onStatus('error'); try { ws.close(); } catch {} }
      });
      ws.on('message', (buf) => {
        try {
          for (const line of buf.toString().split('\r\n')) {
            if (!line) continue;
            if (line === 'RECONNECT') { try { ws.close(); } catch {} continue; } // Twitch asked us to reconnect
            if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
            const m = parsePrivmsg(line);
            if (m) this.cb.onMessage(m);
          }
        } catch { /* a single malformed frame must not kill the connection */ }
      });
      ws.on('error', () => this.cb.onStatus('error'));
      ws.on('close', () => {
        if (this.closed) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.reconnectTimer = setTimeout(() => this._connect(), delay);
      });
    } catch { this.cb.onStatus('error'); }
  }
  async _pollViewers() {
    try {
      const r = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': TWITCH_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          operationName: 'M', variables: { l: this.channel },
          query: 'query M($l:String!){ user(login:$l){ stream { viewersCount } } }',
        }]),
        signal: this.controller.signal,
      });
      if (this.closed) return;
      if (!r.ok) {
        if (r.status === 401) { console.error(`[twitch] GQL auth failed for #${this.channel} (401) — check TWITCH_GQL_CLIENT_ID`); this.cb.onStatus('error'); }
        else console.warn(`[twitch] GQL HTTP ${r.status} for #${this.channel}, retrying`);
        return;
      }
      const j = await r.json();
      if (this.closed) return;
      const s = j?.[0]?.data?.user?.stream;
      this.cb.onViewers(s ? s.viewersCount : 0);
      this.cb.onStatus(s ? 'live' : 'offline');
    } catch (e) { if (e?.name !== 'AbortError') { /* keep last known; non-fatal */ } }
  }
  stop() {
    this.closed = true;
    clearInterval(this.viewersTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.controller.abort(); } catch {}
    try { this.ws?.close(); } catch {}
  }
}
