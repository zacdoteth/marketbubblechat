# Public Single-Show Backend (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v1 per-session isolation with ONE shared public show that every visitor sees, add operator-gated featured-stream selection, public native MB chat (guest IDs + rate-limit), and Railway-Volume persistence.

**Architecture:** A single `showRoom` singleton holds the canonical state (streams, featured pick, merged chat incl. native, stats) and broadcasts every event to all connected clients. `fanout.js` attaches every WebSocket to that one room with role gating (operator = control token; viewer = native chat only). The ingester pool, parsers, and X-broadcast worker are reused — the pool simply fans out to the one show room.

**Tech Stack:** Node ESM, `ws`, native `node:test`, Node `fs` (Railway Volume JSON). No new deps.

**Reference spec:** `docs/superpowers/specs/2026-06-11-public-single-show-backend-design.md`

---

### Task 1: aggregator `clear()`

The show room needs to wipe chat on operator `clearChat`.

**Files:**
- Modify: `server/src/aggregator.js`
- Test: `server/test/aggregator.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `server/test/aggregator.test.js`:

```js
test('clear() empties the buffer', () => {
  const agg = createAggregator({ max: 10 });
  agg.push({ id: 'a' }); agg.push({ id: 'b' });
  assert.equal(agg.size, 2);
  agg.clear();
  assert.equal(agg.size, 0);
  assert.deepEqual(agg.recent(), []);
});
```

(If `createAggregator`/`test`/`assert` aren't imported at the top of that file, add `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { createAggregator } from '../src/aggregator.js';` — check first.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/aggregator.test.js`
Expected: FAIL — `agg.clear is not a function`.

- [ ] **Step 3: Implement**

In `server/src/aggregator.js`, add a `clear` method inside the returned object (after `recent()`):

```js
    clear() { buf.length = 0; },
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/aggregator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/aggregator.js server/test/aggregator.test.js
git commit -m "feat(server): aggregator.clear() for operator clear-chat"
```

---

### Task 2: config additions (mb color, slow-mode, store path)

**Files:**
- Modify: `server/src/config.js`

- [ ] **Step 1: Add config**

In `server/src/config.js`, add after the `X_INGEST_TOKEN` line:

```js
// Native MB chat: minimum interval between messages per connection (slow-mode default).
export const NATIVE_SLOWMODE_MS = Number(process.env.NATIVE_SLOWMODE_MS) || 2500;
// Where the persisted show config (stream URLs + featured) lives — a Railway Volume in prod.
export const SHOW_CONFIG_PATH = process.env.SHOW_CONFIG_PATH || './.show.json';
```

And add `mb` to `PLATFORM_COLORS`:

```js
export const PLATFORM_COLORS = {
  twitch: '#A571FF', x: '#F4F4F6', kick: '#53FC18', mb: '#5B8CFF',
};
```

- [ ] **Step 2: Verify it loads**

Run: `cd server && node -e "import('./src/config.js').then(c=>console.log(c.NATIVE_SLOWMODE_MS, c.SHOW_CONFIG_PATH, c.PLATFORM_COLORS.mb))"`
Expected: `2500 ./.show.json #5B8CFF`

- [ ] **Step 3: Commit**

```bash
git add server/src/config.js
git commit -m "feat(server): config for native slow-mode, show-config path, mb color"
```

---

### Task 3: showStore — persist show config to a JSON file

Pure-ish module: load/save `{ streams: [url...], featuredKey }` to a path. Tolerates a missing/corrupt file.

**Files:**
- Create: `server/src/showStore.js`
- Test: `server/test/showStore.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/showStore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { createShowStore } from '../src/showStore.js';

test('showStore: save then load round-trips; missing file → empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'showstore-'));
  const path = join(dir, 'show.json');
  const store = createShowStore(path);

  // missing file → safe empty default
  assert.deepEqual(await store.load(), { streams: [], featuredKey: null });

  await store.save({ streams: ['https://twitch.tv/a', 'https://kick.com/b'], featuredKey: 'twitch:a' });
  assert.deepEqual(await store.load(), { streams: ['https://twitch.tv/a', 'https://kick.com/b'], featuredKey: 'twitch:a' });

  rmSync(dir, { recursive: true, force: true });
});

test('showStore: corrupt file → empty default (never throws)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'showstore-'));
  const path = join(dir, 'show.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, 'not json {{{');
  const store = createShowStore(path);
  assert.deepEqual(await store.load(), { streams: [], featuredKey: null });
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/showStore.test.js`
Expected: FAIL — `Cannot find module '../src/showStore.js'`.

