// server/src/ingesters/kick.js
export function parseKickEvent(frame) {
  if (!frame || frame.event !== 'App\\Events\\ChatMessageEvent') return null;
  let d;
  try { d = JSON.parse(frame.data); } catch { return null; }
  const username = d?.sender?.username;
  const text = d?.content;
  if (!username || text == null) return null;
  return { username, text, ts: Date.parse(d?.created_at) || 0 };
}
