import { resolveKickChannel } from './kickApi.js';
import { subscribeChat, unsubscribe } from './kickWebhook.js';
// Official Kick ingester: viewer counts via /public/v1/channels (polled),
// chat via the chat.message.sent webhook (delivered centrally, routed by broadcaster_user_id).
export class KickIngester {
  constructor(channel, { onViewers, onStatus, onResolved }) {
    this.slug = String(channel).toLowerCase();
    this.cb = { onViewers, onStatus, onResolved };
    this.timer = null; this.subIds = null; this.broadcasterUserId = null; this.closed = false;
  }
  async start() {
    try {
      const info = await resolveKickChannel(this.slug);
      if (!info?.broadcasterUserId) { this.cb.onStatus('error'); return; }
      this.broadcasterUserId = info.broadcasterUserId;
      this.cb.onResolved?.(info.broadcasterUserId);
      this.cb.onViewers(info.viewerCount || 0);
      this.cb.onStatus(info.isLive ? 'live' : 'offline');
      try { this.subIds = await subscribeChat(info.broadcasterUserId); } catch (e) { /* chat sub may fail; viewers still work */ }
      this.timer = setInterval(() => this._poll(), 20_000);
    } catch (e) { this.cb.onStatus('error'); }
  }
  async _poll() {
    try { const info = await resolveKickChannel(this.slug); if (info) { this.cb.onViewers(info.viewerCount || 0); this.cb.onStatus(info.isLive ? 'live' : 'offline'); } } catch {}
  }
  async stop() { this.closed = true; clearInterval(this.timer); if (this.subIds) { try { await unsubscribe(this.subIds); } catch {} } }
}
