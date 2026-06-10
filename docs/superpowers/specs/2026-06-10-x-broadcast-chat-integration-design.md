# X Live Broadcast Chat — Integration Design

**Date:** 2026-06-10
**Scope:** New X-broadcast chat source for CONFLUX. Backend (`server/src/`) + a new standalone worker (`worker/`) + a small `conflux.html` helper. Builds on the verified findings in [2026-06-10-x-broadcast-chat-feasibility-findings.md](2026-06-10-x-broadcast-chat-feasibility-findings.md).
**Deadline context:** Market Bubble submission due June 11 — favor proven + low-risk.

## Goal

Merge **live X Live-Broadcast chat** (the Periscope/chatman overlay on `x.com/i/broadcasts/{id}`) into CONFLUX alongside Twitch + Kick, plus the **real concurrent-viewer count** — all captured anonymously (no login).

## Approved decisions

- **Tier 1 (Playwright), proven.** Capture via a real headless browser, not a hand-rolled handshake.
- **Separate worker, not in-backend.** A standalone Node+Playwright worker captures and **POSTs normalized messages to the backend**, which routes them into rooms by broadcast id — mirroring the working Kick-webhook pattern. The featherweight backend never runs a browser. The worker runs **locally at demo time** (where Playwright is proven), configured with backend URL + token.
- **Variant A routing.** The operator **pastes the broadcast link in the dashboard** (creates the pill + subscribes their room, like every other platform) **and** runs the worker with that URL. Session isolation is untouched: the backend routes the worker's chat only to rooms subscribed to `xbroadcast:{id}`. The dashboard shows a copy-ready worker command to make launching one click.
- **Explicit launch, not polling.** The worker is launched with the broadcast URL (no `/x/active` endpoint). This fits X's per-stream-changing broadcast ids.

## Architecture

```
Operator pastes x.com/i/broadcasts/{id}  ─►  room.connect ─► pool entry "xbroadcast:{id}" (status: connecting, pill shown)
Operator runs: node x-broadcast-worker.mjs <url>
        │
        ▼
  X WORKER (local, headless Chromium — the verified probe, hardened)
   • opens the broadcast anonymously, reads chatman WS frames
   • parseXFrame(): kind:1 → chat {username,displayName,text,ts,uuid}; kind:2 → occupancy
   • batches + POST {token, broadcastId, messages[], occupancy, status, broadcaster}
        │  HTTPS POST /ingest/x
        ▼
  BACKEND  index.js: verify X_INGEST_TOKEN, dedupe by uuid
        │      → hub.routeXChat(broadcastId, msg)      (≈ routeKickChat)
        │      → hub.setXViewers(broadcastId, occupancy)
        │      → hub.setXStatus(broadcastId, status)
        ▼
  pool entry "xbroadcast:{id}".rooms  ─►  each subscribed room ─► its WS client
```

## Components

### 1. Worker — `worker/x-broadcast-worker.mjs` (new, standalone)
- Own `worker/package.json` (`playwright` dep only) so the server stays single-dep.
- Config from env/flags: `BACKEND_HTTP` (e.g. `https://conflux-backend-production.up.railway.app`), `X_INGEST_TOKEN`. Usage: `node x-broadcast-worker.mjs <broadcast-url>`.
- Launches headless Chromium (anonymous, `navigator.webdriver` spoof), opens the broadcast, intercepts the chatman WS via `page.on('websocket')` + `framereceived`.
- Uses the shared pure parser `parseXFrame` (below) to turn frames into normalized chat / occupancy.
- Captures the **broadcaster handle/title** (from the `broadcasts/show` response or page title) and sends it once as the display label.
- **Batches** messages (~1s flush) and POSTs to `/ingest/x`. Sends `occupancy` updates and `status` transitions.
- **Resilience:** on WS close, reload the page to reconnect (X rotates chatman servers); after N failed reconnects or an explicit "ended", POST `status:offline` and exit. If the backend POST fails, queue and retry with backoff (never lose messages on a transient blip). A per-process supervisor restarts a crashed page.

