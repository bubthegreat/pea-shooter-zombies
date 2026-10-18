import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, publicConfig } from '../server/sim/config.js';
import { applyDamage } from '../server/sim/combat.js';
import { stepGarden, plantAt } from '../server/sim/garden.js';
import { gardenSlots } from '../server/sim/world.js';
import { makeGame, run, entitiesOfKind } from './helpers.js';

test('publicConfig is plain JSON with everything the client needs', () => {
  const cfg = publicConfig(DEFAULT_CONFIG);
  const round = JSON.parse(JSON.stringify(cfg));
  assert.deepEqual(round, cfg);
  for (const k of [
    'tickRate', 'snapRate', 'moveSpeed', 'eyeHeight', 'playerHeight', 'roundLength', 'wiltRespawn', 'sproutTime',
    'tierThresholds', 'streakBonus', 'weapons', 'plantTypes', 'startSunshine', 'mowerStartTime', 'waves', 'world', 'gardenSlots',
  ]) assert.ok(k in cfg, `missing ${k}`);
  assert.equal(cfg.gardenSlots.length, 36);
  assert.equal(cfg.plantTypes.peashooter.cost, 50);
  assert.equal(cfg.plantTypes.cactus.cost, 100);
  assert.deepEqual(cfg.weapons.plant.map((w) => w.id), ['pea_blaster'], 'plant kids keep one gun');
  assert.deepEqual(Object.keys(cfg.plantTypes), ['peashooter', 'cactus', 'repeater', 'snowpea', 'spikesquash', 'melonpult', 'wallnut', 'gatling', 'houseplant']);
  assert.equal(cfg.plantTypes.snowpea.tier, 2);
  assert.equal(cfg.plantTypes.snowpea.name, 'Snow Pea');
  assert.equal(cfg.plantTypes.wallnut.hp, DEFAULT_CONFIG.plantTypes.wallnut.hp);
  assert.deepEqual(cfg.plantLevels.cost, [0.75, 1.25]);
  assert.equal(cfg.plantLevels.max, 3);
  assert.equal(cfg.weapons.zombie.at(-1).id, 'auto_shot_rifle');
  assert.equal(cfg.waves.times[0], 5);
  assert.equal(cfg.world.garage.doorMinX, 14);
  assert.equal(cfg.world.mowerHome.z, 34);
  assert.ok(!('features' in cfg) && !('difficulties' in cfg), 'server tuning stays private');
});

test('converted bots never pile up: each one poofs into a sun pickup and nothing walks away', () => {
  const game = makeGame();
  const a = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  for (let i = 0; i < 8; i++) {
    const b = game.spawnBot('zombie', i - 4, 0);
    applyDamage(game, b, 99, a);
  }
  assert.equal([...game.entities.values()].filter((e) => e.kind === 'bot').length, 0);
  assert.equal([...game.entities.values()].filter((e) => e.kind === 'sun').length, 8);
  assert.equal(game.drainEvents().filter((e) => e.type === 'wilt' && e.retired).length, 0);
  assert.equal(a.progress, 8);
});

test('turrets aim where a moving target was a moment ago', () => {
  const idx = gardenSlots().findIndex((s) => s.kind === 'peashooter' && s.x === 0 && s.z === 0);
  const aimYaw = (vx) => {
    const game = makeGame();
    game.addPlayer('a', { team: 'plant', mode: 'coop' });
    const plant = plantAt(game, idx);
    const z = game.spawnBot('zombie', 0, -15);
    z.vx = vx;
    plant.cooldown = 99;
    stepGarden(game, 1 / 30);
    return plant.yaw;
  };
  const still = aimYaw(0);
  const running = aimYaw(6); // running to the +x side => aim trails toward -x
  assert.ok(Math.abs(still) < 1e-9);
  assert.ok(running !== still);
  assert.ok(running > 0 === true, `turn left (toward -x) when target runs right, yaw=${running}`);
  assert.equal(entitiesOfKind(makeGame(), 'projectile').length, 0);
});
