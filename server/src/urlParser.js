// server/src/urlParser.js
const HOSTS = {
  'twitch.tv': 'twitch',
  'kick.com': 'kick',
  'x.com': 'x',
  'twitter.com': 'x',
};

export function parseStreamUrl(input) {
  let s = String(input || '').trim();
  if (!s) return { error: 'empty input' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { error: 'invalid url' }; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const platform = HOSTS[host];
  if (!platform) return { error: 'unsupported platform: ' + host };
  const seg = u.pathname.split('/').filter(Boolean);
  // X Live Broadcast: x.com/i/broadcasts/{id}. The id is CASE-SENSITIVE (don't lowercase),
  // and it routes through a distinct ingester `source` ('xbroadcast', captured by the worker),
  // while the display platform stays 'x'.
  if (platform === 'x' && seg[0] === 'i' && seg[1] === 'broadcasts' && seg[2]) {
    return { platform: 'x', source: 'xbroadcast', channel: seg[2] };
  }
  let channel = (seg[0] || '').replace(/^@/, '').toLowerCase();
  if (!channel) return { error: 'no channel in url' };
  // `source` selects the ingester + forms the pool key; for normal streams it equals platform.
  return { platform, source: platform, channel };
}
