// server/src/ingesters/xBroadcast.js
// Placeholder ingester for X Live Broadcast chat. The ACTUAL capture is done by an
// external Node+Playwright worker that POSTs to /ingest/x (see index.js + the worker/).
// This class does no capture itself — it just holds the ref-counted pool entry open
// while a room is subscribed, so the worker's messages have somewhere to route.
// Mirrors how Kick chat is fulfilled externally by a webhook.
export class XBroadcastIngester {
  constructor(channel, { onStatus } = {}) {
    this.channel = channel;
    this.cb = { onStatus };
  }
  async start() { this.cb.onStatus?.('connecting'); } // worker drives real status via setXStatus
  async stop() {}
}
