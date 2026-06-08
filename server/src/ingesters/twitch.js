// server/src/ingesters/twitch.js
export function parsePrivmsg(line) {
  const m = line.match(/^(?:@(\S+) )?:(\w+)!\w+@[\w.]+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return null;
  const tags = {};
  if (m[1]) for (const kv of m[1].split(';')) {
    const i = kv.indexOf('=');
    tags[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const username = m[2];
  const display = (tags['display-name'] || '').replace(/\\s/g, ' ').trim() || username;
  return { username, displayName: display, color: tags.color || '', text: m[3] };
}
