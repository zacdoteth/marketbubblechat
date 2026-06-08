// Centralized env + platform constants. No secrets are hard-coded here;
// secrets come from process.env (loaded via --env-file=.env or the host).
export const PORT = Number(process.env.PORT) || 8787;
export const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';

// Public, well-known unauthenticated identifiers (not secrets):
export const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

// Kick official API app credentials (client_credentials flow, no user login):
export const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
export const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

export const PLATFORM_COLORS = {
  twitch: '#A571FF', x: '#F4F4F6', kick: '#53FC18',
};
