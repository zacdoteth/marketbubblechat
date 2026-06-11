# CONFLUX Real-Time Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CONFLUX — a strictly-real, no-login, multi-platform live-chat aggregator that merges Twitch + Kick + X chat (and a native shared room) into one canonical feed with detailed per-stream stats, served to a streamer Dashboard and a viewer Watch visualization.

**Architecture:** An always-on Node backend (Railway) runs one ingester per connected stream (anonymous Twitch IRC, anonymous Kick Pusher, X pay-go `search/recent` polling), normalizes every message to a common schema, merges them into a single sequenced ring buffer + live stats engine, and fans the identical stream out to all clients over one WebSocket. The frontend is the existing `conflux.html` rewired to consume that WebSocket (no secrets, no simulation) — Dashboard adds a paste-links connect panel + detailed stats; Watch keeps the particle-river visualization driven by real messages.

**Tech Stack:** Node 20+ (native `fetch`, `node:test`, `--env-file`), the `ws` package (WebSocket server + Twitch/Kick clients), vanilla HTML/CSS/JS frontend (Three.js r128, no build). Backend on Railway, frontend on Vercel.

**Spec:** `docs/superpowers/specs/2026-06-08-conflux-realtime-aggregator-architecture-design.md`

---

## File Structure

```
marketbubblechat/
├─ conflux.html                      # EXISTING frontend — rewired to the real WS (no simulator)
├─ server/                           # NEW backend (always-on Node)
│  ├─ package.json                   # type:module, ws dep, test/start scripts
│  ├─ .gitignore                     # .env, node_modules
│  ├─ .env.example                   # documents X_BEARER_TOKEN etc. (no real secret)
│  ├─ src/
│  │  ├─ config.js                   # env + platform constants (pusher key, gql id, colors)
│  │  ├─ urlParser.js                # parseStreamUrl(url) -> {platform, channel} | {error}
│  │  ├─ normalize.js                # makeMessage(fields) -> canonical Message
│  │  ├─ aggregator.js               # createAggregator() -> push/recent ring buffer + seq
│  │  ├─ stats.js                    # createStats() -> per-stream/platform/streamer/combined
│  │  ├─ streamRegistry.js           # createRegistry() -> add/remove/list/setStatus
│  │  ├─ nativeRoom.js               # createNativeRoom() -> anti-spam validate()
│  │  ├─ hub.js                      # wires registry+ingesters+aggregator+stats+fanout
│  │  ├─ fanout.js                   # ws server: snapshot on connect, broadcast events
│  │  └─ ingesters/
│  │     ├─ twitch.js                # parsePrivmsg() + TwitchIngester (IRC + GQL viewers)
│  │     ├─ kickResolver.js          # resolveKick(channel) slug->chatroom_id (+override)
│  │     ├─ kick.js                  # parseKickEvent() + KickIngester (Pusher + viewers)
│  │     └─ x.js                     # parseSearchResponse() + XIngester (search/recent poll)
│  ├─ src/index.js                   # entry: start http+ws server + hub
│  └─ test/
│     ├─ urlParser.test.js
│     ├─ normalize.test.js
│     ├─ aggregator.test.js
│     ├─ stats.test.js
│     ├─ streamRegistry.test.js
│     ├─ nativeRoom.test.js
│     ├─ twitchParse.test.js
│     ├─ kickParse.test.js
│     ├─ kickResolver.test.js
│     └─ xParse.test.js
└─ docs/superpowers/...
```

**Protocol (single source of truth — used by backend fanout AND frontend client):**

Server → client:
- `{ type:'snapshot', streams:[Stream], messages:[Message], stats:StatsModel }` (on connect)
- `{ type:'message', message:Message }`
- `{ type:'stats', stats:StatsModel }` (every ~1.5s)
- `{ type:'streams', streams:[Stream] }` (on registry change)
- `{ type:'error', error:string }`

Client → server:
- `{ type:'post', handle:string, text:string }`
- `{ type:'connectStream', url:string, streamerLabel:string }`
- `{ type:'disconnectStream', id:string }`

**Message** = `{ id, seq, streamId, platform, streamer, username, displayName, color, text, ts }`
**Stream** = `{ id, platform, channel, streamerLabel, url, status }` (`status`: connecting|live|offline|error)
**StatsModel** = `{ combined:{viewers,msgsPerMin}, perStream:{[id]:{viewers,msgsPerMin,platform,streamer,status}}, perPlatform:{[p]:{viewers,msgsPerMin}}, perStreamer:{[s]:{viewers,msgsPerMin}}, site:{viewers} }`

---

## Phase 0 — Backend scaffold

### Task 0: Project setup

**Files:**
- Create: `server/package.json`
- Create: `server/.gitignore`
- Create: `server/.env.example`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "conflux-server",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test",
    "start": "node --env-file=.env src/index.js",
    "dev": "node --env-file=.env --watch src/index.js"
  },
  "dependencies": { "ws": "^8.18.0" }
}
```

- [ ] **Step 2: Create `server/.gitignore`**

```
node_modules/
.env
*.log
```

- [ ] **Step 3: Create `server/.env.example`**

```
# Copy to .env and fill in. .env is gitignored — never commit real secrets.
PORT=8787
# X (Twitter) app-only Bearer token. Use VERBATIM as shown in the X dev portal
# (it contains literal %2B / %3D sequences — do NOT URL-decode it).
X_BEARER_TOKEN=PASTE_BEARER_VERBATIM
# Optional JSON map of kick channel slug -> chatroom_id, used if the live
# Cloudflare-gated lookup is blocked from the host. e.g. {"xqc":668}
KICK_CHATROOM_OVERRIDES={}
```

- [ ] **Step 4: Install and verify**

Run: `cd server && npm install && node --test` (no tests yet)
Expected: install succeeds; `node --test` prints "tests 0" and exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/hempopat/Desktop/mrktbubble/marketbubblechat
git add server/package.json server/.gitignore server/.env.example
git commit -m "chore(server): scaffold backend project"
```

---

### Task 1: Config + constants

**Files:**
- Create: `server/src/config.js`

- [ ] **Step 1: Create `server/src/config.js`**

```js
// Centralized env + platform constants. No secrets are hard-coded here;
// secrets come from process.env (loaded via --env-file=.env or the host).
export const PORT = Number(process.env.PORT) || 8787;
export const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';

// Public, well-known unauthenticated identifiers (not secrets):
export const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
export const KICK_WS_URL =
  `wss://ws-us2.pusher.com/app/${KICK_PUSHER_KEY}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
export const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

export const PLATFORM_COLORS = {
  twitch: '#A571FF', x: '#F4F4F6', kick: '#53FC18', mb: '#3FD0C0',
};

let _overrides = null;
export function kickOverride(channel) {
  if (_overrides === null) {
    try { _overrides = JSON.parse(process.env.KICK_CHATROOM_OVERRIDES || '{}'); }
    catch { _overrides = {}; }
  }
  return _overrides[String(channel || '').toLowerCase()] || null;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/config.js
git commit -m "feat(server): add config and platform constants"
```

---

## Phase 1 — Pure logic units (TDD)

### Task 2: URL parser

**Files:**
- Create: `server/src/urlParser.js`
- Test: `server/test/urlParser.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/urlParser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamUrl } from '../src/urlParser.js';

