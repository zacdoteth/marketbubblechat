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
  let channel = (seg[0] || '').replace(/^@/, '').toLowerCase();
  if (!channel) return { error: 'no channel in url' };
  return { platform, channel };
}
