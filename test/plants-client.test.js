import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConfig, DEFAULT_CONFIG } from '../server/sim/config.js';
import { gardenSlots } from '../server/sim/world.js';
import { plantAt, pickUpgradeTarget as serverPick, upgradeCost as serverCost } from '../server/sim/garden.js';
import { plantList, unlockedPlants, nextUnlock, stars, upgradeCost, pickUpgradeTarget, upgradePrompt, DEFAULT_PLANTS } from '../client/plants.js';
import { Input } from '../client/input.js';
import { mulberry32, makeGame } from './helpers.js';

const cfg = JSON.parse(JSON.stringify(publicConfig()));

test('plantList follows the server roster: keys 1-9 in unlock order with icons', () => {
  const list = plantList(cfg);
  assert.deepEqual(list.map((p) => p.id), Object.keys(DEFAULT_CONFIG.plantTypes));
  assert.deepEqual(list.map((p) => p.key), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(list[3].name, 'Snow Pea');
  assert.ok(list.every((p) => typeof p.icon === 'string' && p.icon.length > 0 && Number.isFinite(p.cost)));
  assert.equal(new Set(list.map((p) => p.icon)).size, 9, 'nine different icons');
  // without a config the built-in roster is used and matches the server's
  assert.deepEqual(plantList(null).map((p) => [p.id, p.name, p.tier, p.cost]), plantList(cfg).map((p) => [p.id, p.name, p.tier, p.cost]));
  assert.deepEqual(Object.keys(DEFAULT_PLANTS), Object.keys(DEFAULT_CONFIG.plantTypes));
});

test('unlockedPlants / nextUnlock by tier', () => {
  assert.deepEqual(unlockedPlants(cfg, 0).map((p) => p.id), ['peashooter', 'cactus']);
  assert.deepEqual(unlockedPlants(cfg, 3).map((p) => p.id), ['peashooter', 'cactus', 'repeater', 'snowpea', 'spikesquash']);
  assert.equal(unlockedPlants(cfg, 7).length, 9);
  assert.deepEqual(nextUnlock(cfg, 0).plants.map((p) => p.name), ['Repeater']);
  assert.equal(nextUnlock(cfg, 6).plants[0].name, 'House Plant');
  assert.equal(nextUnlock(cfg, 7), null);
});

test('upgrade cost and prompt text match the server', () => {
  for (const kind of Object.keys(DEFAULT_CONFIG.plantTypes)) {
    for (const level of [1, 2, 3]) assert.equal(upgradeCost(cfg, kind, level), serverCost(DEFAULT_CONFIG, kind, level), `${kind} L${level}`);
  }
  assert.equal(stars(2), '★★');
  const plant = { plantKind: 'cactus', level: 1 };
  assert.equal(upgradePrompt(cfg, plant, 500), 'Press U to upgrade Cactus ★★ — 75☀️');
  assert.match(upgradePrompt(cfg, plant, 10), /needs .* 75 to upgrade/);
  assert.match(upgradePrompt(cfg, { plantKind: 'cactus', level: 3 }, 999), /fully grown/);
  assert.match(upgradePrompt(cfg, { plantKind: 'houseplant', level: 2 }, 999), /House Plant ★★★ — 375/);
});

test('client upgrade target matches the server for random positions and looks', () => {
  const game = makeGame();
  const p = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  gardenSlots().forEach((_, i) => { if (i % 3 !== 1) plantAt(game, i, 'cactus'); });
  const rnd = mulberry32(99);
  let withTarget = 0;
  for (let i = 0; i < 400; i++) {
    p.x = -18 + rnd() * 36;
    p.z = -3 + rnd() * 18;
    p.yaw = (rnd() * 2 - 1) * Math.PI;
    const s = serverPick(game, p);
    const c = pickUpgradeTarget(game.entities, p, cfg);
    assert.equal(c ? c.plant.id : null, s ? s.id : null, `at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) yaw ${p.yaw.toFixed(2)}`);
    if (s) withTarget++;
  }
  assert.ok(withTarget > 100, 'the sample actually hits plants');
});

// ---- keys ---------------------------------------------------------------------------------------

function fakeInput() {
  const noop = () => {};
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { addEventListener: noop, pointerLockElement: null };
  globalThis.window = { addEventListener: noop };
  const input = new Input({ addEventListener: noop });
  input.enabled = true;
  return { input, restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } } };
}
const key = (code, extra = {}) => ({ code, target: { tagName: 'BODY' }, repeat: false, preventDefault() {}, ...extra });

test('keys 1-9 (top row and numpad) queue planting presses; U is the upgrade key', () => {
  const { input, restore } = fakeInput();
  try {
    for (let n = 1; n <= 9; n++) input._key(key('Digit' + n), true);
    input._key(key('Numpad4'), true);
    input._key(key('Digit0'), true);
    input._key(key('Digit5', { repeat: true }), true); // key repeat does not plant again
    assert.deepEqual(input.planter.queue.map((q) => q.kind), [5, 6, 7, 8, 9, 4], 'ten presses, the sender keeps the newest six');
    assert.equal(input.planter.seq, 10);
    assert.equal(input.message().upgrade, false);
    input._key(key('KeyU'), true);
    assert.equal(input.message().upgrade, true);
    input._key(key('KeyU'), false);
    assert.equal(input.message().upgrade, true, 'a tap shorter than one send interval still reaches the server');
    input._upgradePending = false;
    assert.equal(input.message().upgrade, false);
  } finally {
    restore();
  }
});
