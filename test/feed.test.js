import test from 'node:test';
import assert from 'node:assert/strict';
import { feedLine } from '../client/feed.js';
import { cleanName } from '../client/text.js';
import { sanitizeName } from '../server/sim/names.js';

const text = (line) => line.parts.map((p) => p.text).join('');

test('convert: "Jacob turned Zombie into a flower!" with team colours', () => {
  const line = feedLine({ type: 'convert', byName: 'Jacob', byKind: 'player', targetName: 'Zombie', targetKind: 'bot', human: false });
  assert.equal(text(line), 'Jacob turned Zombie into a flower!');
  assert.deepEqual(line.parts.filter((p) => p.team).map((p) => [p.text, p.team]), [['Jacob', 'plant'], ['Zombie', 'zombie']]);
  assert.equal(line.head, false);
});

test('headshot kills are marked', () => {
  const line = feedLine({ type: 'convert', byName: 'Jacob', byKind: 'player', targetName: 'Zombie', targetKind: 'bot', head: true });
  assert.equal(line.head, true);
  const w = feedLine({ type: 'wilt', byName: 'J-Bob', byKind: 'player', targetName: 'Pea', targetKind: 'player', head: true });
  assert.equal(w.head, true);
});

test('wilt: zombie wilts a plant kid; garden plants get an article', () => {
  assert.equal(text(feedLine({ type: 'wilt', byName: 'J-Bob', byKind: 'player', targetName: 'Pea', targetKind: 'player' })), 'J-Bob wilted Pea!');
  assert.equal(text(feedLine({ type: 'wilt', byName: 'J-Bob', byKind: 'player', targetName: 'Cactus', targetKind: 'garden', plantKind: 'cactus' })), 'J-Bob wrecked a Cactus!');
});

test('mow: "J-Bob mowed a Cactus!"', () => {
  const line = feedLine({ type: 'mow', byName: 'J-Bob', byKind: 'player', targetName: 'Cactus', targetKind: 'garden' });
  assert.equal(text(line), 'J-Bob mowed a Cactus!');
  assert.equal(line.parts[0].team, 'zombie');
});

test('mower_destroyed names the plant that did it', () => {
  const line = feedLine({ type: 'mower_destroyed', byName: 'Pea', byKind: 'player', targetKind: 'mower' });
  assert.equal(text(line), 'Pea wrecked the mower!');
  assert.equal(line.parts[0].team, 'plant');
});

test('bots fighting bots stay out of the feed; a human on either side shows', () => {
  assert.equal(feedLine({ type: 'convert', byName: 'Peashooter', byKind: 'garden', targetName: 'Zombie', targetKind: 'bot' }), null);
  assert.equal(feedLine({ type: 'mow', byName: 'Zombie', byKind: 'bot', targetName: 'Cactus', targetKind: 'garden' }), null);
  const hit = feedLine({ type: 'convert', byName: 'Peashooter', byKind: 'garden', targetName: 'Zed', targetKind: 'player', human: true });
  assert.equal(text(hit), 'Peashooter turned Zed into a flower!');
  assert.equal(text(feedLine({ type: 'wilt', byName: 'Zombie', byKind: 'bot', targetName: 'Pea', targetKind: 'player' })), 'Zombie wilted Pea!');
});

test('junk and unrelated events give null; hostile names stay plain text', () => {
  for (const ev of [null, undefined, 5, {}, { type: 'hit' }, { type: 'convert' }, { type: 'wave', byKind: 'player' }]) assert.equal(feedLine(ev), null);
  const line = feedLine({ type: 'convert', byName: '<i onload=a()>', byKind: 'player', targetName: 'Z', targetKind: 'bot' });
  assert.equal(line.parts[0].text, '<i onload=a()>');
  const long = feedLine({ type: 'convert', byName: 'a'.repeat(100), byKind: 'player', targetName: 'Z', targetKind: 'bot' });
  assert.ok(long.parts[0].text.length <= 16);
});

test('client cleanName matches the server sanitizer', () => {
  const cases = ['  Jacob ', 'x'.repeat(40), `a${String.fromCharCode(0, 7, 0x202e, 0x200b)}b`, '', '   ', '<b>', String.fromCodePoint(0x1f33b).repeat(20)];
  for (const c of cases) assert.equal(cleanName(c, 'Player'), sanitizeName(c));
  assert.equal(cleanName(null, 'Zed'), 'Zed');
});

test('tagAlpha: opaque up close, fades smoothly, gone far away', async () => {
  const { tagAlpha, TAG_NEAR, TAG_FAR } = await import('../client/tags.js');
  assert.equal(tagAlpha(0), 1);
  assert.equal(tagAlpha(TAG_NEAR), 1);
  assert.equal(tagAlpha(TAG_FAR), 0);
  assert.equal(tagAlpha(500), 0);
  const mid = tagAlpha((TAG_NEAR + TAG_FAR) / 2);
  assert.ok(mid > 0.4 && mid < 0.6, `mid ${mid}`);
  assert.ok(tagAlpha(35) > tagAlpha(50) && tagAlpha(50) > tagAlpha(65));
});