test('parses twitch url', () => {
  assert.deepEqual(parseStreamUrl('https://twitch.tv/xQc'), { platform: 'twitch', channel: 'xqc' });
});
test('parses kick url with www and trailing slash', () => {
  assert.deepEqual(parseStreamUrl('https://www.kick.com/Trainwreckstv/'), { platform: 'kick', channel: 'trainwreckstv' });
});
test('parses x url and strips @', () => {
  assert.deepEqual(parseStreamUrl('x.com/@Banks'), { platform: 'x', channel: 'banks' });
});
test('parses twitter.com as x', () => {
  assert.deepEqual(parseStreamUrl('https://twitter.com/Z'), { platform: 'x', channel: 'z' });
});
test('rejects empty', () => {
  assert.ok(parseStreamUrl('   ').error);
});
test('rejects unsupported host', () => {
  assert.ok(parseStreamUrl('https://youtube.com/foo').error);
});
test('rejects url with no channel', () => {
  assert.ok(parseStreamUrl('https://twitch.tv/').error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/urlParser.test.js`
Expected: FAIL — `Cannot find module '../src/urlParser.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/urlParser.js
const HOSTS = {
  'twitch.tv': 'twitch',
  'kick.com': 'kick',
  'x.com': 'x',
  'twitter.com': 'x',
};

export function parseStreamUrl(input) {
  let s = String(input || '').trim();
  if (!s) return { error: 'empty input' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { error: 'invalid url' }; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const platform = HOSTS[host];
  if (!platform) return { error: 'unsupported platform: ' + host };
  const seg = u.pathname.split('/').filter(Boolean);
  let channel = (seg[0] || '').replace(/^@/, '').toLowerCase();
  if (!channel) return { error: 'no channel in url' };
  return { platform, channel };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/urlParser.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/urlParser.js server/test/urlParser.test.js
git commit -m "feat(server): add stream URL parser"
```

---

### Task 3: Message normalizer

**Files:**
- Create: `server/src/normalize.js`
- Test: `server/test/normalize.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/normalize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMessage } from '../src/normalize.js';

test('maps fields and applies platform color fallback', () => {
  const m = makeMessage({ streamId: 's1', platform: 'twitch', streamer: 'Banks',
    username: 'viewer1', text: 'gm', ts: 1000 });
  assert.equal(m.platform, 'twitch');
  assert.equal(m.streamer, 'Banks');
  assert.equal(m.username, 'viewer1');
  assert.equal(m.displayName, 'viewer1');
  assert.equal(m.color, '#A571FF');  // twitch fallback
  assert.equal(m.text, 'gm');
  assert.equal(m.ts, 1000);
  assert.equal(m.seq, 0);            // assigned later by aggregator
});
test('keeps provided color and displayName', () => {
  const m = makeMessage({ platform: 'kick', username: 'u', displayName: 'U', color: '#123456', text: 'x', ts: 1 });
  assert.equal(m.color, '#123456');
  assert.equal(m.displayName, 'U');
});
test('native message gets mb color and empty streamer', () => {
  const m = makeMessage({ platform: 'mb', username: 'you', text: 'hi', ts: 2 });
  assert.equal(m.color, '#3FD0C0');
  assert.equal(m.streamer, '');
});
test('coerces missing username to anon and stringifies text', () => {
  const m = makeMessage({ platform: 'x', text: 42, ts: 3 });
  assert.equal(m.username, 'anon');
  assert.equal(m.text, '42');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/normalize.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/normalize.js
import { PLATFORM_COLORS } from './config.js';

let _seq = 0; // local monotonic id counter (NOT the canonical seq; aggregator sets seq)

export function makeMessage({ streamId = null, platform, streamer = '',
  username, displayName, color, text, ts = 0 }) {
  const name = username || displayName || 'anon';
  return {
    id: 'm' + (++_seq),
    seq: 0,
    streamId,
    platform,
    streamer,
    username: name,
    displayName: displayName || name,
    color: color || PLATFORM_COLORS[platform] || '#ECE7DD',
    text: String(text ?? ''),
    ts,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/normalize.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/normalize.js server/test/normalize.test.js
git commit -m "feat(server): add message normalizer"
```

---

### Task 4: Aggregator ring buffer

**Files:**
- Create: `server/src/aggregator.js`
- Test: `server/test/aggregator.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/aggregator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAggregator } from '../src/aggregator.js';

test('assigns increasing seq', () => {
  const a = createAggregator({ max: 100 });
  const m1 = a.push({ text: 'a' });
  const m2 = a.push({ text: 'b' });
  assert.equal(m1.seq, 1);
  assert.equal(m2.seq, 2);
});
test('caps buffer at max and drops oldest', () => {
  const a = createAggregator({ max: 3 });
  for (let i = 0; i < 5; i++) a.push({ text: 'm' + i });
  const r = a.recent();
  assert.equal(r.length, 3);
  assert.deepEqual(r.map(m => m.text), ['m2', 'm3', 'm4']);
});
test('recent returns a copy (mutation-safe)', () => {
  const a = createAggregator({ max: 3 });
  a.push({ text: 'a' });
  a.recent().push({ text: 'evil' });
  assert.equal(a.recent().length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/aggregator.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/aggregator.js
export function createAggregator({ max = 100 } = {}) {
  let seq = 0;
  const buf = [];
  return {
    push(msg) {
      msg.seq = ++seq;
      buf.push(msg);
      while (buf.length > max) buf.shift();
      return msg;
    },
    recent() { return buf.slice(); },
    get size() { return buf.length; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/aggregator.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/aggregator.js server/test/aggregator.test.js
git commit -m "feat(server): add aggregator ring buffer"
```

---

### Task 5: Stats engine

**Files:**
- Create: `server/src/stats.js`
- Test: `server/test/stats.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../src/stats.js';

test('aggregates viewers across stream/platform/streamer + site', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'twitch', streamer: 'Banks' });
  s.registerStream('s2', { platform: 'twitch', streamer: 'Z' });
  s.registerStream('s3', { platform: 'kick', streamer: 'Banks' });
  s.setViewers('s1', 100);
  s.setViewers('s2', 50);
  s.setViewers('s3', 30);
  s.setSiteViewers(7);
  const snap = s.snapshot(10_000);
  assert.equal(snap.combined.viewers, 187);          // 100+50+30+7
  assert.equal(snap.perPlatform.twitch.viewers, 150); // s1+s2
  assert.equal(snap.perPlatform.kick.viewers, 30);
  assert.equal(snap.perStreamer.Banks.viewers, 130);  // s1+s3
  assert.equal(snap.perStreamer.Z.viewers, 50);
  assert.equal(snap.site.viewers, 7);
  assert.equal(snap.perStream.s1.viewers, 100);
});

test('msgsPerMin counts only the last 60s', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'kick', streamer: 'Banks' });
  s.recordMessage('s1', 1_000);    // old (will fall outside window)
  s.recordMessage('s1', 61_500);
  s.recordMessage('s1', 61_800);
  const snap = s.snapshot(62_000); // window = (2000, 62000]; 1000 excluded
  assert.equal(snap.perStream.s1.msgsPerMin, 2);
  assert.equal(snap.combined.msgsPerMin, 2);
});

test('removeStream drops it from aggregates', () => {
  const s = createStats();
  s.registerStream('s1', { platform: 'x', streamer: 'Banks' });
  s.setViewers('s1', 9);
  s.removeStream('s1');
  const snap = s.snapshot(0);
  assert.equal(snap.combined.viewers, 0);
  assert.equal(snap.perStream.s1, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/stats.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/stats.js
const WINDOW_MS = 60_000;

export function createStats() {
  const streams = new Map(); // id -> { platform, streamer, viewers, msgTimes[] }
  let siteViewers = 0;

  return {
    registerStream(id, meta = {}) {
      if (!streams.has(id))
        streams.set(id, { platform: meta.platform, streamer: meta.streamer || '', viewers: 0, msgTimes: [] });
    },
    removeStream(id) { streams.delete(id); },
    setViewers(id, n) { const s = streams.get(id); if (s) s.viewers = Number(n) || 0; },
    setSiteViewers(n) { siteViewers = Number(n) || 0; },
    recordMessage(id, now) { const s = streams.get(id); if (s) s.msgTimes.push(now); },
    snapshot(now) {
      const perStream = {}, perPlatform = {}, perStreamer = {};
      let combinedViewers = 0, combinedRate = 0;
      for (const [id, s] of streams) {
        s.msgTimes = s.msgTimes.filter(t => now - t < WINDOW_MS);
        const rate = s.msgTimes.length;
        perStream[id] = { viewers: s.viewers, msgsPerMin: rate, platform: s.platform, streamer: s.streamer };
        combinedViewers += s.viewers;
        combinedRate += rate;
        (perPlatform[s.platform] ||= { viewers: 0, msgsPerMin: 0 });
        perPlatform[s.platform].viewers += s.viewers;
        perPlatform[s.platform].msgsPerMin += rate;
        (perStreamer[s.streamer] ||= { viewers: 0, msgsPerMin: 0 });
        perStreamer[s.streamer].viewers += s.viewers;
        perStreamer[s.streamer].msgsPerMin += rate;
      }
      return {
        combined: { viewers: combinedViewers + siteViewers, msgsPerMin: combinedRate },
        perStream, perPlatform, perStreamer,
        site: { viewers: siteViewers },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/stats.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/stats.js server/test/stats.test.js
git commit -m "feat(server): add stats engine"
```

---

### Task 6: Stream registry

**Files:**
- Create: `server/src/streamRegistry.js`
- Test: `server/test/streamRegistry.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/streamRegistry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/streamRegistry.js';

test('add returns unique id and connecting status', () => {
  const r = createRegistry();
  const a = r.add({ platform: 'twitch', channel: 'banks', streamerLabel: 'Banks', url: 'u' });
  assert.equal(a.status, 'connecting');
  assert.ok(a.id);
});
test('allows two streams on the same platform (collab)', () => {
  const r = createRegistry();
  const a = r.add({ platform: 'twitch', channel: 'banks', streamerLabel: 'Banks' });
  const b = r.add({ platform: 'twitch', channel: 'zee', streamerLabel: 'Z' });
  assert.notEqual(a.id, b.id);
  assert.equal(r.list().length, 2);
});
test('setStatus and remove work', () => {
  const r = createRegistry();
  const a = r.add({ platform: 'kick', channel: 'x' });
  r.setStatus(a.id, 'live');
  assert.equal(r.get(a.id).status, 'live');
  assert.equal(r.remove(a.id), true);
  assert.equal(r.get(a.id), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/streamRegistry.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/streamRegistry.js
let _id = 0;

export function createRegistry() {
  const map = new Map();
  return {
    add({ platform, channel, streamerLabel = '', url = '' }) {
      const id = 's' + (++_id);
      const stream = { id, platform, channel, streamerLabel, url, status: 'connecting' };
      map.set(id, stream);
      return stream;
    },
    remove(id) { return map.delete(id); },
    get(id) { return map.get(id); },
    setStatus(id, status) { const s = map.get(id); if (s) s.status = status; return s; },
    list() { return [...map.values()]; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/streamRegistry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/streamRegistry.js server/test/streamRegistry.test.js
git commit -m "feat(server): add stream registry"
```

---

### Task 7: Native room anti-spam

**Files:**
- Create: `server/src/nativeRoom.js`
- Test: `server/test/nativeRoom.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/nativeRoom.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRoom } from '../src/nativeRoom.js';

test('rejects empty and whitespace', () => {
  const r = createNativeRoom();
  assert.equal(r.validate('c1', '   ', 0).ok, false);
});
test('rejects over-length', () => {
  const r = createNativeRoom({ maxLen: 5 });
  assert.equal(r.validate('c1', 'abcdef', 0).ok, false);
});
test('rate-limits same connection', () => {
  const r = createNativeRoom({ rateMs: 2000 });
  assert.equal(r.validate('c1', 'hi', 1000).ok, true);
  assert.equal(r.validate('c1', 'again', 1500).ok, false); // <2s later
  assert.equal(r.validate('c1', 'ok now', 3500).ok, true);  // >2s later
});
test('different connections are independent and text is trimmed', () => {
  const r = createNativeRoom({ rateMs: 2000 });
  assert.equal(r.validate('c1', ' hello ', 0).text, 'hello');
  assert.equal(r.validate('c2', 'world', 0).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/nativeRoom.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/nativeRoom.js
export function createNativeRoom({ rateMs = 2000, maxLen = 280 } = {}) {
  const last = new Map(); // connId -> last post ts
  return {
    validate(connId, rawText, now) {
      const text = String(rawText || '').trim();
      if (!text) return { ok: false, reason: 'empty' };
      if (text.length > maxLen) return { ok: false, reason: 'too long' };
      const prev = last.get(connId) || 0;
      if (now - prev < rateMs) return { ok: false, reason: 'rate limited' };
      last.set(connId, now);
      return { ok: true, text };
    },
    drop(connId) { last.delete(connId); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/nativeRoom.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/nativeRoom.js server/test/nativeRoom.test.js
git commit -m "feat(server): add native room anti-spam"
```

---

## Phase 2 — Ingester parsers (TDD) + ingester classes

### Task 8: Twitch PRIVMSG parser

**Files:**
- Create: `server/src/ingesters/twitch.js` (parser only this task)
- Test: `server/test/twitchParse.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/twitchParse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrivmsg } from '../src/ingesters/twitch.js';

const LINE = '@badge-info=;badges=turbo/1;color=#0D4200;display-name=ronni;id=1;mod=0;room-id=1337;user-id=1337 :ronni!ronni@ronni.tmi.twitch.tv PRIVMSG #dallas :Kappa Keepo Kappa';

test('extracts username, display-name, color, text', () => {
  const m = parsePrivmsg(LINE);
  assert.equal(m.username, 'ronni');
  assert.equal(m.displayName, 'ronni');
  assert.equal(m.color, '#0D4200');
  assert.equal(m.text, 'Kappa Keepo Kappa');
});
test('handles message containing colons', () => {
  const line = ':bob!bob@bob.tmi.twitch.tv PRIVMSG #x :http://a.com : lol';
  const m = parsePrivmsg(line);
  assert.equal(m.username, 'bob');
  assert.equal(m.text, 'http://a.com : lol');
});
test('falls back to login when display-name empty', () => {
  const line = '@display-name= :cat!cat@cat.tmi.twitch.tv PRIVMSG #x :meow';
  assert.equal(parsePrivmsg(line).displayName, 'cat');
});
test('returns null for non-PRIVMSG lines', () => {
  assert.equal(parsePrivmsg(':tmi.twitch.tv 001 justinfan :Welcome'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/twitchParse.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (parser only)**

```js
// server/src/ingesters/twitch.js
export function parsePrivmsg(line) {
  const m = line.match(/^(?:@(\S+) )?:(\w+)!\w+@[\w.]+ PRIVMSG #\S+ :(.*)$/);
  if (!m) return null;
  const tags = {};
  if (m[1]) for (const kv of m[1].split(';')) {
    const i = kv.indexOf('=');
    tags[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const username = m[2];
  const display = (tags['display-name'] || '').replace(/\\s/g, ' ').trim() || username;
  return { username, displayName: display, color: tags.color || '', text: m[3] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/twitchParse.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingesters/twitch.js server/test/twitchParse.test.js
git commit -m "feat(server): add twitch PRIVMSG parser"
```

---

### Task 9: Kick event parser

**Files:**
- Create: `server/src/ingesters/kick.js` (parser only this task)
- Test: `server/test/kickParse.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/kickParse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKickEvent } from '../src/ingesters/kick.js';

test('parses a ChatMessageEvent (double-encoded data)', () => {
  const inner = JSON.stringify({ content: 'hello kick', created_at: '2026-06-08T06:29:23Z',
    sender: { username: 'kicker99' } });
  const frame = { event: 'App\\Events\\ChatMessageEvent', data: inner };
  const m = parseKickEvent(frame);
  assert.equal(m.username, 'kicker99');
  assert.equal(m.text, 'hello kick');
  assert.equal(m.ts, Date.parse('2026-06-08T06:29:23Z'));
});
test('ignores non-chat events', () => {
  assert.equal(parseKickEvent({ event: 'pusher:ping', data: '{}' }), null);
});
test('returns null on malformed data', () => {
  assert.equal(parseKickEvent({ event: 'App\\Events\\ChatMessageEvent', data: 'not json' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/kickParse.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (parser only)**

```js
// server/src/ingesters/kick.js
export function parseKickEvent(frame) {
  if (!frame || frame.event !== 'App\\Events\\ChatMessageEvent') return null;
  let d;
  try { d = JSON.parse(frame.data); } catch { return null; }
  const username = d?.sender?.username;
  const text = d?.content;
  if (!username || text == null) return null;
  return { username, text, ts: Date.parse(d?.created_at) || 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/kickParse.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingesters/kick.js server/test/kickParse.test.js
git commit -m "feat(server): add kick chat event parser"
```

---

### Task 10: Kick channel resolver (Cloudflare-gated, with override fallback)

**Files:**
- Create: `server/src/ingesters/kickResolver.js`
- Test: `server/test/kickResolver.test.js`

> **Note:** `https://kick.com/api/v2/channels/{slug}` is behind Cloudflare TLS-fingerprint protection. A plain `fetch` may return 403 from a datacenter IP (Railway). The resolver therefore supports a `KICK_CHATROOM_OVERRIDES` env map (`{"slug":chatroomId}`) as a guaranteed path for known demo channels, and accepts an injectable `fetchImpl` for testing. If live lookup is blocked in production, populate the override map (resolve the id once from a normal browser: open the channel, the id is `chatroom.id` in the v2 JSON).

- [ ] **Step 1: Write the failing test**

```js
// server/test/kickResolver.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKick } from '../src/ingesters/kickResolver.js';

test('uses override when present (no network)', async () => {
  const r = await resolveKick('xqc', { fetchImpl: async () => { throw new Error('should not call'); },
    overrideFn: () => 668 });
  assert.equal(r.chatroomId, 668);
  assert.equal(r.source, 'override');
});
test('parses live api response', async () => {
  const body = { chatroom: { id: 12345 }, livestream: { viewer_count: 4800 } };
  const r = await resolveKick('someone', {
    overrideFn: () => null,
    fetchImpl: async () => ({ ok: true, json: async () => body }),
  });
  assert.equal(r.chatroomId, 12345);
  assert.equal(r.viewers, 4800);
  assert.equal(r.isLive, true);
});
test('throws on blocked/non-ok response', async () => {
  await assert.rejects(() => resolveKick('blocked', {
    overrideFn: () => null,
    fetchImpl: async () => ({ ok: false, status: 403 }),
  }), /403/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/kickResolver.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// server/src/ingesters/kickResolver.js
import { kickOverride } from '../config.js';

const BROWSERY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function resolveKick(channel, { fetchImpl = fetch, overrideFn = kickOverride } = {}) {
  const slug = String(channel || '').toLowerCase();
  const ov = overrideFn(slug);
  if (ov) return { chatroomId: ov, viewers: null, isLive: null, source: 'override' };

  const res = await fetchImpl(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`,
    { headers: BROWSERY_HEADERS });
  if (!res.ok) throw new Error(`kick lookup failed ${res.status} (Cloudflare?) — set KICK_CHATROOM_OVERRIDES`);
  const j = await res.json();
  return {
    chatroomId: j?.chatroom?.id,
    viewers: j?.livestream?.viewer_count ?? null,
    isLive: !!j?.livestream,
    source: 'api',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/kickResolver.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingesters/kickResolver.js server/test/kickResolver.test.js
git commit -m "feat(server): add kick channel resolver with override fallback"
```

---

### Task 11: X search/recent parser

**Files:**
- Create: `server/src/ingesters/x.js` (parser only this task)
- Test: `server/test/xParse.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/test/xParse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResponse } from '../src/ingesters/x.js';

const RESP = {
  data: [
    { id: '2', author_id: '10', text: 'second', created_at: '2026-06-08T00:00:02Z' },
    { id: '1', author_id: '11', text: 'first', created_at: '2026-06-08T00:00:01Z' },
  ],
  includes: { users: [
    { id: '10', username: 'alice', name: 'Alice' },
    { id: '11', username: 'bob', name: 'Bob' },
  ] },
};

test('maps tweets + resolves author usernames', () => {
  const out = parseSearchResponse(RESP);
  assert.equal(out.length, 2);
  const byId = Object.fromEntries(out.map(m => [m.id, m]));
  assert.equal(byId['2'].username, 'alice');
  assert.equal(byId['2'].displayName, 'Alice');
  assert.equal(byId['1'].username, 'bob');
  assert.equal(byId['1'].text, 'first');
  assert.equal(byId['1'].ts, Date.parse('2026-06-08T00:00:01Z'));
});
test('handles empty result', () => {
  assert.deepEqual(parseSearchResponse({ meta: { result_count: 0 } }), []);
});
test('falls back to author_id when user not in includes', () => {
  const out = parseSearchResponse({ data: [{ id: '9', author_id: '99', text: 't', created_at: '2026-06-08T00:00:00Z' }] });
  assert.equal(out[0].username, '99');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/xParse.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation (parser only)**

```js
// server/src/ingesters/x.js  (parser; ingester class added in Task 14)
export function parseSearchResponse(json) {
  const users = {};
  for (const u of (json?.includes?.users || [])) users[u.id] = u;
  return (json?.data || []).map(t => ({
    id: t.id,
    username: users[t.author_id]?.username || t.author_id,
    displayName: users[t.author_id]?.name || users[t.author_id]?.username || t.author_id,
    text: t.text,
    ts: Date.parse(t.created_at) || 0,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/xParse.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingesters/x.js server/test/xParse.test.js
git commit -m "feat(server): add X search/recent parser"
```

---

## Phase 3 — Ingester runtime classes

> These classes hold live sockets/timers and emit normalized events. They are verified by integration (running against real channels), not unit tests. Each exposes: `start()`, `stop()`, and is constructed with callbacks `{ onMessage(fields), onViewers(n), onStatus(status) }`. They MUST be failure-isolated: any error inside one ingester is caught and reported via `onStatus('error')`, never thrown to the caller.

### Task 12: TwitchIngester (append to `twitch.js`)

**Files:**
- Modify: `server/src/ingesters/twitch.js` (add the class; keep `parsePrivmsg`)

- [ ] **Step 1: Append the ingester class**

Add below `parsePrivmsg` in `server/src/ingesters/twitch.js`:

```js
import WebSocket from 'ws';
import { TWITCH_IRC_URL, TWITCH_GQL_CLIENT_ID } from '../config.js';

export class TwitchIngester {
  constructor(channel, { onMessage, onViewers, onStatus }) {
    this.channel = String(channel).toLowerCase();
    this.cb = { onMessage, onViewers, onStatus };
    this.ws = null; this.viewersTimer = null; this.closed = false;
  }
  start() {
    this._connect();
    this._pollViewers();
    this.viewersTimer = setInterval(() => this._pollViewers(), 20_000);
  }
  _connect() {
    try {
      const ws = new WebSocket(TWITCH_IRC_URL);
      this.ws = ws;
      ws.on('open', () => {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS SCHMOOPIIE');
        ws.send('NICK justinfan' + Math.floor(Math.random() * 1e5));
        ws.send('JOIN #' + this.channel);
        this.cb.onStatus('live');
      });
      ws.on('message', (buf) => {
        for (const line of buf.toString().split('\r\n')) {
          if (!line) continue;
          if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
          const m = parsePrivmsg(line);
          if (m) this.cb.onMessage(m);
        }
      });
      ws.on('error', () => this.cb.onStatus('error'));
      ws.on('close', () => { if (!this.closed) setTimeout(() => this._connect(), 2000); });
    } catch { this.cb.onStatus('error'); }
  }
  async _pollViewers() {
    try {
      const r = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': TWITCH_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          operationName: 'M', variables: { l: this.channel },
          query: 'query M($l:String!){ user(login:$l){ stream { viewersCount } } }',
        }]),
      });
      const j = await r.json();
      const s = j?.[0]?.data?.user?.stream;
      this.cb.onViewers(s ? s.viewersCount : 0);
      this.cb.onStatus(s ? 'live' : 'offline');
    } catch { /* keep last known; non-fatal */ }
  }
  stop() {
    this.closed = true;
    clearInterval(this.viewersTimer);
    try { this.ws?.close(); } catch {}
  }
}
```

- [ ] **Step 2: Verify the module still imports and parser tests pass**

Run: `cd server && node --test test/twitchParse.test.js`
Expected: PASS (4 tests) — the added class must not break the parser.

- [ ] **Step 3: Manual smoke test against a live channel**

Create a throwaway `server/scratch-twitch.mjs`:

```js
import { TwitchIngester } from './src/ingesters/twitch.js';
const ing = new TwitchIngester(process.argv[2] || 'xqc', {
  onMessage: m => console.log('MSG', m.username + ':', m.text),
  onViewers: n => console.log('VIEWERS', n),
  onStatus: s => console.log('STATUS', s),
});
ing.start();
setTimeout(() => { ing.stop(); process.exit(0); }, 15000);
```

Run: `cd server && node scratch-twitch.mjs <a-currently-live-twitch-channel>`
Expected: `STATUS live`, a `VIEWERS <n>` line, and several `MSG ...` lines within 15s. Then delete the scratch file: `rm server/scratch-twitch.mjs`.

- [ ] **Step 4: Commit**

```bash
git add server/src/ingesters/twitch.js
git commit -m "feat(server): add TwitchIngester (anonymous IRC + GQL viewers)"
```

---

### Task 13: KickIngester (append to `kick.js`)

**Files:**
- Modify: `server/src/ingesters/kick.js` (add the class; keep `parseKickEvent`)

- [ ] **Step 1: Append the ingester class**

Add below `parseKickEvent` in `server/src/ingesters/kick.js`:

```js
import WebSocket from 'ws';
import { KICK_WS_URL } from '../config.js';
import { resolveKick } from './kickResolver.js';

export class KickIngester {
  constructor(channel, { onMessage, onViewers, onStatus }) {
    this.channel = String(channel).toLowerCase();
    this.cb = { onMessage, onViewers, onStatus };
    this.ws = null; this.viewersTimer = null; this.chatroomId = null; this.closed = false;
  }
  async start() {
    try {
      const info = await resolveKick(this.channel);
      this.chatroomId = info.chatroomId;
      if (!this.chatroomId) { this.cb.onStatus('error'); return; }
      if (info.viewers != null) this.cb.onViewers(info.viewers);
      this._connect();
      this.viewersTimer = setInterval(() => this._pollViewers(), 20_000);
    } catch (e) { this.cb.onStatus('error'); }
  }
  _connect() {
    try {
      const ws = new WebSocket(KICK_WS_URL);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` } }));
        this.cb.onStatus('live');
      });
      ws.on('message', (buf) => {
        let frame; try { frame = JSON.parse(buf.toString()); } catch { return; }
        if (frame.event === 'pusher:ping') { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); return; }
        const m = parseKickEvent(frame);
        if (m) this.cb.onMessage(m);
      });
      ws.on('error', () => this.cb.onStatus('error'));
      ws.on('close', () => { if (!this.closed) setTimeout(() => this._connect(), 2000); });
    } catch { this.cb.onStatus('error'); }
  }
  async _pollViewers() {
    try {
      const info = await resolveKick(this.channel);
      if (info.viewers != null) this.cb.onViewers(info.viewers);
      if (info.isLive === false) this.cb.onStatus('offline');
    } catch { /* non-fatal */ }
  }
  stop() {
    this.closed = true;
    clearInterval(this.viewersTimer);
    try { this.ws?.close(); } catch {}
  }
}
```

- [ ] **Step 2: Verify parser tests still pass**

Run: `cd server && node --test test/kickParse.test.js`
Expected: PASS (3 tests).

- [ ] **Step 3: Manual smoke test (needs a resolvable channel)**

Create `server/scratch-kick.mjs`:

```js
import { KickIngester } from './src/ingesters/kick.js';
const ing = new KickIngester(process.argv[2] || 'xqc', {
  onMessage: m => console.log('MSG', m.username + ':', m.text),
  onViewers: n => console.log('VIEWERS', n),
  onStatus: s => console.log('STATUS', s),
});
ing.start();
setTimeout(() => { ing.stop(); process.exit(0); }, 15000);
```

Run: `cd server && node scratch-kick.mjs <a-live-kick-channel>`
Expected: `STATUS live` + chat lines. **If you see `STATUS error` from a 403 (Cloudflare)**, resolve the chatroom id once in a browser (open the channel, find `chatroom.id` at `https://kick.com/api/v2/channels/<slug>`), then re-run with `KICK_CHATROOM_OVERRIDES='{"<slug>":<id>}' node scratch-kick.mjs <slug>`. Confirm chat then flows. Delete the scratch file afterward: `rm server/scratch-kick.mjs`.

- [ ] **Step 4: Commit**

```bash
git add server/src/ingesters/kick.js
git commit -m "feat(server): add KickIngester (Pusher chat + viewer polling)"
```

---

### Task 14: XIngester (append to `x.js`)

**Files:**
- Modify: `server/src/ingesters/x.js` (add the class; keep `parseSearchResponse`)

- [ ] **Step 1: Append the ingester class**

Add below `parseSearchResponse` in `server/src/ingesters/x.js`:

```js
import { X_BEARER_TOKEN } from '../config.js';

export class XIngester {
  // channel = the X handle (without @). "viewers" is X's engagement total shown as live.
  constructor(channel, { onMessage, onViewers, onStatus }, { pollMs = 10_000 } = {}) {
    this.handle = String(channel).replace(/^@/, '');
    this.cb = { onMessage, onViewers, onStatus };
    this.pollMs = pollMs; this.sinceId = null; this.total = 0; this.timer = null; this.closed = false;
  }
  start() {
    if (!X_BEARER_TOKEN) { this.cb.onStatus('error'); return; }
    this.cb.onStatus('live');
    this._poll();
    this.timer = setInterval(() => this._poll(), this.pollMs);
  }
  async _poll() {
    try {
      const url = new URL('https://api.x.com/2/tweets/search/recent');
      url.searchParams.set('query', `(to:${this.handle}) -is:retweet`);
      url.searchParams.set('max_results', '100');
      url.searchParams.set('tweet.fields', 'created_at,author_id,conversation_id');
      url.searchParams.set('expansions', 'author_id');
      url.searchParams.set('user.fields', 'username,name');
      if (this.sinceId) url.searchParams.set('since_id', this.sinceId);
      // NOTE: bearer is used VERBATIM (contains literal %2B/%3D — do not decode).
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + X_BEARER_TOKEN } });
      if (r.status === 429) return;            // rate limited — skip this cycle
      if (!r.ok) { this.cb.onStatus('error'); return; }
      const json = await r.json();
      const msgs = parseSearchResponse(json).sort((a, b) => a.ts - b.ts);
      for (const m of msgs) this.cb.onMessage(m);
      const newest = json?.meta?.newest_id;
      if (newest) this.sinceId = newest;
      this.total += json?.meta?.result_count || 0;  // engagement total = "live" per spec
      this.cb.onViewers(this.total);
    } catch { /* non-fatal; try again next cycle */ }
  }
  stop() { this.closed = true; clearInterval(this.timer); }
}
```

- [ ] **Step 2: Verify parser tests still pass**

Run: `cd server && node --test test/xParse.test.js`
Expected: PASS (3 tests).

- [ ] **Step 3: Manual smoke test against the real X API**

Create `server/scratch-x.mjs`:

```js
import { XIngester } from './src/ingesters/x.js';
const ing = new XIngester(process.argv[2] || 'elonmusk', {
  onMessage: m => console.log('X MSG', m.username + ':', m.text.slice(0, 60)),
  onViewers: n => console.log('X TOTAL', n),
  onStatus: s => console.log('X STATUS', s),
}, { pollMs: 10000 });
ing.start();
setTimeout(() => { ing.stop(); process.exit(0); }, 22000);
```

Run: `cd server && node --env-file=.env scratch-x.mjs <an-active-x-handle>`
Expected: `X STATUS live` and (for an active handle) reply lines within two poll cycles. Confirms the real key works end-to-end. Delete scratch: `rm server/scratch-x.mjs`.

- [ ] **Step 4: Commit**

```bash
git add server/src/ingesters/x.js
git commit -m "feat(server): add XIngester (pay-go search/recent polling)"
```

---

## Phase 4 — Hub + fan-out (the shared feed)

### Task 15: Hub (wires registry + ingesters + aggregator + stats)

**Files:**
- Create: `server/src/hub.js`

- [ ] **Step 1: Create `server/src/hub.js`**

```js
// server/src/hub.js — owns app state and orchestrates ingesters.
import { createRegistry } from './streamRegistry.js';
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { createNativeRoom } from './nativeRoom.js';
import { makeMessage } from './normalize.js';
import { parseStreamUrl } from './urlParser.js';
import { TwitchIngester } from './ingesters/twitch.js';
import { KickIngester } from './ingesters/kick.js';
import { XIngester } from './ingesters/x.js';

const INGESTERS = { twitch: TwitchIngester, kick: KickIngester, x: XIngester };

export function createHub({ onMessage, onStats, onStreams, now = () => Date.now() }) {
  const registry = createRegistry();
  const agg = createAggregator({ max: 100 });
  const stats = createStats();
  const room = createNativeRoom();
  const running = new Map(); // streamId -> ingester instance

  function emit(fields) {
    const msg = makeMessage(fields);
    agg.push(msg);
    if (msg.streamId) stats.recordMessage(msg.streamId, now());
    onMessage(msg);
  }
  function pushStreams() { onStreams(registry.list()); }

  return {
    registry, agg, stats,
    snapshot() { return { streams: registry.list(), messages: agg.recent(), stats: stats.snapshot(now()) }; },
    statsSnapshot() { return stats.snapshot(now()); },
    setSiteViewers(n) { stats.setSiteViewers(n); },

    connectStream(url, streamerLabel) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      const stream = registry.add({ ...parsed, streamerLabel, url });
      stats.registerStream(stream.id, { platform: parsed.platform, streamer: streamerLabel || '' });
      const Ing = INGESTERS[parsed.platform];
      const ing = new Ing(parsed.channel, {
        onMessage: (m) => emit({ ...m, streamId: stream.id, platform: parsed.platform, streamer: streamerLabel || '' }),
        onViewers: (n) => stats.setViewers(stream.id, n),
        onStatus: (s) => { registry.setStatus(stream.id, s); pushStreams(); },
      });
      running.set(stream.id, ing);
      ing.start();
      pushStreams();
      return { stream };
    },

    disconnectStream(id) {
      const ing = running.get(id);
      if (ing) { try { ing.stop(); } catch {} running.delete(id); }
      registry.remove(id);
      stats.removeStream(id);
      pushStreams();
    },

    postNative(connId, handle, text) {
      const v = room.validate(connId, text, now());
      if (!v.ok) return { error: v.reason };
      emit({ platform: 'mb', streamer: '', username: String(handle || 'anon').slice(0, 24), text: v.text, ts: now() });
      return { ok: true };
    },
    dropConn(connId) { room.drop(connId); },
  };
}
```

- [ ] **Step 2: Quick integration sanity test (no live sockets)**

Create `server/test/hub.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';

test('native post flows into messages + rejects bad url', () => {
  const msgs = [];
  const hub = createHub({ onMessage: m => msgs.push(m), onStats: () => {}, onStreams: () => {}, now: () => 1000 });
  assert.equal(hub.postNative('c1', 'you', 'hello').ok, true);
  assert.equal(msgs.at(-1).platform, 'mb');
  assert.equal(msgs.at(-1).text, 'hello');
  assert.ok(hub.connectStream('https://youtube.com/x', 'Banks').error); // unsupported
});
```

Run: `cd server && node --test test/hub.test.js`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add server/src/hub.js server/test/hub.test.js
git commit -m "feat(server): add hub orchestrating ingesters, aggregator, stats, room"
```

---

### Task 16: Fan-out WebSocket server + entry point

**Files:**
- Create: `server/src/fanout.js`
- Create: `server/src/index.js`

- [ ] **Step 1: Create `server/src/fanout.js`**

```js
// server/src/fanout.js — one WS server; snapshot on connect, broadcast events.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';

export function startFanout(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });
  let connId = 0;

  const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(s); };

  const hub = createHub({
    onMessage: (message) => broadcast({ type: 'message', message }),
    onStats: () => {},
    onStreams: (streams) => broadcast({ type: 'streams', streams }),
  });

  function updateSite() { hub.setSiteViewers(wss.clients.size); }

  wss.on('connection', (ws) => {
    ws._cid = 'c' + (++connId);
    updateSite();
    send(ws, { type: 'snapshot', ...hub.snapshot() });
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      try {
        if (msg.type === 'post') {
          const r = hub.postNative(ws._cid, msg.handle, msg.text);
          if (r.error) send(ws, { type: 'error', error: r.error });
        } else if (msg.type === 'connectStream') {
          const r = hub.connectStream(msg.url, msg.streamerLabel);
          if (r.error) send(ws, { type: 'error', error: r.error });
        } else if (msg.type === 'disconnectStream') {
          hub.disconnectStream(msg.id);
        }
      } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
    });
    ws.on('close', () => { hub.dropConn(ws._cid); updateSite(); });
  });

  // periodic stats push
  setInterval(() => broadcast({ type: 'stats', stats: hub.statsSnapshot() }), 1500);
  return { wss, hub };
}
```

- [ ] **Step 2: Create `server/src/index.js`**

```js
// server/src/index.js — http server (health) + WS fan-out.
import { createServer } from 'node:http';
import { PORT } from './config.js';
import { startFanout } from './fanout.js';

const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('CONFLUX backend live');
});
startFanout(server);
server.listen(PORT, () => console.log('CONFLUX backend on :' + PORT));
```

- [ ] **Step 3: Manual end-to-end test (native room over WS)**

Start the server: `cd server && cp -n .env.example .env && node --env-file=.env src/index.js`
(Leave `X_BEARER_TOKEN` as the placeholder for now; native room doesn't need it.)

In a second terminal, create `server/scratch-ws.mjs`:

```js
import WebSocket from 'ws';
const a = new WebSocket('ws://localhost:8787');
const b = new WebSocket('ws://localhost:8787');
a.on('message', m => console.log('A recv', m.toString().slice(0, 120)));
b.on('open', () => setTimeout(() => b.send(JSON.stringify({ type: 'post', handle: 'bob', text: 'hi from b' })), 500));
setTimeout(() => process.exit(0), 2500);
```

Run: `cd server && node scratch-ws.mjs`
Expected: client A receives a `snapshot` then a `message` with `text:"hi from b"` and `platform:"mb"` — proving the shared fan-out works. Stop the server (Ctrl-C), delete scratch: `rm server/scratch-ws.mjs`.

- [ ] **Step 4: Run the full backend test suite**

Run: `cd server && node --test`
Expected: PASS — all unit/integration tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/fanout.js server/src/index.js
git commit -m "feat(server): add WS fan-out and entry point"
```

---

## Phase 5 — Frontend rewire (`conflux.html`)

> The existing file simulates data. We replace the simulator with a live WS client, keep the visual system (rows, particle river, stats HUD), add the connect panel, and render real detailed stats. **Codex rules still apply:** SVG icons not emoji in chrome, fail-safe every external dependency (a backend outage must show a reconnecting state, never a blank app), keep Three.js r128 patterns.

### Task 17: Add the backend WS client + config constant

**Files:**
- Modify: `conflux.html` (inside the main `<script>`, near the top of the JS, after the `ICON`/`paint()` block around line 439)

- [ ] **Step 1: Insert the WS client block**

Immediately after the `})();` that closes the `paint()` IIFE (line 439), insert:

```js
/* ---------- backend connection (the real feed) ---------- */
const BACKEND_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'ws://localhost:8787'
  : 'wss://REPLACE_WITH_RAILWAY_HOST';   // set at deploy time (Task 24)
let backendWS = null, backendReady = false;
const onSnapshot = [], onServerMessage = [], onStats = [], onStreams = [];
function connectBackend() {
  try {
    const ws = new WebSocket(BACKEND_URL);
    backendWS = ws;
    ws.onopen = () => { backendReady = true; setConnState(true); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'snapshot') { onSnapshot.forEach(f => f(m)); }
      else if (m.type === 'message') { onServerMessage.forEach(f => f(m.message)); }
      else if (m.type === 'stats') { onStats.forEach(f => f(m.stats)); }
      else if (m.type === 'streams') { onStreams.forEach(f => f(m.streams)); }
      else if (m.type === 'error') { console.warn('server:', m.error); }
    };
    ws.onclose = () => { backendReady = false; setConnState(false); setTimeout(connectBackend, 2000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  } catch { setConnState(false); setTimeout(connectBackend, 2000); }
}
function sendBackend(obj) { if (backendReady) try { backendWS.send(JSON.stringify(obj)); } catch {} }
function setConnState(ok) {
  document.body.classList.toggle('disconnected', !ok);
}
```

- [ ] **Step 2: Add a minimal disconnected indicator style**

In the `<style>` block, after the `.live{...}` rule (around line 58), add:

```css
body.disconnected .live{opacity:.4}
body.disconnected .live::after{content:" · reconnecting";font-size:9px;color:var(--muted)}
```

- [ ] **Step 3: Verify the file still loads (no JS errors)**

Run: `cd /Users/hempopat/Desktop/mrktbubble/marketbubblechat && python3 -m http.server 5500`
Open `http://localhost:5500/conflux.html` in a browser, open devtools console.
Expected: page renders; console shows a WebSocket connection attempt to `ws://localhost:8787` (failing is fine — backend may be off). No uncaught JS errors. Stop the server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add conflux.html
git commit -m "feat(web): add backend WebSocket client + reconnecting state"
```

---

### Task 18: Replace the simulator with real messages

**Files:**
- Modify: `conflux.html` — `addRow` (line 482), the boot seed loop (lines 865-869), `tick` scheduling (line 872), `emitDemo` (line 597)

- [ ] **Step 1: Adapt `addRow` to accept a server Message**

Replace the `addRow` signature and its identity fields. Change line 482 from:

```js
function addRow({platform,channel,username,message,live,golden,mine}){
```
to:
```js
function addRow({platform,channel,username,message,streamer,live,golden,mine}){
```

And change the username/label rendering: in the `row.innerHTML` template (around line 487-491), the badge currently shows `LABEL[platform]`. Replace the badge label expression `${LABEL[platform]}` with a platform+streamer label:

```js
`<span class="badge">${ICONS[platform]}<span class="h">${LABEL[platform]}${streamer?(' · '+esc(streamer)):''}</span></span>`+
```

- [ ] **Step 2: Wire server messages into `addRow`**

At the end of the `connectBackend` setup region (after Task 17's block), register a handler. Add:

```js
onServerMessage.push((m) => {
  addRow({
    platform: m.platform === 'mb' ? 'native' : m.platform,  // UI class name for native is 'native'
    channel: m.streamId || 'MB',
    username: m.displayName || m.username,
    message: m.text,
    streamer: m.streamer || '',
    mine: false,
  });
});
onSnapshot.push((snap) => {
  feed.innerHTML = '';
  snap.messages.forEach(m => addRow({
    platform: m.platform === 'mb' ? 'native' : m.platform,
    channel: m.streamId || 'MB', username: m.displayName || m.username,
    message: m.text, streamer: m.streamer || '',
  }));
  feed.scrollTop = feed.scrollHeight;
});
```

> Note the platform mapping: the backend uses `mb` for native; the frontend CSS class is `m-native` / chip `c-native`. Map `mb → native` on the way in. All four chips already exist (`kick/x/twitch/native`).

- [ ] **Step 3: Remove the simulator**

Delete the boot seed loop (lines 865-869, the `for(let i=0;i<6;i++){...}` block that fabricates rows) and replace the two boot scheduling lines:

Change:
```js
setTimeout(confluencePulse, 420);
setTimeout(tick, 1500);
```
to:
```js
setTimeout(confluencePulse, 420);
connectBackend();
```

Then delete the now-unused `emitDemo` function (lines 597-606) and the `tick` function (lines 608-609). Also delete the `WEIGHT`/`pickPlatform` block (lines 595-596) if no longer referenced. (Leave `pick`, `clock`, `esc`, `kfmt`, `STATE`, `addRow`, particle code intact — still used.)

- [ ] **Step 4: Verify end-to-end with the backend running**

Terminal 1: `cd server && node --env-file=.env src/index.js`
Terminal 2: `cd /Users/hempopat/Desktop/mrktbubble/marketbubblechat && python3 -m http.server 5500`
Open `http://localhost:5500/conflux.html`. In the page console run:
```js
backendWS.send(JSON.stringify({type:'post',handle:'tester',text:'hello real feed'}))
```
Expected: a real row appears in the feed labelled MB with text "hello real feed", and the particle river fires. No simulated/random messages appear anymore. Stop both servers.

- [ ] **Step 5: Commit**

```bash
git add conflux.html
git commit -m "feat(web): replace simulator with real backend feed"
```

---

### Task 19: Native composer → backend post

**Files:**
- Modify: `conflux.html` — `sendMine` (line 661)

- [ ] **Step 1: Add a handle prompt + replace `sendMine` body**

Replace the `sendMine` function (lines 661-666) with:

```js
function myHandle(){
  let h = localStorage.getItem('conflux_handle');
  if(!h){ h = (prompt('Pick a chat name (no login):','')||'').trim().slice(0,24) || ('guest'+((Math.random()*9000+1000)|0)); localStorage.setItem('conflux_handle', h); }
  return h;
}
function sendMine(){
  const t=compose.value.trim(); if(!t)return;
  sendBackend({ type:'post', handle: myHandle(), text: t });
  compose.value='';   // the server will echo it back into the shared feed
}
```

> We no longer locally `addRow` for our own message — the backend broadcasts it to everyone (including us) so the feed stays one canonical shared room. The `VIEW.native+=1` line is removed (site viewers now come from real connected-client count via stats).

- [ ] **Step 2: Verify**

With backend + page running (as in Task 18 Step 4): type a message in the composer, press Enter.
Expected: it appears in the feed (round-tripped through the server), teal/native styled. Open a second browser tab — the same message is visible there too (shared room proven).

- [ ] **Step 3: Commit**

```bash
git add conflux.html
git commit -m "feat(web): native composer posts to shared backend room"
```

---

### Task 20: Connect panel (paste links, 2-per-platform)

**Files:**
- Modify: `conflux.html` — repurpose the existing `panel-foot` "Live" sources area (lines 367-384) and `twPill`/`connectTwitch` logic (lines 716-741)

- [ ] **Step 1: Replace the sources markup with a connect panel**

Replace the `<div class="sources">...</div>` block (lines 368-377) with:

```html
      <div class="sources" id="connectPanel">
        <span class="lbl">Connect</span>
        <input type="text" id="connectUrl" placeholder="paste twitch / kick / x link…" autocomplete="off" spellcheck="false">
        <input type="text" id="connectWho" placeholder="who (Banks/Z)" autocomplete="off" spellcheck="false" maxlength="16">
        <button class="src btn s-twitch" id="connectGo">+ Add stream</button>
        <span id="connectList" class="connect-list"></span>
      </div>
```

- [ ] **Step 2: Add connect-panel styles**

In `<style>`, after the `.sources` rules (around line 184), add:

```css
#connectUrl{flex:1;min-width:150px;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:8px;color:var(--ink);font-family:'Space Mono',monospace;font-size:11px;padding:7px 10px;outline:none}
#connectWho{width:110px;background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:8px;color:var(--ink);font-family:'Space Mono',monospace;font-size:11px;padding:7px 10px;outline:none}
.connect-list{display:flex;gap:6px;flex-wrap:wrap}
.connect-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;font-family:'Space Mono',monospace;font-size:10px;border:1px solid var(--line);color:var(--ink)}
.connect-pill .st{width:6px;height:6px;border-radius:50%;background:var(--muted)}
.connect-pill.live .st{background:#53FC18;box-shadow:0 0 6px #53FC18}
.connect-pill.error .st{background:#FF4D4D}
.connect-pill .rm{cursor:pointer;color:var(--muted)}
.connect-pill .rm:hover{color:var(--ink)}
```

- [ ] **Step 3: Wire the connect panel logic**

Replace the entire Twitch-connect block (lines 716-741, from `const twPill=...` through the `tw-ch` keydown listener) with:

```js
/* ---------- connect panel (paste links across platforms) ---------- */
const connectUrl=document.getElementById('connectUrl'), connectWho=document.getElementById('connectWho'),
  connectGo=document.getElementById('connectGo'), connectList=document.getElementById('connectList');
function doConnect(){
  const url=connectUrl.value.trim(); if(!url)return;
  sendBackend({ type:'connectStream', url, streamerLabel: connectWho.value.trim() });
  connectUrl.value='';
}
connectGo.addEventListener('click', doConnect);
connectUrl.addEventListener('keydown', e=>{ if(e.key==='Enter') doConnect(); });
function renderStreams(streams){
  connectList.innerHTML='';
  streams.forEach(s=>{
    const el=document.createElement('span');
    el.className='connect-pill '+(s.status==='live'?'live':(s.status==='error'?'error':''));
    el.innerHTML=`<span class="st"></span>${esc(s.platform)}·${esc(s.channel)}${s.streamerLabel?(' ('+esc(s.streamerLabel)+')'):''} <span class="rm" data-id="${s.id}">✕</span>`;
    connectList.appendChild(el);
  });
}
connectList.addEventListener('click', e=>{ const rm=e.target.closest('.rm'); if(rm) sendBackend({type:'disconnectStream', id:rm.dataset.id}); });
onStreams.push(renderStreams);
onSnapshot.push(snap=>renderStreams(snap.streams));
```

- [ ] **Step 4: Verify (2 streams, same platform)**

Backend + page running. In the connect panel, add `https://twitch.tv/<live-channel-1>` (who: Banks), then `https://twitch.tv/<live-channel-2>` (who: Z).
Expected: two `connect-pill`s appear, both flip to `live` (green dot), and real chat from both channels merges into the one feed with correct `Twitch · Banks` / `Twitch · Z` labels. Remove one with ✕ — its pill disappears and its messages stop.

- [ ] **Step 5: Commit**

```bash
git add conflux.html
git commit -m "feat(web): add paste-links connect panel with multi-stream support"
```

---

### Task 21: Detailed stats rendering + hover breakdown

**Files:**
- Modify: `conflux.html` — the stats intervals (lines 538-592) and the header HUD (lines 298-302) / `vbreak` footer (lines 378-383)

- [ ] **Step 1: Remove the simulated viewer drift**

Delete the simulated `VIEW` drift `setInterval` (lines 538-544) and the `combined()`/`shownViewers` simulation (lines 535-537). Delete `paintViewers` (lines 545-550) and the viewer-easing lines inside the 120ms loop (lines 587-591). The real numbers now come from the stats event.

- [ ] **Step 2: Render real stats from the server**

Add (near the other `onStats`/handlers):

```js
let latestStats = null;
function kfmt2(n){ n=Number(n)||0; return n>=1000?(n/1000).toFixed(1)+'K':String(Math.round(n)); }
onStats.push((st)=>{
  latestStats = st;
  document.getElementById('viewers').textContent = (st.combined.viewers||0).toLocaleString();
  document.getElementById('bcViewers').textContent = (st.combined.viewers||0).toLocaleString();
  document.getElementById('rate').textContent = st.combined.msgsPerMin||0;
  // per-platform footer pills
  const pf = st.perPlatform||{};
  setVB('v-kick', pf.kick); setVB('v-x', pf.x); setVB('v-twitch', pf.twitch);
  document.getElementById('v-native').textContent = kfmt2((st.site&&st.site.viewers)||0);
});
function setVB(id, p){ const el=document.getElementById(id); if(el) el.textContent = kfmt2(p?p.viewers:0); }
```

- [ ] **Step 2b: Update the `rate` label semantics**

The header stat label currently says `msg/sec` (line 301). Change its text to `msg/min` to match the stats engine window. In the HTML, replace `<span>msg/sec</span>` (line 301) with `<span>msg/min</span>`.

- [ ] **Step 3: Add hover breakdown on the combined count**

Add a tooltip element + handler. In the `<style>` add:

```css
.vbreakdown{position:absolute;z-index:40;background:rgba(10,9,11,.96);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-family:'Space Mono',monospace;font-size:11px;color:var(--ink);box-shadow:0 18px 50px -20px #000;display:none;max-width:260px}
.vbreakdown.show{display:block}
.vbreakdown b{color:var(--gold-br)}
.vbreakdown .r{display:flex;justify-content:space-between;gap:14px;padding:2px 0}
```

Add markup right before `</header>` (after line 302's `</div>` closing `.hud`, i.e. line 302→303):

```html
  <div class="vbreakdown" id="vbreakdown"></div>
```

Add JS:

```js
const vEl=document.getElementById('viewers'), vbd=document.getElementById('vbreakdown');
vEl.parentElement.style.cursor='help';
vEl.parentElement.addEventListener('mouseenter', ()=>{
  if(!latestStats)return;
  const rows=[];
  for(const [id,s] of Object.entries(latestStats.perStream||{}))
    rows.push(`<div class="r"><span>${s.platform}${s.streamer?(' · '+s.streamer):''}</span><b>${kfmt2(s.viewers)}</b></div>`);
  rows.push(`<div class="r"><span>site (native)</span><b>${kfmt2(latestStats.site.viewers)}</b></div>`);
  vbd.innerHTML = `<div class="r"><span><b>combined</b></span><b>${(latestStats.combined.viewers||0).toLocaleString()}</b></div>`+rows.join('');
  const r=vEl.getBoundingClientRect(); vbd.style.top=(r.bottom+8)+'px'; vbd.style.left=Math.max(8,r.left-40)+'px';
  vbd.classList.add('show');
});
vEl.parentElement.addEventListener('mouseleave', ()=>vbd.classList.remove('show'));
```

- [ ] **Step 4: Verify**

Backend + page + at least one live stream connected.
Expected: header count shows the real combined number (Twitch GQL + Kick + site), `msg/min` reflects real throughput, footer pills show real per-platform viewers, and hovering the count reveals a per-stream + site breakdown. Numbers change as real viewers fluctuate.

- [ ] **Step 5: Commit**

```bash
git add conflux.html
git commit -m "feat(web): render real detailed stats with hover source breakdown"
```

---

### Task 22: Watch-mode visualization sanity + dead-code cleanup

**Files:**
- Modify: `conflux.html` — remove leftover references to deleted simulator state; confirm Watch mode

- [ ] **Step 1: Grep for orphaned references**

Run: `cd /Users/hempopat/Desktop/mrktbubble/marketbubblechat && grep -n "emitDemo\|paintViewers\|VIEW\.\|combined()\|shownViewers\|\btick\b\|connectTwitch\|twForm\|tw-ch\|tw-go" conflux.html`
Expected: no matches remain (each was removed in Tasks 18/20/21). If any remain, remove that line or its guard. (The `bump`/`STATE.counts` chip counters may still be referenced by `addRow`; keep counting messages per platform for the chip badges — leave `bump` intact but ensure it isn't called from deleted code.)

- [ ] **Step 2: Confirm chip counters still work**

If `addRow` no longer calls `bump`, add a per-platform count increment inside the `onServerMessage` handler from Task 18:

```js
// inside onServerMessage.push handler, after addRow(...)
const p = m.platform === 'mb' ? 'native' : m.platform;
STATE.counts[p] = (STATE.counts[p]||0) + 1;
const cnt = document.getElementById('cnt-'+p); if(cnt) cnt.textContent = STATE.counts[p];
```

- [ ] **Step 3: Verify both modes**

Backend + page + a live stream. Toggle Dashboard ↔ Watch (header segmented control).
Expected: Dashboard shows the cockpit (connect panel + stats + dense chat); Watch shows the particle-river visualization reacting to each real incoming message (per-platform colors), plus the shared chat sidebar. WebGL-off (disable hardware accel / force a `THREE_OK=false` test): chat + stats still fully work.

- [ ] **Step 4: Run backend tests once more (no regressions)**

Run: `cd server && node --test`
Expected: PASS — all green.

- [ ] **Step 5: Commit**

```bash
git add conflux.html
git commit -m "refactor(web): remove simulator dead code; verify watch visualization"
```

---

## Phase 6 — Deploy + demo hardening

### Task 23: Backend deploy to Railway

**Files:** none (deploy/config)

- [ ] **Step 1: Push the branch**

```bash
cd /Users/hempopat/Desktop/mrktbubble/marketbubblechat
git push -u origin conflux-realtime
```

- [ ] **Step 2: Create the Railway service**

In the Railway dashboard: New Project → Deploy from GitHub repo → select this repo/branch → set **Root Directory** to `server`. Railway auto-detects Node and runs `npm install` + `npm start`.

- [ ] **Step 3: Set env vars in Railway**

Add: `X_BEARER_TOKEN` = the verbatim bearer (with literal `%2B`/`%3D`). Add `KICK_CHATROOM_OVERRIDES` if any channel needs it (see Task 13 Step 3). Railway sets `PORT` automatically — `config.js` already reads `process.env.PORT`.

- [ ] **Step 4: Verify the deployed backend**

Run: `curl https://<your-app>.up.railway.app/health`
Expected: `ok`. Note the `wss://<your-app>.up.railway.app` URL for the frontend.

---

### Task 24: Point frontend at the deployed backend + deploy to Vercel

**Files:**
- Modify: `conflux.html` (the `BACKEND_URL` constant from Task 17)

- [ ] **Step 1: Set the production backend URL**

In `conflux.html`, replace `wss://REPLACE_WITH_RAILWAY_HOST` with `wss://<your-app>.up.railway.app`.

- [ ] **Step 2: Commit**

```bash
git add conflux.html
git commit -m "chore(web): point frontend at Railway backend"
git push
```

- [ ] **Step 3: Deploy frontend to Vercel**

In Vercel: New Project → import the repo/branch. No build step (static). Set output to serve `conflux.html` (or add a `vercel.json` rewrite of `/` → `/conflux.html`). Deploy.

- [ ] **Step 4: Full production smoke test**

Open the Vercel URL. Connect a live Twitch channel + a live Kick channel + an active X handle via the connect panel.
Expected: all three platforms' real messages merge into one feed with correct source labels; combined viewer count + hover breakdown are real; native composer posts appear for a second browser tab too; toggling Watch shows the live visualization. Confirm the X spending stays within the cap (X dashboard).

---

### Task 25: Demo-resilience pass

**Files:**
- Modify: `conflux.html` (only if a gap is found)

- [ ] **Step 1: Backend-down resilience**

Stop the Railway service briefly. Reload the frontend.
Expected: page renders, header shows `LIVE · reconnecting`, no crash; when the backend returns, the feed resumes automatically.

- [ ] **Step 2: Quiet-stream resilience**

Connect a channel that is live but low-traffic.
Expected: viewer count + status still show; no errors; feed simply updates slowly. Confirms the demo never depends on a busy chat.

- [ ] **Step 3: X-failure isolation**

Temporarily set a bad `X_BEARER_TOKEN` in Railway and redeploy.
Expected: the X stream shows `error` status in its connect pill, but Twitch + Kick + native continue working untouched (failure isolation per spec §9). Restore the correct token afterward.

- [ ] **Step 4: Final commit + tag**

```bash
cd /Users/hempopat/Desktop/mrktbubble/marketbubblechat
git add -A && git commit -m "chore: demo-resilience pass" --allow-empty
git push
```

---

## Self-Review (coverage check against the spec)

- **§3 architecture (backend aggregator → one canonical feed → fan-out):** Tasks 15 (hub), 16 (fanout). ✓
- **§4.1 stream registry / multi-stream per platform:** Task 6 + Task 20 (verified 2-per-platform). ✓
- **§4.2 URL parser:** Task 2. ✓
- **§4.3 ingesters (Twitch/Kick/X), failure-isolated:** Tasks 8–14; isolation via try/catch + `onStatus('error')`. ✓
- **§4.4 normalizer:** Task 3. ✓
- **§4.5 aggregator + ring buffer:** Task 4. ✓
- **§4.6 stats (per-stream/platform/streamer/combined):** Task 5 + Task 21 render. ✓
- **§4.7 native room (pick-a-handle, anti-spam, site-viewer count):** Task 7 + Task 19 + fanout `setSiteViewers`. ✓
- **§4.8 fan-out (snapshot, message, stats, streams):** Task 16. ✓
- **§4.9 modes (Dashboard cockpit, Watch visualization):** Tasks 20–22. ✓
- **§5 data model (Message/Stream/StatsModel):** defined once in File Structure; used consistently across Tasks 3,5,6,15,16. ✓
- **§6 X total-as-live + hover breakdown:** Task 14 (`onViewers(total)`) + Task 21 (hover). ✓
- **§7 connect UX (paste links, default-empty):** Task 20; no seed config (none added anywhere). ✓
- **§8 no-login:** anonymous IRC/Pusher; X app token server-side; pick-a-handle. ✓
- **§9 error handling / fail-safe:** reconnects (Tasks 12,13,17), WebGL-independent chat (Task 22 Step 3), demo resilience (Task 25). ✓
- **§13 build order:** phases mirror it. ✓
- **§15 secrets:** `.gitignore` (Task 0), `.env.example` only, frontend holds no secret, bearer used verbatim (Task 14). ✓

**Placeholder scan:** the single intentional placeholder is `BACKEND_URL = 'wss://REPLACE_WITH_RAILWAY_HOST'`, resolved in Task 24 Step 1. No `TODO`/`TBD` logic gaps.
**Type consistency:** `Message`/`Stream`/`StatsModel` field names match across hub, fanout, stats, and frontend handlers; `mb`↔`native` mapping is explicit at both frontend ingress points (Tasks 18, 21, 22).

---

## Notes / known risks carried from the spec

- **Kick Cloudflare:** if Railway's datacenter IP is 403'd on the channel lookup, use `KICK_CHATROOM_OVERRIDES` (resolve the id once in a browser). Documented in Tasks 10/13/23. A future hardening is a TLS-impersonation client (`cycletls`) — out of scope for the 3-day build.
- **Twitch IRC** is undocumented; EventSub (login-required) is the sanctioned successor if it ever sunsets — isolated behind `TwitchIngester`.
- **X** is polling (seconds latency), total-as-live by design; spending capped in the X console.