- [ ] **Step 3: Implement**

Create `server/src/showStore.js`:

```js
// server/src/showStore.js — persist the show config (stream URLs + featured) to a JSON file
// (a Railway Volume in prod). Chat history is NOT persisted. Never throws on read.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY = { streams: [], featuredKey: null };

export function createShowStore(path) {
  let writing = Promise.resolve();
  return {
    async load() {
      try {
        const raw = await readFile(path, 'utf8');
        const j = JSON.parse(raw);
        return {
          streams: Array.isArray(j.streams) ? j.streams.filter(s => typeof s === 'string') : [],
          featuredKey: typeof j.featuredKey === 'string' ? j.featuredKey : null,
        };
      } catch { return { ...EMPTY }; }
    },
    // serialize writes so concurrent saves can't interleave; swallow disk errors (warn, don't crash)
    save(cfg) {
      const body = JSON.stringify({ streams: cfg.streams || [], featuredKey: cfg.featuredKey ?? null });
      writing = writing.then(async () => {
        try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); }
        catch (e) { console.warn('[showStore] save failed (continuing in-memory):', e.message); }
      });
      return writing;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/showStore.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/showStore.js server/test/showStore.test.js
git commit -m "feat(server): showStore — persist show config (streams+featured)"
```

---

### Task 4: showRoom — the singleton shared show

The heart of v2. Implements the pool's room interface (`streamIdFor`/`onMessage`/`onViewers`/`onStatus`/`setLabel`) but **broadcasts to all clients**, plus client attach/detach, featured selection, native chat with per-connection rate-limit, clear/slow-mode, and persistence-aware connect/disconnect/restore.

