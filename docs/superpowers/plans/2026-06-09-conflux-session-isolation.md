# CONFLUX Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each browser session its own isolated room of streams (refresh = blank, two shows never collide) while sharing the real upstream ingesters across sessions so cost stays flat.

**Architecture:** Replace the single global registry/aggregator/stats in `hub.js` with: (1) a global, ref-counted `IngesterPool` keyed by `platform:channel` that owns one real ingester per channel and fans its events out to subscribed rooms, and (2) a per-WebSocket `Room` that owns its own aggregator + stats + stream set. `fanout.js` creates one `Room` per connection and tears it down on close. The Kick webhook stays app-level and routes by broadcaster id to the right rooms.

**Tech Stack:** Node ESM, `ws`, native `node:test`. No new dependencies.

---

### Task 1: IngesterPool — ref-counted subscribe/unsubscribe + idle linger

Owns one real ingester per `platform:channel`, ref-counted by rooms. When the last room leaves, the ingester is stopped after a grace period. Timer functions and the ingester map are injectable for testing.

**Files:**
- Create: `server/src/ingesterPool.js`
- Test: `server/test/ingesterPool.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/ingesterPool.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngesterPool } from '../src/ingesterPool.js';

// A fake ingester that records lifecycle and lets tests push events.
function makeFakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.started = false; this.stopped = false; instances.push(this); }
    async start() { this.started = true; this.cb.onStatus('live'); this.cb.onViewers(42); this.cb.onResolved?.('bid-' + this.channel); }
    async stop() { this.stopped = true; }
    emit(text) { this.cb.onMessage({ username: 'u', text }); }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}

// A controllable scheduler so linger does not depend on wall-clock.
function makeScheduler() {
  const jobs = [];
  return {
    setTimer: (fn) => { const j = { fn, cancelled: false }; jobs.push(j); return j; },
    clearTimer: (j) => { if (j) j.cancelled = true; },
    fireAll: () => { for (const j of jobs.splice(0)) if (!j.cancelled) j.fn(); },
  };
}

function fakeRoom() {
  return { msgs: [], statuses: [], viewers: [],
    onMessage(f) { this.msgs.push(f); },
    onStatus(k, s) { this.statuses.push([k, s]); },
    onViewers(k, n) { this.viewers.push([k, n]); } };
}

test('pool: two rooms on same channel share ONE ingester; stops only after last leaves + linger', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer, lingerMs: 1000 });
  const a = fakeRoom(), b = fakeRoom();

  await pool.subscribe('twitch', 'foo', a);
  await pool.subscribe('twitch', 'foo', b);
  assert.equal(instances.length, 1, 'one shared ingester');

  pool.unsubscribe('twitch:foo', a);
  sch.fireAll();
  assert.equal(instances[0].stopped, false, 'still has a subscriber -> not stopped');

  pool.unsubscribe('twitch:foo', b);
  assert.equal(instances[0].stopped, false, 'linger not fired yet');
  sch.fireAll();
  assert.equal(instances[0].stopped, true, 'stopped after last leaves + linger');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/ingesterPool.test.js`
Expected: FAIL — `Cannot find module '../src/ingesterPool.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/ingesterPool.js`:

