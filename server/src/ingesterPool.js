// server/src/ingesterPool.js — global, ref-counted pool of real ingesters.
// One ingester per "platform:channel"; events fan out to subscribed rooms.
import { TwitchIngester } from './ingesters/twitch.js';
import { KickIngester } from './ingesters/kick.js';
import { XIngester } from './ingesters/x.js';
import { XBroadcastIngester } from './ingesters/xBroadcast.js';

// Keyed by `source` (not display platform): x.com/{handle} → 'x' (reply search),
// x.com/i/broadcasts/{id} → 'xbroadcast' (worker-fed). Display platform stays 'x' for both.
const DEFAULT_INGESTERS = { twitch: TwitchIngester, kick: KickIngester, x: XIngester, xbroadcast: XBroadcastIngester };

export function createIngesterPool({
  ingesters = DEFAULT_INGESTERS,
  lingerMs = 20_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map();          // poolKey -> entry
  const broadcasterToKey = new Map(); // broadcasterUserId(string) -> poolKey

  const keyOf = (source, channel) => source + ':' + channel;

  // `source` selects the ingester + forms the pool key; `platform` is the display platform
  // (equals source for twitch/kick/x; 'x' for source 'xbroadcast').
  async function subscribe(source, channel, room, platform = source) {
    const key = keyOf(source, channel);
    let entry = entries.get(key);
    if (entry) {
      if (entry.lingerTimer) { clearTimer(entry.lingerTimer); entry.lingerTimer = null; }
      entry.rooms.add(room);
      if (entry.lastStatus != null) room.onStatus(key, entry.lastStatus);
      if (entry.lastViewers != null) room.onViewers(key, entry.lastViewers);
      if (entry.label != null) room.setLabel?.(key, entry.label);
      return key;
    }
    entry = { source, platform, channel, ingester: null, rooms: new Set([room]),
      broadcasterUserId: null, lastStatus: null, lastViewers: null, label: null, lingerTimer: null };
    entries.set(key, entry);
    const Ing = ingesters[source];
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

  // --- X broadcast: fed by the external worker via POST /ingest/x. Routing key is the
  // broadcast id directly (it IS the channel), so no broadcaster map is needed. ---
  function routeXChat(broadcastId, fields) {
    const key = keyOf('xbroadcast', broadcastId);
    const entry = entries.get(key);
    if (!entry) return; // worker capturing a broadcast no room wants — drop
    for (const r of entry.rooms) r.onMessage({ ...fields, poolKey: key, platform: 'x' });
  }
  function setXViewers(broadcastId, n) {
    const key = keyOf('xbroadcast', broadcastId);
    const entry = entries.get(key);
    if (!entry) return;
    entry.lastViewers = n;
    for (const r of entry.rooms) r.onViewers(key, n);
  }
  function setXStatus(broadcastId, status) {
    const key = keyOf('xbroadcast', broadcastId);
    const entry = entries.get(key);
    if (!entry) return;
    entry.lastStatus = status;
    for (const r of entry.rooms) r.onStatus(key, status);
  }
  function setXLabel(broadcastId, label) {
    const key = keyOf('xbroadcast', broadcastId);
    const entry = entries.get(key);
    if (!entry) return;
    entry.label = label;
    for (const r of entry.rooms) r.setLabel?.(key, label);
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

  return { subscribe, unsubscribe, routeKickChat, routeXChat, setXViewers, setXStatus, setXLabel, stopAll, _entries: entries, _broadcasterToKey: broadcasterToKey };
}
