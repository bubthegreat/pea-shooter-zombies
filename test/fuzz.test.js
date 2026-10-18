import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD } from '../server/sim/world.js';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { Game } from '../server/sim/game.js';
import { mulberry32 } from './helpers.js';

// Random humans doing random things for a few simulated minutes: nothing throws, state stays sane.
for (const seed of [1, 2, 3]) {
  test(`fuzz: random play (seed ${seed}) keeps invariants`, () => {
    const rnd = mulberry32(seed * 977);
    const game = new Game(DEFAULT_CONFIG, mulberry32(seed));
    const ids = ['a', 'b'];
    const joined = new Set();
    for (let tick = 0; tick < 30 * 240; tick++) {
      if (tick % 45 === 0) {
        const id = ids[Math.floor(rnd() * ids.length)];
        if (joined.has(id) && rnd() < 0.15) {
          game.removePlayer(id);
          joined.delete(id);
        } else if (!joined.has(id)) {
          if (game.addPlayer(id, { name: id, team: rnd() < 0.5 ? 'plant' : 'zombie', mode: rnd() < 0.5 ? 'coop' : 'versus', difficulty: rnd() < 0.5 ? 'easy' : 'normal' })) joined.add(id);
        }
      }
      for (const id of joined) {
        if (tick % 3 === 0) {
          game.handleInput(id, {
            seq: tick,
            keys: { f: rnd() < 0.6, b: rnd() < 0.1, l: rnd() < 0.2, r: rnd() < 0.2, jump: rnd() < 0.05 },
            yaw: (rnd() - 0.5) * 20,
            pitch: (rnd() - 0.5) * 4,
            fire: rnd() < 0.5,
            use: rnd() < 0.3,
            drop: rnd() < 0.05,
            plant: Math.floor(rnd() * 3),
            plantSeq: rnd() < 0.5 ? tick : undefined,
          });
          // now and then wander into the garage so the tool rack gets exercised too
          const me = game.entities.get(id);
          if (me && rnd() < 0.02) {
            const r = DEFAULT_CONFIG.rack[Math.floor(rnd() * DEFAULT_CONFIG.rack.length)];
            me.x = r.x + (rnd() - 0.5) * 2;
            me.z = r.z - 0.5 - rnd();
          }
        }
      }
      game.tick(1 / 30);
      if (tick % 30 === 0) {
        const snap = game.snapshot();
        JSON.stringify(snap);
        game.drainEvents();
        const ids2 = new Set();
        for (const e of snap.entities) {
          assert.ok(!ids2.has(e.id), `duplicate id ${e.id}`);
          ids2.add(e.id);
          for (const k of ['x', 'y', 'z', 'yaw', 'hp', 'maxHp']) assert.ok(Number.isFinite(e[k]), `${e.kind} ${e.id}.${k}=${e[k]}`);
          assert.ok(e.hp >= 0, `${e.id} hp ${e.hp}`);
          if (e.kind === 'player' || e.kind === 'bot') {
            assert.ok(Math.abs(e.x) <= WORLD.extent.maxX && e.z >= WORLD.extent.minZ && e.z <= WORLD.extent.maxZ, `${e.id} out of world`);
            assert.ok(!(e.z > WORLD.bounds.maxZ && (e.x < 13.9 || e.x > 26.1)), `${e.id} inside a wall at ${e.x},${e.z}`);
          }
        }
        assert.ok(snap.entities.length < 400, 'entity count stays bounded');
        // tool bookkeeping: one holder per tool, both sides agree
        for (const r of snap.entities.filter((e) => e.kind === 'rack_item')) {
          const holders = snap.entities.filter((e) => e.item === r.itemId);
          assert.ok(holders.length <= 1, `${r.itemId} held by ${holders.length}`);
          assert.equal(r.heldBy, holders[0]?.id ?? null, `${r.itemId} heldBy`);
          if (r.heldBy) assert.equal(r.available, false);
          if (holders[0]?.item === 'wheelbarrow') assert.ok(holders[0].itemHp > 0 && holders[0].itemHp <= 30);
        }
        if (snap.phase === 'lobby') assert.equal(snap.entities.length, 0);
      }
    }
  });
}