**Files:**
- Create: `server/src/showRoom.js`
- Test: `server/test/showRoom.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/showRoom.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShowRoom } from '../src/showRoom.js';
import { createIngesterPool } from '../src/ingesterPool.js';

// Inert ingesters so nothing hits the network.
function inertIngesters() {
  class Inert { constructor(_c, cb = {}) { this.cb = cb; } async start() { this.cb.onStatus?.('connecting'); } async stop() {} }
  return { twitch: Inert, kick: Inert, x: Inert, xbroadcast: Inert };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };
const mkPool = () => createIngesterPool({ ingesters: inertIngesters(), ...noopSched });
function mkClient() { const sent = []; return { send: (o) => sent.push(o), sent }; }

test('showRoom: attach sends a snapshot with a guestId; broadcasts reach all clients', () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(), b = mkClient();
  const ca = room.attach(a.send); const cb = room.attach(b.send);
  assert.equal(a.sent[0].type, 'snapshot');
  assert.ok(ca.guestId.startsWith('guest-'));
  assert.ok(cb.guestId !== ca.guestId, 'distinct guest ids');
  room.broadcast({ type: 'ping' });
  assert.ok(a.sent.some(o => o.type === 'ping'));
  assert.ok(b.sent.some(o => o.type === 'ping'));
});

test('showRoom: connect adds a stream, sets it featured, and broadcasts to all', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(), b = mkClient();
  room.attach(a.send); room.attach(b.send);
  const r = await room.connect('https://twitch.tv/foo');
  assert.ok(r.stream);
  // both clients saw the streams update + a featured event
  for (const c of [a, b]) {
    assert.ok(c.sent.some(o => o.type === 'streams' && o.streams.some(s => s.channel === 'foo')));
    assert.ok(c.sent.some(o => o.type === 'featured' && o.id === r.stream.id), 'first stream auto-featured');
  }
});

test('showRoom: pool message fans out to every client', async () => {
  const pool = mkPool();
  const room = createShowRoom({ pool, now: () => 1000 });
  const a = mkClient(), b = mkClient();
  room.attach(a.send); room.attach(b.send);
  await room.connect('https://twitch.tv/foo');
  // simulate the ingester delivering a chat line via the pool
  pool.routeKickChat; // (no-op ref) — drive onMessage directly through the pool entry:
  const key = 'twitch:foo';
  room.onMessage({ poolKey: key, platform: 'twitch', username: 'u', text: 'hi', ts: 1 });
  for (const c of [a, b]) {
    const m = c.sent.filter(o => o.type === 'message').pop();
    assert.equal(m.message.text, 'hi');
    assert.equal(m.message.platform, 'twitch');
  }
});

test('showRoom: selectFeatured switches the featured stream', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); room.attach(a.send);
  const s1 = (await room.connect('https://twitch.tv/foo')).stream;
  const s2 = (await room.connect('https://kick.com/bar')).stream;
  assert.equal(room.snapshotFor({ guestId: 'g' }).featuredId, s1.id, 'first stays featured');
  room.selectFeatured(s2.id);
  assert.equal(room.snapshotFor({ guestId: 'g' }).featuredId, s2.id);
  assert.equal(room.selectFeatured('nope').error, 'no such stream');
});

test('showRoom: disconnect of the featured stream reassigns featured', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); room.attach(a.send);
  const s1 = (await room.connect('https://twitch.tv/foo')).stream;
  const s2 = (await room.connect('https://kick.com/bar')).stream;
  room.disconnect(s1.id); // s1 was featured
  assert.equal(room.snapshotFor({ guestId: 'g' }).featuredId, s2.id, 'featured falls to the remaining stream');
});

test('showRoom: nativeChat broadcasts as mb under the guest id; rate-limit drops the 2nd', () => {
  let t = 1000;
  const room = createShowRoom({ pool: mkPool(), now: () => t, slowModeMs: 2500 });
  const a = mkClient(), b = mkClient();
  const ca = room.attach(a.send); room.attach(b.send);
  assert.deepEqual(room.nativeChat(ca, 'gm'), { ok: true });
  for (const c of [a, b]) { const m = c.sent.filter(o => o.type === 'message').pop(); assert.equal(m.message.text, 'gm'); assert.equal(m.message.platform, 'mb'); assert.equal(m.message.username, ca.guestId); }
  // immediate second message from the same client is rate-limited
  assert.deepEqual(room.nativeChat(ca, 'spam'), { error: 'slow down' });
  // after the slow-mode window, allowed again
  t += 2600;
  assert.deepEqual(room.nativeChat(ca, 'ok now'), { ok: true });
  // empty/whitespace ignored
  assert.equal(room.nativeChat(ca, '   '), undefined);
});

test('showRoom: clearChat empties the buffer and broadcasts clear', async () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); const ca = room.attach(a.send);
  room.nativeChat(ca, 'hello');
  assert.equal(room.snapshotFor({ guestId: 'g' }).messages.length, 1);
  room.clearChat();
  assert.equal(room.snapshotFor({ guestId: 'g' }).messages.length, 0);
  assert.ok(a.sent.some(o => o.type === 'clear'));
});

test('showRoom: mb viewer count tracks connected clients', () => {
  const room = createShowRoom({ pool: mkPool(), now: () => 1000 });
  const a = mkClient(); const ca = room.attach(a.send);
  const b = mkClient(); const cb = room.attach(b.send);
  assert.equal(room.statsSnapshot().perPlatform.mb.viewers, 2);
  room.detach(cb);
  assert.equal(room.statsSnapshot().perPlatform.mb.viewers, 1);
});

test('showRoom: restore re-connects persisted streams and featured', async () => {
  const cfg = { streams: ['https://twitch.tv/foo', 'https://kick.com/bar'], featuredKey: 'kick:bar' };
  const store = { load: async () => cfg, save: async () => {} };
  const room = createShowRoom({ pool: mkPool(), now: () => 1000, store });
  await room.restore();
  const snap = room.snapshotFor({ guestId: 'g' });
  assert.equal(snap.streams.length, 2);
  const bar = snap.streams.find(s => s.channel === 'bar');
  assert.equal(snap.featuredId, bar.id, 'featured restored by poolKey');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node --test test/showRoom.test.js`
Expected: FAIL — `Cannot find module '../src/showRoom.js'`.

- [ ] **Step 3: Implement**

Create `server/src/showRoom.js`:

