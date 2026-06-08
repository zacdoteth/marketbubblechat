// server/src/stats.js
const WINDOW_MS = 60_000;

export function createStats() {
  const streams = new Map(); // id -> { platform, streamer, viewers, msgTimes[] }

  return {
    registerStream(id, meta = {}) {
      if (!streams.has(id))
        streams.set(id, { platform: meta.platform, streamer: meta.streamer || '', viewers: 0, msgTimes: [] });
    },
    removeStream(id) { streams.delete(id); },
    setViewers(id, n) { const s = streams.get(id); if (s) { const v = Number(n); s.viewers = (Number.isFinite(v) && v >= 0) ? Math.floor(v) : 0; } },
    recordMessage(id, now) { const s = streams.get(id); if (s) s.msgTimes.push(now); },
    snapshot(now) {
      const perStream = {}, perPlatform = {}, perStreamer = {};
      let combinedViewers = 0, combinedRate = 0;
      for (const [id, s] of streams) {
        s.msgTimes = s.msgTimes.filter(t => now - t < WINDOW_MS);
        const rate = s.msgTimes.length;
        perStream[id] = { viewers: s.viewers, msgsPerMin: rate, platform: s.platform, streamer: s.streamer };
        combinedViewers += s.viewers;
        combinedRate += rate;
        (perPlatform[s.platform] ||= { viewers: 0, msgsPerMin: 0 });
        perPlatform[s.platform].viewers += s.viewers;
        perPlatform[s.platform].msgsPerMin += rate;
        (perStreamer[s.streamer] ||= { viewers: 0, msgsPerMin: 0 });
        perStreamer[s.streamer].viewers += s.viewers;
        perStreamer[s.streamer].msgsPerMin += rate;
      }
      return {
        combined: { viewers: combinedViewers, msgsPerMin: combinedRate },
        perStream, perPlatform, perStreamer,
      };
    },
  };
}
