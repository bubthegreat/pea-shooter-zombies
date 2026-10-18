import test from 'node:test';
import assert from 'node:assert/strict';
import { stickKeys, touchLook, mobilize, isTouch, TOUCH_LOOK_MULT, STICK_DEADZONE } from '../client/touch.js';
import { applyLook, Input } from '../client/input.js';
import { DEFAULTS } from '../client/settings.js';

const R = 56;
const pressed = (k) => Object.keys(k).filter((n) => k[n]).sort().join('');

test('stickKeys: dead zone, 4 straight directions and 4 diagonals', () => {
  assert.equal(pressed(stickKeys(0, 0, R)), '');
  assert.equal(pressed(stickKeys(R * STICK_DEADZONE * 0.9, 0, R)), '', 'inside the dead zone');
  assert.equal(pressed(stickKeys(R * 0.4, 0, R)), 'r');
  assert.equal(pressed(stickKeys(-R, 0, R)), 'l');
  assert.equal(pressed(stickKeys(0, -R, R)), 'f', 'up on screen is forward');
  assert.equal(pressed(stickKeys(0, R, R)), 'b');
  assert.equal(pressed(stickKeys(R, -R, R)), 'fr');
  assert.equal(pressed(stickKeys(-R, -R, R)), 'fl');
  assert.equal(pressed(stickKeys(R, R, R)), 'br');
  assert.equal(pressed(stickKeys(-R, R, R)), 'bl');
});

test('stickKeys: a thumb slightly off an axis still goes straight', () => {
  // 15 degrees off forward: only forward
  const a = (15 * Math.PI) / 180;
  assert.equal(pressed(stickKeys(Math.sin(a) * R, -Math.cos(a) * R, R)), 'f');
  // 40 degrees off forward: forward + right
  const b = (40 * Math.PI) / 180;
  assert.equal(pressed(stickKeys(Math.sin(b) * R, -Math.cos(b) * R, R)), 'fr');
});

test('stickKeys: junk input presses nothing', () => {
  assert.equal(pressed(stickKeys(NaN, 5, R)), '');
  assert.equal(pressed(stickKeys(10, 10, 0)), '');
  assert.equal(pressed(stickKeys(10, 10, -3)), '');
});

test('touchLook: same direction conventions as the mouse, scaled by the touch multiplier', () => {
  const base = applyLook(0, 0, 40 * TOUCH_LOOK_MULT, -20 * TOUCH_LOOK_MULT, DEFAULTS);
  const t = touchLook(0, 0, 40, -20, DEFAULTS);
  assert.ok(Math.abs(t.yaw - base.yaw) < 1e-12 && Math.abs(t.pitch - base.pitch) < 1e-12);
  assert.ok(t.yaw < 0, 'dragging right turns right');
  assert.ok(t.pitch > 0, 'dragging up looks up');
  const inv = touchLook(0, 0, 40, -20, { ...DEFAULTS, invertX: true, invertY: true });
  assert.ok(inv.yaw > 0 && inv.pitch < 0, 'invert settings apply');
  const slow = touchLook(0, 0, 40, 0, { ...DEFAULTS, sens: 0.5 });
  assert.ok(Math.abs(slow.yaw - t.yaw / 2) < 1e-12, 'speed setting scales touch looks');
  assert.ok(Math.abs(touchLook(0, 0, 0, -9999, DEFAULTS).pitch) <= 1.4, 'pitch stays clamped');
});

test('mobilize: keyboard hints become touch hints', () => {
  assert.equal(mobilize('Hold E to start the mower! x'), 'Hold USE to start the mower! x');
  assert.equal(mobilize('Engine starting… keep holding E! 40%'), 'Engine starting… keep holding USE! 40%');
  assert.equal(mobilize("You're driving the mower. Press E to hop off"), "You're driving the mower. Tap USE to hop off");
  assert.equal(mobilize('Press Q to put it down'), 'Tap DROP to put it down');
  assert.equal(mobilize('then press q'), 'then press q', 'lowercase q is not a key hint');
  assert.equal(mobilize('Press 1 to plant a Peashooter!'), 'Tap \u{1F331} to plant a Peashooter!');
  assert.equal(mobilize('press 2 to plant a Cactus!'), 'tap \u{1F335} to plant a Cactus!');
  assert.equal(mobilize('stand by a spot and press 1 or 2 to plant.'), 'stand by a spot and tap a seed card to plant.');
  assert.equal(mobilize('Press 1-5 to plant here!'), 'Tap a seed card to plant here!');
  assert.equal(mobilize('Press 3 to plant a Repeater!'), 'Tap \u{1F33F} to plant a Repeater!');
  assert.equal(mobilize('Press U to upgrade Cactus \u2605\u2605 \u2014 75\u2600\uFE0F'), 'Tap UPGRADE to upgrade Cactus \u2605\u2605 \u2014 75\u2600\uFE0F');
  assert.equal(mobilize('Easy peasy: Eat Even Eggs'), 'Easy peasy: Eat Even Eggs', 'only a lone E/Q is a key');
  assert.equal(mobilize(''), '');
  assert.equal(mobilize(undefined), undefined);
});

test('isTouch is false without a browser', () => {
  assert.equal(isTouch(), false);
});

test('Input in touch mode: no pointer lock, "locked" follows requestLock/exitLock and releases everything', () => {
  const globals = {};
  for (const k of ['document', 'window']) globals[k] = globalThis[k];
  const noop = () => {};
  globalThis.document = { addEventListener: noop, pointerLockElement: null, exitPointerLock() { throw new Error('no pointer lock on touch'); } };
  globalThis.window = { addEventListener: noop };
  try {
    const canvas = { addEventListener: noop, requestPointerLock() { throw new Error('no pointer lock on touch'); } };
    const input = new Input(canvas);
    input.touch = true;
    const seen = [];
    input.onLockChange = (l) => seen.push(l);
    input.enabled = true;
    input.requestLock();
    assert.equal(input.locked, true);
    input.keys.f = true;
    input.fire = true;
    input.setMenuOpen(true); // the settings panel frees the controls
    assert.equal(input.locked, false);
    assert.equal(input.keys.f, false);
    assert.equal(input.fire, false);
    input.setMenuOpen(false);
    input.requestLock();
    input.requestLock(); // idempotent
    assert.deepEqual(seen, [true, false, true]);
    input.exitLock();
    assert.equal(input.locked, false);
  } finally {
    for (const k of Object.keys(globals)) {
      if (globals[k] === undefined) delete globalThis[k];
      else globalThis[k] = globals[k];
    }
  }
});
