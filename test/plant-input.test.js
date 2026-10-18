import test from 'node:test';
import assert from 'node:assert/strict';
import { PlantSender } from '../client/input.js';
import { makeGame, S } from './helpers.js';

function plantingGame() {
  const game = makeGame();
  const p = game.addPlayer('a', { team: 'plant', mode: 'coop' });
  p.sunshine = 1000;
  p.x = (S(0, 0).x + S(0, 1).x) / 2; // two empty front-row slots in reach, the next row is out of reach
  p.z = S(0, 0).z - 2.5;
  return { game, p };
}

test('PlantSender: three quick presses of the same key plant three times (no zero gap needed)', () => {
  const { game, p } = plantingGame();
  const ps = new PlantSender();
  ps.press(1);
  ps.press(1);
  ps.press(1);
  // one message per tick, exactly like the 30 Hz sender
  for (let i = 0; i < 6; i++) {
    const f = ps.fields();
    game.handleInput('a', { keys: {}, ...f });
    ps.commit(f);
    game.tick(1 / 30);
  }
  assert.equal(game.gardenCount(), 2, 'only two empty peashooter slots in range, both filled');
  assert.equal(p.sunshine, 900, 'two plantings paid for; the third press found no slot');
  assert.equal(ps.queue.length, 0);
});

test('PlantSender: a press is kept until its message was really sent', () => {
  const ps = new PlantSender();
  ps.press(2);
  const f1 = ps.fields();
  assert.deepEqual(f1, { plant: 2, plantSeq: 1 });
  // socket was closed: not committed, so the press survives and is resent
  assert.deepEqual(ps.fields(), { plant: 2, plantSeq: 1 });
  ps.commit(f1);
  assert.deepEqual(ps.fields(), { plant: 0, plantSeq: 1 });
  ps.press(1);
  assert.deepEqual(ps.fields(), { plant: 1, plantSeq: 2 });
});

test('PlantSender: a flood of presses is bounded, newest wins', () => {
  const ps = new PlantSender(3);
  for (let i = 0; i < 10; i++) ps.press(1);
  assert.equal(ps.queue.length, 3);
  assert.equal(ps.queue.at(-1).seq, 10);
});
