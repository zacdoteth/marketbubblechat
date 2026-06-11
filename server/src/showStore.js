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
