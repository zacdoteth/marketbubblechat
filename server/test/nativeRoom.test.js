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
