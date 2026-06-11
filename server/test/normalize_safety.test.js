import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMessage } from '../src/normalize.js';

test('RELIABILITY: makeMessage with missing required fields', () => {
  // Call with minimal args
  const m = makeMessage({ platform: 'twitch' });
  
  console.log('Made message:', m);
  assert.ok(m.id, 'should have local id');
  assert.ok(m.username === 'anon', 'missing username defaults to anon');
  assert.ok(m.displayName === 'anon', 'missing displayName defaults to name fallback');
  assert.ok(m.text === '', 'missing text defaults to empty string');
  assert.ok(m.ts === 0, 'missing ts defaults to 0');
  assert.ok(m.color, 'should have a color');
  assert.ok(m.streamId === null, 'missing streamId is null');
  assert.ok(m.streamer === '', 'missing streamer is empty string');
});

test('RELIABILITY: makeMessage null/undefined edge cases', () => {
  const m = makeMessage({ 
    platform: 'twitch', 
    text: null,
    username: null,
    displayName: null,
    color: null,
    streamer: null,
    streamId: null,
    ts: null
  });
  
  console.log('Message with nulls:', m);
  assert.equal(m.text, '', 'null text becomes empty string (never the literal "null" in chat)');
  assert.equal(m.username, 'anon', 'null username becomes anon');
  assert.equal(m.displayName, 'anon', 'null displayName becomes anon');
  assert.equal(m.streamer, '', 'null streamer becomes empty string');
  assert.equal(m.color, '#A571FF', 'null color falls back to the platform color (twitch)');
});

test('RELIABILITY: makeMessage with non-string text', () => {
  const m1 = makeMessage({ platform: 'twitch', text: 123 });
  assert.equal(m1.text, '123');
  
  const m2 = makeMessage({ platform: 'twitch', text: { obj: 'ect' } });
  assert.equal(m2.text, '[object Object]');
  
  const m3 = makeMessage({ platform: 'twitch', text: true });
  assert.equal(m3.text, 'true');
});

test('RELIABILITY: makeMessage seq is always 0 before aggregator', () => {
  const messages = [];
  for (let i = 0; i < 100; i++) {
    messages.push(makeMessage({ platform: 'twitch', text: `msg${i}` }));
  }
  
  // All should have seq = 0 until aggregator assigns
  messages.forEach((m, i) => {
    assert.equal(m.seq, 0, `message ${i} should have seq=0 before aggregator`);
  });
});

