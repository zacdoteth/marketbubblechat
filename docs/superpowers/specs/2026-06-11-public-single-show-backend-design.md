# Public Single-Show Backend (v2) — Design

**Date:** 2026-06-11
**Scope:** Backend (`server/src/`) re-architecture + native chat. Replaces the v1 per-session isolation with one shared public show. Frontend (video/theater/featured display) is zac's deck — out of scope here.
**Status:** v2, post–June-11 submission. The v1 isolated build ships for the challenge as-is; this is the product pivot.

## Why

MarketBubble is pivoting from a *creator-centric private dashboard* to a *public, user-centric streaming app*: MarketBubble.com is ONE shared live show that all visitors watch and chat in. The motivating feature is **native MB chat** (Banks's spec): public visitors type messages that join the unified feed as an `mb` source and are seen by everyone. "Every viewer sees it" is impossible under v1's per-connection isolation, so the room model must change.

This **reverses the v1 session isolation** (each visitor = private blank room). v1 isolation was correct for the old vision; v2 needs the opposite — one shared room everyone joins.

## Approved decisions

- **One shared public show** (not multi-channel). Single canonical show state, broadcast to all.
- **Full pivot (Approach A):** retire per-session isolation; refactor to one singleton show room. Reuse the ingester pool, parsers, stats, and X-broadcast worker.
- **Chat = merged from ALL added streams + native** (`mb`). Video = the one operator-selected *featured* stream.
- **Native chat: auto-assigned guest IDs + server-side rate-limit.** No login, no nickname input.
- **Persistence: Railway Volume (JSON file)** — show config (stream URLs + featured pick) survives restarts; chat history stays ephemeral.

## Architecture

```
                 ┌─────────────── THE SHOW (singleton) ───────────────┐
operator(token) ─┤  streams[] · featuredStreamId · merged buffer      │
   selectFeatured│  · stats · native chat (platform 'mb') · guests    │
   connect/disc  └───────────────────────┬────────────────────────────┘
viewer ─ attach ─────────── join ────────┤  broadcast EVERY event to ALL clients
viewer ─ nativeChat ─────── (rate-limited)┘
   X worker ── GET /x/active (the one show) ── POST /ingest/x ─▶ routed into the show
   Railway Volume ◀── save show config on change / load + re-connect on boot
```

- **One `showRoom` singleton** created at startup. Every WS connection attaches; events broadcast to all (reuses the v1 per-send `bufferedAmount` backpressure guard).
- On connect, a client receives a full snapshot of current state (NOT blank).

## Components

### 1. `showRoom` — `server/src/showRoom.js` (refactor of `room.js`)
The single source of truth. Holds:
- `streams` (Map, operator-added) + `featuredStreamId`.
- `agg` (one merged aggregator — Twitch/Kick/X/native all flow in) + `stats`.
- `guests` (Map<ws, guestId>) + per-connection native rate-limit state.
- `clients` (Set<ws>) for broadcast.

Methods: `attach(ws)` (assign guestId, send snapshot, add to clients), `detach(ws)`, `broadcast(obj)`, `snapshot()` → `{streams:[...], featuredId, messages, stats, guestId}`, plus the operator/native handlers below. The ingester-pool fan-out callbacks (`onMessage/onViewers/onStatus/setLabel`) target this one room (mostly unchanged from v1, minus the per-room translation — there's one room now).

### 2. Roles + guest IDs — `server/src/fanout.js`
- **Operator** = presents `CONTROL_TOKEN`. **`CONTROL_TOKEN` is now REQUIRED** (v1 left it open; that's unsafe once the public can reach the controls). If unset → operator actions are rejected and a loud startup warning is logged.
- **Viewer** = every other connection. Each connection gets `guestId = 'guest-' + <base36 random>` on attach, returned in the snapshot.
- Control messages (`connectStream`, `disconnectStream`, `selectFeatured`, `clearChat`, `slowMode`) require a valid token → else `{type:'error', error:'not authorized'}` to that sender. `nativeChat` is open (rate-limited).

### 3. Featured stream
- State `featuredStreamId`. `{type:'selectFeatured', id, token}` → validate token + that `id` exists → set + broadcast `{type:'featured', id}`. Defaults to the first stream added; cleared/reassigned if that stream is removed.
- Backend only tracks the selection and exposes each stream's `{platform, channel, url}`; the **video embed is the frontend's job** (X-broadcast video embeddability to be verified separately).

### 4. Native chat — `mb` source
- `{type:'nativeChat', text}` from a viewer → backend:
  - **Rate-limit per connection** (default min-interval `NATIVE_SLOWMODE_MS = 2500ms`, configurable; operator `slowMode` adjusts at runtime), **length cap 240**, drop empty/whitespace + identical-consecutive dupes.
  - Allowed → `makeMessage({platform:'mb', streamId:'mb-native', username:guestId, text, ts})` → push to `agg` → `broadcast({type:'message', message})` → counted in stats.
  - Rate-limited → `{type:'error', error:'slow down'}` to that sender only.
- Add `mb` to `PLATFORM_COLORS` (brand blue) in `config.js`; `normalize.js` already coerces text/fields.
- `mb` "viewer count" = number of connected clients (`clients.size`) — a real concurrent-audience metric surfaced in stats (`perPlatform.mb.viewers`).

### 5. Moderation (operator, foundation-level)
- `{type:'clearChat', token}` → clear the merged/native buffer + broadcast `{type:'clear'}` so all clients reset their on-screen feed.
- `{type:'slowMode', seconds, token}` → set the native rate-limit interval at runtime + broadcast the new value (so the UI can show "slow mode: Ns").
- Per-guest mute/ban + profanity filter are explicit **follow-ups**.

### 6. Persistence — `server/src/showStore.js` (new) + Railway Volume
- Volume mounted at `/data` (Railway); path from `SHOW_CONFIG_PATH` (default `/data/show.json`).
- On any operator stream change or featured change → debounced write of `{streams:[{url}], featuredId}` (config only, NOT chat).
- On startup → read the file; **system-re-connect** each stream (internal, no token) into the show room; restore `featuredStreamId`. If the volume/file is missing or unreadable → start empty + log a warning (never crash).

### 7. X-broadcast worker — unchanged, simpler
`GET /x/active` now returns the one show's X-broadcast ids; the cloud worker keeps capturing + `POST /ingest/x` routes into the single show. Token gating unchanged.

## WebSocket protocol

**Server → client:**
- `{type:'snapshot', streams, featuredId, messages, stats, guestId}` (on connect)
- `{type:'streams', streams}` · `{type:'featured', id}` · `{type:'message', message}` · `{type:'stats', stats}` · `{type:'clear'}` · `{type:'slowMode', seconds}` (broadcast)
- `{type:'error', error}` (to one client: rate-limit / unauthorized)

**Client → server:**
- Operator (token): `{type:'connectStream', url, token}` · `{type:'disconnectStream', id, token}` · `{type:'selectFeatured', id, token}` · `{type:'clearChat', token}` · `{type:'slowMode', seconds, token}`
- Viewer (open, rate-limited): `{type:'nativeChat', text}`

## Reliability / error handling
- **CONTROL_TOKEN required:** unset → operator actions rejected (show is read-only/native-only) + loud warning. Prevents random visitors from controlling the public show.
- **Native abuse:** per-connection rate-limit + length cap + dupe-drop; offending sender notified, never the whole room. (Heavier moderation is a follow-up.)
- **Persistence failure:** volume unavailable → in-memory only + warning; never crash.
- **Restart recovery:** reload config from the volume, re-connect streams, restore featured; reconnecting clients get the restored snapshot.
- **Broadcast safety:** retain the per-send `bufferedAmount` cap so one stuck client can't OOM the process; malformed frames can't crash the process (existing guards).
- **XSS:** backend caps/stores raw text; the frontend MUST escape on render (note for zac).

## Out of scope (separate specs / follow-ups)
- Per-guest mute/ban, profanity/spam ML filtering.
- Multi-show / channels / discovery.
- Login / accounts / persistent identity.
- **Video embedding + theater UI** (zac's frontend) — including verifying X-broadcast video can embed.

## Migration from v1
- `room.js` (per-connection) → `showRoom.js` (singleton). `fanout.js` rewired to attach all connections to the one room with role gating + guest IDs.
- `ingesterPool.js` keeps the pool but there is effectively one subscriber (the show room); `routeXChat`/`setX*` target the show room. `/x/active` returns the show's X broadcasts.
- The v1 isolation tests (`room.test.js`, `fanout_isolation.test.js`, parts of `hub.test.js`/`xBroadcast.test.js`) are **reworked** into shared-room tests. Pure-logic tests (parsers, `normalize`, `stats`, `aggregator`, `parseXFrame`) are unaffected.

## Testing
- **Shared room:** two clients connect → both receive the same streams/messages/featured; a message from the ingesters reaches *all* clients.
- **Roles:** viewer (no token) `connectStream`/`selectFeatured` → rejected; operator (token) → applied + broadcast.
- **Native chat:** viewer `nativeChat` → broadcast to all as `platform:'mb'` under their `guestId`; exceeding the rate-limit → dropped + `error` to that sender only; length capped at 240.
- **Featured:** `selectFeatured` valid id → broadcast `featured`; invalid id → rejected; removing the featured stream reassigns/clears it.
- **Persistence:** save config → simulate restart (fresh store load) → streams re-connected + featured restored; missing file → clean empty start.
- **X worker:** `/x/active` returns the show's X ids; `routeXChat` reaches all clients.
- **Guest IDs:** each connection gets a distinct `guest-…`; native messages carry it.

## Files
- `server/src/showRoom.js` — new (singleton show; replaces `room.js`).
- `server/src/showStore.js` — new (Railway Volume load/save of show config).
- `server/src/fanout.js` — rewrite: one room, attach-all, role gating, guest IDs, new message types.
- `server/src/hub.js` / `ingesterPool.js` — target the single show room; `/x/active` unchanged.
- `server/src/config.js` — `CONTROL_TOKEN` required; `NATIVE_SLOWMODE_MS`, `SHOW_CONFIG_PATH`; `PLATFORM_COLORS.mb`.
- `server/src/index.js` — startup: load show config + re-connect; CONTROL_TOKEN warning.
- `server/src/room.js` — removed (superseded by `showRoom.js`).
- `server/test/…` — rework isolation tests → shared-room/role/native/featured/persistence tests.
- **Railway:** add a Volume mounted at `/data` to the backend service; set `CONTROL_TOKEN`, `SHOW_CONFIG_PATH`.
