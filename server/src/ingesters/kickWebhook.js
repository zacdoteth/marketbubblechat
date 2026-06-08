import crypto from 'node:crypto';
import { getKickToken } from './kickAuth.js';
const API = 'https://api.kick.com/public/v1';
export async function subscribeChat(broadcasterUserId) {
  const token = await getKickToken();
  const r = await fetch(`${API}/events/subscriptions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ events: [{ name: 'chat.message.sent', version: 1 }], method: 'webhook', broadcaster_user_id: broadcasterUserId }),
  });
  if (!r.ok) throw new Error('kick subscribe ' + r.status + ' ' + await r.text());
  const j = await r.json();
  return (j.data || []).map(d => d.subscription_id).filter(Boolean);
}
export async function unsubscribe(subscriptionIds) {
  const ids = Array.isArray(subscriptionIds) ? subscriptionIds : [subscriptionIds];
  if (!ids.length) return;
  const token = await getKickToken();
  const qs = ids.map(id => `id=${encodeURIComponent(id)}`).join('&');
  await fetch(`${API}/events/subscriptions?${qs}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
}
// pure — unit-tested. payload = chat.message.sent event body
export function parseChatWebhook(payload) {
  const bid = payload?.broadcaster?.user_id ?? payload?.broadcaster?.broadcaster_user_id ?? payload?.broadcaster_user_id;
  const username = payload?.sender?.username || payload?.sender?.slug || 'viewer';
  const text = payload?.content ?? '';
  const ts = Date.parse(payload?.created_at || '') || 0;
  return { broadcasterUserId: bid != null ? String(bid) : null, username, text, ts };
}
let _pubKey = null;
export async function getKickPublicKey() {
  if (_pubKey) return _pubKey;
  const r = await fetch(`${API}/public-key`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('kick public-key ' + r.status);
  const j = await r.json();
  _pubKey = j?.data?.public_key || j?.public_key || null;
  return _pubKey;
}
export function verifyKickSignature({ messageId, timestamp, body, signature, publicKey }) {
  try {
    const data = `${messageId}.${timestamp}.${body}`;
    const v = crypto.createVerify('RSA-SHA256'); v.update(data); v.end();
    return v.verify(publicKey, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
