# CONFLUX Session Isolation — Design

**Date:** 2026-06-09
**Scope:** Backend (`server/src/`), with near-zero frontend change. Supersedes the single-global-room model for `hub.js` / `fanout.js`.
**Origin:** User asked "if 2 people use it at the same time with different streams, won't it get confused?" and "on each refresh we should get a blank dashboard with no pre-added streams." Both trace to the same root cause.

## Problem

The backend is a **single global room**:
- `hub.js` holds **one** registry, **one** aggregator, **one** stats object for the whole process.
- `fanout.js` `broadcast()` sends every `message` / `streams` / `stats` event to **all** connected clients.
- On connect, every client receives `hub.snapshot()` = **all** streams anyone ever added.

Consequences:
1. **No isolation.** Two independent operators adding different streams see each other's streams merged into one feed. Two shows collide.
2. **Refresh is never blank.** Streams live on the server globally (the browser only persists the control token in `localStorage`, not streams), so every refresh replays the global stream list back to the client.

Both are fixed by **per-session isolation**: each WebSocket connection is its own private room.

## Decisions (user-approved)

- **Session model: strict per-session rooms.** Each WS connection = one isolated room. No shareable room links / room codes (user chose "one dashboard per show"). A bare visit/refresh always starts an empty room.
- **Implementation: Approach 1 — shared, ref-counted ingester pool.** Rooms are isolated logically, but the real upstream connections (Twitch IRC, X poller, Kick subscription) live in one global pool keyed by `platform:channel` and ref-counted by rooms. Keeps cost flat regardless of how many sessions watch the same channel (critical for the paid X API).
- **Idle-linger grace period** on pool entries so a refresh that re-adds the same channel reuses a warm connection instead of churning.
- **`CONTROL_TOKEN` stays** — now purely a cost-abuse gate (without it anyone with the URL could spin up paid X pollers), not an isolation mechanism.

## Architecture

### Components

```
WS connection ──┐
WS connection ──┼─► Fanout ──► Room (per WS)  ─┐
WS connection ──┘                              │  each room: own streamSet, aggregator, stats
                                               │
                                  Room.connect(url) / Room.disconnect(streamId)
                                               │
                                               ▼
                                   IngesterPool (global, ref-counted)
                                   Map<"platform:channel", PoolEntry>
                                     PoolEntry = { ingester, rooms:Set<Room>,
                                                   channel, platform,
                                                   broadcasterUserId?, lingerTimer? }
                                               │  fan-out callbacks
                                               ▼
                              Twitch IRC / X poller / Kick API+webhook (one each per channel)
```

### 1. Room (`server/src/room.js` — new)

A `Room` owns the per-session view. Created on WS connect, destroyed on WS close.

