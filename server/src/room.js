// server/src/room.js — one isolated session: own streams, aggregator, stats.
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { makeMessage } from './normalize.js';
import { parseStreamUrl } from './urlParser.js';

let _id = 0; // process-global unique stream id counter

export function createRoom({ pool, send, now = () => Date.now() }) {
  const agg = createAggregator({ max: 100 });
  const stats = createStats();
  const streams = new Map();       // streamId -> { id, platform, channel, status, poolKey }
  const keyToStreamId = new Map(); // poolKey -> streamId (1:1 within a room)

  const pushStreams = () => send({ type: 'streams', streams: [...streams.values()] });

  const room = {
    streamIdFor(poolKey) { return keyToStreamId.get(poolKey); },
    snapshot() { return { streams: [...streams.values()], messages: agg.recent(), stats: stats.snapshot(now()) }; },
    statsSnapshot() { return stats.snapshot(now()); },
    pushStats() { send({ type: 'stats', stats: stats.snapshot(now()) }); },

    async connect(url) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      const source = parsed.source || parsed.platform; // pool key / ingester selection
      const key = source + ':' + parsed.channel;
      const existingId = keyToStreamId.get(key);
      if (existingId) return { stream: streams.get(existingId) };
      const id = 's' + (++_id);
      const stream = { id, platform: parsed.platform, source, channel: parsed.channel, status: 'connecting', poolKey: key };
      streams.set(id, stream);
      keyToStreamId.set(key, id);
      stats.registerStream(id, { platform: parsed.platform, streamer: '' });
      pushStreams();                 // instant pill (connecting)
      await pool.subscribe(source, parsed.channel, room, parsed.platform);
      return { stream };
    },

    disconnect(streamId) {
      const s = streams.get(streamId);
      if (!s) return;
      pool.unsubscribe(s.poolKey, room);
      streams.delete(streamId);
      keyToStreamId.delete(s.poolKey);
      stats.removeStream(streamId);
      pushStreams();
    },

    destroy() {
      for (const s of streams.values()) pool.unsubscribe(s.poolKey, room);
      streams.clear();
      keyToStreamId.clear();
    },

    // ---- pool fan-out callbacks (keyed by poolKey; translate to this room’s streamId) ----
    onMessage(fields) {
      const streamId = keyToStreamId.get(fields.poolKey);
      if (!streamId) return; // late event after unsubscribe
      const msg = makeMessage({ ...fields, streamId });
      agg.push(msg);
      if (streams.has(streamId)) stats.recordMessage(streamId, now());
      send({ type: 'message', message: msg });
    },
    onViewers(poolKey, n) {
      const streamId = keyToStreamId.get(poolKey);
      if (streamId) stats.setViewers(streamId, n);
    },
    onStatus(poolKey, status) {
      const streamId = keyToStreamId.get(poolKey);
      if (!streamId) return;
      const s = streams.get(streamId);
      if (s) s.status = status;
      pushStreams();
    },
    setLabel(poolKey, label) {
      const streamId = keyToStreamId.get(poolKey);
      if (!streamId) return;
      const s = streams.get(streamId);
      if (s) { s.label = label; pushStreams(); }
    },
  };
  return room;
}
