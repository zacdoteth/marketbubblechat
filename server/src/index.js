// server/src/index.js — http server (health + Kick webhook) + WS fan-out.
import { createServer } from 'node:http';
import { PORT, X_BEARER_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, X_INGEST_TOKEN } from './config.js';
import { startFanout } from './fanout.js';
import { getKickPublicKey, verifyKickSignature, parseChatWebhook } from './ingesters/kickWebhook.js';

const MAX_BODY_SIZE = 1024 * 1024; // 1MB — real Kick chat events are ~hundreds of bytes
// idempotency: Kick retries deliveries; drop duplicates by Kick-Event-Message-Id.
const recentKickMessageIds = new Set();
const MAX_KICK_IDS = 5000;
// idempotency for X-broadcast chat: the worker may resend history+live overlap or retry; dedup by uuid.
const recentXUuids = new Set();
const MAX_X_UUIDS = 5000;

let hubRef = null;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ingest/x') {
    // X Live Broadcast chat from the external capture worker. Token-gated; disabled (503) if
    // X_INGEST_TOKEN is unset, so there's no fake-injection surface by default.
    if (!X_INGEST_TOKEN) { res.writeHead(503); res.end('x ingest disabled'); return; }
    const chunks = []; let total = 0; let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      total += c.length;
      if (total > MAX_BODY_SIZE) { aborted = true; try { res.writeHead(413); res.end('payload too large'); } catch {} req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body?.token !== X_INGEST_TOKEN) { res.writeHead(401); res.end('unauthorized'); return; }
        const broadcastId = body?.broadcastId;
        if (!broadcastId) { res.writeHead(400); res.end('broadcastId required'); return; }
        if (hubRef) {
          if (typeof body.broadcaster === 'string' && body.broadcaster) hubRef.setXLabel(broadcastId, body.broadcaster);
          if (typeof body.status === 'string') hubRef.setXStatus(broadcastId, body.status);
          if (Number.isFinite(body.occupancy)) hubRef.setXViewers(broadcastId, body.occupancy);
          for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
            const uuid = m?.uuid;
            if (uuid) {
              if (recentXUuids.has(uuid)) continue; // drop dup (history+live overlap / retry)
              recentXUuids.add(uuid);
              if (recentXUuids.size > MAX_X_UUIDS) {
                const keep = Array.from(recentXUuids).slice(-Math.floor(MAX_X_UUIDS / 2));
                recentXUuids.clear(); for (const id of keep) recentXUuids.add(id);
              }
            }
            hubRef.routeXChat(broadcastId, { username: m.username, displayName: m.displayName, text: m.text, ts: m.ts || Date.now() });
          }
        }
        res.writeHead(200); res.end('ok');
      } catch (e) {
        if (e instanceof SyntaxError) { res.writeHead(400); res.end('bad json'); }
        else { console.error('[x-ingest] handler error:', e.message); res.writeHead(500); res.end('error'); }
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/webhooks/kick') {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      total += c.length;
      if (total > MAX_BODY_SIZE) { aborted = true; try { res.writeHead(413); res.end('payload too large'); } catch {} req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const messageId = req.headers['kick-event-message-id'];
        const timestamp = req.headers['kick-event-message-timestamp'];
        const signature = req.headers['kick-event-signature'];
        // idempotency: ack-and-skip a retry we've already processed.
        if (messageId && recentKickMessageIds.has(messageId)) { res.writeHead(200); res.end('ok'); return; }
        // Signature verification: when we have BOTH a public key and a signature, enforce it
        // (reject forgeries). If the key can't be fetched or no signature is sent, fall back to
        // best-effort (do not drop chat) — availability over strictness for this scheme.
        try {
          const pk = await getKickPublicKey();
          if (pk && signature) {
            const ok = verifyKickSignature({ messageId, timestamp, body: raw, signature, publicKey: pk });
            if (!ok) { console.warn('[kick] webhook signature invalid; rejecting'); res.writeHead(401); res.end('invalid signature'); return; }
          }
        } catch (e) { console.warn('[kick] signature verification unavailable (allowing best-effort):', e.message); }
        const payload = JSON.parse(raw);
        const type = req.headers['kick-event-type'] || '';
        if (type === 'chat.message.sent' || payload?.content != null) {
          const m = parseChatWebhook(payload);
          if (hubRef && m.broadcasterUserId) hubRef.routeKickChat(m.broadcasterUserId, { username: m.username, text: m.text, ts: m.ts || Date.now() });
          else if (!m.broadcasterUserId) console.warn('[kick] webhook chat dropped: no broadcaster_user_id; username:', m.username);
        }
        // record only after successful processing so a failed parse can still be retried
        if (messageId) {
          recentKickMessageIds.add(messageId);
          if (recentKickMessageIds.size > MAX_KICK_IDS) {
            const keep = Array.from(recentKickMessageIds).slice(-Math.floor(MAX_KICK_IDS / 2));
            recentKickMessageIds.clear();
            for (const id of keep) recentKickMessageIds.add(id);
          }
        }
      } catch (e) {
        if (e instanceof SyntaxError) console.warn('[kick] malformed JSON in webhook body:', raw.slice(0, 200));
        else console.error('[kick] webhook handler error:', e.message);
      }
      res.writeHead(200); res.end('ok'); // always 200 so Kick doesn't retry-storm
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/x/active') {
    // The cloud worker polls this to learn which broadcasts to capture. Token-gated via header
    // (no secret in the URL/logs); disabled if X_INGEST_TOKEN unset.
    if (!X_INGEST_TOKEN) { res.writeHead(503); res.end('x ingest disabled'); return; }
    if (req.headers['x-ingest-token'] !== X_INGEST_TOKEN) { res.writeHead(401); res.end('unauthorized'); return; }
    const broadcasts = hubRef ? hubRef.activeXBroadcasts() : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ broadcasts }));
    return;
  }
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('CONFLUX backend live');
});
const { hub } = startFanout(server);
hubRef = hub;

// process-level guards: an unhandled error in a callback/timer must not silently kill the process.
process.on('unhandledRejection', (reason) => { console.error('[fatal] unhandledRejection:', reason); });
process.on('uncaughtException', (err) => { console.error('[fatal] uncaughtException:', err); });

// startup provider availability — make missing creds visible instead of failing silently later.
if (!X_BEARER_TOKEN) console.warn('[startup] X ingestion disabled: X_BEARER_TOKEN not set');
if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) console.warn('[startup] Kick ingestion disabled: KICK_CLIENT_ID or KICK_CLIENT_SECRET not set');
if (!X_INGEST_TOKEN) console.warn('[startup] X-broadcast ingest disabled: X_INGEST_TOKEN not set (POST /ingest/x → 503)');

server.listen(PORT, () => console.log('CONFLUX backend on :' + PORT));

// graceful shutdown: unsubscribe Kick webhooks + close connections so we don't leak subscriptions.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, cleaning up...`);
  const forceExit = setTimeout(() => process.exit(0), 5000);
  forceExit.unref?.();
  try { await hub.stopAll(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
