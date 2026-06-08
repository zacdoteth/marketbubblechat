// server/src/nativeRoom.js
export function createNativeRoom({ rateMs = 2000, maxLen = 280 } = {}) {
  const last = new Map(); // connId -> last post ts
  return {
    validate(connId, rawText, now) {
      const text = String(rawText || '').trim();
      if (!text) return { ok: false, reason: 'empty' };
      if (text.length > maxLen) return { ok: false, reason: 'too long' };
      const prev = last.has(connId) ? last.get(connId) : -Infinity;
      if (now - prev < rateMs) return { ok: false, reason: 'rate limited' };
      last.set(connId, now);
      return { ok: true, text };
    },
    drop(connId) { last.delete(connId); },
  };
}