```js
// server/src/ingesterPool.js — global, ref-counted pool of real ingesters.
// One ingester per "platform:channel"; events fan out to subscribed rooms.
import { TwitchIngester } from './ingesters/twitch.js';
import { KickIngester } from './ingesters/kick.js';
import { XIngester } from './ingesters/x.js';

const DEFAULT_INGESTERS = { twitch: TwitchIngester, kick: KickIngester, x: XIngester };

export function createIngesterPool({
  ingesters = DEFAULT_INGESTERS,
  lingerMs = 20_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map();          // poolKey -> entry
  const broadcasterToKey = new Map(); // broadcasterUserId(string) -> poolKey

  const keyOf = (platform, channel) => platform + ':' + channel;

  async function subscribe(platform, channel, room) {
    const key = keyOf(platform, channel);
    let entry = entries.get(key);
    if (entry) {
      if (entry.lingerTimer) { clearTimer(entry.lingerTimer); entry.lingerTimer = null; }
      entry.rooms.add(room);
      if (entry.lastStatus != null) room.onStatus(key, entry.lastStatus);
      if (entry.lastViewers != null) room.onViewers(key, entry.lastViewers);
      return key;
    }
    entry = { platform, channel, ingester: null, rooms: new Set([room]),
      broadcasterUserId: null, lastStatus: null, lastViewers: null, lingerTimer: null };
    entries.set(key, entry);
    const Ing = ingesters[platform];
    const ing = new Ing(channel, {
      onMessage: (m) => { for (const r of entry.rooms) r.onMessage({ ...m, poolKey: key, platform }); },
      onViewers: (n) => { entry.lastViewers = n; for (const r of entry.rooms) r.onViewers(key, n); },
      onStatus: (s) => { entry.lastStatus = s; for (const r of entry.rooms) r.onStatus(key, s); },
      onResolved: (bid) => { entry.broadcasterUserId = String(bid); broadcasterToKey.set(String(bid), key); },
    });
    entry.ingester = ing;
    try { await ing.start(); } catch {}
    return key;
  }

  function unsubscribe(key, room) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.rooms.delete(room);
    if (entry.rooms.size === 0 && !entry.lingerTimer) {
      entry.lingerTimer = setTimer(() => { _stopEntry(key); }, lingerMs);
      entry.lingerTimer?.unref?.();
    }
  }

  async function _stopEntry(key) {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.rooms.size > 0) { entry.lingerTimer = null; return; } // someone rejoined during linger
    entries.delete(key);
    if (entry.broadcasterUserId) broadcasterToKey.delete(entry.broadcasterUserId);
    try { await entry.ingester?.stop(); } catch {}
  }

  return { subscribe, unsubscribe, _entries: entries, _broadcasterToKey: broadcasterToKey };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/ingesterPool.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingesterPool.js server/test/ingesterPool.test.js
git commit -m "feat(server): ref-counted ingester pool with idle linger"
```

---

### Task 2: IngesterPool — replay-on-join, Kick routing, stopAll

Add three behaviors to the pool: a room joining an existing channel gets the current status/viewers replayed; Kick webhook chat routes by broadcaster id to that channel's rooms; `stopAll()` for graceful shutdown.

**Files:**
- Modify: `server/src/ingesterPool.js`
- Test: `server/test/ingesterPool.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `server/test/ingesterPool.test.js`:

```js
test('pool: a room joining an existing channel gets status+viewers replayed', async () => {
  const { ingesters } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  const a = fakeRoom(), b = fakeRoom();
  await pool.subscribe('twitch', 'foo', a);
  await pool.subscribe('twitch', 'foo', b);
  // b joined after the ingester already reported live/42 -> it must be replayed.
  assert.deepEqual(b.statuses.at(-1), ['twitch:foo', 'live']);
  assert.deepEqual(b.viewers.at(-1), ['twitch:foo', 42]);
});

test('pool: linger reuse — re-subscribing within the window keeps the SAME ingester', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  const a = fakeRoom();
  await pool.subscribe('twitch', 'foo', a);
  pool.unsubscribe('twitch:foo', a);    // schedules linger
  await pool.subscribe('twitch', 'foo', a); // rejoin before firing
  sch.fireAll();                          // cancelled timer must be a no-op
  assert.equal(instances.length, 1, 'no second ingester created');
  assert.equal(instances[0].stopped, false, 'warm ingester reused, not stopped');
});

test('pool: routeKickChat reaches only the resolved broadcaster’s rooms; unknown bid dropped', async () => {
  const { ingesters } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  const a = fakeRoom(), b = fakeRoom();
  await pool.subscribe('kick', 'roshtein', a); // Fake.start resolves 'bid-roshtein'
  await pool.subscribe('kick', 'someone', b);  // resolves 'bid-someone'
  pool.routeKickChat('bid-roshtein', { username: 'x', text: 'hi', ts: 1 });
  assert.equal(a.msgs.length, 1);
  assert.equal(a.msgs[0].text, 'hi');
  assert.equal(a.msgs[0].platform, 'kick');
  assert.equal(b.msgs.length, 0, 'other channel’s room untouched');
  pool.routeKickChat('does-not-exist', { username: 'x', text: 'drop', ts: 2 });
  assert.equal(a.msgs.length, 1, 'unknown broadcaster dropped');
});

