import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD, PLOTS } from '../server/sim/world.js';
import { GRID, terrainHeight, terrainConfig, terrainMin, terrainMax } from '../server/sim/terrain.js';
import { mulberry32 } from './helpers.js';

// What the client does with the welcome message: decode the grid and sample it with the same triangles.
function clientSampler() {
  const cfg = terrainConfig();
  const buf = Buffer.from(cfg.data, 'base64');
  const h = new Float32Array(cfg.nx * cfg.nz);
  for (let i = 0; i < h.length; i++) h[i] = buf.readInt16LE(i * 2) / 100;
  return (x, z) => {
    const fx = Math.max(0, Math.min(cfg.nx - 1.000001, (x - cfg.x0) / cfg.cell));
    const fz = Math.max(0, Math.min(cfg.nz - 1.000001, (z - cfg.z0) / cfg.cell));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * cfg.nx + i;
    const [ha, hb, hc, hd] = [h[k], h[k + 1], h[k + cfg.nx], h[k + cfg.nx + 1]];
    return u <= v ? ha + u * (hd - hc) + v * (hc - ha) : ha + v * (hd - hb) + u * (hb - ha);
  };
}

test('the grid covers the whole yard and travels as base64 int16 centimetres', () => {
  const cfg = terrainConfig();
  assert.equal(cfg.nx, Math.round((WORLD.bounds.maxX - WORLD.bounds.minX) / cfg.cell) + 1);
  assert.equal(cfg.nz, Math.round((WORLD.bounds.maxZ - WORLD.bounds.minZ) / cfg.cell) + 1);
  assert.equal(Buffer.from(cfg.data, 'base64').length, cfg.nx * cfg.nz * 2);
  assert.ok(cfg.data.length < 40000, `welcome stays small (${cfg.data.length} chars)`);
});

test('the client decodes the same ground the server stands on (same triangles)', () => {
  const sample = clientSampler();
  const rnd = mulberry32(5);
  for (let i = 0; i < 2000; i++) {
    const x = WORLD.bounds.minX + rnd() * (WORLD.bounds.maxX - WORLD.bounds.minX);
    const z = WORLD.bounds.minZ + rnd() * (WORLD.bounds.maxZ - WORLD.bounds.minZ);
    assert.ok(Math.abs(sample(x, z) - terrainHeight(x, z)) < 1e-6, `at ${x.toFixed(2)}, ${z.toFixed(2)}`);
  }
});

test('deterministic: the same heights every time', () => {
  assert.equal(terrainConfig().data, terrainConfig().data);
  assert.equal(terrainHeight(12.3, -31.7), terrainHeight(12.3, -31.7));
  assert.equal(Math.round(terrainHeight(-18, -32) * 100), 294); // the big mound (golden value: a layout change must be deliberate)
});

test('flat where people build: house, garage, plots, spawn, pen and shed', () => {
  const flat = (x, z, what) => assert.equal(terrainHeight(x, z), 0, `${what} at ${x}, ${z} is flat`);
  for (const p of PLOTS) for (const s of p.slots) flat(s.x, s.z, `${p.door} slot`);
  flat(WORLD.plantSpawn.x, WORLD.plantSpawn.z, 'plant spawn');
  flat((WORLD.house.minX + WORLD.garage.maxX) / 2, 15, 'house');
  flat(0, WORLD.gate.z, 'gate');
  flat(WORLD.pen.minX, WORLD.pen.minZ + 1, 'pen');
  flat(30, -9.5, 'shed');
  flat(WORLD.fridge.x, WORLD.fridge.z - 1, 'fridge');
});

test('rolling hills, two big mounds, a creek bed and a basement', () => {
  assert.ok(terrainMax() > 2.5, `highest ${terrainMax()}`);
  assert.ok(terrainHeight(-18, -32) > 2.5 && terrainHeight(21, -30) > 2.2, 'two big mounds');
  assert.ok(terrainHeight(-35, -10.5) < -0.9, 'creek bed');
  assert.ok(terrainHeight(-35, -3) > -0.5, 'creek is a ditch, not a lake');
  assert.ok(terrainMin() <= WORLD.cellar.floor + 0.001, 'basement floor');
  assert.equal(terrainHeight(-10, 21), WORLD.cellar.floor);
  assert.ok(terrainHeight(-20, 22.4) > -0.01, 'ground level at the top of the stairs');
  // away from the basement the land is walkable: no face steeper than the walkers' limit
  let steepest = 0;
  for (let x = GRID.x0; x < GRID.x0 + 79; x += 0.5) {
    for (let z = GRID.z0; z < GRID.z0 + 97; z += 0.5) {
      if (x > -22 && x < -4 && z > 16 && z < 26) continue;
      steepest = Math.max(steepest, Math.abs(terrainHeight(x + 0.5, z) - terrainHeight(x, z)) / 0.5, Math.abs(terrainHeight(x, z + 0.5) - terrainHeight(x, z)) / 0.5);
    }
  }
  assert.ok(steepest < 1.0, `steepest slope ${steepest}`);
});
