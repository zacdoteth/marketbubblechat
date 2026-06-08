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
