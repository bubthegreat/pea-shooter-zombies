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

const extra = { potRules: cfg.potRules, pots: cfg.pots, doorHp: cfg.doorHp };

test('the pot ghost agrees with the server about where a pot may stand (random cells, builder in and out of the house, pots, people)', () => {
  const game = makeGame({ features: { cover: false } });
  const p = game.addPlayer('p', { team: 'plant', mode: 'versus' });
  const q = game.addPlayer('q', { team: 'plant', mode: 'versus' });
  p.sunshine = 1e6;
  const potDef = cfg.builds.plant.find((b) => b.id === 'pot');
  const idx = cfg.builds.plant.indexOf(potDef) + 1;
  // a few pots already standing (placed the real way)
  for (const [gx, gz] of [[-5, 10], [-9, 18], [3, 12], [-5, 20]]) {
    p.x = gx;
    p.z = gz - 2;
    game.handleInput('p', { build: idx, bx: gx, bz: gz, br: 0, buildSeq: p.buildSeqSeen + 1 });
    game.tick(1 / 30);
  }
  assert.equal(game.cover.buildsOf('p', 'pot'), 4);
  const m = new MapData(cfg.map, cfg.builds, game.mapState(), extra);
  assert.equal(m.placed.size, 4);
  const rnd = mulberry32(21);
  let ok = 0;
  let bad = 0;
  const reasons = new Set();
  for (let i = 0; i < 3000; i++) {
    const inside = rnd() < 0.8;
    p.x = inside ? -13 + rnd() * 20.5 : -20 + rnd() * 40;
    p.z = inside ? 6.5 + rnd() * 17 : -2 + rnd() * 30;
    p.y = 0;
    q.x = -13 + rnd() * 20;
    q.z = 7 + rnd() * 16;
    const gx = Math.round(-14 + rnd() * 23);
    const gz = Math.round(5 + rnd() * 20);
    const server = checkBuild(game, p, { ...potDef, team: 'plant' }, gx, gz, 0, { free: true });
    const others = [...game.entities.values()].filter((e) => (e.kind === 'player' || e.kind === 'bot' || e.kind === 'garden'));
    const client = m.placement(potDef, gx, gz, 0, p, others);
    assert.equal(client.ok, server.ok, `(${gx}, ${gz}) builder ${p.x.toFixed(1)}, ${p.z.toFixed(1)}: client ${client.reason} server ${server.reason}`);
    if (!server.ok) assert.equal(client.reason, server.reason, `(${gx}, ${gz}) reason`);
    if (server.ok) ok++;
    else bad++;
    reasons.add(server.reason ?? 'ok');
  }
  assert.ok(ok > 150 && bad > 150, `a mix of cells: ${ok} ok, ${bad} refused`);
  for (const r of ['house', 'lane', 'crowd', 'blocked', 'busy']) assert.ok(reasons.has(r), `saw ${r}: ${[...reasons]}`);
});

test('door HP from snapshots and the doorUp event keep the client doors in step', () => {
  const m = new MapData(cfg.map, cfg.builds, null, extra);
  assert.equal(m.doors.get('door:garage').maxHp, 360);
  assert.equal(m.doors.get('door:front').hp, 220);
  assert.equal(m.setDoorHps([220, 220, 220, 360]), false, 'nothing changed');
  assert.equal(m.setDoorHps([150, 220, 0, 360]), true);
  assert.equal(m.doors.get('door:front').hp, 150);
  assert.equal(m.doors.get('door:back').alive, false);
  assert.equal(m.doors.get('door:side').alive, true);
  m.onEvent({ type: 'doorUp', id: 'door:back', hp: 55, maxHp: 220 });
  assert.equal(m.doors.get('door:back').alive, true);
  assert.equal(m.doors.get('door:back').hp, 55);
  assert.equal(m.setDoorHps([150, 220, 55, 360]), false);
  assert.equal(m.nearestDoorId(5, 3, 9), 'door:front');
  assert.equal(m.nearestDoorId(30, -40, 9), null);
});