### 2. Shared parser — `server/src/ingesters/xBroadcastParse.js` (new, pure, tested)
- `parseXFrame(raw)` → `{type:'chat', msg:{username,displayName,text,ts,uuid}}` | `{type:'viewers', occupancy}` | `null`.
- Implements the verified 3-layer decode: outer `{kind,payload}` → parse `payload` → parse `body`. **Chat = outer `kind:1`** → innermost `{body→text, username, displayName, timestamp→ts, uuid}`. **Viewers = outer `kind:2`** → inner `kind:4` → `{occupancy}`. Tolerant of missing fields and non-JSON frames (returns `null`).
- Imported by both the worker (relative path) and the server tests — single source of truth.

### 3. URL parsing — `server/src/urlParser.js`
- Detect `x.com/i/broadcasts/{id}` and `twitter.com/i/broadcasts/{id}` → `{platform:'x', source:'xbroadcast', channel:{id}}`.
- All other returns gain `source` defaulting to `platform` (twitch/kick → source===platform; `x.com/{handle}` → `source:'x'`, the existing paid reply-search path, left intact).
- `source` selects the ingester + forms the pool key; `platform` stays `'x'` for color/normalize/UI.

### 4. Pool — `server/src/ingesterPool.js`
- Register `XBroadcastIngester` under `ingesters['xbroadcast']`: a **placeholder** whose `start()` calls `onStatus('connecting')` and does **no capture** (the worker drives real status/chat/viewers) and `stop()` is a no-op. It exists only to hold the ref-counted pool entry open while a room is subscribed.
- `subscribe` keys entries by `source:channel` and selects `ingesters[source]`; fan-out still tags messages with the display `platform` (`'x'`). (Signature carries both `source` and `platform`.)
- Add three methods mirroring `routeKickChat` (key = `'xbroadcast:'+broadcastId`; no broadcaster-map needed since the id *is* the channel):
  - `routeXChat(broadcastId, fields)` → fan `{...fields, poolKey, platform:'x'}` to `entry.rooms` via `room.onMessage`.
  - `setXViewers(broadcastId, n)` → `room.onViewers(key, n)` for each room.
  - `setXStatus(broadcastId, s)` → `room.onStatus(key, s)` for each room.
  - All no-op safely when no entry exists (worker capturing a broadcast no room wants → dropped, logged).

### 5. Room — `server/src/room.js`
- `connect(url)` uses `parsed.source` for the pool key + ingester selection, stores `platform: parsed.platform` and `source: parsed.source` on the stream object (so the frontend can tell a broadcast from a handle). No other change — the existing `onMessage/onViewers/onStatus` callbacks already handle worker-driven events.

### 6. Ingest endpoint — `server/src/index.js`
- `POST /ingest/x`, body `{token, broadcastId, messages?, occupancy?, status?, broadcaster?}`.
  - `X_INGEST_TOKEN` **unset → 503** ("x ingest disabled"): secure by default, unlike the open control gate.
  - `token` mismatch → 401; missing `broadcastId` → 400.
  - **Dedup by `uuid`** via a bounded recent-set (mirrors the Kick `recentKickMessageIds` idempotency). New messages → `hub.routeXChat(broadcastId, {username,displayName,text,ts})`.
  - `occupancy` present → `hub.setXViewers`; `status` present → `hub.setXStatus`; `broadcaster` present → `hub.setXLabel` (**stretch** — see below).
  - Always `200` on success; body-size cap like the Kick handler.
- `hub.js` gains `routeXChat / setXViewers / setXStatus / setXLabel` delegating to the pool. Config (`server/src/config.js`) gains `X_INGEST_TOKEN`.

