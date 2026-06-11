// server/src/showRoom.js — the ONE shared public show. Holds the canonical state
// (streams, featured pick, merged chat incl. native, stats) and broadcasts every event
// to ALL connected clients. Implements the ingester-pool room interface (onMessage/...),
// but fans out to every client instead of one socket.
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { makeMessage } from './normalize.js';
import { parseStreamUrl } from './urlParser.js';
import { NATIVE_SLOWMODE_MS } from './config.js';

const MB_STREAM = 'mb-native'; // synthetic stats stream for native chat

export function createShowRoom({ pool, now = () => Date.now(), slowModeMs = NATIVE_SLOWMODE_MS, store = null } = {}) {
  const agg = createAggregator({ max: 100 });
  const stats = createStats();
  const streams = new Map();        // streamId -> { id, platform, source, channel, status, url, poolKey, label? }
  const keyToStreamId = new Map();  // poolKey -> streamId
  const clients = new Set();        // { send, guestId, lastNativeTs }
  let featuredId = null;
  let _sid = 0, _gid = 0;
  let _slowMs = slowModeMs;

  stats.registerStream(MB_STREAM, { platform: 'mb', streamer: '' }); // native chat metrics

  const room = {
    // ---- broadcast helpers ----
    broadcast(obj) { for (const c of clients) { try { c.send(obj); } catch {} } },
    pushStreams() { room.broadcast({ type: 'streams', streams: [...streams.values()] }); },
    statsSnapshot() { return stats.snapshot(now()); },
    pushStats() { room.broadcast({ type: 'stats', stats: stats.snapshot(now()) }); },
    snapshotFor(client) {
      return { type: 'snapshot', streams: [...streams.values()], featuredId,
        messages: agg.recent(), stats: stats.snapshot(now()), guestId: client.guestId };
    },

    // ---- client lifecycle ----
    attach(send) {
      const client = { send, guestId: 'guest-' + (++_gid).toString(36), lastNativeTs: -Infinity }; // -Inf so the FIRST message is never rate-limited regardless of clock magnitude
      clients.add(client);
      stats.setViewers(MB_STREAM, clients.size);
      try { send(room.snapshotFor(client)); } catch {}
      return client;
    },
    detach(client) { clients.delete(client); stats.setViewers(MB_STREAM, clients.size); },

    // ---- operator: streams + featured (fanout gates by token) ----
    async connect(url) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      const source = parsed.source || parsed.platform;
      const key = source + ':' + parsed.channel;
      const existingId = keyToStreamId.get(key);
      if (existingId) return { stream: streams.get(existingId) };
      const id = 's' + (++_sid);
      const stream = { id, platform: parsed.platform, source, channel: parsed.channel, status: 'connecting', url, poolKey: key };
      streams.set(id, stream); keyToStreamId.set(key, id);
      stats.registerStream(id, { platform: parsed.platform, streamer: '' });
      if (!featuredId) { featuredId = id; room.broadcast({ type: 'featured', id }); }
      room.pushStreams();
      await pool.subscribe(source, parsed.channel, room, parsed.platform);
      room._persist();
      return { stream };
    },
    disconnect(id) {
      const s = streams.get(id);
      if (!s) return;
      pool.unsubscribe(s.poolKey, room);
      streams.delete(id); keyToStreamId.delete(s.poolKey); stats.removeStream(id);
      if (featuredId === id) { featuredId = streams.keys().next().value || null; room.broadcast({ type: 'featured', id: featuredId }); }
      room.pushStreams(); room._persist();
    },
    selectFeatured(id) {
      if (!streams.has(id)) return { error: 'no such stream' };
      featuredId = id; room.broadcast({ type: 'featured', id }); room._persist();
      return { ok: true };
    },

    // ---- viewer: native chat (rate-limited) ----
    nativeChat(client, text) {
      let t = String(text == null ? '' : text).trim();
      if (!t) return;
      if (t.length > 240) t = t.slice(0, 240);
      const ts = now();
      if (ts - client.lastNativeTs < _slowMs) return { error: 'slow down' };
      client.lastNativeTs = ts;
      const msg = makeMessage({ platform: 'mb', streamId: MB_STREAM, username: client.guestId, text: t, ts });
      agg.push(msg); stats.recordMessage(MB_STREAM, ts);
      room.broadcast({ type: 'message', message: msg });
      return { ok: true };
    },

    // ---- moderation ----
    clearChat() { agg.clear(); room.broadcast({ type: 'clear' }); },
    setSlowMode(seconds) { _slowMs = Math.max(0, Number(seconds) || 0) * 1000; room.broadcast({ type: 'slowMode', seconds: _slowMs / 1000 }); },

    // ---- persistence ----
    _persist() {
      if (!store) return;
      const featuredKey = featuredId && streams.get(featuredId) ? streams.get(featuredId).poolKey : null;
      store.save({ streams: [...streams.values()].map(s => s.url), featuredKey });
    },
    async restore() {
      if (!store) return;
      const cfg = await store.load();
      for (const url of cfg.streams || []) { try { await room.connect(url); } catch {} }
      if (cfg.featuredKey) { const id = keyToStreamId.get(cfg.featuredKey); if (id) { featuredId = id; room.broadcast({ type: 'featured', id }); } }
    },

    // ---- ingester-pool room interface (fan out to all clients) ----
    streamIdFor(poolKey) { return keyToStreamId.get(poolKey); },
    onMessage(fields) {
      const streamId = keyToStreamId.get(fields.poolKey);
      if (!streamId) return;
      const msg = makeMessage({ ...fields, streamId });
      agg.push(msg);
      if (streams.has(streamId)) stats.recordMessage(streamId, now());
      room.broadcast({ type: 'message', message: msg });
    },
    onViewers(poolKey, n) { const id = keyToStreamId.get(poolKey); if (id) stats.setViewers(id, n); },
    onStatus(poolKey, status) { const id = keyToStreamId.get(poolKey); if (!id) return; const s = streams.get(id); if (s) s.status = status; room.pushStreams(); },
    setLabel(poolKey, label) { const id = keyToStreamId.get(poolKey); if (!id) return; const s = streams.get(id); if (s) { s.label = label; room.pushStreams(); } },

    get _clientCount() { return clients.size; },
  };
  return room;
}