test('pool: stopAll stops every ingester', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const sch = makeScheduler();
  const pool = createIngesterPool({ ingesters, setTimer: sch.setTimer, clearTimer: sch.clearTimer });
  await pool.subscribe('twitch', 'foo', fakeRoom());
  await pool.subscribe('kick', 'bar', fakeRoom());
  await pool.stopAll();
  assert.ok(instances.every(i => i.stopped), 'all ingesters stopped');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && node --test test/ingesterPool.test.js`
Expected: FAIL — `pool.routeKickChat is not a function` (and `stopAll` undefined). The replay + linger-reuse tests should already pass from Task 1.

- [ ] **Step 3: Add `routeKickChat` and `stopAll` to the pool**

In `server/src/ingesterPool.js`, add these two functions before the `return`:

```js
  function routeKickChat(broadcasterUserId, fields) {
    const key = broadcasterToKey.get(String(broadcasterUserId));
    if (!key) { console.warn('[kick] webhook chat dropped: unknown broadcaster', broadcasterUserId); return; }
    const entry = entries.get(key);
    if (!entry) return;
    for (const r of entry.rooms) r.onMessage({ ...fields, poolKey: key, platform: 'kick' });
  }

  async function stopAll() {
    for (const key of [...entries.keys()]) {
      const entry = entries.get(key);
      if (!entry) continue;
      if (entry.lingerTimer) clearTimer(entry.lingerTimer);
      entry.rooms.clear();
      entries.delete(key);
      if (entry.broadcasterUserId) broadcasterToKey.delete(entry.broadcasterUserId);
      try { await entry.ingester?.stop(); } catch {}
    }
  }
```

Then update the `return` line to expose them:

```js
  return { subscribe, unsubscribe, routeKickChat, stopAll, _entries: entries, _broadcasterToKey: broadcasterToKey };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && node --test test/ingesterPool.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingesterPool.js server/test/ingesterPool.test.js
git commit -m "feat(server): pool replay-on-join, Kick routing, stopAll"
```

---

### Task 3: Room — per-session streams, aggregator, stats

A `Room` owns one session's view. It allocates room-local stream ids, subscribes to the pool, records fanned-out events into its own aggregator + stats, and sends events to its own socket via an injected `send`.

**Files:**
- Create: `server/src/room.js`
- Test: `server/test/room.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/room.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../src/room.js';
import { createIngesterPool } from '../src/ingesterPool.js';

function makeFakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.stopped = false; instances.push(this); }
    async start() { this.cb.onStatus('live'); this.cb.onViewers(7); this.cb.onResolved?.('bid-' + this.channel); }
    async stop() { this.stopped = true; }
    emit(text) { this.cb.onMessage({ username: 'u', text }); }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };

test('room.connect: rejects unsupported url; snapshot empty before any connect', () => {
  const pool = createIngesterPool({ ...makeFakeIngesters(), ...noopSched });
  const sent = [];
  const room = createRoom({ pool, send: (o) => sent.push(o), now: () => 1000 });
  const snap = room.snapshot();
  assert.deepEqual(snap.streams, []);
  assert.deepEqual(snap.messages, []);
  assert.ok(snap.stats);
});

test('room.connect: bad url returns error and adds nothing', async () => {
  const pool = createIngesterPool({ ...makeFakeIngesters(), ...noopSched });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  const r = await room.connect('https://youtube.com/x');
  assert.ok(r.error);
  assert.equal(room.snapshot().streams.length, 0);
});

test('room.connect: de-dupes same platform+channel within the room', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const pool = createIngesterPool({ ingesters, ...noopSched });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  const a = await room.connect('https://x.com/elonmusk');
  const b = await room.connect('https://x.com/elonmusk');
  assert.equal(a.stream.id, b.stream.id, 'same stream returned');
  assert.equal(room.snapshot().streams.length, 1);
  assert.equal(instances.length, 1, 'one ingester');
});

