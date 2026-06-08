// Centralized env + platform constants. No secrets are hard-coded here;
// secrets come from process.env (loaded via --env-file=.env or the host).
export const PORT = Number(process.env.PORT) || 8787;
export const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
// Optional control-channel gate. If set, only clients that send this token may
// connect/disconnect streams (the creator opens the dashboard with ?key=<token>).
// If unset (default), the control channel is open — fine for a local/demo run.
export const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';

// Public, well-known unauthenticated identifiers (not secrets):
export const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

// Kick official API app credentials (client_credentials flow, no user login):
export const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
export const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
if (PUBLIC_BASE_URL.includes('localhost') && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: PUBLIC_BASE_URL is localhost in production. Set PUBLIC_BASE_URL to your public app URL (e.g. https://my-app.up.railway.app) so Kick can deliver chat webhooks.');
}

export const PLATFORM_COLORS = {
  twitch: '#A571FF', x: '#F4F4F6', kick: '#53FC18',
};