```js
// server/src/showRoom.js — the ONE shared public show. Holds the canonical state
// (streams, featured pick, merged chat incl. native, stats) and broadcasts every event
// to ALL connected clients. Implements the ingester-pool room interface (onMessage/...),
// but fans out to every client instead of one socket.
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { makeMessage } from './normalize.js';
import { parseStreamUrl } from './urlParser.js';
import { NATIVE_SLOWMODE_MS } from './config.js';

const MB_STREAM = 'mb-native'; // synthetic stats stream for native chat

export function createShowRoom({ pool, now = () => Date.now(), slowModeMs = NATIVE_SLOWMODE_MS, store = null } = {}) {
  const agg = createAggregator({ max: 100 });
  const stats = createStats();
  const streams = new Map();        // streamId -> { id, platform, source, channel, status, url, poolKey, label? }
  const keyToStreamId = new Map();  // poolKey -> streamId
  const clients = new Set();        // { send, guestId, lastNativeTs }
  let featuredId = null;
  let _sid = 0, _gid = 0;
  let _slowMs = slowModeMs;

  stats.registerStream(MB_STREAM, { platform: 'mb', streamer: '' }); // native chat metrics

  const room = {
    // ---- broadcast helpers ----
    broadcast(obj) { for (const c of clients) { try { c.send(obj); } catch {} } },
    pushStreams() { room.broadcast({ type: 'streams', streams: [...streams.values()] }); },
    statsSnapshot() { return stats.snapshot(now()); },
    pushStats() { room.broadcast({ type: 'stats', stats: stats.snapshot(now()) }); },
    snapshotFor(client) {
      return { type: 'snapshot', streams: [...streams.values()], featuredId,
        messages: agg.recent(), stats: stats.snapshot(now()), guestId: client.guestId };
    },

    // ---- client lifecycle ----
    attach(send) {
      const client = { send, guestId: 'guest-' + (++_gid).toString(36), lastNativeTs: -Infinity }; // -Inf so the FIRST message is never rate-limited regardless of clock magnitude
      clients.add(client);
      stats.setViewers(MB_STREAM, clients.size);
      try { send(room.snapshotFor(client)); } catch {}
      return client;
    },
    detach(client) { clients.delete(client); stats.setViewers(MB_STREAM, clients.size); },

    // ---- operator: streams + featured (fanout gates by token) ----
    async connect(url) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      const source = parsed.source || parsed.platform;
      const key = source + ':' + parsed.channel;
      const existingId = keyToStreamId.get(key);
      if (existingId) return { stream: streams.get(existingId) };
      const id = 's' + (++_sid);
      const stream = { id, platform: parsed.platform, source, channel: parsed.channel, status: 'connecting', url, poolKey: key };
      streams.set(id, stream); keyToStreamId.set(key, id);
      stats.registerStream(id, { platform: parsed.platform, streamer: '' });
      if (!featuredId) { featuredId = id; room.broadcast({ type: 'featured', id }); }
      room.pushStreams();
      await pool.subscribe(source, parsed.channel, room, parsed.platform);
      room._persist();
      return { stream };
    },
    disconnect(id) {
      const s = streams.get(id);
      if (!s) return;
      pool.unsubscribe(s.poolKey, room);
      streams.delete(id); keyToStreamId.delete(s.poolKey); stats.removeStream(id);
      if (featuredId === id) { featuredId = streams.keys().next().value || null; room.broadcast({ type: 'featured', id: featuredId }); }
      room.pushStreams(); room._persist();
    },
    selectFeatured(id) {
      if (!streams.has(id)) return { error: 'no such stream' };
      featuredId = id; room.broadcast({ type: 'featured', id }); room._persist();
      return { ok: true };
    },

    // ---- viewer: native chat (rate-limited) ----
    nativeChat(client, text) {
      let t = String(text == null ? '' : text).trim();
      if (!t) return;
      if (t.length > 240) t = t.slice(0, 240);
      const ts = now();
      if (ts - client.lastNativeTs < _slowMs) return { error: 'slow down' };
      client.lastNativeTs = ts;
      const msg = makeMessage({ platform: 'mb', streamId: MB_STREAM, username: client.guestId, text: t, ts });
      agg.push(msg); stats.recordMessage(MB_STREAM, ts);
      room.broadcast({ type: 'message', message: msg });
      return { ok: true };
    },

    // ---- moderation ----
    clearChat() { agg.clear(); room.broadcast({ type: 'clear' }); },
    setSlowMode(seconds) { _slowMs = Math.max(0, Number(seconds) || 0) * 1000; room.broadcast({ type: 'slowMode', seconds: _slowMs / 1000 }); },

    // ---- persistence ----
    _persist() {
      if (!store) return;
      const featuredKey = featuredId && streams.get(featuredId) ? streams.get(featuredId).poolKey : null;
      store.save({ streams: [...streams.values()].map(s => s.url), featuredKey });
    },
    async restore() {
      if (!store) return;
      const cfg = await store.load();
      for (const url of cfg.streams || []) { try { await room.connect(url); } catch {} }
      if (cfg.featuredKey) { const id = keyToStreamId.get(cfg.featuredKey); if (id) { featuredId = id; room.broadcast({ type: 'featured', id }); } }
    },

    // ---- ingester-pool room interface (fan out to all clients) ----
    streamIdFor(poolKey) { return keyToStreamId.get(poolKey); },
    onMessage(fields) {
      const streamId = keyToStreamId.get(fields.poolKey);
      if (!streamId) return;
      const msg = makeMessage({ ...fields, streamId });
      agg.push(msg);
      if (streams.has(streamId)) stats.recordMessage(streamId, now());
      room.broadcast({ type: 'message', message: msg });
    },
    onViewers(poolKey, n) { const id = keyToStreamId.get(poolKey); if (id) stats.setViewers(id, n); },
    onStatus(poolKey, status) { const id = keyToStreamId.get(poolKey); if (!id) return; const s = streams.get(id); if (s) s.status = status; room.pushStreams(); },
    setLabel(poolKey, label) { const id = keyToStreamId.get(poolKey); if (!id) return; const s = streams.get(id); if (s) { s.label = label; room.pushStreams(); } },

    get _clientCount() { return clients.size; },
  };
  return room;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node --test test/showRoom.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/showRoom.js server/test/showRoom.test.js
git commit -m "feat(server): showRoom — shared show, featured, native chat, persistence"
```

