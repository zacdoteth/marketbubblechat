import { KICK_CLIENT_ID, KICK_CLIENT_SECRET } from '../config.js';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
let _token = null, _exp = 0;
export async function getKickToken(force = false) {
  if (!force && _token && Date.now() < _exp - 60_000) return _token;
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) throw new Error('KICK creds missing');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: KICK_CLIENT_ID, client_secret: KICK_CLIENT_SECRET });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('kick token ' + r.status);
  const j = await r.json();
  _token = j.access_token; _exp = Date.now() + (j.expires_in || 3600) * 1000;
  return _token;
}
export function _resetKickToken() { _token = null; _exp = 0; }
