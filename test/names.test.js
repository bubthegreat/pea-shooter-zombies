import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, sanitizeLobbyName } from '../server/sim/names.js';

const ch = (...codes) => String.fromCharCode(...codes);

test('sanitizeName trims, caps at 16 and falls back to Player', () => {
  assert.equal(sanitizeName('  Jacob  '), 'Jacob');
  assert.equal(sanitizeName('x'.repeat(40)), 'x'.repeat(16));
  assert.equal(sanitizeName('  ' + 'y'.repeat(40)), 'y'.repeat(16));
  assert.equal(sanitizeName(''), 'Player');
  assert.equal(sanitizeName('   '), 'Player');
  for (const bad of [undefined, null, 42, {}, [], true, () => 'x']) assert.equal(sanitizeName(bad), 'Player');
});

test('sanitizeName strips control, bidi and zero-width characters', () => {
  assert.equal(sanitizeName(`Ja${ch(0)}co${ch(7)}b\n`), 'Jacob');
  assert.equal(sanitizeName(`${ch(27)}[31mRed`), '[31mRed');
  assert.equal(sanitizeName(`a${ch(0x7f)}b${ch(0x85)}c`), 'abc');
  assert.equal(sanitizeName(`${ch(0x202e)}evil${ch(0x202c)}`), 'evil');
  assert.equal(sanitizeName(`a${ch(0x200b)}b${ch(0x2066)}c${ch(0xfeff)}`), 'abc');
  assert.equal(sanitizeName(`${ch(0, 1)}`), 'Player');
  assert.equal(sanitizeName('tab\there'), 'tabhere');
  assert.equal(sanitizeName(`line${ch(0x2028)}break`), 'linebreak');
});

test('sanitizeName keeps markup as plain text (rendering uses textContent) and caps by code point', () => {
  assert.equal(sanitizeName('<b>hi</b>'), '<b>hi</b>');
  const kids = String.fromCodePoint(0x1f33b).repeat(20);
  const out = sanitizeName(kids);
  assert.equal([...out].length, 16);
  assert.equal(out, String.fromCodePoint(0x1f33b).repeat(16));
});

test('sanitizeName honours custom fallback and max', () => {
  assert.equal(sanitizeName('', 'Zed'), 'Zed');
  assert.equal(sanitizeName('abcdef', 'Zed', 3), 'abc');
});

test('sanitizeLobbyName caps at 32 and falls back', () => {
  assert.equal(sanitizeLobbyName('z'.repeat(80), 'x'), 'z'.repeat(32));
  assert.equal(sanitizeLobbyName(` ${ch(0)} `, "Jo's Backyard"), "Jo's Backyard");
  assert.equal(sanitizeLobbyName(`  Cool${ch(1)} Club  `, 'x'), 'Cool Club');
});
