// server/src/ingesterPool.js — global, ref-counted pool of real ingesters.
// One ingester per "platform:channel"; events fan out to subscribed rooms.
import { TwitchIngester } from './ingesters/twitch.js';
import { KickIngester } from './ingesters/kick.js';
import { XIngester } from './ingesters/x.js';

const DEFAULT_INGESTERS = { twitch: TwitchIngester, kick: KickIngester, x: XIngester };

export function createIngesterPool({
  ingesters = DEFAULT_INGESTERS,
  lingerMs = 20_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map();          // poolKey -> entry
  const broadcasterToKey = new Map(); // broadcasterUserId(string) -> poolKey

  const keyOf = (platform, channel) => platform + ':' + channel;

  async function subscribe(platform, channel, room) {
    const key = keyOf(platform, channel);
    let entry = entries.get(key);
    if (entry) {
      if (entry.lingerTimer) { clearTimer(entry.lingerTimer); entry.lingerTimer = null; }
      entry.rooms.add(room);
      if (entry.lastStatus != null) room.onStatus(key, entry.lastStatus);
      if (entry.lastViewers != null) room.onViewers(key, entry.lastViewers);
      return key;
    }
    entry = { platform, channel, ingester: null, rooms: new Set([room]),
      broadcasterUserId: null, lastStatus: null, lastViewers: null, lingerTimer: null };
    entries.set(key, entry);
    const Ing = ingesters[platform];
    const ing = new Ing(channel, {
      onMessage: (m) => { for (const r of entry.rooms) r.onMessage({ ...m, poolKey: key, platform }); },
      onViewers: (n) => { entry.lastViewers = n; for (const r of entry.rooms) r.onViewers(key, n); },
      onStatus: (s) => { entry.lastStatus = s; for (const r of entry.rooms) r.onStatus(key, s); },
      onResolved: (bid) => { entry.broadcasterUserId = String(bid); broadcasterToKey.set(String(bid), key); },
    });
    entry.ingester = ing;
    try { await ing.start(); } catch {}
    return key;
  }

  function unsubscribe(key, room) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.rooms.delete(room);
    if (entry.rooms.size === 0 && !entry.lingerTimer) {
      entry.lingerTimer = setTimer(() => { _stopEntry(key); }, lingerMs);
      entry.lingerTimer?.unref?.();
    }
  }

  async function _stopEntry(key) {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.rooms.size > 0) { entry.lingerTimer = null; return; } // someone rejoined during linger
    entries.delete(key);
    if (entry.broadcasterUserId) broadcasterToKey.delete(entry.broadcasterUserId);
    try { await entry.ingester?.stop(); } catch {}
  }

  function routeKickChat(broadcasterUserId, fields) {
    const key = broadcasterToKey.get(String(broadcasterUserId));
    if (!key) { console.warn('[kick] webhook chat dropped: unknown broadcaster', broadcasterUserId); return; }
    const entry = entries.get(key);
    if (!entry) return;
    for (const r of entry.rooms) r.onMessage({ ...fields, poolKey: key, platform: 'kick' });
  }

  async function stopAll() {
    for (const key of [...entries.keys()]) {
      const entry = entries.get(key);
      if (!entry) continue;
      if (entry.lingerTimer) clearTimer(entry.lingerTimer);
      entry.rooms.clear();
      entries.delete(key);
      if (entry.broadcasterUserId) broadcasterToKey.delete(entry.broadcasterUserId);
      try { await entry.ingester?.stop(); } catch {}
    }
  }

  return { subscribe, unsubscribe, routeKickChat, stopAll, _entries: entries, _broadcasterToKey: broadcasterToKey };
}