---

### Task 5: rewrite fanout.js for the shared show + role gating

One `showRoom`; every connection attaches; operator messages require the control token; viewers can only `nativeChat`.

**Files:**
- Modify: `server/src/fanout.js` (full rewrite)

- [ ] **Step 1: Rewrite `server/src/fanout.js`**

Replace the entire contents with:

```js
// server/src/fanout.js — one WS server attaching every connection to the ONE shared show.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';
import { createShowRoom } from './showRoom.js';
import { createShowStore } from './showStore.js';
import { CONTROL_TOKEN, SHOW_CONFIG_PATH } from './config.js';

// Operator gate: control actions REQUIRE the token. Unset → nobody can control (read-only show).
const mayControl = (msg) => !!CONTROL_TOKEN && msg.token === CONTROL_TOKEN;
const OPERATOR_TYPES = new Set(['connectStream', 'disconnectStream', 'selectFeatured', 'clearChat', 'slowMode']);

export function startFanout(httpServer, hubOptions = {}) {
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createHub(hubOptions);
  const store = createShowStore(SHOW_CONFIG_PATH);
  const showRoom = createShowRoom({ pool: hub.pool, store });

  const send = (ws, obj) => {
    try { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(obj)); } catch {}
  };

  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    const client = showRoom.attach((obj) => send(ws, obj));

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      (async () => {
        try {
          if (OPERATOR_TYPES.has(msg.type) && !mayControl(msg)) {
            send(ws, { type: 'error', error: 'not authorized' }); return;
          }
          switch (msg.type) {
            case 'nativeChat': { const r = showRoom.nativeChat(client, msg.text); if (r && r.error) send(ws, { type: 'error', error: r.error }); break; }
            case 'connectStream': { const r = await showRoom.connect(msg.url); if (r && r.error) send(ws, { type: 'error', error: r.error }); break; }
            case 'disconnectStream': showRoom.disconnect(msg.id); break;
            case 'selectFeatured': { const r = showRoom.selectFeatured(msg.id); if (r && r.error) send(ws, { type: 'error', error: r.error }); break; }
            case 'clearChat': showRoom.clearChat(); break;
            case 'slowMode': showRoom.setSlowMode(msg.seconds); break;
          }
        } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
      })();
    });

    ws.on('close', () => { try { showRoom.detach(client); } catch {} });
  });

  const statsTick = setInterval(() => { try { showRoom.pushStats(); } catch {} }, 1500);
  statsTick.unref?.();
  return { wss, hub, showRoom };
}
```

