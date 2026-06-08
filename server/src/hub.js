// server/src/hub.js — owns app state and orchestrates ingesters.
import { createRegistry } from './streamRegistry.js';
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { createNativeRoom } from './nativeRoom.js';
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
  const room = createNativeRoom();
  const running = new Map(); // streamId -> ingester instance

  function emit(fields) {
    const msg = makeMessage(fields);
    agg.push(msg);
    if (msg.streamId) stats.recordMessage(msg.streamId, now());
    onMessage(msg);
  }
  function pushStreams() { onStreams(registry.list()); }

  return {
    registry, agg, stats,
    snapshot() { return { streams: registry.list(), messages: agg.recent(), stats: stats.snapshot(now()) }; },
    statsSnapshot() { return stats.snapshot(now()); },
    setSiteViewers(n) { stats.setSiteViewers(n); },

    connectStream(url, streamerLabel) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      const stream = registry.add({ ...parsed, streamerLabel, url });
      stats.registerStream(stream.id, { platform: parsed.platform, streamer: streamerLabel || '' });
      const Ing = INGESTERS[parsed.platform];
      const ing = new Ing(parsed.channel, {
        onMessage: (m) => emit({ ...m, streamId: stream.id, platform: parsed.platform, streamer: streamerLabel || '' }),
        onViewers: (n) => stats.setViewers(stream.id, n),
        onStatus: (s) => { registry.setStatus(stream.id, s); pushStreams(); },
      });
      running.set(stream.id, ing);
      ing.start();
      pushStreams();
      return { stream };
    },

    disconnectStream(id) {
      const ing = running.get(id);
      if (ing) { try { ing.stop(); } catch {} running.delete(id); }
      registry.remove(id);
      stats.removeStream(id);
      pushStreams();
    },

    postNative(connId, handle, text) {
      const v = room.validate(connId, text, now());
      if (!v.ok) return { error: v.reason };
      emit({ platform: 'mb', streamer: '', username: String(handle || 'anon').slice(0, 24), text: v.text, ts: now() });
      return { ok: true };
    },
    dropConn(connId) { room.drop(connId); },
  };
}
