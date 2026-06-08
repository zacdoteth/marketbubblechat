// server/src/normalize.js
import { PLATFORM_COLORS } from './config.js';

let _seq = 0; // local monotonic id counter (NOT the canonical seq; aggregator sets seq)

export function makeMessage({ streamId = null, platform, streamer = '',
  username, displayName, color, text, ts = 0 }) {
  const name = username || displayName || 'anon';
  return {
    id: 'm' + (++_seq),
    seq: 0,
    streamId: streamId ?? null,
    platform,
    streamer: streamer || '',          // coerce null → '' (default only catches undefined)
    username: name,
    displayName: displayName || name,
    color: color || PLATFORM_COLORS[platform] || '#ECE7DD',
    text: String(text ?? ''),
    ts: ts ?? 0,                        // coerce null → 0 (guards downstream Date math)
  };
}
