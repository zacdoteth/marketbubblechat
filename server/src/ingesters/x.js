// server/src/ingesters/x.js  (parser; ingester class added in Task 14)
export function parseSearchResponse(json) {
  const users = {};
  for (const u of (json?.includes?.users || [])) users[u.id] = u;
  return (json?.data || []).map(t => ({
    id: t.id,
    username: users[t.author_id]?.username || t.author_id,
    displayName: users[t.author_id]?.name || users[t.author_id]?.username || t.author_id,
    text: t.text,
    ts: Date.parse(t.created_at) || 0,
  }));
}

import { X_BEARER_TOKEN } from '../config.js';

export class XIngester {
  // channel = the X handle (without @). "viewers" is X's engagement total shown as live.
  constructor(channel, { onMessage, onViewers, onStatus }, { pollMs = 10_000 } = {}) {
    this.handle = String(channel).replace(/^@/, '');
    this.cb = { onMessage, onViewers, onStatus };
    this.pollMs = pollMs; this.sinceId = null; this.total = 0; this.timer = null; this.closed = false;
  }
  start() {
    if (!X_BEARER_TOKEN) { this.cb.onStatus('error'); return; }
    this.cb.onStatus('live');
    this._poll();
    this.timer = setInterval(() => this._poll(), this.pollMs);
  }
  async _poll() {
    try {
      const url = new URL('https://api.x.com/2/tweets/search/recent');
      url.searchParams.set('query', `(to:${this.handle}) -is:retweet`);
      url.searchParams.set('max_results', '100');
      url.searchParams.set('tweet.fields', 'created_at,author_id,conversation_id');
      url.searchParams.set('expansions', 'author_id');
      url.searchParams.set('user.fields', 'username,name');
      if (this.sinceId) url.searchParams.set('since_id', this.sinceId);
      // NOTE: bearer is used VERBATIM (contains literal %2B/%3D — do not decode).
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + X_BEARER_TOKEN } });
      if (r.status === 429) return;            // rate limited — skip this cycle
      if (!r.ok) { this.cb.onStatus('error'); return; }
      const json = await r.json();
      const msgs = parseSearchResponse(json).sort((a, b) => a.ts - b.ts);
      for (const m of msgs) this.cb.onMessage(m);
      const newest = json?.meta?.newest_id;
      if (newest) this.sinceId = newest;
      this.total += json?.meta?.result_count || 0;  // engagement total = "live" per spec
      this.cb.onViewers(this.total);
    } catch { /* non-fatal; try again next cycle */ }
  }
  stop() { this.closed = true; clearInterval(this.timer); }
}
