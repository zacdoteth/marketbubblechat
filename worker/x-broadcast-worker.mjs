// worker/x-broadcast-worker.mjs
// CONFLUX X Live-Broadcast chat worker.
//
// Captures live X (Twitter) Broadcast chat ANONYMOUSLY (logged-OUT) and POSTs it to
// the CONFLUX backend. A headless Chromium opens https://x.com/i/broadcasts/{id};
// X's own JS opens the Periscope "chatman" WebSocket and we passively read its frames
// via Playwright's page.on('websocket') + ws.on('framereceived'). No login, no tokens,
// no handshake to manage — we eavesdrop. Frames are decoded by the SHARED, tested
// parser parseXFrame() (single source of truth, also used by the backend tests).
//
// Verified protocol + frame format:
//   docs/superpowers/specs/2026-06-10-x-broadcast-chat-feasibility-findings.md
//   docs/superpowers/specs/2026-06-10-x-broadcast-chat-integration-design.md  (component #1)
//
// Usage:  node x-broadcast-worker.mjs <broadcast-url>
// Env:    BACKEND_HTTP   e.g. https://conflux-backend-production.up.railway.app
//         X_INGEST_TOKEN required — shared secret the backend checks (POST /ingest/x)
//
// POSTs to {BACKEND_HTTP}/ingest/x as JSON:
//   { token, broadcastId, broadcaster?, status?, occupancy?, messages?:[{uuid,username,displayName,text,ts}] }

import { chromium } from 'playwright';
import { parseXFrame } from '../server/src/ingesters/xBroadcastParse.js';

// ── config ────────────────────────────────────────────────────────────────
const BACKEND_HTTP = (process.env.BACKEND_HTTP || 'http://localhost:8080').replace(/\/+$/, '');
const X_INGEST_TOKEN = process.env.X_INGEST_TOKEN || '';
const BROADCAST_URL = process.argv[2] || '';

// A normal desktop UA so X serves the standard web client (not a bot/blocked page).
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FLUSH_MS = 1000;             // batch chat and POST at most ~1/s
const RECONNECT_DELAY_MS = 4000;   // wait before page.reload() after a chat WS drop
const MAX_RECONNECTS = 4;          // consecutive failed reconnects (no socket) ⇒ broadcast ended
const SOCKET_WAIT_MS = 12_000;     // how long to wait for a chatman socket after a (re)load
const MAX_QUEUE = 5000;            // cap the retry queue so a long backend outage can't OOM us
const POST_RETRY_BASE_MS = 1000;   // backoff base for failed POSTs
const POST_RETRY_MAX_MS = 30_000;
const SUPERVISOR_BASE_MS = 2000;   // backoff base for crash-restart of the whole run
const SUPERVISOR_MAX_MS = 60_000;

