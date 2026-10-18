import test from 'node:test';
import assert from 'node:assert/strict';
import { Settings, sanitize, DEFAULTS, SENS_MIN, SENS_MAX } from '../client/settings.js';
import { applyLook } from '../client/input.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('defaults when storage is missing, empty, corrupt or throws', () => {
  assert.deepEqual(new Settings(null).values, DEFAULTS);
  assert.deepEqual(new Settings(fakeStorage()).values, DEFAULTS);
  assert.deepEqual(new Settings(fakeStorage({ 'bb-look': '{nope' })).values, DEFAULTS);
  const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const s = new Settings(boom);
  assert.deepEqual(s.values, DEFAULTS);
  s.set({ invertY: true }); // must not throw, still applies in memory
  assert.equal(s.values.invertY, true);
});

test('sanitize clamps sensitivity and rejects junk', () => {
  assert.equal(sanitize({ sens: 99 }).sens, SENS_MAX);
  assert.equal(sanitize({ sens: 0 }).sens, SENS_MIN);
  assert.equal(sanitize({ sens: NaN }).sens, 1);
  assert.equal(sanitize({ sens: '2' }).sens, 1);
  assert.equal(sanitize({ invertX: 'yes', invertY: 1 }).invertX, false);
  assert.equal(sanitize({ sens: 1.2345 }).sens, 1.23);
  assert.deepEqual(sanitize(null), DEFAULTS);
});

test('set persists, reload restores, subscribers hear about it, reset restores defaults', () => {
  const st = fakeStorage();
  const s = new Settings(st);
  const seen = [];
  const off = s.subscribe((v) => seen.push(v));
  s.set({ invertX: true, sens: 2.5 });
  assert.equal(seen.length, 1);
  assert.deepEqual(new Settings(st).values, { invertX: true, invertY: false, sens: 2.5 });
  off();
  s.reset();
  assert.equal(seen.length, 1);
  assert.deepEqual(new Settings(st).values, DEFAULTS);
});

test('applyLook: default directions, inversion, sensitivity, pitch clamp, yaw wrap', () => {
  const base = { invertX: false, invertY: false, sens: 1 };
  const right = applyLook(0, 0, 100, 0, base);
  assert.ok(right.yaw < 0, 'mouse right turns right (negative yaw)');
  const up = applyLook(0, 0, 0, -100, base);
  assert.ok(up.pitch > 0, 'mouse up looks up');

  const ix = applyLook(0, 0, 100, 0, { ...base, invertX: true });
  assert.equal(ix.yaw, -right.yaw);
  const iy = applyLook(0, 0, 0, -100, { ...base, invertY: true });
  assert.equal(iy.pitch, -up.pitch);

  const fast = applyLook(0, 0, 100, 0, { ...base, sens: 2 });
  assert.ok(Math.abs(fast.yaw / right.yaw - 2) < 1e-9);
  const slow = applyLook(0, 0, 100, 0, { ...base, sens: 0.25 });
  assert.ok(Math.abs(slow.yaw / right.yaw - 0.25) < 1e-9);

  assert.equal(applyLook(0, 1.39, 0, -10000, { ...base, sens: 3 }).pitch, 1.4);
  assert.equal(applyLook(0, -1.39, 0, 10000, { ...base, sens: 3 }).pitch, -1.4);
  assert.equal(applyLook(0, 1.39, 0, 10000, { ...base, invertY: true, sens: 3 }).pitch, 1.4);

  const wrap = applyLook(-3.1, 0, 100, 0, base);
  assert.ok(wrap.yaw > 0 && wrap.yaw <= Math.PI);
});
