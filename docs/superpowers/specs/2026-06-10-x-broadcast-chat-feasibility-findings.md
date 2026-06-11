# X Live Broadcast Chat — Feasibility Findings

**Date:** 2026-06-10
**Status:** ✅ VERIFIED FEASIBLE — **not built** (paused by decision; this is a research record for a future build).
**Method:** Live captures with a throwaway Playwright probe against real X Live Broadcasts.

## The question

Can we capture **live X Live-Broadcast chat** (the Periscope-style scrolling chat overlay on `x.com/i/broadcasts/{id}`) for free, without paying the X API and ideally without login? This is **different content** from what the current `XIngester` pulls — that one polls `api.x.com/2/tweets/search/recent` with `query=(to:<handle>)`, i.e. **replies to a handle**, not broadcast chat.

## Verified result (real data, anonymous / logged-OUT)

An anonymous headless browser viewing a live broadcast **receives the live chat** over the Periscope "chatman" WebSocket. Confirmed on a ~22,000-viewer broadcast (`1qGoNNwBAzvKv`) by passively capturing real organic messages — e.g. `gm` from **@zacxbt**, `😀😀` from **@shellistonnn** — plus the `history` backlog and the live viewer count (22,033). **No login, no API key, no payment, nothing sent.**

Quiet rooms (e.g. a 50-viewer broadcast) showed **only occupancy frames** — not an anonymous limitation, just nobody typing. On a busy room it all flows.

## Handshake (all returned 200 anonymously)

1. `GET  api.x.com/1.1/broadcasts/show.json?ids={broadcast_id}` → media_key
2. `GET  api.x.com/1.1/live_video_stream/status/{media_key}` → chat access info
3. `POST proxsee-cf.pscp.tv/api/v2/accessChatPublic` → `{ endpoint, access_token, channel, room_id, read_only:true, replay_endpoint, signer_token, ... }`
4. WS open: `wss://prod-chatman-ancillary-{region}.pscp.tv/chatapi/v1/chatnow`
5. REST backlog: `{endpoint}/chatapi/v1/history` → `{ messages:[...], cursor }`
6. Keepalive: `proxsee.pscp.tv/api/v2/startPublic`, `…/pingPublic`

**Subscribe frames the client SENDS on the WS:**
```
{"payload":"{\"access_token\":\"…\"}","kind":2}                         // auth
{"payload":"{\"body\":\"{\\\"room\\\":\\\"{broadcast_id}\\\"}\",\"kind\":1}","kind":2}  // subscribe to room
```

## Frame format (RECEIVED) — triple-nested JSON, discriminated by OUTER `kind`

**Chat message = outer `kind:1`:**
```
L0: {"kind":1, "payload":"<json string>"}
L1: JSON.parse(payload) → {"room":"{id}", "body":"<json string>"}
L2: JSON.parse(body)    → {
      "body":"<text>", "username":"zacxbt",
      "displayName":"zac.eth (ARX MODE) ☂️",
      "type":1, "timestamp":1781066725114, "uuid":"…",
      "participant_index":N, "remoteID":"…",
      "programDateTime":"2026-06-10T04:45:25.114Z", "ntpFor*":…
    }
```
History items use the **identical** encoding (each element of `messages[]` is the same `{kind:1, payload:…}` shape).

**Viewer count / presence = outer `kind:2`:**
```
L0: {"kind":2, "payload":"<json string>"}
L1: JSON.parse(payload) → {"kind":4, "sender":{…}, "body":"<json string>"}
L2: JSON.parse(body)    → {"room":"{id}", "occupancy":22033, "total_participants":22033}
```

## Mapping to CONFLUX `makeMessage`

`platform:'x'`, `username`←`username`, `displayName`←`displayName`, `text`←`body`, `ts`←`timestamp` (ms), `id`←`uuid`. **Viewer count** ← latest `occupancy` (this is REAL concurrent viewers — could replace the current "engagement total shown as live" hack).

## Two build paths (decision deferred)

- **Tier 1 — Playwright headless Chrome (proven).** Let X's own client do the handshake; we read frames via `page.on('websocket')` + `framereceived`. Robust to handshake changes. **Heavy:** ~300MB Chromium per broadcast; Railway needs the Playwright image. The session-pool we shipped would ref-count one Chromium per distinct broadcast.
- **Tier 2 — direct `fetch` + `ws`, no browser (unverified).** Replicate the handshake above in plain Node and open the WS with the `ws` dep we already use. Featherweight (~3MB), drops into the current stack. **Risk:** we reproduce X's guest-token handshake ourselves, so an X change breaks us. **Next step if building:** a spike confirming steps 1–3 work with a public web bearer + `x-guest-token` and no browser fingerprinting.

## Caveats / notes

- Captures **X Live Broadcast chat**, NOT tweet replies (current paid `XIngester`). If built, this would be a *new* X source (likely replacing the reply-search for the "X stream chat" use case).
- Anonymous **public read-only viewer** = much cleaner ToS/optics than logged-in scraping (no account, no auth bypass) — still automated access; weigh for a public challenge submission.
- URL patterns: `x.com/i/broadcasts/{id}`, `twitter.com/i/broadcasts/{id}`, or a post embedding a live broadcast.
- Region in the chatman host (`us-east-1`) comes from the `accessChatPublic` `endpoint` field — don't hardcode it; read it from the handshake.
