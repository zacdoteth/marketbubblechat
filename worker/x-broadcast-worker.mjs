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
// Two modes:
//   • POLL MODE (default, no CLI arg) — long-lived cloud service (e.g. Railway).
//     Every POLL_MS it GETs {BACKEND_HTTP}/x/active (header x-ingest-token) to discover
//     which broadcast ids to capture, then starts/stops capture sessions to match. ONE
//     shared headless browser; one context+page per broadcast. Resilient: a poll failure
//     or a single session crash never takes down the process or the other sessions.
//   • SINGLE MODE (a broadcast URL passed as a CLI arg) — back-compat one-off capture of
//     exactly that broadcast, no polling. Preserves local testing.
//
// POSTs to {BACKEND_HTTP}/ingest/x as JSON:
//   { token, broadcastId, broadcaster?, status?, occupancy?, messages?:[{uuid,username,displayName,text,ts}] }

import { chromium } from 'playwright';
import { parseXFrame } from './xBroadcastParse.js'; // vendored copy of server/src/ingesters/xBroadcastParse.js

// ── config ────────────────────────────────────────────────────────────────
const BACKEND_HTTP = (process.env.BACKEND_HTTP || 'http://localhost:8080').replace(/\/+$/, '');
const X_INGEST_TOKEN = process.env.X_INGEST_TOKEN || '';
const POLL_MS = Number(process.env.POLL_MS) || 5000; // active-broadcast discovery interval (poll mode)
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

