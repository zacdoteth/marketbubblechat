# CONFLUX — Real-Time Multi-Platform Chat Aggregator: Architecture Design

**Date:** 2026-06-08
**Project:** Market Bubble $10,000 Vibe Code Challenge submission
**Deadline:** June 11, 2026 (3 days out)
**Deliverable repo:** `marketbubblechat` (branch `conflux-realtime`, built on `zacdoteth/conflux-html-review`)
**Status:** Design — approved decisions captured; pending user review before implementation plan.

---

## 1. Goal

A **unified, real-time live-chat + viewer aggregator** for crypto streamers who simulcast across platforms. It merges **every chat into one feed** and **every stat into one place**, with **specific per-source labeling** of who each message comes from.

Two co-hosts (**@Banks + @Z**) run a collab podcast/stream simultaneously across **Twitch, Kick, and X**. Their audiences are fractured across platforms; this tool fuses them.

### The canonical brief (from the three requirement sources)

From **Banks's review**, the **challenge brief**, and the **C-suite iMessage**:

1. **Specific labeling** of who each message is from (which platform + which co-host).
2. **Banks + Z both stream on X** → X is a first-class source.
3. **Combined viewer count** display, with **hover to see where each viewer is coming from** (per-source breakdown).
4. **Native chat that lives on marketbubble.com** — a real shared room site viewers chat in.
5. **A streamer dashboard** to see the entire chat + all viewers, **and** a viewer **Watch mode**.
6. **Elite, very-easy-to-use UI; "stream-friendly"** = a great **streamer control cockpit**.
7. Pull viewers + chatters into **the main shared chat**.

### Hard requirement set by the user (this session)

- **Everything REAL. Strictly. No simulation, no faked feeds.**
- **No login anywhere** — neither for ingesting platform chat nor for the native room.
- **Seamless connect UX:** the streamer just **pastes their stream links** across platforms.
- **Collab-native:** the **same platform must support 2 different streams** (two Twitch channels, two X accounts, etc.), because the show is always two co-hosts.
- **Stats maximally detailed:** every platform individual, every stream individual.
- **Watch mode = a visualization of comments flowing in from the different platforms** (the particle river) — **not** an embedded video player.

---

## 2. Feasibility ground truth (verified 2026-06-08, no assumptions)

This is *why* the architecture is shaped the way it is. All facts below were verified live, not assumed.