test('room: isolation — a fanned-out message lands only in the subscribing room', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const pool = createIngesterPool({ ingesters, ...noopSched });
  const sentA = [], sentB = [];
  const roomA = createRoom({ pool, send: (o) => sentA.push(o), now: () => 1000 });
  const roomB = createRoom({ pool, send: (o) => sentB.push(o), now: () => 1000 });
  await roomA.connect('https://twitch.tv/foo'); // instance[0] = twitch:foo
  await roomB.connect('https://twitch.tv/bar'); // instance[1] = twitch:bar
  instances.find(i => i.channel === 'foo').emit('hello-foo');
  const aMsgs = sentA.filter(o => o.type === 'message');
  const bMsgs = sentB.filter(o => o.type === 'message');
  assert.equal(aMsgs.length, 1);
  assert.equal(aMsgs[0].message.text, 'hello-foo');
  assert.equal(aMsgs[0].message.streamId, roomA.snapshot().streams[0].id);
  assert.equal(bMsgs.length, 0, 'room B never sees room A’s channel');
});

test('room.destroy: releases pool refs so the ingester stops after linger', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const jobs = [];
  const pool = createIngesterPool({ ingesters,
    setTimer: (fn) => { const j = { fn }; jobs.push(j); return j; }, clearTimer: () => {} });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  await room.connect('https://twitch.tv/foo');
  room.destroy();
  jobs.splice(0).forEach(j => j.fn());     // fire linger
  assert.equal(instances[0].stopped, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/room.test.js`
Expected: FAIL — `Cannot find module '../src/room.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/room.js`:

```js
// server/src/room.js — one isolated session: own streams, aggregator, stats.
import { createAggregator } from './aggregator.js';
import { createStats } from './stats.js';
import { makeMessage } from './normalize.js';
import { parseStreamUrl } from './urlParser.js';

let _id = 0; // process-global unique stream id counter

export function createRoom({ pool, send, now = () => Date.now() }) {
  const agg = createAggregator({ max: 100 });
  const stats = createStats();
  const streams = new Map();       // streamId -> { id, platform, channel, status, poolKey }
  const keyToStreamId = new Map(); // poolKey -> streamId (1:1 within a room)

  const pushStreams = () => send({ type: 'streams', streams: [...streams.values()] });

  const room = {
    streamIdFor(poolKey) { return keyToStreamId.get(poolKey); },
    snapshot() { return { streams: [...streams.values()], messages: agg.recent(), stats: stats.snapshot(now()) }; },
    statsSnapshot() { return stats.snapshot(now()); },
    pushStats() { send({ type: 'stats', stats: stats.snapshot(now()) }); },

    async connect(url) {
      const parsed = parseStreamUrl(url);
      if (parsed.error) return { error: parsed.error };
      const key = parsed.platform + ':' + parsed.channel;
      const existingId = keyToStreamId.get(key);
      if (existingId) return { stream: streams.get(existingId) };
      const id = 's' + (++_id);
      const stream = { id, platform: parsed.platform, channel: parsed.channel, status: 'connecting', poolKey: key };
      streams.set(id, stream);
      keyToStreamId.set(key, id);
      stats.registerStream(id, { platform: parsed.platform, streamer: '' });
      pushStreams();                 // instant pill (connecting)
      await pool.subscribe(parsed.platform, parsed.channel, room);
      return { stream };
    },

    disconnect(streamId) {
      const s = streams.get(streamId);
      if (!s) return;
      pool.unsubscribe(s.poolKey, room);
      streams.delete(streamId);
      keyToStreamId.delete(s.poolKey);
      stats.removeStream(streamId);
      pushStreams();
    },

    destroy() {
      for (const s of streams.values()) pool.unsubscribe(s.poolKey, room);
      streams.clear();
      keyToStreamId.clear();
    },

    // ---- pool fan-out callbacks (keyed by poolKey; translate to this room’s streamId) ----
    onMessage(fields) {
      const streamId = keyToStreamId.get(fields.poolKey);
      if (!streamId) return; // late event after unsubscribe
      const msg = makeMessage({ ...fields, streamId });
      agg.push(msg);
      if (streams.has(streamId)) stats.recordMessage(streamId, now());
      send({ type: 'message', message: msg });
    },
    onViewers(poolKey, n) {
      const streamId = keyToStreamId.get(poolKey);
      if (streamId) stats.setViewers(streamId, n);
    },
    onStatus(poolKey, status) {
      const streamId = keyToStreamId.get(poolKey);
      if (!streamId) return;
      const s = streams.get(streamId);
      if (s) s.status = status;
      pushStreams();
    },
  };
  return room;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/room.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/room.js server/test/room.test.js
git commit -m "feat(server): per-session Room over the ingester pool"
```

---

### Task 4: Reduce hub.js to pool ownership + Kick routing delegate

`createHub` becomes the composition root: it owns one `IngesterPool` and exposes `routeKickChat` (for the webhook receiver) and `stopAll` (for shutdown). All per-session state moves to `Room`.

**Files:**
- Modify: `server/src/hub.js` (full rewrite)
- Test: `server/test/hub.test.js` (full rewrite)

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `server/test/hub.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub.js';

function makeFakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.stopped = false; instances.push(this); }
    async start() { this.cb.onResolved?.('bid-' + this.channel); }
    async stop() { this.stopped = true; }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}
const noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };

test('hub: routeKickChat delegates to the pool and reaches subscribed rooms', async () => {
  const hub = createHub({ ...makeFakeIngesters(), ...noopSched });
  const got = [];
  const room = { onMessage: (f) => got.push(f), onStatus: () => {}, onViewers: () => {} };
  await hub.pool.subscribe('kick', 'roshtein', room);
  hub.routeKickChat('bid-roshtein', { username: 'u', text: 'gg', ts: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'gg');
  assert.equal(got[0].platform, 'kick');
});

test('hub: stopAll stops pooled ingesters', async () => {
  const { ingesters, instances } = makeFakeIngesters();
  const hub = createHub({ ingesters, ...noopSched });
  await hub.pool.subscribe('twitch', 'foo', { onMessage(){}, onStatus(){}, onViewers(){} });
  await hub.stopAll();
  assert.ok(instances.every(i => i.stopped));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/hub.test.js`
Expected: FAIL — `hub.pool is undefined` / `hub.routeKickChat is not a function` (old hub still exports `connectStream` etc.).

- [ ] **Step 3: Rewrite `server/src/hub.js`**

Replace the entire contents of `server/src/hub.js` with:

```js
// server/src/hub.js — composition root: owns the shared ingester pool.
// Per-session state (streams/aggregator/stats) lives in Room (see room.js).
import { createIngesterPool } from './ingesterPool.js';

export function createHub(poolOptions = {}) {
  const pool = createIngesterPool(poolOptions);
  return {
    pool,
    routeKickChat: (broadcasterUserId, fields) => pool.routeKickChat(broadcasterUserId, fields),
    stopAll: () => pool.stopAll(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/hub.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/hub.js server/test/hub.test.js
git commit -m "refactor(server): hub owns shared pool; per-session state moves to Room"
```

---

### Task 5: Rewire fanout.js (per-WS rooms) and index.js (routeKickChat + stopAll)

`fanout.js` creates a `Room` per connection, sends that room its empty snapshot, routes control messages to it, tears it down on close, and pushes per-room stats on the tick. `index.js` switches the webhook to `routeKickChat` and shutdown to `stopAll`.

**Files:**
- Modify: `server/src/fanout.js` (full rewrite)
- Modify: `server/src/index.js:47` and `server/src/index.js:91-94`

- [ ] **Step 1: Rewrite `server/src/fanout.js`**

Replace the entire contents of `server/src/fanout.js` with:

```js
// server/src/fanout.js — one WS server; each connection is its own isolated Room.
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';
import { createRoom } from './room.js';
import { CONTROL_TOKEN } from './config.js';

// Control gate: with CONTROL_TOKEN set, only clients presenting it may add/remove
// streams (guards paid-API cost abuse). Unset → open (demo). Isolation is per-room
// regardless: a client can only ever affect its own room.
const mayControl = (msg) => !CONTROL_TOKEN || msg.token === CONTROL_TOKEN;

export function startFanout(httpServer, hubOptions = {}) {
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createHub(hubOptions);
  const rooms = new Set();

  const send = (ws, obj) => {
    try {
      // skip a backed-up client so one stuck reader can't OOM us
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(obj));
    } catch {}
  };

  wss.on('connection', (ws) => {
    ws.on('error', () => {}); // malformed frames must not crash the process
    const room = createRoom({ pool: hub.pool, send: (obj) => send(ws, obj) });
    rooms.add(room);
    send(ws, { type: 'snapshot', ...room.snapshot() }); // empty -> blank dashboard

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      (async () => {
        try {
          if (msg.type === 'connectStream' || msg.type === 'disconnectStream') {
            if (!mayControl(msg)) { send(ws, { type: 'error', error: 'not authorized to control streams' }); return; }
          }
          if (msg.type === 'connectStream') {
            const r = await room.connect(msg.url);
            if (r.error) send(ws, { type: 'error', error: r.error });
          } else if (msg.type === 'disconnectStream') {
            room.disconnect(msg.id);
          }
        } catch (e) { send(ws, { type: 'error', error: 'server error' }); }
      })();
    });

    ws.on('close', () => { try { room.destroy(); } catch {} rooms.delete(room); });
  });

  // periodic per-room stats push. unref so it never keeps the process (or a test) alive
  // on its own — the listening socket is what keeps a real server running.
  const statsTick = setInterval(() => { for (const room of rooms) { try { room.pushStats(); } catch {} } }, 1500);
  statsTick.unref?.();
  return { wss, hub };
}
```

- [ ] **Step 2: Update `server/src/index.js` — webhook routing call**

Find (around line 47):

```js
          if (hubRef && m.broadcasterUserId) hubRef.handleKickChat(m.broadcasterUserId, { username: m.username, text: m.text, ts: m.ts || Date.now() });
```

Replace `handleKickChat` with `routeKickChat`:

```js
          if (hubRef && m.broadcasterUserId) hubRef.routeKickChat(m.broadcasterUserId, { username: m.username, text: m.text, ts: m.ts || Date.now() });
```

- [ ] **Step 3: Update `server/src/index.js` — graceful shutdown**

Find (around lines 91-94):

```js
  try {
    const ids = hub.registry.list().map(s => s.id);
    await Promise.all(ids.map(id => Promise.resolve(hub.disconnectStream(id)).catch(() => {})));
  } catch {}
```

Replace with:

```js
  try { await hub.stopAll(); } catch {}
```

- [ ] **Step 4: Run the full suite to verify nothing regressed structurally**

Run: `cd server && node --test`
Expected: `hub.test.js`, `ingesterPool.test.js`, `room.test.js` PASS. `reliability_fixes.test.js` is expected to FAIL here (it still calls the old hub API) — fixed in Task 6. Note the failure count; everything else should pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/fanout.js server/src/index.js
git commit -m "refactor(server): per-WS room lifecycle in fanout; index routeKickChat+stopAll"
```

---

### Task 6: Port the old hub-API tests in reliability_fixes.test.js

`reliability_fixes.test.js` exercises three behaviors that moved from hub to Room/pool: same-channel de-dupe, Kick routing for unknown/removed streams, and stats cleanup on disconnect. Port them to the new API. Also fix the stale comment in `final_verification.test.js`.

**Files:**
- Modify: `server/test/reliability_fixes.test.js:29-67`
- Modify: `server/test/final_verification.test.js:37`

- [ ] **Step 1: Read the current hub-API tests**

Run: `cd server && sed -n '1,70p' test/reliability_fixes.test.js`
Note the import line and the three `hub.*` tests (lines ~29-67) you are replacing.

- [ ] **Step 2: Replace the three hub tests with Room/pool equivalents**

In `server/test/reliability_fixes.test.js`: (a) change the import `import { createHub } from '../src/hub.js';` to:

```js
import { createRoom } from '../src/room.js';
import { createIngesterPool } from '../src/ingesterPool.js';

// Shared fakes for the ported room/pool tests
function _fakeIngesters() {
  const instances = [];
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; this.stopped = false; instances.push(this); }
    async start() { this.cb.onResolved?.('bid-' + this.channel); this.cb.onStatus('live'); this.cb.onViewers(1); }
    async stop() { this.stopped = true; }
  }
  return { ingesters: { twitch: Fake, kick: Fake, x: Fake }, instances };
}
const _noopSched = { setTimer: (fn) => ({ fn }), clearTimer: () => {} };
```

(b) Replace the three tests (the `dedupe`, `handleKickChat routes/guards`, and `removed stream id no-op` tests, lines ~29-67) with:

```js
test('FIX room.connect: same platform+channel returns existing stream (dedupe)', async () => {
  const { ingesters, instances } = _fakeIngesters();
  const pool = createIngesterPool({ ingesters, ..._noopSched });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  const a = await room.connect('https://x.com/elonmusk');
  const b = await room.connect('https://x.com/elonmusk');
  assert.equal(a.stream.id, b.stream.id, 'same stream returned');
  assert.equal(room.snapshot().streams.length, 1, 'only one stream registered');
  assert.equal(instances.length, 1, 'only one ingester started');
});