const log = (...a) => console.log('[x-worker]', ...a);
const errlog = (...a) => console.error('[x-worker]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHATMAN_RE = /pscp\.tv|chatman/i;

// ── env validation ──────────────────────────────────────────────────────────
if (!X_INGEST_TOKEN) {
  errlog('X_INGEST_TOKEN is not set — refusing to start. Set it to the backend ingest secret.');
  process.exit(1);
}

// Extract the {id} from /i/broadcasts/{id} on x.com or twitter.com, with or without a query string.
function parseBroadcastId(url) {
  const m = String(url).match(/(?:x\.com|twitter\.com)\/i\/broadcasts\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

// Build the canonical broadcast URL from a bare id.
const broadcastUrlFor = (id) => `https://x.com/i/broadcasts/${id}`;

// ── capture session ─────────────────────────────────────────────────────────
// startCapture(browser, broadcastId) → handle { id, stop() }.
// All per-broadcast state (queue, occupancy, broadcaster, status, reconnect counters,
// flush loop, browser context) lives INSIDE this closure — no module-level globals are
// shared across sessions, so two broadcasts never leak into each other.
function startCapture(browser, broadcastId) {
  const url = broadcastUrlFor(broadcastId);
  const slog = (...a) => log(`[${broadcastId}]`, ...a);
  const serrlog = (...a) => errlog(`[${broadcastId}]`, ...a);

  // ── per-session outbound state (POST batching + retry queue) ──────────────
  const queue = [];           // pending chat messages awaiting a successful POST
  let latestOccupancy = null; // last viewer count seen (sent on each flush)
  let occupancyDirty = false; // a fresh occupancy to push even with no new chat
  let broadcaster = null;     // best-effort display label, sent once
  let broadcasterSent = false;
  let lastStatusSent = null;  // de-dupe status transitions
  let pendingStatus = null;   // a status transition to include on the next flush
  let postBackoff = POST_RETRY_BASE_MS;
  let flushing = false;
  let stopped = false;        // set on stop()/broadcast-ended so loops wind down

  // ── per-session browser/capture state ─────────────────────────────────────
  let context = null;
  let flushTimer = null;
  let reconnects = 0;         // consecutive (re)loads that yielded no chat socket
  let sawSocketThisLoad = false;
  let reconnecting = false;
  let ended = false;          // broadcast judged ended (drives a final offline + self-stop)

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
    if (flushing) return;
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
      if (batch.length) slog(`forwarded ${batch.length} message(s)` + (sendOccupancy != null ? ` · occupancy ${sendOccupancy}` : ''));
      else if (sendOccupancy != null) slog(`occupancy ${sendOccupancy}`);
      if (sendStatus) slog(`status → ${sendStatus}`);
    } catch (e) {
      // Put the messages back at the FRONT so order is preserved, and retry next tick.
      if (batch.length) queue.unshift(...batch);
      serrlog(`POST /ingest/x failed (${e.message}); ${queue.length} queued, retrying in ${postBackoff}ms`);
      flushing = false;
      await sleep(postBackoff);
      postBackoff = Math.min(postBackoff * 2, POST_RETRY_MAX_MS);
      return;
    }
    flushing = false;
  }

  // Best-effort final flush of an offline status (used on stop / broadcast end).
  async function flushOffline() {
    setStatus('offline');
    for (let i = 0; i < 3; i++) { // a few attempts so the pill flips to offline reliably
      await flush();
      if (lastStatusSent === 'offline' && !queue.length) break;
      await sleep(500);
    }
  }

  // After a (re)load, give X time to open the chatman socket. If none appears for
  // MAX_RECONNECTS consecutive tries, treat the broadcast as ended.
  async function waitForSocket() {
    if (stopped) return;
    const deadline = Date.now() + SOCKET_WAIT_MS;
    while (Date.now() < deadline) {
      if (stopped) return;
      if (sawSocketThisLoad) return;
      await sleep(500);
    }
    if (stopped) return;
    reconnects++;
    slog(`no chat socket after reload (${reconnects}/${MAX_RECONNECTS})`);
    if (reconnects >= MAX_RECONNECTS) {
      slog('broadcast appears to have ended');
      ended = true;
      // Wind this session down on its own: drop it from the registry, flush offline, close.
      onSelfEnded(broadcastId);
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect(page) {
    if (stopped || reconnecting) return;
    reconnecting = true;
    setTimeout(async () => {
      reconnecting = false;
      if (stopped) return;
      sawSocketThisLoad = false;
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        serrlog('reload failed:', e.message);
      }
      await waitForSocket();
    }, RECONNECT_DELAY_MS);
  }

  // Wire one freshly-created page: response label sniffing, websocket capture, title fallback.
  function wirePage(page) {
    // Best-effort broadcaster label from the broadcasts/show.json response body.
    page.on('response', async (resp) => {
      try {
        if (broadcaster) return;
        if (!/broadcasts\/show\.json/i.test(resp.url())) return;
        const j = await resp.json().catch(() => null);
        // Real shape: { broadcasts: { "<id>": { user_display_name, username, twitter_username, ... } } }
        const bc = j?.broadcasts;
        const b = (bc && (bc[broadcastId] || Object.values(bc)[0])) || j?.broadcast || j || {};
        const name = b.user_display_name || b.username || b.twitter_username;
        if (name) { setBroadcaster(name); slog(`broadcaster → ${broadcaster}`); }
      } catch { /* non-fatal: label is best-effort */ }
    });

    // The core: every WebSocket X's client opens passes through here. We attach a frame
    // reader to the chatman/pscp socket and decode each frame with the shared parser.
    page.on('websocket', (ws) => {
      const wsUrl = ws.url();
      if (!CHATMAN_RE.test(wsUrl)) return; // ignore X's other sockets (pushpin, etc.)
      sawSocketThisLoad = true;
      reconnects = 0; // a live socket resets the "ended" counter
      slog('chat socket open:', wsUrl.replace(/\?.*$/, ''));
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
        slog('chat socket closed — reloading to reconnect (X rotates chatman servers)');
        scheduleReconnect(page);
      });
    });
  }

  // ── run the session (its OWN context + page; one shared browser across sessions) ──
  async function run() {
    context = await browser.newContext({ userAgent: USER_AGENT });
    // Hide the obvious automation flag so X serves the normal client.
    await context.addInitScript(() =>
      Object.defineProperty(navigator, 'webdriver', { get: () => false }));
    const page = await context.newPage();
    wirePage(page);

    // Periodic flusher — independent of the page so queued messages drain even mid-reconnect.
    flushTimer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
    flushTimer.unref?.();

    slog(`opening broadcast …`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Fallback label from the page <title>, POLLED — X is an SPA, so at domcontentloaded
    // the title is still "X"/empty; it becomes the broadcast title only after the client renders.
    (async () => {
      await sleep(2500); // give broadcasts/show.json (the broadcaster's name) first dibs over the title
      for (let i = 0; i < 12 && !broadcaster && !stopped; i++) {
        try {
          const title = (await page.title()) || '';
          const cleaned = title.replace(/^\(\d+\)\s*/, '').replace(/\s*[\/|·]\s*X\s*$/i, '').trim();
          if (cleaned && !/^(x|untitled)$/i.test(cleaned)) { setBroadcaster(cleaned); slog(`broadcaster → ${broadcaster}`); break; }
        } catch { /* non-fatal: label is best-effort */ }
        await sleep(1000);
      }
    })();

    await waitForSocket();
  }

  // Tear the session down: stop loops, flush a final offline, close the context.
  let stopping = null;
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      stopped = true;
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      try { await flushOffline(); } catch {}
      try { if (context) await context.close(); } catch {}
    })();
    return stopping;
  }

  // Kick off the session. A crash inside run() must not kill the poller or the other
  // sessions, so we isolate it here and drop ourselves from the registry on failure.
  run().catch((e) => {
    if (stopped) return;
    serrlog(`capture crashed (${e.message}); dropping session`);
    onSelfEnded(broadcastId);
  });

  return { id: broadcastId, stop };
}

// ── session registry (poll mode) ─────────────────────────────────────────────
// id → handle returned by startCapture. Shared browser is created once in pollLoop.
const sessions = new Map();
let sharedBrowser = null;
let shuttingDown = false;

