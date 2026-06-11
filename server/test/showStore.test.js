import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createShowStore } from '../src/showStore.js';

test('showStore: save then load round-trips; missing file → empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'showstore-'));
  const path = join(dir, 'show.json');
  const store = createShowStore(path);

  assert.deepEqual(await store.load(), { streams: [], featuredKey: null });

  await store.save({ streams: ['https://twitch.tv/a', 'https://kick.com/b'], featuredKey: 'twitch:a' });
  assert.deepEqual(await store.load(), { streams: ['https://twitch.tv/a', 'https://kick.com/b'], featuredKey: 'twitch:a' });

  rmSync(dir, { recursive: true, force: true });
});

test('showStore: corrupt file → empty default (never throws)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'showstore-'));
  const path = join(dir, 'show.json');
  writeFileSync(path, 'not json {{{');
  const store = createShowStore(path);
  assert.deepEqual(await store.load(), { streams: [], featuredKey: null });
  rmSync(dir, { recursive: true, force: true });
});
