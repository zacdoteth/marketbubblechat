// worker/xBroadcastParse.js
// VENDORED copy of server/src/ingesters/xBroadcastParse.js (the canonical, unit-tested source).
// Vendored so the worker builds as a self-contained Docker image (build context = worker/).
// KEEP IN SYNC with the server copy if the X frame format ever changes.
//
// Pure decoder for X Live-Broadcast (Periscope "chatman") WS frames — triple-nested JSON,
// discriminated by the OUTER `kind`:
//   chat    = outer kind 1: payload → {room, body}; body → {body:text, username, displayName, timestamp, uuid, type}
//   viewers = outer kind 2: payload → {kind:4, sender, body}; body → {room, occupancy, total_participants}
// Returns {type:'chat', msg:{username,displayName,text,ts,uuid}} | {type:'viewers', occupancy} | null. Never throws.
export function parseXFrame(raw) {
  let outer;
  try { outer = JSON.parse(typeof raw === 'string' ? raw : String(raw ?? '')); }
  catch { return null; }
  if (!outer || typeof outer !== 'object' || typeof outer.payload !== 'string') return null;

  let l1;
  try { l1 = JSON.parse(outer.payload); } catch { return null; }
  if (!l1 || typeof l1.body !== 'string') return null;

  let l2;
  try { l2 = JSON.parse(l1.body); } catch { return null; }
  if (!l2 || typeof l2 !== 'object') return null;

  if (outer.kind === 1) {
    if (typeof l2.body !== 'string') return null;
    const username = l2.username || l2.displayName || 'anon';
    return { type: 'chat', msg: {
      username,
      displayName: l2.displayName || username,
      text: l2.body,
      ts: Number(l2.timestamp) || 0,
      uuid: l2.uuid || '',
    } };
  }
  if (outer.kind === 2) {
    if (typeof l2.occupancy === 'number') return { type: 'viewers', occupancy: l2.occupancy };
    return null;
  }
  return null;
}
