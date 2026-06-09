# CONFLUX UI Improvements — Design

**Date:** 2026-06-09
**Scope:** Frontend only (`conflux.html`). No backend changes required.
**Origin:** User feedback on the live deploy — connect gives no feedback, pills show made-up streamer labels, stats too shallow.

## Problems

1. **Connect action gives no feedback.** Adding a stream that's mistyped/unsupported/offline fails **silently** (server `error` messages only `console.warn`, never shown). A valid-but-offline channel connects but produces no chat → "nothing happened."
2. **Pills show a streamer label** (`twitch · strogo (Banks)`). The Banks/Z labels are noise and were operator-invented. Pills should read `platform · channel` only.
3. **Stats too shallow.** Only a header count + a tiny hover tooltip + a 3-pill footer. User wants an always-visible **channel breakdown + platform breakdown**.

## Decisions (user-approved)

- **Drop the streamer label entirely.** Remove the "who/label" input; pills show `platform · channel`; no per-person dimension anywhere.
- **Detailed stats = a persistent left column** in Dashboard mode (uses the empty space beside the centered chat). Hidden in Watch mode (Watch stays the pure visualization).
- **Keep msg/min** in the stats column (alongside viewers), per-platform and per-channel.
- **Mute/show toggles at BOTH levels.** Platform toggles relocate to a prominent bar **below the "watching" counter** (each pill = platform name + live count + mute/show), replacing the old top filter chips AND the footer count-pills. Per-channel mute toggles live on each channel row in the stats column.

## Design

### 1. Remove streamer label
- Delete the `#connectWho` input from the setup row.
- `doConnect()` sends `connectStream` **without** `streamerLabel` (backend defaults it to `''`, already handled).
- `renderStreams()` pills render `${platform} · ${channel}` — drop the `(label)` suffix.
- `#bcStreamers` (broadcast-stage label): set from the connected **channels** (`platform·channel`, joined by ` · `), not labels. Empty when none connected.
- Backend `perStreamer` stat becomes uniformly `''` and is simply unused — left in place (no backend edit; YAGNI on removal).

### 2. Connect feedback
- Add a small inline status line inside `.panel-setup` (`#connectMsg`, `aria-live="polite"`).
- The WS `onmessage` handler for `type:'error'` now writes the message to `#connectMsg` (styled as an error) instead of only `console.warn`. Auto-clears after ~5s or on the next successful `streams` update.
- On a successful add, briefly show `connecting <platform>·<channel>…`; the pill's existing `status` (`connecting`→`live`/`offline`) already reflects progress — surface `offline` explicitly in `#connectMsg` ("kick·foo is offline — no chat until it goes live") so an offline channel isn't mistaken for a failure.
- `doConnect()` does a client-side pre-check: if the pasted text isn't a twitch/kick/x URL, show the inline error immediately (don't even send).

### 3. Left stats column (Dashboard)
- New element `.statspanel` (id `#stats`) added inside `.app`, before `.panel`.
- **Layout:** in `mode-dashboard`, `.app` shows `#stats` (fixed ~260px) + `.panel` (centered, existing max-width). In `mode-watch`, `#stats` is `display:none` (Watch = stage + chat only). On narrow screens (≤820px) the column stacks **above** the panel as a compact strip; ≤520px it collapses to combined + per-platform only.
- **Content, rendered from the `stats` event + the `streams` list (joined on `streamId`):**
  - **Combined:** big tabular number = `combined.viewers`; sub-line `combined.msgsPerMin` msg/min.
  - **By platform:** one row per platform that has ≥1 connected stream — color dot + name + `viewers` (kfmt) + `msg/min`. Order: Twitch, Kick, X.
  - **By channel:** one row per connected stream — platform-color dot + `channel` + `viewers` + `msg/min` + a live/offline indicator (from `stream.status`) + a **mute toggle** (eye/eye-off SVG) that hides/shows just that channel's messages.
  - Empty state (no streams): "No streams yet — paste a link above to start."
- Reuses existing `latestStats`, the `onStats` handler, and the `streams` list kept by `renderStreams`/`onSnapshot`. Add a `renderStats()` called on both `stats` and `streams` updates.
- The existing header combined count + hover tooltip stay (harmless).

### 4. Platform toggle bar + filtering
- **New `.platbar` strip directly below `<header>`** (above `.app`), visible in BOTH modes. Holds one pill per platform (Twitch, Kick, X): color dot + platform name + live viewer count (from `perPlatform`) + acts as the **mute/show toggle** (`aria-pressed`). This REPLACES the old `.filters .chip` block (removed from `.panel-head`) and the footer `.vbreak` count-pills (removed).
- **Two filter dimensions in `STATE`:**
  - `STATE.enabled[platform]` (existing) — platform mute, toggled by the `.platbar` pills.
  - `STATE.streamMuted[streamId]` (new, default unmuted) — per-channel mute, toggled by the stats-column row toggle.
- **`applyFilters()`** (single source of truth) shows a row iff `STATE.enabled[row.dataset.p]` **and** `!STATE.streamMuted[row.dataset.ch]` (rows already carry `dataset.p`=platform and `dataset.ch`=streamId). Re-scans all rows on any toggle; particle river gating stays platform-level (existing behavior).
- Both the `.platbar` pills and the per-channel toggles reflect current mute state visually (dimmed/eye-off when muted).

## Data flow
`streams` event → list of `{id, platform, channel, status}`. `stats` event → `{combined, perPlatform, perStream:{[id]:{viewers,msgsPerMin}}}`. `renderStats()` joins them: per-channel = each stream + `perStream[stream.id]`.

## Error handling / fail-safe
- All new rendering null-guards missing `perStream[id]` / `perPlatform[p]` (show `0`).
- Inline connect errors never throw; if `#connectMsg` is missing, no-op.
- Backend unreachable → stats column shows last-known + the existing reconnecting state.

## Out of scope
- Backend changes (none needed). Removing the unused `perStreamer` from the backend.
- Watch-mode changes.
- Mobile redesign beyond the stack/collapse rules above.

## Testing
- Manual browser verification against the live backend (Playwright): add a valid live channel (pill `platform·channel`, stats column populates), add a bad URL (inline error), add an offline channel (inline "offline" note), connect 2 same-platform channels (per-channel + per-platform both correct), toggle Watch (column hides, platbar stays), check ≤820px stacking.
- **Toggles:** mute a platform pill → all its rows hide, its count still shows; mute one channel via its stats-row toggle → only that channel's rows hide (other same-platform channel stays); unmute restores; platform-mute + channel-mute compose correctly.
- `grep -c "<script"` still `3`.

## Files
- `conflux.html` (only).
