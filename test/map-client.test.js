import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConfig, DEFAULT_CONFIG } from '../server/sim/config.js';
import { terrainHeight } from '../server/sim/terrain.js';
import { checkBuild } from '../server/sim/build.js';
import { WORLD } from '../server/sim/world.js';
import { MapData } from '../client/map.js';
import { makeGame, mulberry32 } from './helpers.js';

const cfg = publicConfig();

test('the client map samples the same ground as the server', () => {
  const m = new MapData(cfg.map, cfg.builds);
  const rnd = mulberry32(3);
  for (let i = 0; i < 3000; i++) {
    const x = -40 + rnd() * 80;
    const z = -52 + rnd() * 98;
    assert.ok(Math.abs(m.groundHeight(x, z) - terrainHeight(x, z)) < 1e-6);
  }
});

test('supportY and rayGround: decks and hills', () => {
  const m = new MapData(cfg.map, cfg.builds);
  assert.equal(m.supportY(5, 26, 0.9), 0.9, 'on the deck');
  assert.equal(m.supportY(5, 26, 0), 0, 'a walker at ground level next to... under the deck edge');
  const hit = m.rayGround(0, 1.6, 0, 0, -0.6, -0.8, 30);
  assert.ok(hit && Math.abs(hit.y - m.groundHeight(hit.x, hit.z)) < 0.01);
  assert.equal(m.rayGround(0, 1.6, 0, 0, 1, 0, 10), null, 'looking at the sky');
});

test('the ghost agrees with the server about where a build may go (random spots, all kinds)', () => {
  const game = makeGame({ features: { cover: true } });
  const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
  const z = game.addPlayer('z', { team: 'zombie' });
  z.x = 0;
  z.z = -40;
  const state = game.mapState();
  const m = new MapData(cfg.map, cfg.builds, state);
  // a few builds and a destroyed stone so the dynamic parts matter
  p.sunshine = 5000;
  for (const [gx, gz] of [[0, -30], [6, -30], [12, -30]]) {
    game.handleInput('p', { build: 1, bx: gx, bz: gz, br: 0, buildSeq: p.buildSeqSeen + 1 });
    game.tick(1 / 30);
  }
  for (const ev of game.drainEvents()) m.onEvent(ev);
  game.cover.destroy(game.cover.get('door:front'));
  for (const ev of game.drainEvents()) m.onEvent(ev);
  const rnd = mulberry32(8);
  let ok = 0;
  let bad = 0;
  for (let i = 0; i < 1500; i++) {
    p.x = -35 + rnd() * 70;
    p.z = -45 + rnd() * 85;
    p.y = 0;
    const kind = 1 + Math.floor(rnd() * 2);
    const def = cfg.builds.plant[kind - 1];
    const rot = rnd() < 0.5 ? 1 : 0;
    const gx = Math.round(p.x + (rnd() - 0.5) * 20);
    const gz = Math.round(p.z + (rnd() - 0.5) * 20);
    const server = checkBuild(game, p, { ...def, team: 'plant' }, gx, gz, rot, { free: true });
    const others = [...game.entities.values()].filter((e) => e.kind === 'player' || e.kind === 'bot' || e.kind === 'garden');
    const client = m.placement(def, gx, gz, rot, p, others);
    assert.equal(client.ok, server.ok, `(${gx}, ${gz}) rot ${rot} player at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}: client ${client.reason} server ${server.reason}`);
    if (server.ok) ok++;
    else bad++;
  }
  assert.ok(ok > 100 && bad > 100, `a mix of spots: ${ok} ok, ${bad} refused`);
  assert.ok(WORLD && DEFAULT_CONFIG);
});

test('events keep the client state in step: hits, breaks, builds, round reset', () => {
  const m = new MapData(cfg.map, cfg.builds);
  const stone = cfg.map.cover.find((c) => c.kind === 'gravestone');
  m.onEvent({ type: 'coverHit', id: stone.id, hp: 30, maxHp: 60 });
  assert.equal(m.piece(stone.id).hp, 30);
  m.onEvent({ type: 'coverBreak', id: stone.id });
  assert.equal(m.piece(stone.id).alive, false);
  m.onEvent({ type: 'build', id: 'b1', kind: 'fence', x: 4, z: 5, rot: 1, by: 'p', hp: 150, maxHp: 150 });
  assert.equal(m.placed.get('b1').w, 1);
  assert.equal(m.placed.get('b1').d, 3);
  m.applyState({ round: 2, gone: ['door:back'], hurt: {}, builds: [] });
  assert.equal(m.doors.get('door:back').alive, false);
  m.reset(null);
  assert.equal(m.piece(stone.id).alive, true);
  assert.equal(m.placed.size, 0);
});