test('FIX pool.routeKickChat: routes to mapped room, drops unknown broadcaster', async () => {
  const { ingesters } = _fakeIngesters();
  const pool = createIngesterPool({ ingesters, ..._noopSched });
  const got = [];
  const room = createRoom({ pool, send: (o) => { if (o.type === 'message') got.push(o.message); }, now: () => 1000 });
  await room.connect('https://kick.com/somebody'); // resolves 'bid-somebody'
  pool.routeKickChat('999999', { username: 'u', text: 'dropped', ts: 1 }); // unknown -> drop
  assert.equal(got.length, 0);
  pool.routeKickChat('bid-somebody', { username: 'u', text: 'kept', ts: 2 });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'kept');
});

test('FIX room.disconnect: removes stats and late Kick chat is a no-op', async () => {
  const { ingesters } = _fakeIngesters();
  const pool = createIngesterPool({ ingesters, ..._noopSched });
  const room = createRoom({ pool, send: () => {}, now: () => 1000 });
  const s = await room.connect('https://kick.com/somebody');
  const id = s.stream.id;
  room.disconnect(id);
  assert.equal(room.statsSnapshot().perStream[id], undefined, 'stats cleaned up');
  // late webhook for the now-removed channel must not throw and must not re-add anything
  assert.doesNotThrow(() => pool.routeKickChat('bid-somebody', { username: 'x', text: 'y', ts: 0 }));
  assert.equal(room.snapshot().streams.length, 0);
});
```

- [ ] **Step 3: Fix the stale comment in final_verification.test.js**

Run: `cd server && sed -n '34,40p' test/final_verification.test.js` to view the comment context. Change the line:

```js
  // Flows through: hub.connectStream -> emit -> stats -> snapshot
