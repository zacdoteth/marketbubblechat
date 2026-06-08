// server/src/ingesters/kickResolver.js
import { kickOverride } from '../config.js';

const BROWSERY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function resolveKick(channel, { fetchImpl = fetch, overrideFn = kickOverride } = {}) {
  const slug = String(channel || '').toLowerCase();
  const ov = overrideFn(slug);
  if (ov) return { chatroomId: ov, viewers: null, isLive: null, source: 'override' };

  const res = await fetchImpl(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
    { headers: BROWSERY_HEADERS });
  if (!res.ok) throw new Error(`kick lookup failed ${res.status} (Cloudflare?) — set KICK_CHATROOM_OVERRIDES`);
  const j = await res.json();
  return {
    chatroomId: j?.chatroom?.id,
    viewers: j?.livestream?.viewer_count ?? null,
    isLive: !!j?.livestream,
    source: 'api',
  };
}
