import { getKickToken, _resetKickToken } from './kickAuth.js';
const API = 'https://api.kick.com/public/v1';
// pure mapper — unit-tested
export function mapChannel(c) {
  if (!c) return null;
  const live = !!c.stream?.is_live;
  return { broadcasterUserId: c.broadcaster_user_id, isLive: live, viewerCount: live ? (c.stream?.viewer_count || 0) : 0, slug: c.slug };
}
export async function resolveKickChannel(slug, fetchImpl = fetch) {
  const headers = (t) => ({ Authorization: 'Bearer ' + t, Accept: 'application/json', 'User-Agent': 'marketbubblechat/1.0' });
  let token = await getKickToken();
  let r = await fetchImpl(`${API}/channels?slug=${encodeURIComponent(slug)}`, { headers: headers(token) });
  if (r.status === 401) { _resetKickToken(); token = await getKickToken(true); r = await fetchImpl(`${API}/channels?slug=${encodeURIComponent(slug)}`, { headers: headers(token) }); }
  // Rate-limited / permission-denied: degrade gracefully (keep last-known) instead of throwing.
  if (r.status === 429 || r.status === 403) { console.warn(`[kick] ${r.status} (rate-limited or denied) resolving ${slug}`); return null; }
  if (!r.ok) throw new Error('kick channels ' + r.status);
  const j = await r.json();
  return mapChannel((j.data || [])[0]);
}