```

to:

```js
  // Flows through: room.connect -> pool fan-out -> stats -> snapshot
```

(Comment only — do not change the test logic; it does not import hub.)

- [ ] **Step 4: Run the full suite**

Run: `cd server && node --test`
Expected: ALL tests PASS. Confirm the summary shows 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/test/reliability_fixes.test.js server/test/final_verification.test.js
git commit -m "test(server): port hub-API tests to Room/pool; fix stale comment"
```

---

### Task 7: End-to-end WS isolation test (the user's two requirements, proven)

A real integration test: boot an HTTP server + `startFanout` with fake ingesters injected, connect two `ws` clients, and assert (a) each gets an empty snapshot on connect (blank dashboard) and (b) a message for client A's channel never reaches client B (isolation).

**Files:**
- Test: `server/test/fanout_isolation.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/fanout_isolation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startFanout } from '../src/fanout.js';

// Fake ingesters captured so the test can emit a message on demand.
const captured = [];
function makeFakeIngesters() {
  class Fake {
    constructor(channel, cb) { this.channel = channel; this.cb = cb; captured.push(this); }
    async start() { this.cb.onStatus('live'); this.cb.onViewers(5); this.cb.onResolved?.('bid-' + this.channel); }
    async stop() {}
    emit(text) { this.cb.onMessage({ username: 'u', text }); }
  }
  return { twitch: Fake, kick: Fake, x: Fake };
}

const next = (ws, pred) => new Promise((resolve) => {
  ws.on('message', function h(buf) {
    const m = JSON.parse(buf.toString());
    if (pred(m)) { ws.off('message', h); resolve(m); }
  });
});

test('fanout: per-session isolation + blank snapshot on connect', async () => {
  captured.length = 0;
  const server = createServer();
  startFanout(server, { ingesters: makeFakeIngesters() });
  await new Promise((r) => server.listen(0, r));
  const url = 'ws://127.0.0.1:' + server.address().port;

  const A = new WebSocket(url), B = new WebSocket(url);
  const snapA = await next(A, (m) => m.type === 'snapshot');
  const snapB = await next(B, (m) => m.type === 'snapshot');
  assert.deepEqual(snapA.streams, [], 'A starts blank');
  assert.deepEqual(snapB.streams, [], 'B starts blank');

  // A connects a twitch channel; B connects a different one.
  A.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/foo' }));
  B.send(JSON.stringify({ type: 'connectStream', url: 'https://twitch.tv/bar' }));
  await next(A, (m) => m.type === 'streams' && m.streams.some(s => s.channel === 'foo'));
  await next(B, (m) => m.type === 'streams' && m.streams.some(s => s.channel === 'bar'));

  // Emit on A's channel; only A must receive the chat message.
  const bGotForeign = next(B, (m) => m.type === 'message' && m.message.text === 'hello-foo');
  const aGot = next(A, (m) => m.type === 'message' && m.message.text === 'hello-foo');
  captured.find(i => i.channel === 'foo').emit('hello-foo');
  await aGot; // A receives it
  const race = await Promise.race([bGotForeign.then(() => 'leaked'),
    new Promise((r) => setTimeout(() => r('isolated'), 150))]);
  assert.equal(race, 'isolated', 'B must NOT receive A’s channel message');

  A.close(); B.close();
  await new Promise((r) => server.close(r));
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && node --test test/fanout_isolation.test.js`
Expected: PASS. (If `startFanout` ignored `hubOptions`, the real ingesters would hit the network and `captured` would be empty → the test would fail. It passes because Task 5 threads `hubOptions` into `createHub`.)