- [ ] **Step 2: Verify syntax + the suite still loads (room.js tests will be migrated in Task 7)**

Run: `cd server && node --check src/fanout.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add server/src/fanout.js
git commit -m "refactor(server): fanout attaches all connections to one shared show + role gating"
```

---

### Task 6: index.js — restore on startup + token warning; retire room.js

**Files:**
- Modify: `server/src/index.js` (startup section + the `hubRef`/shutdown wiring)
- Delete: `server/src/room.js`

- [ ] **Step 1: Wire the show room restore + control-token warning**

In `server/src/index.js`, change the fanout wiring line:

```js
const { hub } = startFanout(server);
hubRef = hub;
```

to:

```js
const { hub, showRoom } = startFanout(server);
hubRef = hub;
// Load the persisted show (stream URLs + featured) and re-connect on boot.
showRoom.restore().catch((e) => console.warn('[startup] show restore failed:', e.message));
```

Then, in the startup-warning block (next to the X/Kick warnings), add:

```js
import { CONTROL_TOKEN } from './config.js'; // ensure imported at top with the others
// ...
if (!CONTROL_TOKEN) console.warn('[startup] CONTROL_TOKEN not set — operator controls are LOCKED (read-only show). Set it to enable /add.');
```

(If `CONTROL_TOKEN` isn't already imported at the top of `index.js`, add it to the existing `import { ... } from './config.js';` line rather than a second import.)

- [ ] **Step 2: Delete the obsolete per-session room**

```bash
git rm server/src/room.js
```

- [ ] **Step 3: Verify the server boots**

Run: `cd server && PORT=8899 node src/index.js & sleep 1.5; curl -s localhost:8899/health; echo; kill %1`
Expected: `ok` and a startup log line warning about CONTROL_TOKEN (unset locally).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.js
git commit -m "feat(server): restore show on boot; CONTROL_TOKEN-locked warning; remove room.js"
```

---

### Task 7: migrate the v1 isolation tests to the shared-show model

The v1 per-session tests reference the removed `room.js` and the old isolation semantics. Replace them with a shared-show integration test and fix the X-routing test's import.

**Files:**
- Delete: `server/test/room.test.js`, `server/test/fanout_isolation.test.js`
- Modify: `server/test/xBroadcast.test.js` (swap `createRoom` → `createShowRoom`)
- Create: `server/test/fanout_shared.test.js`

- [ ] **Step 1: Remove the obsolete isolation tests**

```bash
git rm server/test/room.test.js server/test/fanout_isolation.test.js
```

- [ ] **Step 2: Point the X-routing test at the show room**

In `server/test/xBroadcast.test.js`, replace `import { createRoom } from '../src/room.js';` with `import { createShowRoom } from '../src/showRoom.js';`, and replace every `createRoom({ pool, send: ... , now: ... })` with a show room + attached client. Concretely, change the two routing tests so each room is built as:

```js
const room = createShowRoom({ pool, now: () => 1000 });
const sent = []; room.attach((o) => sent.push(o));
```

…and assert against `sent` (the broadcast list) instead of the old per-room `send` spy. For the isolation-style test, since there is now ONE shared room, assert instead that **two attached clients both receive** the X chat for the subscribed broadcast (replacing the old "room B is isolated" assertion). Keep the `activeXBroadcasts` and "unsubscribed id is a no-op" tests as-is (they don't depend on rooms).

- [ ] **Step 3: Write the shared-show integration test**

Create `server/test/fanout_shared.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startFanout } from '../src/fanout.js';

const captured = [];
function fakeIngesters() {
  class Fake { constructor(channel, cb) { this.channel = channel; this.cb = cb; captured.push(this); } async start() { this.cb.onStatus('live'); this.cb.onViewers(5); } async stop() {} emit(text) { this.cb.onMessage({ username: 'u', text }); } }
  return { twitch: Fake, kick: Fake, x: Fake, xbroadcast: Fake };
}
const next = (ws, pred) => new Promise((res) => { ws.on('message', function h(b) { const m = JSON.parse(b.toString()); if (pred(m)) { ws.off('message', h); res(m); } }); });

