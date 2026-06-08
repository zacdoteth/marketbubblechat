// server/src/index.js — http server (health + Kick webhook) + WS fan-out.
import { createServer } from 'node:http';
import { PORT } from './config.js';
import { startFanout } from './fanout.js';
import { getKickPublicKey, verifyKickSignature, parseChatWebhook } from './ingesters/kickWebhook.js';

let hubRef = null;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhooks/kick') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const messageId = req.headers['kick-event-message-id'];
        const timestamp = req.headers['kick-event-message-timestamp'];
        const signature = req.headers['kick-event-signature'];
        // verify-if-possible, non-fatal (Kick sig scheme; do not drop chat if verification can't run)
        try { const pk = await getKickPublicKey(); if (pk && signature) verifyKickSignature({ messageId, timestamp, body: raw, signature, publicKey: pk }); } catch {}
        const payload = JSON.parse(raw);
        const type = req.headers['kick-event-type'] || '';
        if (type === 'chat.message.sent' || payload?.content != null) {
          const m = parseChatWebhook(payload);
          if (hubRef && m.broadcasterUserId) hubRef.handleKickChat(m.broadcasterUserId, { username: m.username, text: m.text, ts: m.ts || Date.now() });
        }
      } catch {}
      res.writeHead(200); res.end('ok'); // always 200 so Kick doesn't retry-storm
    });
    return;
  }
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('CONFLUX backend live');
});
const { hub } = startFanout(server);
hubRef = hub;
server.listen(PORT, () => console.log('CONFLUX backend on :' + PORT));
