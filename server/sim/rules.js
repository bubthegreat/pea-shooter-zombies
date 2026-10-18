// Round rules: zombie waves, win conditions, and the automatic restart after a round ends.
import { WORLD } from './world.js';

/** Wave times (seconds into the round). The last wave arrives lastWaveLead seconds before sunrise. */
export function planWaves(config) {
  const last = config.roundLength - config.lastWaveLead;
  const shift = config.features?.headStart === false ? 0 : config.headStart ?? 0; // the zombies wait at the gate first
  const times = [];
  for (let k = 0; ; k++) {
    const t = shift + config.waveFirst + k * config.waveInterval;
    if (t >= last - config.waveInterval / 2) break;
    times.push(t);
  }
  times.push(last);
  return times;
}

function zombieBotCount(game) {
  let n = 0;
  for (const e of game.entities.values()) if (e.kind === 'bot' && e.team === 'zombie') n++;
  return n;
}

/** Zombies still in the fight. A converted kid (sprout) digs back up after a few seconds, so it counts. */
function anyZombieAlive(game) {
  for (const e of game.entities.values()) {
    if (e.team !== 'zombie') continue;
    if (e.kind === 'bot' && e.state === 'alive') return true;
    if (e.kind === 'player' && (e.state === 'alive' || e.state === 'sprout')) return true;
  }
  return false;
}

function spawnWave(game, number, final) {
  const c = game.config;
  const gate = WORLD.gate;
  const wanted = game.difficultyConfig().waveBase + number;
  const size = Math.max(0, Math.min(wanted, c.maxZombieBots - zombieBotCount(game)));
  for (let i = 0; i < size; i++) {
    game.spawnBot('zombie', gate.minX + game.rng() * (gate.maxX - gate.minX), gate.z);
  }
  game.wave = number;
  if (final) game.finalWaveSpawned = true;
  game.emit('wave', { wave: number, size, final });
}

export function endRound(game, winner) {
  game.phase = 'ended';
  game.winner = winner;
  game.endTimer = game.config.endedTime;
  for (const [id, e] of game.entities) {
    if (e.kind === 'projectile') game.entities.delete(id);
    else if (e.kind === 'bot') game.clearInput(e);
  }
  game.emit('win', { winner });
}

export function stepRules(game, dt) {
  const c = game.config;
  if (game.phase === 'ended') {
    game.endTimer -= dt;
    if (game.endTimer <= 0) {
      if (c.autoRestart) game.startRound();
      else game.endMatch();
    }
    return;
  }
  if (game.phase !== 'playing') return;

  if (c.features.waves) {
    while (game.waveIndex < game.waveTimes.length && game.roundTime >= game.waveTimes[game.waveIndex]) {
      spawnWave(game, game.waveIndex + 1, game.waveIndex === game.waveTimes.length - 1);
      game.waveIndex++;
    }
  }

  if (!c.features.winRules) return;
  if (game.fridge.meter >= 1) endRound(game, 'zombie');
  else if (game.roundTime >= c.roundLength) endRound(game, 'plant');
  else if (game.finalWaveSpawned && !anyZombieAlive(game)) endRound(game, 'plant');
}
