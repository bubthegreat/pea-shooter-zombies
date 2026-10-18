// DOM heads-up display. Everything is driven from the latest snapshot's own entity.
import { weaponInfo } from './models.js';

const $ = (id) => document.getElementById(id);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class HUD {
  constructor() {
    this.root = $('hud');
    this.el = {
      wave: $('wavetext'), timeSun: $('timesun'), timeFill: $('timefill'), timeLabel: $('timelabel'),
      garden: $('gardencount'), sunBox: $('sunbox'), sunCount: $('suncount'),
      seeds: $('seedcards'), seed1: $('seed1'), seed2: $('seed2'),
      hpIco: $('hpico'), hpFill: $('hpfill'), hpText: $('hptext'),
      weapon: $('weaponname'), pips: [...$('pips').children], upgFill: $('upgfill'), upgText: $('upgtext'),
      streakBox: $('streak'), streak: $('streaknum'),
      banner: $('banner'), bannerTitle: $('bannertitle'), bannerSub: $('bannersub'),
      toast: $('toast'), down: $('downoverlay'), downTitle: $('downtitle'), downCount: $('downcount'), downSub: $('downsub'),
      help: $('help'), pause: $('pausehint'), mute: $('mutebtn'),
      end: $('endscreen'), endTitle: $('endtitle'), endSub: $('endsub'), endCount: $('endcount'), endChange: $('endchange'),
      vignette: $('vignette'), hitmark: $('hitmark'),
    };
    this.team = null;
    this.lastSun = 0;
    this.lastStreak = 0;
    this.lastHp = null;
    this.downState = null;
    this.downStart = 0;
    this.endStart = 0;
    this.endShown = false;
    this.helpUntil = 0;
    this.helpHidden = false;
    this.promptText = '';
    this.toastUntil = 0;
    this._hitTimer = 0;
    this._bannerTimer = 0;
    this._cache = {};
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  /** Called when a new life / round begins and the help panel should appear again. */
  resetForJoin(now) {
    this.helpUntil = now + 20000;
    this.helpHidden = false;
    this.lastSun = 0;
    this.lastStreak = 0;
    this.lastHp = null;
    this.downState = null;
    this.endShown = false;
    this.el.end.classList.add('hidden');
    this.el.down.classList.add('hidden');
    this.el.help.classList.remove('hide', 'fade');
  }

  toggleHelp() {
    this.helpHidden = !this.helpHidden;
    this.el.help.classList.toggle('hide', this.helpHidden);
    this.el.help.classList.remove('fade');
    this.helpUntil = performance.now() + 60000;
  }

  setMuted(m) { this.el.mute.textContent = m ? '\u{1F507}' : '\u{1F50A}'; }

  banner(title, sub = '', cls = 'upgrade') {
    const b = this.el.banner;
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub;
    b.className = cls;
    void b.offsetWidth; // restart animation
    b.classList.add('show');
  }

  toast(text, ms = 2200) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('on');
    this.toastUntil = performance.now() + ms;
    this._cache.prompt = null;
  }

  setPrompt(text) { this.promptText = text || ''; }

  hit() {
    const h = this.el.hitmark;
    h.classList.add('on');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => h.classList.remove('on'), 90);
  }

  damage() {
    const v = this.el.vignette;
    v.classList.add('flash');
    requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove('flash')));
  }

  pressSeed(n) {
    const el = n === 1 ? this.el.seed1 : this.el.seed2;
    el.classList.remove('pressed');
    void el.offsetWidth;
    el.classList.add('pressed');
  }

  _set(key, el, prop, val) {
    // avoid layout churn: only touch the DOM when a value changes
    if (this._cache[key] !== val) {
      this._cache[key] = val;
      if (prop === 'text') el.textContent = val;
      else if (prop === 'width') el.style.width = val;
      else if (prop === 'left') el.style.left = val;
      else if (prop === 'class') el.className = val;
    }
  }

  /**
   * ctx: { own, snap, config, now, locked, nearSlot: {kind}|null }
   */
  update(ctx) {
    const { own, snap, config, now } = ctx;
    const e = this.el;
    const team = own && own.team === 'zombie' ? 'zombie' : 'plant';
    if (team !== this.team) {
      this.team = team;
      this.root.classList.remove('plant', 'zombie');
      this.root.classList.add(team);
      e.sunBox.classList.toggle('hidden', team !== 'plant');
      e.seeds.classList.toggle('hidden', team !== 'plant');
      this._set('hpico', e.hpIco, 'text', team === 'plant' ? '\u{1F33B}' : '\u{1F9DF}');
    }

    // ---- top bar
    if (snap) {
      const rl = num(snap.roundLength, 0), rt = num(snap.roundTime, 0);
      const wave = num(snap.wave, 0);
      this._set('wave', e.wave, 'text', snap.phase === 'ended' ? 'Round over!' : wave > 0 ? `Wave ${wave}` : 'Get ready!');
      if (rl > 0) {
        const f = Math.max(0, Math.min(1, rt / rl));
        this._set('sunpos', e.timeSun, 'left', (f * 100).toFixed(1) + '%');
        this._set('timelabel', e.timeLabel, 'text', f >= 1 ? 'Sunrise!' : `Sunrise in ${fmtTime(rl - rt)}`);
      }
      this._set('garden', e.garden, 'text', String(num(snap.gardenCount, 0)));
    }

    if (own) {
      // ---- health
      const maxHp = Math.max(1, num(own.maxHp, 100));
      const hp = Math.max(0, num(own.hp, maxHp));
      const f = hp / maxHp;
      this._set('hpw', e.hpFill, 'width', (f * 100).toFixed(0) + '%');
      this._set('hpt', e.hpText, 'text', String(Math.ceil(hp)));
      this._set('hpc', e.hpFill, 'class', f < 0.3 ? 'low' : f < 0.6 ? 'mid' : '');
      if (this.lastHp !== null && hp < this.lastHp - 0.01 && hp > 0) this.damage();
      this.lastHp = hp;

      // ---- weapon & upgrades
      const wi = weaponInfo(own.weapon, own.team);
      this._set('wn', e.weapon, 'text', wi.name);
      const tier = Math.max(0, Math.min(3, num(own.tier, 0) | 0));
      for (let i = 0; i < e.pips.length; i++) {
        const on = i <= tier;
        if (this._cache['pip' + i] !== on) { this._cache['pip' + i] = on; e.pips[i].classList.toggle('on', on); }
      }
      const th = Array.isArray(config && config.tierThresholds) ? config.tierThresholds : [0, 3, 7, 12];
      const progress = num(own.progress, 0);
      if (tier >= 3 || th[tier + 1] === undefined) {
        this._set('uw', e.upgFill, 'width', '100%');
        this._set('uc', e.upgFill, 'class', 'max');
        this._set('ut', e.upgText, 'text', 'Top gun! ⭐');
      } else {
        const next = th[tier + 1];
        this._set('uw', e.upgFill, 'width', Math.max(0, Math.min(100, (progress / next) * 100)).toFixed(0) + '%');
        this._set('uc', e.upgFill, 'class', '');
        this._set('ut', e.upgText, 'text', `Next gun: ${Math.min(progress, next)} / ${next}`);
      }
      const streak = num(own.streak, 0) | 0;
      const sb = num(config && config.streakBonus, 10);
      this._set('st', e.streak, 'text', String(streak));
      if (streak > this.lastStreak) { e.streakBox.classList.remove('hot'); void e.streakBox.offsetWidth; e.streakBox.classList.add('hot'); }
      this.lastStreak = streak;
      if (this._cache.sb !== sb) { this._cache.sb = sb; e.streakBox.lastChild.textContent = ` / ${sb}`; }

      // ---- sunshine & seeds
      if (team === 'plant') {
        const sun = Math.floor(num(own.sunshine, 0));
        this._set('sun', e.sunCount, 'text', String(sun));
        if (sun > this.lastSun) { e.sunBox.classList.remove('bump'); void e.sunBox.offsetWidth; e.sunBox.classList.add('bump'); }
        this.lastSun = sun;
        const c1 = costOf(config, 'peashooter', 50), c2 = costOf(config, 'cactus', 100);
        this._set('c1', e.seed1.querySelector('.cost b'), 'text', String(c1));
        this._set('c2', e.seed2.querySelector('.cost b'), 'text', String(c2));
        const near = ctx.nearSlot ? ctx.nearSlot.kind : null;
        this._set('s1', e.seed1, 'class', 'seed' + (sun < c1 ? ' no' : '') + (near === 'peashooter' ? ' near' : ''));
        this._set('s2', e.seed2, 'class', 'seed' + (sun < c2 ? ' no' : '') + (near === 'cactus' ? ' near' : ''));
      }

      // ---- wilted / sprout countdown
      const st = own.state === 'wilted' || own.state === 'sprout' ? own.state : null;
      if (st !== this.downState) {
        this.downState = st;
        this.downStart = now;
        e.down.classList.toggle('hidden', !st);
        if (st === 'wilted') {
          e.downTitle.textContent = 'You wilted! \u{1F940}';
          e.downSub.textContent = "Hang on — you'll bloom back soon!";
        } else if (st === 'sprout') {
          e.downTitle.textContent = "You're a sprout! \u{1F331}";
          e.downSub.textContent = 'Digging back up as a zombie…';
        }
      }
      if (st) {
        const total = st === 'wilted' ? num(config && config.wiltRespawn, 4) : num(config && config.sproutTime, 5);
        const left = Math.max(1, Math.ceil(num(own.respawnIn, total - (now - this.downStart) / 1000)));
        this._set('dc', e.downCount, 'text', String(left));
      }
    }

    // ---- help panel fades after a while
    if (now > this.helpUntil && !this.helpHidden && !e.help.classList.contains('fade')) {
      e.help.classList.add('fade');
      setTimeout(() => { if (e.help.classList.contains('fade')) e.help.classList.add('hide'); }, 700);
    }

    // ---- toast / prompt
    if (now < this.toastUntil) {
      // timed toast stays
    } else if (this.promptText) {
      this._set('prompt', e.toast, 'text', this.promptText);
      e.toast.classList.add('on');
    } else {
      e.toast.classList.remove('on');
      this._cache.prompt = null;
    }

    e.pause.classList.toggle('hidden', !(own && snap && snap.phase === 'playing' && !ctx.locked));

    // ---- end screen
    if (snap && snap.phase === 'ended') {
      if (!this.endShown) {
        this.endShown = true;
        this.endStart = now;
        const w = snap.winner;
        e.end.className = w === 'zombie' ? 'zombie' : 'plant';
        e.endTitle.textContent = w === 'zombie' ? 'ZOMBIES WIN! \u{1F9DF}' : w === 'plant' ? 'PLANTS WIN! \u{1F31E}' : 'ROUND OVER!';
        const mine = own && own.team === w;
        e.help.classList.add('hide');
        e.endSub.textContent = w ? (mine ? 'Great job, team!' : 'Good try! Next round you can get them.') : 'Nice game!';
      }
      const total = num(config && config.endedTime, 10);
      const left = Math.max(0, Math.ceil(total - (now - this.endStart) / 1000));
      this._set('ec', e.endCount, 'text', `Next round in ${left}…`);
    } else if (this.endShown) {
      this.endShown = false;
      e.end.classList.add('hidden');
    }
  }
}

function costOf(config, kind, def) {
  const t = config && config.plantTypes && config.plantTypes[kind];
  return t && typeof t.cost === 'number' ? t.cost : def;
}