| Platform | Live chat without login | Viewer count without login | Browser-direct? |
|---|---|---|---|
| **Twitch** | ✅ Anonymous `justinfan` IRC over `wss://irc-ws.chat.twitch.tv:443` | ✅ Public GQL (`gql.twitch.tv/gql`, public Client-ID) or DecAPI, CORS-open | ✅ Fully client-side capable |
| **Kick** | ✅ Pusher WS `wss://ws-us2.pusher.com` (key `32cbd69e4b950bf97679`), channel `chatrooms.{id}.v2`, event `App\Events\ChatMessageEvent` | ✅ `livestream.viewer_count` from channel API | ⚠️ Chat = browser-direct, **but** slug→`chatroom_id` lookup (`kick.com/api/v2/channels/{slug}`) is **CORS + Cloudflare-blocked** → needs a server with browser-impersonation (`curl_cffi`/Playwright) or hardcoded stable IDs |
| **X / Twitter** | ❌ **No public real-time chat exists** (Periscope chat dead; Spaces has no text; X-Live comments are just replies). True push stream = X API **Pro $5,000/mo** | ⚠️ **No real concurrent count** (X shows cumulative only). Engagement counts (likes/replies) free via `cdn.syndication.twimg.com` | ❌ **Needs backend** (token can't touch browser, no CORS) |

### The X path (verified, locked)

- X API **pay-as-you-go is the default for new developers** (since Feb 6 2026): no monthly minimum, pre-load credits, settable spending cap.
- **`GET /2/tweets/search/recent` (7-day) IS included on pay-go** — **✅ VERIFIED LIVE 2026-06-08** against the project's own pay-go key (`HTTP 200`, real results). No longer an assumption.
- **Token gotcha (verified):** the project's Bearer token must be sent **verbatim as displayed** — it contains literal `%2B`/`%3D` sequences and must **NOT** be URL-decoded (decoding → `401`; raw → `200`).
- Poll `query=(to:Banks OR to:Z) -is:retweet`, `max_results=100`, with `since_id` to fetch only new replies. Rate limit **450 req/15 min** (1 every 2s) → **10s polling has 5× headroom**.
- **Cost for a 30-min demo: ~$5 realistic, ~$90 worst-case. Cap at $25.**
- **Catches:** (a) it's **polling** (~seconds latency), not push; (b) token must stay **server-side** (no CORS); (c) **provision the X dev account + credits on Day 1** — key approval is not guaranteed-instant.

### Consequences that force the architecture

- A **server/backend is mandatory** — for the X token, for Kick's Cloudflare-gated lookup, and for a *single shared* native room.
- The codex's old "one file, no backend, no build" constraint was correct for a **simulation** but **cannot deliver strictly-real cross-platform chat**. It is **explicitly overridden** for this build.

---

## 3. Architecture

**Shape:** one backend **aggregator** ingests all sources, merges them into a single canonical stream, and **fans that one stream out** to every connected client. The frontend is a thin, polished UI holding no secrets.

```
┌──────────────────────── FRONTEND (static, Vercel) ─────────────────────────┐
│  CONFLUX app — one polished UI, two modes:                                  │
│   • DASHBOARD  (streamer cockpit): full unified chat + detailed per-stream  │
│                stats + the "paste your links" connect panel                 │
│   • WATCH      (public viewer):    particle-river VISUALIZATION of comments │
│                flowing in per-platform + the shared combined chat           │
│  Holds NO API keys. One WebSocket to the backend. Anonymous handle only.    │
└──────────────▲───────────────────────────────────────────────┬────────────┘
   unified feed │ + live stats + shared-chat history     native │ messages,
   (one canonical ordered stream, fanned out to ALL)     connect/disconnect
                │                                                ▼  streams
┌────────────── BACKEND aggregator (always-on Node host) ────────────────────┐
│  PER-STREAM INGESTERS (N streams, 2+ allowed per platform):                │
│    Twitch ingester → justinfan IRC WS per channel  + GQL viewer count       │
│    Kick   ingester → slug→id (Cloudflare bypass), Pusher WS + viewer_count   │
│    X      ingester → poll search/recent (to:@handle) per X account, since_id │
│    Native room     → shared chat, anonymous handles, light anti-spam        │
│  ─────────────────────────────────────────────────────────────────────────│
│  NORMALIZE  → every message → common schema, tagged {platform, streamer}    │
│  MERGE      → one ordered unified feed (ring buffer of last ~100 msgs)       │
│  STATS      → per-stream + per-platform + per-streamer + combined totals     │
│  FAN-OUT    → broadcast the SAME canonical stream + stats to all clients     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Hosting

- **Frontend:** Vercel (static).
- **Backend:** an **always-on Node host** (Railway / Render / Fly). *Not* Vercel serverless — serverless functions cannot hold long-lived IRC/Pusher/WebSocket connections.
- Two small deploys. The X API key + any Kick-bypass config live only in backend env vars.

---

## 4. Components (each: what it does · interface · depends on)

### 4.1 Stream registry (backend, in-memory)
- **What:** the list of active streams. Each entry: `{ id, platform, channel, streamerLabel, url, status }`. Supports **multiple streams per platform**.
- **Interface:** `addStream(url, streamerLabel)`, `removeStream(id)`, `listStreams()`. Mutated by the connect panel over the control WebSocket; broadcast to all clients so every dashboard shows the same connected set.
- **Depends on:** URL parser (4.2).

### 4.2 URL parser ("paste your links")
- **What:** turns a pasted URL into `{ platform, channel }`. Recognizes `twitch.tv/<ch>`, `kick.com/<ch>`, `x.com|twitter.com/<handle>`. Rejects/labels unknown hosts.
- **Interface:** `parse(url) → { platform, channel } | { error }`.
- **Depends on:** nothing.

### 4.3 Platform ingesters (one instance per stream)
- **Twitch:** opens an anonymous `justinfan` IRC WS, `JOIN #channel`, parses tagged `PRIVMSG` → `{username, displayName, color, text}`. Replies to `PING` with `PONG`. Auto-reconnect. Viewer count via GQL `viewersCount` (poll ~20s), DecAPI fallback.
- **Kick:** resolves slug→`chatroom_id` (server-side, Cloudflare bypass; cache the id), opens the shared Pusher WS, subscribes `chatrooms.{id}.v2`, parses `ChatMessageEvent` (double-JSON) → `{username, text, ts}`. Viewer count from `livestream.viewer_count` (poll ~20s). Auto-reconnect.
- **X:** every ~10s, `GET /2/tweets/search/recent?query=(to:<handle>) -is:retweet&since_id=<last>&max_results=100&tweet.fields=created_at,author_id,conversation_id`, expand `author_id` → username. Emits new replies as messages. Tracks `since_id`. "Live" stat = X total (per §6).
- **Common interface:** each ingester emits `onMessage(normalized)` and `onStats({streamId, viewers, ...})`; exposes `start()`/`stop()`. **Failure-isolated:** one stream erroring never affects the others.

### 4.4 Normalizer
- **What:** maps any platform payload to the common message schema (§5). Assigns `source` label = `{platform, streamer}`. Assigns a fallback color per platform if none.
- **Interface:** `normalize(raw, streamMeta) → Message`.

### 4.5 Aggregator + ring buffer
- **What:** receives all normalized messages, stamps a monotonic server sequence number for canonical ordering, keeps the **last ~100** in memory for new-joiner history.
- **Interface:** `push(Message)`, `recent() → Message[]`.

### 4.6 Stats engine
- **What:** maintains live counters: **per stream** (viewers, msgs/min), aggregated **per platform**, aggregated **per streamer** (Banks vs Z), and **combined totals**. Powers the hover-breakdown.
- **Interface:** `snapshot() → StatsModel` (§5), pushed to clients on a fixed cadence (~1–2s).

### 4.7 Native shared room
- **What:** the marketbubble.com chat. A site viewer **picks a handle** (no login, stored in `localStorage`), posts over the WebSocket; the message is normalized as `platform: "mb"` and merged into the same canonical feed everyone sees. **Light anti-spam:** per-connection rate limit (~1 msg/2s) + max length (~280). Live **site-viewer count** = number of connected WebSocket clients (a real concurrent number).
- **Interface:** `post(handle, text, connId)`; broadcasts to all.

### 4.8 Fan-out (real-time transport)
- **What:** a single WebSocket server. On connect, sends `{ streams, recentMessages, stats }`. Thereafter pushes `message`, `stats`, and `streams` events. **SSE is the documented fallback** if WS hosting is troublesome (one-way; native posts then go over a POST endpoint).
- **Interface:** client receives a typed event stream; sends `post` and `connect/disconnect stream` control messages.

### 4.9 Frontend modes
- **Dashboard (streamer cockpit):** the existing CONFLUX chat panel made real + the **detailed stats panel** (per-stream / per-platform / per-streamer / combined) + the **connect panel** (paste links, manage the 2-per-platform collab set). Easy, dense, readable.
- **Watch (public viewer):** the **Three.js particle-river visualization** of comments arriving per platform (each platform its color; each message fires particles) + the shared combined chat + composer. No video embed.

---

## 5. Data model

```ts
// One chat message, canonical across all sources
Message = {
  id: string            // backend-assigned
  seq: number           // monotonic server sequence (canonical order)
  streamId: string      // which connected stream produced it (null for "mb")
  platform: "twitch" | "kick" | "x" | "mb"
  streamer: string      // co-host label, e.g. "Banks" | "Z" | "" (mb)
  username: string
  displayName: string
  color: string         // platform fallback if source gives none
  text: string
  ts: number            // epoch ms
}

// A connected source
Stream = {
  id: string
  platform: "twitch" | "kick" | "x"
  channel: string       // channel/handle parsed from the pasted URL
  streamerLabel: string // "Banks" | "Z"
  url: string
  status: "connecting" | "live" | "offline" | "error"
}

// Detailed stats (maximally broken out)
StatsModel = {
  combined: { viewers: number, msgsPerMin: number }
  perStream:   Record<streamId, { viewers: number, msgsPerMin: number, status }>
  perPlatform: Record<platform, { viewers: number, msgsPerMin: number }>
  perStreamer: Record<streamerLabel, { viewers: number, msgsPerMin: number }>
  site: { viewers: number }   // native concurrent site viewers (real)
}
```

**X stat note:** X has no real concurrent-viewer figure. Per the user's decision, X's number is shown as **"live" using the total X exposes** (cumulative / engagement-derived). It is included in `perPlatform.x` and the combined total. The spec records that this figure is total-based, not concurrent — a deliberate, user-approved choice.

---

## 6. Stats & viewer-count behavior

- **Combined viewer count** (header) = sum of all per-stream concurrent counts (Twitch GQL, Kick API) + **site viewers** (real) + **X (total-as-live)**.
- **Hover the combined count** → breakdown by **platform and by stream** (e.g. "Twitch: Banks 5.2k / Z 3.1k · Kick: Banks 4.8k · X: 1.2k(total) · Site: 340").
- **Per-stream rows** in the dashboard: each connected stream shows its own viewers + msgs/min + live/offline status.
- **msgs/min** measured from the real merged feed.

---

## 7. Connect UX ("paste your links")

1. Streamer opens Dashboard → **Connect** panel.
2. Pastes a URL (or several). Parser detects platform + channel; streamer assigns a **co-host label** (Banks / Z) — defaulted, editable.
3. **Same platform twice is supported** (two Twitch, two X, etc.) — the registry keys on `streamId`, not platform.
4. Backend spins up the matching ingester; status flips `connecting → live/offline`. All connected dashboards update (shared registry).
5. Disconnect removes the ingester and its stats.
6. **No seeded streams** (decided). The dashboard opens directly to the connect panel; a demo always begins by pasting links — any live channel, strictly real, zero stale config.

---

## 8. No-login / privacy

- **Zero auth** in the entire chat path: Twitch (anonymous IRC), Kick (anonymous Pusher), X (app token server-side — not a *user* login), native room (pick-a-handle).
- No personal data stored. Native handles live in the visitor's `localStorage`; the backend keeps only an in-memory ring buffer that resets on restart.

---

## 9. Error handling & fail-safe

- **Per-source isolation:** every ingester is independent. A Twitch outage, a Kick Cloudflare block, an X rate-limit, or a quiet stream **never breaks the others or the feed**.
- **Auto-reconnect** on all sockets (Twitch IRC, Kick Pusher, client WS), with backoff.
- **X spending cap** set in the X console; backend also guards poll cadence.
- **Frontend degradation:** if WebGL/Three.js fails, the chat + stats still work (visualization is enhancement, never a dependency). If the backend is unreachable, the UI shows a clear reconnecting state.
- **Demo resilience:** "connect any live channel" keeps the demo strictly-real even if Banks/Z aren't live during judging.

---

## 10. Cost

- **X API:** ~$5 for a 30-min demo (cap $25). Everything else (Twitch, Kick, native, hosting on free tiers) is **$0**.
- **Total expected:** well under $25.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| ~~X dev key not provisioned in time~~ | **✅ RESOLVED 2026-06-08** — pay-go key provisioned with $5 credits; `search/recent` verified returning 200. Use Bearer verbatim (do not URL-decode). |
| Kick `slug→id` Cloudflare-blocked from serverless IPs | Use `curl_cffi`-style browser impersonation on the backend; cache the stable id; fall back to hardcoded ids for the known channels. |
| Twitch anonymous IRC is undocumented / could change | Works today; isolated behind the ingester interface; EventSub (needs login) is the only sanctioned successor — note but don't build now. |
| X "live" number is total, not concurrent | Labeled honestly; user-approved. Pair with real engagement (replies/min). |
| Backend single point of failure for chat | Acceptable for a demo; auto-reconnect + clear UI state; per-source isolation limits blast radius. |
| 3-day clock | Frontend ~80% exists (the current `conflux.html`); the new work is the backend + wiring the UI to real data. Build order in §13. |

---

## 12. Out of scope (YAGNI for this submission)

- Database / durable chat history (in-memory ring buffer only).
- OBS transparent overlay output mode (user did not want it).
- Embedded video player in Watch mode (user wants the visualization instead).
- Accounts, profiles, DMs, moderation tools beyond basic rate-limit/length.
- Quote-tweets / X Spaces ingestion (replies only for X).
- Multi-tenant / multiple simultaneous shows.

---

## 13. Build order (3-day shape — detail comes in the implementation plan)

1. **Backend skeleton** + fan-out WS + native shared room (proves the shared feed end-to-end).
2. **Twitch + Kick ingesters** (free, real) → real merged feed + real per-stream stats.
3. **X ingester** (once the key is provisioned) → real X replies.
4. **Connect panel** (paste links, 2-per-platform) wired to the registry.
5. **Frontend rewire:** point the existing CONFLUX UI at the real WebSocket; detailed stats panel; hover breakdown.
6. **Watch-mode visualization** polish; failure-mode + demo-resilience pass; deploy.

---

## 14. Open items to confirm with the user

- ~~X dev key~~ — **✅ done** (pay-go key with $5 credits, verified live).
- ~~Backend host~~ — **✅ Railway** (decided).
- ~~Seed handles~~ — **✅ none** (decided): opens to the connect panel; paste links at demo time.
- ~~Native-room persistence across restarts~~ — **✅ no** (decided): in-memory ring buffer only.

All open items resolved — spec is implementation-ready.

## 15. Secrets handling

- X credentials are **never** committed. They live only in the backend host's env / a **gitignored `.env`** (added to `.gitignore` before the backend is created).
- Frontend never contains any platform secret — it talks only to our backend.
- Only the **Bearer token** is needed (app-only auth for `search/recent`); Consumer Key/Secret are not deployed.
- Credentials shared in plaintext during planning should be **regenerated after the challenge**.
