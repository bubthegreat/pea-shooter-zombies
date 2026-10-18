import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../server/sim/config.js';
import { WORLD } from '../server/sim/world.js';
import { spawnProjectile, stepProjectiles } from '../server/sim/combat.js';
import { makeGame, run, keys } from './helpers.js';

function setup(extra = {}) {
  const game = makeGame(extra);
  const z = game.addPlayer('z', { name: 'Zed', team: 'zombie', mode: 'versus' });
  const p = game.addPlayer('p', { name: 'Pea', team: 'plant' });
  p.x = 38;
  p.z = 44;
  z.x = -38;
  z.z = -30;
  game.drainEvents();
  return { game, z, p };
}

const shootDoor = (game, id, damage = 8, n = 1) => {
  const d = WORLD.doors.find((x) => x.id === id);
  const piece = game.cover.get(`door:${id}`);
  for (let i = 0; i < n; i++) {
    // a goo shot flying at the door from outside
    spawnProjectile(game, {
      team: 'zombie', owner: 'z', projKind: 'bullet', damage, speed: 20,
      x: d.x + d.nx * 3, y: 1.2, z: d.z + d.nz * 3, dir: { x: -d.nx, y: 0, z: -d.nz },
    });
    for (let k = 0; k < 8; k++) stepProjectiles(game, 1 / 30);
  }
  return piece;
};

test('four doors with HP, listed in config, standing at round start', () => {
  const { game } = setup();
  for (const d of WORLD.doors) {
    const piece = game.cover.get(`door:${d.id}`);
    assert.ok(piece && piece.state === 'alive');
    assert.equal(piece.hp, DEFAULT_CONFIG.doorHp[d.id]);
  }
  assert.ok(DEFAULT_CONFIG.doorHp.garage > DEFAULT_CONFIG.doorHp.front, 'the garage door is the big one');
  const snap = game.mapState();
  assert.deepEqual(snap.gone, []);
  assert.deepEqual(snap.hurt, {});
});

test('zombie shots hurt a door (events at 75, 50, 25 %), plant shots pass through', () => {
  const { game } = setup();
  const max = DEFAULT_CONFIG.doorHp.front;
  const piece = shootDoor(game, 'front', 8, 8); // 64 of the door's HP
  assert.equal(piece.hp, max - 64);
  const hits = game.drainEvents().filter((e) => e.type === 'coverHit' && e.id === 'door:front');
  assert.deepEqual(hits.map((e) => e.maxHp), [max], 'one event as it crossed 75 %');
  shootDoor(game, 'front', 8, 8);
  shootDoor(game, 'front', 8, 8);
  const more = game.drainEvents().filter((e) => e.type === 'coverHit' && e.id === 'door:front');
  assert.equal(more.length, 2, '50 % and 25 %');
  assert.deepEqual(game.mapState().hurt, { 'door:front': piece.hp });
  const hp = piece.hp;
  const d = WORLD.doors[0];
  const pea = spawnProjectile(game, { team: 'plant', owner: 'p', projKind: 'pea', damage: 5, speed: 40, x: d.x, y: 1.2, z: d.z - 3, dir: { x: 0, y: 0, z: 1 } });
  for (let i = 0; i < 8; i++) stepProjectiles(game, 1 / 30);
  assert.equal(piece.hp, hp, 'a plant never hurts its own door');
  assert.ok(pea.z > d.z + 1, 'and its shots fly through');
});

test('a door at 0 HP breaks: planks event, collider gone, stays broken, resets next round', () => {
  const { game, z } = setup();
  const d = WORLD.doors.find((x) => x.id === 'side');
  const piece = shootDoor(game, 'side', 120, 2);
  assert.equal(piece.state, 'broken');
  const ev = game.drainEvents().find((e) => e.type === 'coverBreak');
  assert.ok(ev && ev.id === 'door:side' && ev.kind === 'door' && Math.abs(ev.x - d.x) < 0.5 && Math.abs(ev.z - d.z) < 1);
  assert.deepEqual(game.mapState().gone, ['door:side']);
  // a zombie can walk through the gap now
  z.x = d.x - 4;
  z.z = d.z;
  game.handleInput('z', { keys: keys({ f: true }), yaw: -Math.PI / 2, pitch: 0 }); // +x, into the house
  run(game, 2);
  assert.ok(z.x > d.x + 1, `inside at x=${z.x}`);
  // damage to a broken door is ignored, and a new round puts it back
  assert.equal(game.cover.damage(piece, 10, null, 'zombie'), false);
  const r0 = game.snapshot().round;
  game.startRound();
  assert.equal(game.snapshot().round, r0 + 1);
  assert.equal(game.cover.get('door:side').state, 'alive');
  assert.equal(game.cover.get('door:side').hp, DEFAULT_CONFIG.doorHp.side);
  assert.deepEqual(game.mapState().gone, []);
  z.x = d.x - 4;
  z.z = d.z;
  game.handleInput('z', { keys: keys({ f: true }), yaw: -Math.PI / 2, pitch: 0 });
  run(game, 2);
  assert.ok(z.x < d.x, 'blocked again');
});

test('splash damage reaches doors; the garage door takes a lot more', () => {
  const { game } = setup();
  const d = WORLD.doors.find((x) => x.id === 'front');
  game.cover.splash(d.x, 1, d.z - 0.5, 3.5, 40, null, 'zombie');
  assert.ok(game.cover.get('door:front').hp < DEFAULT_CONFIG.doorHp.front);
  game.cover.splash(d.x, 1, d.z - 0.5, 3.5, 40, null, 'plant');
  const hp = game.cover.get('door:front').hp;
  game.cover.splash(d.x, 1, d.z - 0.5, 3.5, 40, null, 'plant');
  assert.equal(game.cover.get('door:front').hp, hp, 'the plants own the door: their blasts spare it');
});

test('the welcome message carries the static map and the current door state', async () => {
  const { LobbyManager } = await import('../server/lobby.js');
  const mgr = new LobbyManager({ now: () => 0 });
  const member = (id, name) => ({ id, cid: id, name, team: 'plant', lobby: null, sent: [], send(m) { this.sent.push(m); }, raw() {}, lastInputAt: 0, inputActive: false });
  const a = member('a', 'Ann');
  mgr.create(a, { lobbyName: 'L', mode: 'coop', difficulty: 'easy', team: 'plant', name: 'Ann' });
  mgr.start(a);
  const w = a.sent.find((m) => m.t === 'welcome');
  assert.ok(w.config.map.terrain.data.length > 1000);
  assert.deepEqual(w.state.gone, []);
  assert.equal(typeof w.state.round, 'number');
  const lobby = [...mgr.lobbies.values()][0];
  lobby.game.cover.destroy(lobby.game.cover.get('door:back'));
  const b = member('b', 'Bo');
  mgr.join(b, lobby.id, { team: 'zombie', name: 'Bo' });
  const wb = b.sent.filter((m) => m.t === 'welcome').at(-1);
  assert.deepEqual(wb.state.gone, ['door:back']);
  assert.ok(JSON.stringify(wb).length < 120000, `welcome is ${JSON.stringify(wb).length} bytes`);
});
