// server/src/streamRegistry.js
let _id = 0;

export function createRegistry() {
  const map = new Map();
  return {
    add({ platform, channel, streamerLabel = '', url = '' }) {
      const id = 's' + (++_id);
      const stream = { id, platform, channel, streamerLabel, url, status: 'connecting' };
      map.set(id, stream);
      return stream;
    },
    remove(id) { return map.delete(id); },
    get(id) { return map.get(id); },
    setStatus(id, status) { const s = map.get(id); if (s) s.status = status; return s; },
    list() { return [...map.values()]; },
  };
}
