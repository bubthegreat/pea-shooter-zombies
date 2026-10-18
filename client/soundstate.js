// When the looping sounds (fridge alarm, mower engine, garage tools, squeaky wheelbarrow) may sound. Pure logic, no
// audio and no DOM, so it is unit tested with a fake sound. main.js feeds one `LoopMixer` every frame; nothing else
// talks to the loops. The rule is simple: a loop may only sound in a running round (phase 'playing') while we are in the
// game. The moment that stops being true (round over, back in a lobby, connection lost) every loop is cut dead and none
// can restart, whatever the last snapshot said (the sim freezes `fridge.n` and `using` when a round ends).

export const LOOPS = ['alarm', 'weed', 'blower', 'trimmer', 'squeak'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** May loops sound? joined: we are in a game view; hasSelf: our own fighter is in the snapshot; phase: the snapshot's phase. */
export function loopsAllowed(s) {
  return Boolean(s && s.joined && s.hasSelf && s.phase === 'playing');
}

/** Wanted alarm level (0..1): zombies at the fridge (n) and how far the listener is (m). Zero whenever loops are not allowed. */
export function alarmTarget({ allowed, n, dist }) {
  if (!allowed || !(n > 0)) return 0;
  return clamp(1.1 - (Number.isFinite(dist) ? dist : 99) / 50, 0.2, 1);
}

export class LoopMixer {
  /** sound: client/audio.js Sound (loopLevel, engineLevel, stopAll) or null. */
  constructor(sound) {
    this.sound = sound;
    this.alarm = 0; // smoothed alarm level
    this.live = false; // did we start anything since the last silence()
  }

  /**
   * Once per frame. allowed: loopsAllowed(...); alarm: wanted alarm level (alarmTarget); levels: { engine, weed, blower,
   * trimmer, squeak } wanted levels 0..1 (missing = 0).
   */
  update({ allowed, alarm = 0, levels = {} }, dt) {
    if (!allowed) {
      this.silence();
      return;
    }
    const s = this.sound;
    this.alarm += (alarm - this.alarm) * Math.min(1, dt * 6);
    if (this.alarm < 0.002) this.alarm = 0;
    this.live = true;
    if (!s) return;
    s.engineLevel(levels.engine || 0);
    s.loopLevel('alarm', this.alarm);
    for (const k of ['weed', 'blower', 'trimmer', 'squeak']) s.loopLevel(k, levels[k] || 0);
  }

  /** Cut everything now (not a fade) and forget the alarm's level. Safe to call every frame. */
  silence() {
    this.alarm = 0;
    if (!this.live) return;
    this.live = false;
    if (this.sound) this.sound.stopAll();
  }
}
