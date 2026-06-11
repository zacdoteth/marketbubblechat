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

test('clear() empties the buffer', () => {
  const agg = createAggregator({ max: 10 });
  agg.push({ id: 'a' }); agg.push({ id: 'b' });
  assert.equal(agg.size, 2);
  agg.clear();
  assert.equal(agg.size, 0);
  assert.deepEqual(agg.recent(), []);
});
