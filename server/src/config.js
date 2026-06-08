// Centralized env + platform constants. No secrets are hard-coded here;
// secrets come from process.env (loaded via --env-file=.env or the host).
export const PORT = Number(process.env.PORT) || 8787;
export const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';

// Public, well-known unauthenticated identifiers (not secrets):
export const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
export const KICK_WS_URL =
  `wss://ws-us2.pusher.com/app/${KICK_PUSHER_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

export const PLATFORM_COLORS = {
  twitch: '#A571FF', x: '#F4F4F6', kick: '#53FC18', mb: '#3FD0C0',
};

let _overrides = null;
export function kickOverride(channel) {
  if (_overrides === null) {
    try { _overrides = JSON.parse(process.env.KICK_CHATROOM_OVERRIDES || '{}'); }
    catch { _overrides = {}; }
  }
  return _overrides[String(channel || '').toLowerCase()] || null;
}