- [ ] **Step 3: Run the whole suite**

Run: `cd server && node --test`
Expected: ALL PASS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add server/test/fanout_isolation.test.js
git commit -m "test(server): end-to-end per-session isolation + blank snapshot"
```

---

### Task 8: Deploy + manual two-browser verification

Deploy the backend and verify the two user-facing requirements against the live deploy in real browsers.

**Files:** none (deploy + manual).

- [ ] **Step 1: Push and deploy the backend (Railway)**

```bash
git push
cd server && railway up
```
Expected: deploy succeeds; `https://conflux-backend-production.up.railway.app/health` returns `ok`.

- [ ] **Step 2: Verify blank-on-refresh**

Open `https://marketbubblechat-fawn.vercel.app`, hard-refresh (Cmd+Shift+R). Expected: dashboard is blank — no pre-added streams, empty-state copy visible.

- [ ] **Step 3: Verify two-session isolation**

In two separate browser windows (or one normal + one incognito), open the site. In window 1 add `https://twitch.tv/<a-live-channel>`; in window 2 add a *different* live channel. Expected: each window shows ONLY its own stream + chat; neither sees the other's. Refresh window 1 → it goes blank; window 2 is unaffected.

- [ ] **Step 4: Verify shared-ingester (cost) behavior**

In both windows add the *same* live channel. Watch the Railway logs (`railway logs`). Expected: a single ingester/connection for that channel (not two); both windows receive its chat.

- [ ] **Step 5: Final commit (docs/notes only, if any)**

If you adjusted any docs during verification:
```bash
git add -A && git commit -m "docs: note session-isolation verification results"
git push
```

---

## Notes for the implementer

- **No frontend changes are planned.** Blank-on-refresh falls out of the empty per-room snapshot. Only touch `conflux.html` if Step 2/3 of Task 8 reveal a stale client assumption — if so, stop and surface it rather than guessing.
- **Tests never load `.env`** (`node --test` has no `--env-file`), so `CONTROL_TOKEN` is unset and the control gate is open in tests. The live deploy keeps `CONTROL_TOKEN` set as a cost-abuse gate.
- **All injected ingesters ignore extra callbacks.** Twitch/X destructure `{onMessage,onViewers,onStatus}`; Kick destructures `{onViewers,onStatus,onResolved}`. The pool passes all four — each picks what it needs. This is why one pool wiring serves all three.