test('fanout: all clients share ONE show; native chat broadcasts to everyone', async () => {
  captured.length = 0;
  const server = createServer();
  startFanout(server, { ingesters: fakeIngesters() });
  await new Promise((r) => server.listen(0, r));
  const url = 'ws://127.0.0.1:' + server.address().port;

  const A = new WebSocket(url), B = new WebSocket(url);
  const snapA = await next(A, (m) => m.type === 'snapshot');
  await next(B, (m) => m.type === 'snapshot');
  assert.ok(snapA.guestId.startsWith('guest-'), 'A got a guest id');

  // A native-chats (no token needed) -> BOTH A and B receive it as mb
  const bGot = next(B, (m) => m.type === 'message' && m.message.text === 'gm');
  A.send(JSON.stringify({ type: 'nativeChat', text: 'gm' }));
  const got = await bGot;
  assert.equal(got.message.platform, 'mb', 'native message is mb');

  // operator control without a token is rejected (CONTROL_TOKEN unset in tests)
  const errP = next(A, (m) => m.type === 'error');
  A.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/foo' }));
  const err = await errP;
  assert.equal(err.error, 'not authorized');

  A.close(); B.close();
  await new Promise((r) => server.close(r));
});
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && node --test`
Expected: ALL PASS, 0 failures. (Pure-logic tests — parsers, normalize, stats, aggregator, parseXFrame, ingesterPool, showStore, showRoom — plus hub, xBroadcast, and the new fanout_shared.)

- [ ] **Step 5: Commit**

```bash
git add server/test/
git commit -m "test(server): migrate isolation tests to shared-show model"
```

---

### Task 8: deploy + manual two-browser verification

**Files:** none (deploy + manual + Railway/Vercel config).

- [ ] **Step 1: Add the Railway Volume + env, deploy backend**

In the Railway dashboard for `conflux-backend`: add a **Volume** mounted at `/data`; set `SHOW_CONFIG_PATH=/data/show.json` and `CONTROL_TOKEN=<a strong secret>` (generate with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`; set it via `railway variables --set "CONTROL_TOKEN=$VAR"` using a shell var so the literal never hits the command line). Then:

```bash
cd server && railway up --detach
```
Expected: deploy succeeds; `/health` returns `ok`.

- [ ] **Step 2: Verify the shared show + roles against prod**

Run a quick check: open two WS clients to `wss://conflux-backend-production.up.railway.app`; both should get a `snapshot` with a `guestId`; a `nativeChat` from one appears for the other as `platform:'mb'`; a `connectStream` without the token returns `{type:'error', error:'not authorized'}`.

- [ ] **Step 3: Operator add via token**

With the control token, send `{type:'connectStream', url:'https://twitch.tv/<live>', token:'<CONTROL_TOKEN>'}` (token via env/file, never on a logged command line) → both clients receive the stream + a `featured` event + real chat/viewers.

- [ ] **Step 4: Persistence check**

After adding a stream, redeploy (`railway up`) → on reboot the show should reload the stream from `/data/show.json` (both new clients see it without re-adding).

- [ ] **Step 5: Frontend wiring (coordinate with zac)**

Once zac's deck v2 is in: add the Vercel rewrite `{"source":"/add","destination":"/deck.html"}` to `vercel.json`, point the production root at `deck.html`, and redeploy. Then the full loop: open `/` in two browsers → identical live show; operator at `/add?key=<token>` adds + features a stream → both browsers update; a viewer native-chats → everyone sees it.

---

## Notes for the implementer
- The ingester **pool fans out to whatever rooms subscribed** — now that's just the single `showRoom`, so `routeKickChat`/`routeXChat`/`setX*` and the X worker's `/ingest/x` path keep working unchanged (they reach the show room, which broadcasts to all clients).
- `Math.random` is fine in server code (the ban is only in workflow scripts). Guest ids use a per-room counter for deterministic tests.
- Keep the per-send `bufferedAmount` cap and process-level guards — a public show has many clients.
- `CONTROL_TOKEN` MUST be set in prod or the show is read-only (operator can't add streams). That's the intended safe default.
