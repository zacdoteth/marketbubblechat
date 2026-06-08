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