const log = (...a) => console.log('[x-worker]', ...a);
const errlog = (...a) => console.error('[x-worker]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHATMAN_RE = /pscp\.tv|chatman/i;

// ── arg / env validation ──────────────────────────────────────────────────
if (!BROADCAST_URL) {
  errlog('usage: node x-broadcast-worker.mjs <broadcast-url>');
  process.exit(1);
}
if (!X_INGEST_TOKEN) {
  errlog('X_INGEST_TOKEN is not set — refusing to start. Set it to the backend ingest secret.');
  process.exit(1);
}

// Extract the {id} from /i/broadcasts/{id} on x.com or twitter.com, with or without a query string.
function parseBroadcastId(url) {
  const m = String(url).match(/(?:x\.com|twitter\.com)\/i\/broadcasts\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

const broadcastId = parseBroadcastId(BROADCAST_URL);
if (!broadcastId) {
  errlog(`could not parse a broadcast id from "${BROADCAST_URL}" (expected .../i/broadcasts/{id})`);
  process.exit(1);
}

// ── outbound state (POST batching + retry queue) ───────────────────────────
const queue = [];          // pending chat messages awaiting a successful POST
let latestOccupancy = null; // last viewer count seen (sent on each flush)
let occupancyDirty = false; // a fresh occupancy to push even with no new chat
let broadcaster = null;    // best-effort display label, sent once
let broadcasterSent = false;
let lastStatusSent = null; // de-dupe status transitions
let pendingStatus = null;  // a status transition to include on the next flush
let postBackoff = POST_RETRY_BASE_MS;
let flushing = false;
let stopped = false;       // set on shutdown / broadcast-ended so loops wind down

function enqueueChat(msg) {
  queue.push(msg);
  // Drop oldest if the backend is unreachable for a very long time (bounded memory).
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
}

function setStatus(s) {
  if (s === lastStatusSent && s === pendingStatus) return;
  pendingStatus = s;
}

function setBroadcaster(name) {
  if (!name || broadcaster) return;
  broadcaster = String(name).trim().slice(0, 200) || null;
}

// POST one batch. On any failure we KEEP the messages (re-queued by the caller) and back off,
// so a transient network blip never drops chat.
async function postBatch(body) {
  const res = await fetch(`${BACKEND_HTTP}/ingest/x`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Flush loop: gather the current batch + any occupancy/status/broadcaster updates and POST.
// Re-queues on failure and applies exponential backoff to the next attempt.
async function flush() {
  if (flushing || stopped) return;
  // Nothing to send?
  if (!queue.length && !occupancyDirty && !pendingStatus && !(broadcaster && !broadcasterSent)) return;
  flushing = true;

  const batch = queue.splice(0, queue.length);
  const sendOccupancy = occupancyDirty ? latestOccupancy : undefined;
  const sendStatus = pendingStatus || undefined;
  const sendBroadcaster = broadcaster && !broadcasterSent ? broadcaster : undefined;

  const body = { token: X_INGEST_TOKEN, broadcastId };
  if (batch.length) body.messages = batch;
  if (sendOccupancy != null) body.occupancy = sendOccupancy;
  if (sendStatus) body.status = sendStatus;
  if (sendBroadcaster) body.broadcaster = sendBroadcaster;

  try {
    await postBatch(body);
    if (sendOccupancy != null) occupancyDirty = false;
    if (sendStatus) { lastStatusSent = sendStatus; pendingStatus = null; }
    if (sendBroadcaster) broadcasterSent = true;
    postBackoff = POST_RETRY_BASE_MS; // reset backoff on success
    if (batch.length) log(`forwarded ${batch.length} message(s)` + (sendOccupancy != null ? ` · occupancy ${sendOccupancy}` : ''));
    else if (sendOccupancy != null) log(`occupancy ${sendOccupancy}`);
    if (sendStatus) log(`status → ${sendStatus}`);
  } catch (e) {
    // Put the messages back at the FRONT so order is preserved, and retry next tick.
    if (batch.length) queue.unshift(...batch);
    errlog(`POST /ingest/x failed (${e.message}); ${queue.length} queued, retrying in ${postBackoff}ms`);
    flushing = false;
    await sleep(postBackoff);
    postBackoff = Math.min(postBackoff * 2, POST_RETRY_MAX_MS);
    return;
  }
  flushing = false;
}

// Periodic flusher — independent of the browser so queued messages drain even mid-reconnect.
const flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
flushTimer.unref?.();

// Best-effort final flush of an offline status (used on shutdown / broadcast end).
async function flushOffline() {
  setStatus('offline');
  for (let i = 0; i < 3; i++) { // a few attempts so the pill flips to offline reliably
    await flush();
    if (lastStatusSent === 'offline' && !queue.length) break;
    await sleep(500);
  }
}

// ── capture (one browser lifecycle; the supervisor restarts on crash) ──────
// Resolves when the broadcast is determined to have ended (so the supervisor stops).
// Throws on an unexpected crash (so the supervisor restarts with backoff).
async function captureOnce() {
  const browser = await chromium.launch({ headless: true });
  let endedCleanly = false;
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    // Hide the obvious automation flag so X serves the normal client.
    await context.addInitScript(() =>
      Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    const page = await context.newPage();

    let reconnects = 0;        // consecutive (re)loads that yielded no chat socket
    let sawSocketThisLoad = false;
    let resolveEnded;
    const ended = new Promise((r) => { resolveEnded = r; });

    // Best-effort broadcaster label from the broadcasts/show.json response body.
    page.on('response', async (resp) => {
      try {
        if (broadcaster) return;
        if (!/broadcasts\/show\.json/i.test(resp.url())) return;
        const j = await resp.json().catch(() => null);
        // Shape varies; probe the common spots for a display name / handle.
        const b = j?.broadcasts?.[0] || j?.broadcast || j || {};
        const name = b.user_display_name || b.username || j?.user_display_name || j?.username;
        if (name) { setBroadcaster(name); log(`broadcaster → ${broadcaster}`); }
      } catch { /* non-fatal: label is best-effort */ }
    });

    // The core: every WebSocket X's client opens passes through here. We attach a frame
    // reader to the chatman/pscp socket and decode each frame with the shared parser.
    page.on('websocket', (ws) => {
      const url = ws.url();
      if (!CHATMAN_RE.test(url)) return; // ignore X's other sockets (pushpin, etc.)
      sawSocketThisLoad = true;
      reconnects = 0; // a live socket resets the "ended" counter
      log('chat socket open:', url.replace(/\?.*$/, ''));
      setStatus('live');

      ws.on('framereceived', ({ payload }) => {
        // A single malformed frame must never throw; parseXFrame returns null for junk.
        let parsed = null;
        try { parsed = parseXFrame(payload); } catch { parsed = null; }
        if (!parsed) return;
        if (parsed.type === 'chat') {
          enqueueChat(parsed.msg);
        } else if (parsed.type === 'viewers') {
          if (parsed.occupancy !== latestOccupancy) { latestOccupancy = parsed.occupancy; occupancyDirty = true; }
        }
      });

      ws.on('close', () => {
        if (stopped) return;
        log('chat socket closed — reloading to reconnect (X rotates chatman servers)');
        scheduleReconnect();
      });
    });

    let reconnecting = false;
    function scheduleReconnect() {
      if (stopped || reconnecting) return;
      reconnecting = true;
      setTimeout(async () => {
        reconnecting = false;
        if (stopped) return;
        sawSocketThisLoad = false;
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        } catch (e) {
          errlog('reload failed:', e.message);
        }
        await waitForSocket();
      }, RECONNECT_DELAY_MS);
    }

    // After a (re)load, give X time to open the chatman socket. If none appears for
    // MAX_RECONNECTS consecutive tries, treat the broadcast as ended.
    async function waitForSocket() {
      if (stopped) return;
      const deadline = Date.now() + SOCKET_WAIT_MS;
      while (Date.now() < deadline) {
        if (sawSocketThisLoad) return;
        await sleep(500);
      }
      reconnects++;
      log(`no chat socket after reload (${reconnects}/${MAX_RECONNECTS})`);
      if (reconnects >= MAX_RECONNECTS) {
        log('broadcast appears to have ended');
        endedCleanly = true;
        resolveEnded();
        return;
      }
      scheduleReconnect();
    }

    log(`opening broadcast ${broadcastId} …`);
    await page.goto(BROADCAST_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Fallback label from the page <title> if show.json didn't yield one.
    try {
      const title = (await page.title()) || '';
      if (!broadcaster && title) { setBroadcaster(title.replace(/\s*[\/|·].*$/, '')); }
    } catch { /* non-fatal */ }

    await waitForSocket();
    await ended; // resolves only when the broadcast is judged ended
  } finally {
    try { await browser.close(); } catch {}
  }
  return endedCleanly;
}

// Supervisor: restart the browser/page on a crash with backoff. Exits when the broadcast
// ends (captureOnce resolves true) or on shutdown.
async function supervise() {
  let backoff = SUPERVISOR_BASE_MS;
  while (!stopped) {
    try {
      const ended = await captureOnce();
      if (ended) break; // clean end — stop supervising
      backoff = SUPERVISOR_BASE_MS; // returned without "ended" (unusual) → retry promptly
    } catch (e) {
      if (stopped) break;
      errlog(`capture crashed (${e.message}); restarting in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, SUPERVISOR_MAX_MS);
    }
  }
}

// ── clean shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopped = true;
  log(`${signal} received — flushing offline + exiting`);
  const force = setTimeout(() => process.exit(0), 6000);
  force.unref?.();
  try { await flushOffline(); } catch {}
  clearInterval(flushTimer);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A stray error in a callback/timer must not silently kill the worker.
process.on('unhandledRejection', (r) => errlog('unhandledRejection:', r));
process.on('uncaughtException', (e) => errlog('uncaughtException:', e?.message || e));

// ── main ───────────────────────────────────────────────────────────────────
log(`backend ${BACKEND_HTTP} · broadcast ${broadcastId}`);
await supervise();
// Broadcast ended: make sure 'offline' lands, then exit.
stopped = true;
await flushOffline().catch(() => {});
clearInterval(flushTimer);
log('done.');
process.exit(0);