// A session decided it's done (ended or crashed): forget it and tear it down. Safe to call
// even mid-shutdown; the handle's stop() is idempotent.
function onSelfEnded(broadcastId) {
  const handle = sessions.get(broadcastId);
  if (!handle) return;
  sessions.delete(broadcastId);
  log(`capture removed: ${broadcastId} (session ended) · capturing ${sessions.size}`);
  handle.stop().catch(() => {});
}

// One discovery tick: GET /x/active and reconcile sessions to the returned id list.
//   200 {broadcasts:[...]} → start missing, stop extra
//   503                    → ingest disabled: log + keep polling (leave sessions as-is)
//   401                    → bad token: log clearly and exit
//   anything else / fetch error → log + retry next tick (never crash)
async function pollActive() {
  let res;
  try {
    res = await fetch(`${BACKEND_HTTP}/x/active`, {
      method: 'GET',
      headers: { 'x-ingest-token': X_INGEST_TOKEN },
    });
  } catch (e) {
    errlog(`GET /x/active failed (${e.message}); retrying in ${POLL_MS}ms`);
    return;
  }

  if (res.status === 401) {
    errlog('GET /x/active → 401 unauthorized: X_INGEST_TOKEN does not match the backend. Exiting.');
    await shutdown('AUTH');
    return;
  }
  if (res.status === 503) {
    log('GET /x/active → 503: X ingest disabled on backend (X_INGEST_TOKEN unset there). Will keep polling.');
    return;
  }
  if (!res.ok) {
    errlog(`GET /x/active → HTTP ${res.status}; retrying in ${POLL_MS}ms`);
    return;
  }

  let ids = [];
  try {
    const j = await res.json();
    ids = Array.isArray(j?.broadcasts) ? j.broadcasts.map(String).filter(Boolean) : [];
  } catch (e) {
    errlog(`GET /x/active returned unparseable body (${e.message}); retrying in ${POLL_MS}ms`);
    return;
  }

  const wanted = new Set(ids);
  log(`active poll → ${wanted.size} broadcast(s); capturing ${sessions.size}`);

  // Start sessions for newly-wanted ids.
  for (const id of wanted) {
    if (sessions.has(id)) continue;
    log(`capture added: ${id}`);
    try {
      sessions.set(id, startCapture(sharedBrowser, id));
    } catch (e) {
      errlog(`failed to start capture for ${id} (${e.message})`);
    }
  }

  // Stop sessions for ids no longer wanted.
  for (const id of [...sessions.keys()]) {
    if (wanted.has(id)) continue;
    const handle = sessions.get(id);
    sessions.delete(id);
    log(`capture removed: ${id} (no longer active) · capturing ${sessions.size}`);
    handle.stop().catch(() => {});
  }
}

// Long-lived poll mode: one shared browser, poll forever. A single tick's failure never
// crashes the process — pollActive() swallows its own errors and we retry next interval.
async function pollLoop() {
  log(`poll mode · backend ${BACKEND_HTTP} · every ${POLL_MS}ms`);
  sharedBrowser = await chromium.launch({ headless: true });
  while (!shuttingDown) {
    try {
      await pollActive();
    } catch (e) {
      errlog(`poll tick crashed (${e.message}); retrying in ${POLL_MS}ms`);
    }
    if (shuttingDown) break;
    await sleep(POLL_MS);
  }
}

// ── single mode (back-compat: one broadcast from a CLI arg, no polling) ───────
// Captures exactly the one broadcast, exits when it ends or on signal.
async function runSingle(broadcastId) {
  log(`single mode · backend ${BACKEND_HTTP} · broadcast ${broadcastId}`);
  sharedBrowser = await chromium.launch({ headless: true });
  const handle = startCapture(sharedBrowser, broadcastId);
  sessions.set(broadcastId, handle);
  // Resolve when the (only) session ends. We poll the registry — onSelfEnded removes it.
  while (!shuttingDown && sessions.has(broadcastId)) {
    await sleep(500);
  }
}

// ── clean shutdown ───────────────────────────────────────────────────────────
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — stopping ${sessions.size} session(s) + exiting`);
  const force = setTimeout(() => process.exit(0), 8000);
  force.unref?.();
  // Stop every session (each flushes a final 'offline' and closes its context).
  const handles = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(handles.map((h) => h.stop()));
  try { if (sharedBrowser) await sharedBrowser.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A stray error in a callback/timer must not silently kill the worker.
process.on('unhandledRejection', (r) => errlog('unhandledRejection:', r));
process.on('uncaughtException', (e) => errlog('uncaughtException:', e?.message || e));

// ── main ───────────────────────────────────────────────────────────────────
if (BROADCAST_URL) {
  // Back-compat one-off: a URL was passed → capture just that broadcast, no polling.
  const id = parseBroadcastId(BROADCAST_URL);
  if (!id) {
    errlog(`could not parse a broadcast id from "${BROADCAST_URL}" (expected .../i/broadcasts/{id})`);
    process.exit(1);
  }
  await runSingle(id);
  log('done.');
  await shutdown('DONE');
} else {
  // Default: long-lived poller that auto-discovers broadcasts to capture.
  await pollLoop();
}
