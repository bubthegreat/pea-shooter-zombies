// Tiny WebAudio synth: every sound is generated in code (no files, no network).
// Sounds are cheerful and short; positional ones are panned / attenuated by distance.

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.55;
    this.voices = 0;
    this.lis = { x: 0, y: 0, z: 0, yaw: 0 };
    this.engine = null;
    this.loops = {};
    this._noise = null;
    try {
      this.muted = localStorage.getItem('bb-muted') === '1';
    } catch (_) { /* ignore */ }
  }

  /** Must be called from a user gesture (click / key). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch (_) {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      // 1 s of white noise, reused by every noisy sound
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setMuted(m) {
    this.muted = !!m;
    try { localStorage.setItem('bb-muted', this.muted ? '1' : '0'); } catch (_) { /* ignore */ }
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    if (this.muted) {
      this.engineLevel(0);
      for (const k of Object.keys(this.loops)) this.loopLevel(k, 0);
    }
  }

  setListener(x, y, z, yaw) {
    this.lis.x = x; this.lis.y = y; this.lis.z = z; this.lis.yaw = yaw;
  }

  /* ---- building blocks ---- */

  // Output node for a sound, with optional position (gain + pan). Returns null if inaudible.
  _out(pos, vol = 1) {
    if (!this.ctx || this.muted || this.voices > 28) return null;
    let gain = vol;
    let pan = 0;
    if (pos) {
      const dx = pos.x - this.lis.x, dz = pos.z - this.lis.z;
      const dy = (pos.y ?? this.lis.y) - this.lis.y;
      const d = Math.hypot(dx, dy, dz);
      gain *= 1 / (1 + d / 14);
      if (gain < 0.02) return null;
      if (d > 0.5) {
        const rx = Math.cos(this.lis.yaw), rz = -Math.sin(this.lis.yaw);
        pan = Math.max(-0.9, Math.min(0.9, ((dx * rx + dz * rz) / d) * 0.9));
      }
    }
    const g = this.ctx.createGain();
    g.gain.value = gain;
    let tail = g;
    if (pan !== 0 && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    tail.connect(this.master);
    return g;
  }

  _done(node, secs) {
    this.voices++;
    setTimeout(() => {
      this.voices--;
      try { node.disconnect(); } catch (_) { /* ignore */ }
    }, secs * 1000 + 80);
  }

  // Oscillator with a pitch sweep and a simple attack/decay envelope.
  _tone(out, { type = 'sine', f0, f1 = f0, dur = 0.15, vol = 0.3, delay = 0, attack = 0.005, vibHz = 0, vibDepth = 0 }) {
    const c = this.ctx;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(out);
    if (vibHz) {
      const lfo = c.createOscillator();
      const lg = c.createGain();
      lfo.frequency.value = vibHz;
      lg.gain.value = vibDepth;
      lfo.connect(lg);
      lg.connect(o.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  _noiseBurst(out, { dur = 0.15, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, vol = 0.3, delay = 0 }) {
    const c = this.ctx;
    const t0 = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this._noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f);
    f.connect(g);
    g.connect(out);
    s.start(t0, Math.random() * 0.5);
    s.stop(t0 + dur + 0.05);
  }

  /* ---- the sound menu ---- */

  /**
   * name: pea | snow | spike | melon | housepea | goo | slime | bone | sludge | brain | boing | bloom | chime | plant | sun |
   *       crunch | wilt | hurt | tick | headshot | splat | squish | deflect | pickup | drop | thunk | mower_break | respawn |
   *       wave | win | lose | hitme | click
   */
  play(name, pos, vol = 1) {
    if (!this.ctx) return;
    const out = this._out(pos, vol);
    if (!out) return;
    const r = 0.92 + Math.random() * 0.16;
    let secs = 0.3;
    switch (name) {
      case 'pea':
        this._tone(out, { type: 'sine', f0: 1250 * r, f1: 380 * r, dur: 0.12, vol: 0.35 });
        this._tone(out, { type: 'triangle', f0: 2400 * r, f1: 900, dur: 0.05, vol: 0.12 });
        secs = 0.2;
        break;
      case 'spike':
        this._noiseBurst(out, { dur: 0.14, f0: 3500, f1: 900, q: 1.5, vol: 0.3 });
        this._tone(out, { type: 'triangle', f0: 700 * r, f1: 260, dur: 0.12, vol: 0.2 });
        secs = 0.2;
        break;
      case 'housepea':
        this._tone(out, { type: 'sine', f0: 190 * r, f1: 40, dur: 0.4, vol: 0.7 });
        this._noiseBurst(out, { dur: 0.25, type: 'lowpass', f0: 900, f1: 120, vol: 0.5 });
        this._tone(out, { type: 'triangle', f0: 800, f1: 200, dur: 0.15, vol: 0.2 });
        secs = 0.5;
        break;
      case 'goo':
        this._tone(out, { type: 'sine', f0: 320 * r, f1: 110, dur: 0.2, vol: 0.38, vibHz: 28, vibDepth: 40 });
        this._noiseBurst(out, { dur: 0.08, f0: 600, f1: 300, q: 2, vol: 0.12 });
        secs = 0.25;
        break;
      case 'snow':
        this._tone(out, { type: 'sine', f0: 1500 * r, f1: 520 * r, dur: 0.13, vol: 0.3 });
        this._tone(out, { type: 'triangle', f0: 3100 * r, f1: 2300, dur: 0.1, vol: 0.12 });
        this._tone(out, { type: 'sine', f0: 4200, f1: 3400, dur: 0.18, vol: 0.06, delay: 0.04 });
        secs = 0.25;
        break;
      case 'melon':
        this._tone(out, { type: 'sine', f0: 170 * r, f1: 55, dur: 0.28, vol: 0.6 });
        this._noiseBurst(out, { dur: 0.18, type: 'lowpass', f0: 800, f1: 160, vol: 0.35 });
        this._tone(out, { type: 'triangle', f0: 420, f1: 200, dur: 0.12, vol: 0.15 });
        secs = 0.4;
        break;
      case 'slime':
        this._tone(out, { type: 'sine', f0: 280 * r, f1: 80, dur: 0.24, vol: 0.4, vibHz: 34, vibDepth: 55 });
        this._noiseBurst(out, { dur: 0.12, f0: 500, f1: 220, q: 3, vol: 0.18 });
        this._tone(out, { type: 'sine', f0: 700, f1: 330, dur: 0.07, vol: 0.12, delay: 0.1 });
        secs = 0.32;
        break;
      case 'bone':
        this._tone(out, { type: 'square', f0: 950 * r, f1: 640, dur: 0.045, vol: 0.2 });
        this._tone(out, { type: 'square', f0: 700 * r, f1: 480, dur: 0.05, vol: 0.18, delay: 0.07 });
        this._noiseBurst(out, { dur: 0.07, type: 'highpass', f0: 2200, vol: 0.18 });
        secs = 0.2;
        break;
      case 'sludge':
        this._noiseBurst(out, { dur: 0.09, f0: 1100, f1: 420, q: 1.2, vol: 0.28 });
        this._tone(out, { type: 'sine', f0: 150 * r, f1: 80, dur: 0.1, vol: 0.2, vibHz: 40, vibDepth: 30 });
        secs = 0.16;
        break;
      case 'brain':
        this._tone(out, { type: 'sine', f0: 150 * r, f1: 45, dur: 0.5, vol: 0.6, vibHz: 16, vibDepth: 22 });
        this._tone(out, { type: 'sawtooth', f0: 90, f1: 40, dur: 0.4, vol: 0.12 });
        this._noiseBurst(out, { dur: 0.25, type: 'lowpass', f0: 700, f1: 120, vol: 0.4 });
        secs = 0.6;
        break;
      case 'headshot':
        this._tone(out, { type: 'triangle', f0: 1568, dur: 0.32, vol: 0.34 });
        this._tone(out, { type: 'sine', f0: 2093, dur: 0.4, vol: 0.28, delay: 0.05 });
        this._tone(out, { type: 'sine', f0: 3136, dur: 0.5, vol: 0.16, delay: 0.1 });
        this._tone(out, { type: 'square', f0: 2400, f1: 1800, dur: 0.05, vol: 0.1 });
        secs = 0.65;
        break;
      case 'bloom':
        [784, 988, 1175, 1568].forEach((f, i) => this._tone(out, { type: 'sine', f0: f, dur: 0.34, vol: 0.22, delay: i * 0.06 }));
        this._tone(out, { type: 'triangle', f0: 392, f1: 520, dur: 0.18, vol: 0.18 });
        secs = 0.65;
        break;
      case 'splat':
        this._noiseBurst(out, { dur: 0.3, f0: 900, f1: 220, q: 0.9, vol: 0.5 });
        this._tone(out, { type: 'sine', f0: 200 * r, f1: 70, dur: 0.22, vol: 0.45 });
        secs = 0.4;
        break;
      case 'squish':
        this._noiseBurst(out, { dur: 0.35, f0: 500, f1: 140, q: 1.4, vol: 0.45 });
        this._tone(out, { type: 'sine', f0: 130 * r, f1: 50, dur: 0.4, vol: 0.5, vibHz: 20, vibDepth: 20 });
        secs = 0.5;
        break;
      case 'deflect':
        this._noiseBurst(out, { dur: 0.14, type: 'highpass', f0: 2600, f1: 900, vol: 0.2 });
        this._tone(out, { type: 'triangle', f0: 1200 * r, f1: 500, dur: 0.1, vol: 0.12 });
        secs = 0.2;
        break;
      case 'pickup':
        this._tone(out, { type: 'triangle', f0: 392, f1: 520, dur: 0.1, vol: 0.3 });
        this._tone(out, { type: 'triangle', f0: 659, f1: 880, dur: 0.14, vol: 0.3, delay: 0.09 });
        this._noiseBurst(out, { dur: 0.05, type: 'highpass', f0: 3000, vol: 0.18 });
        secs = 0.35;
        break;
      case 'drop':
        this._tone(out, { type: 'sine', f0: 150, f1: 55, dur: 0.16, vol: 0.5 });
        this._noiseBurst(out, { dur: 0.1, type: 'lowpass', f0: 700, f1: 200, vol: 0.3 });
        secs = 0.25;
        break;
      case 'thunk':
        this._tone(out, { type: 'sine', f0: 230 * r, f1: 95, dur: 0.12, vol: 0.55 });
        this._tone(out, { type: 'triangle', f0: 360, f1: 200, dur: 0.06, vol: 0.2 });
        this._noiseBurst(out, { dur: 0.07, f0: 800, f1: 400, q: 1.5, vol: 0.3 });
        secs = 0.2;
        break;
      case 'mower_break':
        this._noiseBurst(out, { dur: 0.18, type: 'lowpass', f0: 900, f1: 150, vol: 0.5 });
        this._tone(out, { type: 'sawtooth', f0: 130, f1: 38, dur: 0.7, vol: 0.28, vibHz: 22, vibDepth: 16 });
        this._noiseBurst(out, { dur: 0.1, type: 'lowpass', f0: 700, f1: 200, vol: 0.35, delay: 0.25 });
        this._noiseBurst(out, { dur: 0.08, type: 'lowpass', f0: 600, f1: 200, vol: 0.28, delay: 0.5 });
        this._tone(out, { type: 'square', f0: 220, f1: 140, dur: 0.08, vol: 0.14, delay: 0.7 });
        secs = 1.0;
        break;
      case 'respawn':
        this._tone(out, { type: 'sine', f0: 784, dur: 0.18, vol: 0.22 });
        this._tone(out, { type: 'sine', f0: 1175, dur: 0.28, vol: 0.2, delay: 0.1 });
        secs = 0.5;
        break;
      case 'boing': {
        // springy: pitch bounces up and down while fading
        const c = this.ctx;
        const t0 = c.currentTime;
        const o = c.createOscillator();
        o.type = 'sine';
        const g = c.createGain();
        const seq = [[220, 0], [700, 0.07], [260, 0.2], [600, 0.3], [310, 0.4], [480, 0.5], [360, 0.6]];
        o.frequency.setValueAtTime(seq[0][0], t0);
        for (let i = 1; i < seq.length; i++) o.frequency.exponentialRampToValueAtTime(seq[i][0], t0 + seq[i][1]);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);
        o.connect(g);
        g.connect(out);
        o.start(t0);
        o.stop(t0 + 0.7);
        this._tone(out, { type: 'triangle', f0: 440, f1: 880, dur: 0.15, vol: 0.12, delay: 0.02 });
        secs = 0.7;
        break;
      }
      case 'chime':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          this._tone(out, { type: 'triangle', f0: f, dur: 0.5, vol: 0.28, delay: i * 0.085 });
          this._tone(out, { type: 'sine', f0: f * 2, dur: 0.4, vol: 0.08, delay: i * 0.085 });
        });
        secs = 0.9;
        break;
      case 'plant':
        this._tone(out, { type: 'sine', f0: 260, f1: 720, dur: 0.12, vol: 0.4 });
        this._noiseBurst(out, { dur: 0.1, type: 'lowpass', f0: 800, f1: 300, vol: 0.18 });
        secs = 0.2;
        break;
      case 'sun':
        this._tone(out, { type: 'sine', f0: 880, dur: 0.18, vol: 0.3 });
        this._tone(out, { type: 'sine', f0: 1320, dur: 0.3, vol: 0.28, delay: 0.07 });
        secs = 0.45;
        break;
      case 'crunch':
        this._noiseBurst(out, { dur: 0.28, f0: 500, f1: 1800, q: 0.8, vol: 0.5 });
        this._tone(out, { type: 'sawtooth', f0: 110, f1: 45, dur: 0.25, vol: 0.2 });
        secs = 0.35;
        break;
      case 'wilt':
        this._tone(out, { type: 'sawtooth', f0: 360, f1: 140, dur: 0.55, vol: 0.12, vibHz: 7, vibDepth: 18 });
        this._tone(out, { type: 'sine', f0: 360, f1: 140, dur: 0.55, vol: 0.2 });
        secs = 0.65;
        break;
      case 'hurt':
        this._tone(out, { type: 'sine', f0: 240, f1: 110, dur: 0.16, vol: 0.35 });
        secs = 0.25;
        break;
      case 'tick':
        this._tone(out, { type: 'square', f0: 1700, f1: 1500, dur: 0.045, vol: 0.12 });
        secs = 0.1;
        break;
      case 'wave':
        this._tone(out, { type: 'sawtooth', f0: 98, f1: 70, dur: 1.2, vol: 0.2, attack: 0.15, vibHz: 5, vibDepth: 6 });
        this._tone(out, { type: 'sine', f0: 196, f1: 140, dur: 1.2, vol: 0.12, attack: 0.15, vibHz: 4, vibDepth: 8 });
        secs = 1.3;
        break;
      case 'win':
        [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5].forEach((f, i) => {
          this._tone(out, { type: 'triangle', f0: f, dur: i === 6 ? 0.8 : 0.22, vol: 0.3, delay: i * 0.14 });
        });
        secs = 1.8;
        break;
      case 'lose':
        [392, 349.23, 311.13, 261.63].forEach((f, i) => {
          this._tone(out, { type: 'sawtooth', f0: f, f1: f * 0.97, dur: i === 3 ? 0.7 : 0.28, vol: 0.12, delay: i * 0.26, vibHz: i === 3 ? 6 : 0, vibDepth: 5 });
        });
        secs = 1.7;
        break;
      case 'click':
        this._tone(out, { type: 'triangle', f0: 600, f1: 900, dur: 0.07, vol: 0.2 });
        secs = 0.15;
        break;
      default:
        this._done(out, 0.1);
        return;
    }
    this._done(out, secs);
  }

  /**
   * Continuous tool loops (own and nearby players'): name = weed | blower | trimmer | squeak; level 0..1 (0 = off).
   * Call every frame with the loudest source, already attenuated by distance.
   */
  loopLevel(name, level) {
    if (!this.ctx) return;
    let L = this.loops[name];
    if (!L) {
      if (level <= 0.01) return;
      L = this.loops[name] = this._makeLoop(name);
      if (!L) return;
    }
    const t = this.ctx.currentTime;
    L.g.gain.setTargetAtTime(this.muted ? 0 : level * L.amp, t, 0.07);
  }

  _makeLoop(name) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = 0;
    g.connect(this.master);
    const noise = () => {
      const s = c.createBufferSource();
      s.buffer = this._noise;
      s.loop = true;
      s.start(0, Math.random() * 0.5);
      return s;
    };
    const lfo = (type, hz, depth, target) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      const d = c.createGain();
      d.gain.value = depth;
      o.connect(d);
      d.connect(target);
      o.start();
      return o;
    };
    const filt = (type, f, q = 1) => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    switch (name) {
      case 'weed': {
        // angry little two-stroke whirr
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 175;
        lfo('sine', 31, 16, o.frequency);
        const lp = filt('lowpass', 1400);
        const trem = c.createGain();
        trem.gain.value = 0.65;
        lfo('sine', 46, 0.3, trem.gain);
        o.connect(lp); lp.connect(trem); trem.connect(g);
        o.start();
        const n = noise();
        const bp = filt('bandpass', 2600, 1.2);
        const ng = c.createGain();
        ng.gain.value = 0.45;
        n.connect(bp); bp.connect(ng); ng.connect(g);
        return { g, amp: 0.2 };
      }
      case 'blower': {
        // steady whoosh
        const n = noise();
        const bp = filt('bandpass', 750, 0.7);
        lfo('sine', 0.7, 70, bp.frequency);
        const lp = filt('lowpass', 2200);
        n.connect(bp); bp.connect(lp); lp.connect(g);
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 78;
        const olp = filt('lowpass', 260);
        const og = c.createGain();
        og.gain.value = 0.35;
        o.connect(olp); olp.connect(og); og.connect(g);
        o.start();
        return { g, amp: 0.42 };
      }
      case 'trimmer': {
        // fast clack-clack-clack
        const gate = c.createGain();
        gate.gain.value = 0.5;
        lfo('square', 13, 0.5, gate.gain);
        const n = noise();
        const bp = filt('bandpass', 3100, 2.2);
        n.connect(bp); bp.connect(gate);
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 96;
        const olp = filt('lowpass', 500);
        const og = c.createGain();
        og.gain.value = 0.35;
        o.connect(olp); olp.connect(og); og.connect(gate);
        o.start();
        gate.connect(g);
        return { g, amp: 0.26 };
      }
      case 'squeak': {
        // squeaky wheel
        const o = c.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 1350;
        lfo('sine', 5.5, 210, o.frequency);
        const am = c.createGain();
        am.gain.value = 0.55;
        lfo('sine', 3.1, 0.45, am.gain);
        o.connect(am); am.connect(g);
        o.start();
        return { g, amp: 0.09 };
      }
      default:
        return null;
    }
  }

  /** Continuous mower engine; level 0..1 (0 = off). */
  engineLevel(level) {
    if (!this.ctx) return;
    if (!this.engine) {
      if (level <= 0.01) return;
      const c = this.ctx;
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 62;
      const o2 = c.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 31;
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 320;
      const g = c.createGain();
      g.gain.value = 0;
      const lfo = c.createOscillator();
      lfo.frequency.value = 13;
      const lg = c.createGain();
      lg.gain.value = 9;
      lfo.connect(lg);
      lg.connect(o.frequency);
      o.connect(f);
      o2.connect(f);
      f.connect(g);
      g.connect(this.master);
      o.start(); o2.start(); lfo.start();
      this.engine = { o, o2, g, f };
    }
    const t = this.ctx.currentTime;
    const target = this.muted ? 0 : level * 0.22;
    this.engine.g.gain.setTargetAtTime(target, t, 0.12);
    this.engine.o.frequency.setTargetAtTime(58 + level * 22, t, 0.2);
  }
}
