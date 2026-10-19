import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, bakeStats, disposeModel } from '../client/models.js';

const bakedGeos = (m) => {
  const s = new Set();
  m.root.traverse((o) => { if (o.isMesh && o.geometry.userData.baked) s.add(o.geometry); });
  return s;
};

test('baked geometry is built once per look and shared between models', () => {
  const e = { id: 'b7', kind: 'bot', team: 'zombie', x: 0, y: 0, z: 0, hp: 5, maxHp: 5, weapon: 'goo_blaster', state: 'alive' };
  const a = buildModel(e);
  const before = { ...bakeStats };
  const b = buildModel({ ...e });
  assert.equal(bakeStats.miss, before.miss, 'the second build merged nothing');
  assert.ok(bakeStats.hit > before.hit);
  const ga = bakedGeos(a);
  const gb = bakedGeos(b);
  assert.ok(ga.size > 0 && ga.size === gb.size);
  for (const g of ga) {
    assert.ok(gb.has(g), 'same geometry object');
    assert.ok(g.userData.shared);
  }
  assert.notEqual(a.root, b.root, 'but the models themselves are separate (they animate on their own)');
  // disposing one model leaves the shared geometry alone (it would re-upload for everybody else)
  let disposed = 0;
  for (const g of ga) g.addEventListener('dispose', () => disposed++);
  disposeModel(a.root);
  assert.equal(disposed, 0);
});

test('different looks bake to different geometry', () => {
  const z = buildModel({ id: 'b1', kind: 'bot', team: 'zombie', x: 0, y: 0, z: 0, hp: 5, maxHp: 5, weapon: 'goo_blaster', state: 'alive' });
  const p = buildModel({ id: 'g1', kind: 'garden', team: 'plant', plantKind: 'peashooter', level: 1, x: 0, y: 0, z: 0, hp: 5, maxHp: 5 });
  const gz = bakedGeos(z);
  for (const g of bakedGeos(p)) assert.ok(!gz.has(g));
});