### 7. Frontend — `conflux.html`
- No change needed to accept the URL (existing `VALID_URL_RE` matches `x.com`).
- **Add:** when a stream with `source:'xbroadcast'` is present, show a one-line, copy-ready command under its pill / in the setup panel: `node x-broadcast-worker.mjs https://x.com/i/broadcasts/{id}` (backend URL + token live in the worker's env, **never rendered** — no token leak). This is the only UI addition.
- **Stretch:** pill label uses the broadcaster label (from `setXLabel`) when present, else the broadcast id (which is functional on its own — core ships without this).

## Data flow & lifecycle
Paste link → `xbroadcast:{id}` entry (status `connecting`, pill). Run worker → first chat/occupancy POST flips status `live`, sets the real viewer count, fans chat into the subscribed room. Room closes (tab/refresh) → entry ref-count drops → linger → removed; later worker POSTs for that id are dropped (logged). Broadcast ends → worker POSTs `status:offline` and exits.

## Reliability / error handling
- **Auth:** ingest requires a configured `X_INGEST_TOKEN`; absent → endpoint disabled. No fake-injection surface.
- **Dedup:** by `uuid`, so history-backlog + live overlap and worker retries never double-post.
- **Backend untouched by the browser:** capture can't crash the proven backend.
- **Worker:** reconnect-on-drop (page reload), restart-on-crash (supervisor), POST retry/queue on transient backend errors, clean `offline` on broadcast end.
- **Isolation preserved:** routing is by `xbroadcast:{id}` to subscribed rooms only — verified the same way as Kick.

## UX
Paste the broadcast link like any platform → copy the shown one-liner → run the worker. Real concurrent-viewer count replaces the X "engagement total" hack for broadcast streams. You start the worker locally before the show; one command per broadcast.

## Out of scope (v1)
- **Handle → live-broadcast auto-resolution** (paste `x.com/8bit` instead of the per-broadcast link) — needs its own verification; deferred. Paste the live broadcast link at showtime.
- **Tier 2** (no-browser handshake replication) — post-submission cleanup.
- **Deploying the worker** to its own cloud service / container — local-run is the reliable demo path.
- The existing paid `XIngester` (handle reply-search) is **left intact** for `x.com/{handle}` URLs; not removed.

## Testing
**Pure unit (`node:test`, server suite):**
- `parseXFrame`: real captured chat frame → `{type:'chat', msg:{text:'gm', username:'zacxbt', displayName:'zac.eth …', ts, uuid}}`; occupancy frame → `{type:'viewers', occupancy:22033}`; malformed/partial frames → `null`.
- `urlParser`: `x.com/i/broadcasts/{id}` → `{platform:'x', source:'xbroadcast', channel:id}`; `x.com/{handle}` → `{platform:'x', source:'x', channel:handle}`.
- Pool: `routeXChat`/`setXViewers`/`setXStatus` reach only rooms subscribed to `xbroadcast:{id}`; unknown id → dropped (no throw). Isolation: a second room on a different broadcast never sees the first's chat.
- Ingest dedup: same `uuid` posted twice → routed once.
**Manual e2e:** run the worker against a live broadcast; paste the link in two browser tabs; confirm chat appears only in the tab(s) that pasted it, the viewer count is real (matches X), and ending the broadcast flips the pill to offline.

## Files
- `worker/x-broadcast-worker.mjs` — new (Playwright capture + POST).
- `worker/package.json` — new (`playwright`).
- `server/src/ingesters/xBroadcastParse.js` — new (pure parser, shared).
- `server/src/ingesters/xBroadcast.js` — new (`XBroadcastIngester` placeholder).
- `server/src/urlParser.js` — add broadcast detection + `source`.
- `server/src/ingesterPool.js` — register `xbroadcast`; `routeXChat`/`setXViewers`/`setXStatus`; key by `source`.
- `server/src/room.js` — use `source` for key/selection; store `source` on stream.
- `server/src/hub.js` — delegate `routeXChat`/`setXViewers`/`setXStatus`/`setXLabel`.
- `server/src/index.js` — `POST /ingest/x` (token-gated, dedup).
- `server/src/config.js` — `X_INGEST_TOKEN`.
- `conflux.html` — show the copy-ready worker command for `xbroadcast` streams; broadcaster label on the pill.
- `server/test/…` — `parseXFrame`, urlParser broadcast case, pool X-routing/isolation, ingest dedup.
