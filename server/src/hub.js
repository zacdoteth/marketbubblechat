// server/src/hub.js — owns app state and orchestrates ingesters.
import { createRegistry } from './streamRegistry.js';
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { makeMessage } from './normalize.js';
import { parseStreamUrl } from './urlParser.js';
import { TwitchIngester } from './ingesters/twitch.js';
import { KickIngester } from './ingesters/kick.js';
import { XIngester } from './ingesters/x.js';

const INGESTERS = { twitch: TwitchIngester, kick: KickIngester, x: XIngester };

export function createHub({ onMessage, onStats, onStreams, now = () => Date.now() }) {
  const registry = createRegistry();
  const agg = createAggregator({ max: 100 });
  const stats = createStats();
  const running = new Map(); // streamId -> ingester instance
  const kickByBroadcaster = new Map(); // broadcasterUserId(string) -> Set<streamId> (collabs/dupes share a bid)

  function emit(fields) {
    const msg = makeMessage(fields);
    agg.push(msg);
    // only record stats if the stream is still registered (a callback may fire after disconnect)
    if (msg.streamId && registry.get(msg.streamId)) stats.recordMessage(msg.streamId, now());
    onMessage(msg);
  }
  function pushStreams() { onStreams(registry.list()); }

  return {
    registry, agg, stats,
    snapshot() { return { streams: registry.list(), messages: agg.recent(), stats: stats.snapshot(now()) }; },
    statsSnapshot() { return stats.snapshot(now()); },

    async connectStream(url, streamerLabel) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      // de-dupe: same platform+channel already connected → return the existing stream (avoid zombie ingesters)
      const existing = registry.list().find(s => s.platform === parsed.platform && s.channel === parsed.channel);
      if (existing) return { stream: existing };
      const stream = registry.add({ ...parsed, streamerLabel, url });
      stats.registerStream(stream.id, { platform: parsed.platform, streamer: streamerLabel || '' });
      const Ing = INGESTERS[parsed.platform];
      const ing = new Ing(parsed.channel, {
        onMessage: (m) => emit({ ...m, streamId: stream.id, platform: parsed.platform, streamer: streamerLabel || '' }),
        onViewers: (n) => stats.setViewers(stream.id, n),
        onStatus: (s) => { registry.setStatus(stream.id, s); pushStreams(); },
        onResolved: (bid) => {
          const key = String(bid);
          if (!kickByBroadcaster.has(key)) kickByBroadcaster.set(key, new Set());
          kickByBroadcaster.get(key).add(stream.id);
        },
      });
      running.set(stream.id, ing);
      // await start so the broadcaster→stream mapping is populated before we return
      // (prevents the first Kick webhook from being dropped as "unknown broadcaster").
      try { await ing.start(); } catch {}
      pushStreams();
      return { stream };
    },

    async disconnectStream(id) {
      const ing = running.get(id);
      if (ing) { try { await ing.stop(); } catch {} running.delete(id); }
      registry.remove(id);
      stats.removeStream(id);
      for (const [bid, ids] of kickByBroadcaster) {
        ids.delete(id);
        if (!ids.size) kickByBroadcaster.delete(bid);
      }
      pushStreams();
    },

    handleKickChat(broadcasterUserId, fields) {
      const streamIds = kickByBroadcaster.get(String(broadcasterUserId));
      if (!streamIds || !streamIds.size) return;
      for (const streamId of streamIds) {
        const s = registry.get(streamId);
        if (!s) continue; // stream was removed between lookup and emit — don't emit a dead streamId
        emit({ ...fields, streamId, platform: 'kick', streamer: s.streamerLabel || '' });
      }
    },
  };
}