State:
- `ws` — the owning socket.
- `streams` — `Map<streamId, { id, platform, channel, status, poolKey }>` (this room's view).
- `agg` — its own aggregator (`createAggregator({ max: 100 })`).
- `stats` — its own stats (`createStats()`).

Methods:
- `connect(url)` → parse via `parseStreamUrl`; on parse error return `{ error }`. De-dupe within the room (same platform+channel already present → return existing). Allocate a room-local `streamId`, register in `stats`, then call `pool.subscribe(platform, channel, this)`. Returns `{ stream }`.
- `disconnect(streamId)` → look up the stream's `poolKey`, call `pool.unsubscribe(poolKey, this)`, remove from `streams` + `stats`.
- `destroy()` → for every stream, `pool.unsubscribe(poolKey, this)`; clear local state. Called on WS close.
- `snapshot()` → `{ streams:[...this.streams.values()], messages: agg.recent(), stats: stats.snapshot(now) }` (empty for a fresh room).
- `statsSnapshot()` → `stats.snapshot(now)`.
- `streamIdFor(poolKey)` → returns this room's local `streamId` for a `poolKey` (1:1 within a room, since channels are de-duped per room), or `undefined` if not subscribed. Used by the pool to translate a fanned-out event into this room's id.

Per-room callbacks the pool invokes (one room may receive the same upstream event as siblings):
- `onMessage(fields)` → `makeMessage`, push to this room's `agg`, record in this room's `stats` if the stream is still registered, send `{type:'message', message}` to this room's `ws`.
- `onViewers(poolKey, n)` → set viewers for the matching room-local streamId in this room's `stats`.
- `onStatus(poolKey, status)` → update the matching room-local stream's status, send a `streams` event to this room.
- `onResolved(poolKey, broadcasterUserId)` → no per-room action needed (broadcaster→pool mapping lives in the pool); kept for symmetry/logging.

Because every room maps a `poolKey` to its **own** streamId, the pool fans out by `poolKey` and each room translates to its local id.

### 2. IngesterPool (`server/src/ingesterPool.js` — new)

Global, single instance. Owns the real ingesters and ref-counts rooms.

`Map<poolKey, PoolEntry>` where `poolKey = `${platform}:${channel}``.

`PoolEntry`:
- `platform`, `channel`
- `ingester` — the running ingester instance
- `rooms` — `Set<Room>`
- `broadcasterUserId` — set when Kick resolves it (`onResolved`)
- `lastStatus`, `lastViewers` — last-known status/viewer count, stored so a room joining an existing entry can be replayed the current state instead of being stuck on "connecting"
- `lingerTimer` — set when `rooms` is empty and we're waiting out the grace period

Methods:
- `subscribe(platform, channel, room)`:
  - `key = platform+':'+channel`.
  - If entry exists: cancel any `lingerTimer`, add `room` to `rooms`, and **immediately replay current status/viewers** to the joining room so it isn't stuck on "connecting" (push last-known status + viewers if available).
  - Else: create the ingester with **pool-level** callbacks that fan out to `entry.rooms`:
    - `onMessage(m)` → for each room in `entry.rooms`: `room.onMessage({ ...m, poolKey:key, platform, streamId: room.streamIdFor(key) })`. (Room resolves its own streamId.)
    - `onViewers(n)` → store `entry.lastViewers=n`; for each room: `room.onViewers(key, n)`.
    - `onStatus(s)` → store `entry.lastStatus=s`; for each room: `room.onStatus(key, s)`.
    - `onResolved(bid)` → `entry.broadcasterUserId=String(bid)`; index `broadcasterToKey.set(String(bid), key)`.
  - `await ingester.start()` before returning (so the broadcaster mapping is populated before the first Kick webhook — preserves the existing fix).
- `unsubscribe(key, room)`:
  - Remove `room` from `entry.rooms`. If `rooms` now empty, start a `lingerTimer` (~20s, `unref`'d). When it fires and `rooms` is still empty: `await ingester.stop()`, delete `broadcasterToKey` for its broadcaster, delete the entry.
- `broadcasterToKey` — `Map<broadcasterUserId, poolKey>` for webhook routing.
- `routeKickChat(broadcasterUserId, fields)`:
  - `key = broadcasterToKey.get(String(broadcasterUserId))`; if none, drop (log "unknown broadcaster").
  - `entry = map.get(key)`; for each room in `entry.rooms`: `room.onMessage({ ...fields, poolKey:key, platform:'kick', streamId: room.streamIdFor(key) })`.

Note: the existing `kickByBroadcaster` Map (broadcaster → set of streamIds) is replaced by `broadcasterToKey` (broadcaster → poolKey) + per-room streamId translation. Collabs / same channel in multiple rooms are handled by `entry.rooms` fan-out.

### 3. Idle-linger grace period

Constant `INGESTER_LINGER_MS = 20000`. On last room leaving an entry, the ingester stays warm for the grace window. A refresh (close → reopen) that re-adds the same channel within the window cancels the timer and reuses the live connection — no Twitch rejoin, no Kick webhook unsub/resub storm. Timer is `unref`'d so it never holds the process open during shutdown.

### 4. Fanout changes (`server/src/fanout.js`)

- On `connection`: create a `Room` bound to this `ws`, store it (e.g. `ws._room = room`), send `{type:'snapshot', ...room.snapshot()}` (empty).
- On `message`: `connectStream` / `disconnectStream` operate on **this ws's room** (`ws._room`). Control-token gate unchanged (`mayControl`).
- On `close` / `error`: `room.destroy()` and drop the reference.
- Remove the global `broadcast()`. Rooms send to their own `ws` directly (a small `send(ws, obj)` helper, keeping the `bufferedAmount` backpressure guard per send).
- Periodic stats tick (1.5s): iterate all live rooms, send each `{type:'stats', stats: room.statsSnapshot()}`.

### 5. Hub (`server/src/hub.js`)

`createHub` is reduced to **wiring**: it owns the single `IngesterPool` and exposes `routeKickChat(...)` for the webhook receiver in `index.js`. Room creation/lifecycle moves to `fanout.js`. The hub no longer owns a global registry/aggregator/stats (those are per-room). `index.js`'s `hubRef.handleKickChat(...)` becomes `hubRef.routeKickChat(...)` (delegates to the pool).

### 6. Frontend (`conflux.html`)

No structural change required — it already renders purely from server `snapshot` / `streams` / `message` / `stats`, and persists only the control token. Empty per-room snapshot → blank-on-refresh falls out for free. Existing empty-state copy ("No streams yet — paste a link above to start.") already covers the blank state. **No edits planned unless manual testing reveals a stale assumption.**

## Data flow (per room)

`WS connect → Room created → snapshot {streams:[], messages:[], stats:empty}` → blank UI.
`connectStream(url) → room.connect → pool.subscribe → (new) ingester.start | (existing) replay status+viewers → streams event (this room only)`.
Upstream `message/viewers/status` → pool fans out to `entry.rooms` → each room records locally + sends to its own ws.
Kick webhook → `index.js` → `hub.routeKickChat` → `pool.routeKickChat` → `entry.rooms` fan-out.
`WS close/refresh → room.destroy → pool.unsubscribe per stream → ref-counts drop → idle ingesters stop after linger`.

## Error handling / fail-safe

- Parse error → `{error}` returned to the connecting room only (existing `type:'error'` path).
- Ingester `start()`/`stop()` wrapped in try/catch (existing pattern), never crash the room or process.
- A callback firing after a room is destroyed: room methods no-op when the stream/streamId is gone (existing "record only if still registered" guard, applied per room).
- Pool entry deletion is idempotent; `unsubscribe` on an unknown key/room is a no-op.
- Webhook for an unknown broadcaster (no `broadcasterToKey` entry) is dropped with a warning and still acked 200 (no retry storm) — unchanged.
- Per-send `bufferedAmount` backpressure guard retained so a slow client can't OOM the process.
- Process-level `unhandledRejection` / `uncaughtException` guards unchanged.
- Graceful shutdown: iterate rooms → `destroy()` (releases pool refs) → pool stops all ingesters (Kick unsubscribe). Linger timers are `unref`'d so they don't block exit.

## Scalability notes (the "is it scalable?" answer)

- Same channel watched by N sessions → **1** upstream ingester (1 paid X poll cadence, 1 Twitch join, 1 Kick sub), fanned out to N rooms. Cost is per-distinct-channel, not per-session.
- Still a single in-memory process (no horizontal scaling — two instances would split state and double Kick webhooks). Acceptable for the challenge's scale; documented as the known ceiling. Out of scope to fix now.
- Per-room memory is bounded (aggregator max 100 + small stats). Closed rooms are torn down on WS close. Optional hard cap on concurrent rooms can be added later if abuse appears (not in this scope).

## Testing

**Unit (`node:test`):**
- Pool ref-counting: 2 rooms subscribe same channel → ingester created once; one unsubscribes → ingester still running; both unsubscribe → ingester stops **after** linger window (use an injectable timer/clock so the test doesn't wait 20s).
- Linger reuse: unsubscribe then re-subscribe same channel within the window → same ingester instance, timer cancelled, no stop/start.
- Room isolation: a message emitted for channel in room A is recorded in A's stats/agg and **not** in room B (B subscribed to a different channel).
- Kick routing: `routeKickChat(bid, …)` reaches only rooms whose pool entry resolved that broadcaster; unknown bid → dropped.
- Teardown: `room.destroy()` releases every pool ref; an entry with no rooms stops (after linger).
- Pure-logic tests (parsers, `normalize`, `stats`, `aggregator`) are unaffected and must still pass.

**Manual (Playwright, against the live backend):**
- Two tabs, different streams each → each sees only its own streams/stats. Refresh tab 1 → it goes blank; tab 2 unaffected.
- Same channel added in both tabs → backend logs show a single ingester; both tabs receive messages.
- Refresh a tab that had streams → blank dashboard, no pre-added streams.
- Kick chat still arrives (webhook routing) for a live Kick channel.

## Out of scope

- Shareable room links / room codes (user chose one-dashboard-per-show).
- Horizontal scaling / multi-instance state sharing.
- Frontend redesign (only touched if testing exposes a stale assumption).
- Persisting/restoring a session's streams across refresh (explicitly want blank).

## Files

- `server/src/room.js` — new (Room).
- `server/src/ingesterPool.js` — new (shared ref-counted pool + Kick routing + linger).
- `server/src/hub.js` — reduced to pool ownership + `routeKickChat` delegate.
- `server/src/fanout.js` — per-WS room lifecycle, per-room send, per-room stats tick.
- `server/src/index.js` — `handleKickChat` → `routeKickChat`; shutdown iterates rooms.
- `server/test/…` — rework hub/fanout tests for rooms; add pool tests.
- `conflux.html` — no change planned.
