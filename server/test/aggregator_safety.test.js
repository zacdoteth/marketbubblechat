import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAggregator } from '../src/aggregator.js';

test('RELIABILITY: aggregator recent() returns copy', () => {
  const a = createAggregator({ max: 3 });
  a.push({ text: 'a' });
  
  const r1 = a.recent();
  r1.push({ text: 'evil' });
  
  const r2 = a.recent();
  assert.equal(r2.length, 1, 'mutation of returned array should not affect internal state');
});

test('RELIABILITY: aggregator max buffer enforcement', () => {
  const a = createAggregator({ max: 2 });
  a.push({ text: 'msg1' });
  a.push({ text: 'msg2' });
  a.push({ text: 'msg3' });
  
  const r = a.recent();
  assert.equal(r.length, 2);
  assert.equal(r[0].text, 'msg2');
  assert.equal(r[1].text, 'msg3');
  assert.equal(r[0].seq, 2);
  assert.equal(r[1].seq, 3);
});

test('RELIABILITY: seq monotonically increasing across many messages', () => {
  const a = createAggregator({ max: 5 });
  
  for (let i = 1; i <= 100; i++) {
    a.push({ text: `msg${i}` });
  }
  
  const r = a.recent();
  assert.equal(r.length, 5);
  
  // Check seq is continuous even after buffer wrapping
  for (let i = 0; i < r.length - 1; i++) {
    assert.ok(r[i].seq < r[i+1].seq, 'seq should be monotonic');
  }
  
  // Last seq should be 100
  assert.equal(r[r.length - 1].seq, 100);
});

test('RELIABILITY: undefined/missing fields in pushed message', () => {
  const a = createAggregator({ max: 3 });
  
  const m = a.push({ }); // empty object
  console.log('Pushed empty object:', m);
  assert.ok(m.seq === 1);
  assert.ok(m.text === undefined);
  
  const r = a.recent();
  assert.equal(r[0].text, undefined);
});

