// DOM heads-up display. Everything is driven from the latest snapshot's own entity.
import { weaponInfo, itemInfo } from './models.js';
import { unlockedPlants, nextUnlock } from './plants.js';

const FEED_MAX = 5;
const FEED_LIFE_MS = 6000;
const HEAD_ICON = String.fromCodePoint(0x1f3af);
const DEFAULT_TIERS = [0, 2, 4, 7, 10, 14, 18, 23];

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
      seeds: $('seedcards'),
      hpIco: $('hpico'), hpFill: $('hpfill'), hpText: $('hptext'),
      weapon: $('weaponname'), pipsBox: $('pips'), pips: [...$('pips').children], upgFill: $('upgfill'), upgText: $('upgtext'),
      itemHp: $('itemhp'), itemHpFill: $('itemhpfill'), itemHpText: $('itemhptext'),
      mowerBox: $('mowerbox'), mowerFill: $('mowerfill'), mowerText: $('mowertext'),
      headshot: $('headshot'), frost: $('frost'),
      streakBox: $('streak'), streak: $('streaknum'),
      banner: $('banner'), bannerTitle: $('bannertitle'), bannerSub: $('bannersub'),
      feed: $('killfeed'), toast: $('toast'), down: $('downoverlay'), downTitle: $('downtitle'), downCount: $('downcount'), downSub: $('downsub'),
      help: $('help'), pause: $('pausehint'), mute: $('mutebtn'),
      end: $('endscreen'), endTitle: $('endtitle'), endSub: $('endsub'), endCount: $('endcount'), endLeave: $('endleave'),
      vignette: $('vignette'), hitmark: $('hitmark'),
      doorsBox: $('doorsbox'), doorCount: $('doorcount'), brainsBox: $('brainsbox'), brainsCount: $('brainscount'),
      fridgeBox: $('fridgebox'), fridgeFill: $('fridgefill'), fridgeText: $('fridgetext'), fridgeIco: $('fridgeico'),
      cd: $('countdown'), cdTitle: $('cdtitle'), cdNum: $('cdnum'), cdSub: $('cdsub'),
      partsBox: $('partsbox'), partsCarry: $('partscarry'),
      pt: { battery: $('pt-battery'), gas: $('pt-gas'), plug: $('pt-plug') },
      bw: $('buildwheel'), bwRing: $('bwring'), bwHelp: $('bwhelp'), bbar: $('buildbar'), bname: $('buildname'), bhint: $('buildhint'),
      loading: $('loading'), loadRule: $('loadrule'), loadMsg: $('loadmsg'),
    };
    this._bwSig = '';
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
    this._seedSig = '';
    this._seedCount = 0;
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
    this.clearFeed();
  }

  /** One kill-feed line ({ parts: [{ text, team? }], head }), newest at the bottom. Text goes in via textContent only. */
  feed(line) {
    if (!line || !Array.isArray(line.parts)) return;
    const box = this.el.feed;
    const row = document.createElement('div');
    row.className = line.head ? 'kf head' : 'kf';
    for (const p of line.parts) {
      const s = document.createElement(p.team ? 'b' : 'span');
      if (p.team) s.className = p.team;
      s.textContent = p.text;
      row.appendChild(s);
    }
    if (line.head) {
      const h = document.createElement('i');
      h.className = 'kf-head';
      h.textContent = HEAD_ICON;
      h.title = 'Headshot';
      row.appendChild(h);
    }
    box.appendChild(row);
    while (box.children.length > FEED_MAX) box.removeChild(box.firstChild);
    setTimeout(() => row.classList.add('out'), FEED_LIFE_MS);
    setTimeout(() => row.remove(), FEED_LIFE_MS + 600);
  }

  clearFeed() { this.el.feed.textContent = ''; }

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

  hit(head = false) {
    const h = this.el.hitmark;
    h.classList.toggle('head', !!head);
    h.classList.add('on');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => h.classList.remove('on'), head ? 160 : 90);
  }

  /** Big kid-style HEADSHOT! pop beside the crosshair (restarts if it is already showing). */
  headshot() {
    const el = this.el.headshot;
    el.classList.remove('pop');
    void el.offsetWidth; // restart animation
    el.classList.add('pop');
  }

  damage() {
    const v = this.el.vignette;
    v.classList.add('flash');
    requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove('flash')));
  }

  /** Loading screen with the one-sentence rules; hidden once the first snapshot arrives. */
  showLoading(rule, msg = 'Loading the backyard\u2026') {
    this.el.loadRule.textContent = rule;
    this.el.loadMsg.textContent = msg;
    this.el.loading.classList.remove('hidden', 'fade');
  }

  hideLoading() {
    const l = this.el.loading;
    if (l.classList.contains('hidden')) return;
    l.classList.add('fade');
    setTimeout(() => { if (l.classList.contains('fade')) l.classList.add('hidden'); }, 520);
  }

  /**
   * The build wheel: items = [{ n, icon, name, cost, unit, ok }] around the crosshair, or null to hide it. `pick` highlights one.
   * Rebuilt only when the list changes; affordability is toggled every call.
   */
  setBuildWheel(items, pick = 0, help = '') {
    const e = this.el;
    if (!items) {
      if (this._bwSig !== '') { this._bwSig = ''; e.bw.classList.add('hidden'); e.bwRing.textContent = ''; }
      return;
    }
    const sig = items.map((i) => `${i.n}:${i.icon}:${i.name}:${i.cost}`).join('|');
    if (sig !== this._bwSig) {
      this._bwSig = sig;
      e.bw.classList.remove('hidden');
      e.bwRing.textContent = '';
      const touch = document.documentElement.classList.contains('touch');
      const r = touch ? 80 : 124;
      const c = touch ? 130 : 180;
      items.forEach((it, i) => {
        const a = (i / items.length) * Math.PI * 2 - Math.PI / 2;
        const b = document.createElement('div');
        b.className = 'bw-item';
        b.dataset.n = String(it.n);
        b.style.left = `${c + Math.cos(a) * r}px`;
        b.style.top = `${c + Math.sin(a) * r}px`;
        const add = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; b.appendChild(s); };
        add('key', String(it.n));
        add('ico', it.icon);
        add('nm', it.name);
        add('cost', `${it.unit} ${it.cost}`);
        e.bwRing.appendChild(b);
      });
    }
    for (const b of e.bwRing.children) {
      const it = items.find((x) => String(x.n) === b.dataset.n);
      const cls = 'bw-item' + (it && !it.ok ? ' no' : '') + (Number(b.dataset.n) === pick ? ' pick' : '');
      if (b.className !== cls) b.className = cls;
    }
    this._set('bwh', e.bwHelp, 'text', help);
  }

  /** The bar at the bottom while a build is selected: name + hint (bad = the ghost is red). */
  setBuildBar(name, hint, bad = false) {
    const e = this.el;
    const on = !!name;
    if (this._cache.bbv !== on) { this._cache.bbv = on; e.bbar.classList.toggle('hidden', !on); }
    if (!on) return;
    this._set('bbn', e.bname, 'text', name);
    this._set('bbh', e.bhint, 'text', hint);
    if (this._cache.bbb !== bad) { this._cache.bbb = bad; e.bbar.classList.toggle('bad', bad); }
  }

  pressSeed(n) {
    const el = this.el.seeds.querySelector(`.seed[data-n="${n | 0}"]`);
    if (!el) return;
    el.classList.remove('pressed');
    void el.offsetWidth;
    el.classList.add('pressed');
  }

  /**
   * The seed bar: one card per unlocked plant (number key, icon, name, cost). Cards are rebuilt only when the unlocked
   * set or a cost changes; affordability is toggled every frame. A freshly unlocked card scrolls into view (touch bar scrolls).
   */
  _syncSeeds(config, tier, sun) {
    const plants = unlockedPlants(config, tier);
    const sig = plants.map((p) => `${p.id}:${p.cost}`).join(',');
    const box = this.el.seeds;
    if (sig !== this._seedSig) {
      this._seedSig = sig;
      box.textContent = '';
      for (const p of plants) {
        const card = document.createElement('div');
        card.className = 'seed';
        card.dataset.n = String(p.key);
        card.dataset.kind = p.id;
        const add = (cls, text) => {
          const el = document.createElement('span');
          el.className = cls;
          el.textContent = text;
          card.appendChild(el);
          return el;
        };
        add('key', String(p.key));
        add('ico', p.icon);
        add('nm', p.name);
        const cost = add('cost', '\u2600\uFE0F ');
        const b = document.createElement('b');
        b.textContent = String(p.cost);
        cost.appendChild(b);
        box.appendChild(card);
      }
      box.classList.toggle('compact', plants.length > 5);
      if (plants.length > this._seedCount && this._seedCount > 0 && box.lastChild && box.lastChild.scrollIntoView) {
        try { box.lastChild.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { /* old browsers */ }
      }
      this._seedCount = plants.length;
      for (const k of Object.keys(this._cache)) if (k.startsWith('seed:')) delete this._cache[k];
    }
    for (const card of box.children) {
      const cost = plants.find((p) => p.id === card.dataset.kind)?.cost ?? 0;
      this._set('seed:' + card.dataset.kind, card, 'class', 'seed' + (sun < cost ? ' no' : ''));
    }
  }

  /** One pip per gun tier (the server sends 8 thresholds; follow whatever it says). */
  _ensurePips(n) {
    if (this.el.pips.length === n) return;
    const box = this.el.pipsBox;
    while (box.children.length < n) box.appendChild(document.createElement('i'));
    while (box.children.length > n) box.removeChild(box.lastChild);
    this.el.pips = [...box.children];
    for (const k of Object.keys(this._cache)) if (k.startsWith('pip')) delete this._cache[k];
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
   * ctx: { own, snap, config, now, locked, mower: {hp, maxHp}|null (only while we drive it) }
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
      e.brainsBox.classList.toggle('hidden', team !== 'zombie');
      e.partsBox.classList.toggle('hidden', team !== 'zombie');
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

      // ---- the Fridge Meter: a big snack bar that zombies eat away
      const fr = snap.fridge || { m: 0, n: 0 };
      const left = Math.max(0, Math.min(1, 1 - num(fr.m, 0)));
      const n = num(fr.n, 0);
      this._set('frw', e.fridgeFill, 'width', (left * 100).toFixed(0) + '%');
      this._set('frc', e.fridgeFill, 'class', left < 0.3 ? 'low' : left < 0.6 ? 'mid' : '');
      this._set('frt', e.fridgeText, 'text', n > 0 ? `ALARM! ${n} zombie${n > 1 ? 's' : ''} at the fridge! ${Math.ceil(left * 100)}%` : `Fridge snacks left ${Math.ceil(left * 100)}%`);
      if (this._cache.fra !== (n > 0)) { this._cache.fra = n > 0; e.fridgeBox.classList.toggle('alarm', n > 0); }

      // ---- head start countdown
      const hs = num(snap.headStart, 0);
      const showCd = hs > 0 && snap.phase === 'playing';
      if (this._cache.cdv !== showCd) { this._cache.cdv = showCd; e.cd.classList.toggle('hidden', !showCd); }
      if (showCd) {
        const zom = team === 'zombie';
        this._set('cds', e.cd, 'class', zom ? '' : 'small');
        this._set('cdt', e.cdTitle, 'text', zom ? 'Zombies come out in\u2026' : 'Zombies come out in\u2026');
        this._set('cdn', e.cdNum, 'text', String(Math.ceil(hs)));
        this._set('cdsub', e.cdSub, 'text', zom ? 'The plants are planting their garden!' : 'Plant your garden and build a fort!');
      }
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
      const held = typeof own.item === 'string' && own.item ? own.item : null;
      this._set('wn', e.weapon, 'text', held ? itemInfo(held).name : wi.name);
      const th = Array.isArray(config && config.tierThresholds) && config.tierThresholds.length ? config.tierThresholds : DEFAULT_TIERS;
      const top = th.length - 1;
      this._ensurePips(th.length);
      const tier = Math.max(0, Math.min(top, num(own.tier, 0) | 0));
      for (let i = 0; i < e.pips.length; i++) {
        const on = i <= tier;
        if (this._cache['pip' + i] !== on) { this._cache['pip' + i] = on; e.pips[i].classList.toggle('on', on); }
      }
      const progress = num(own.progress, 0);
      const plantKid = team === 'plant';
      if (tier >= top || th[tier + 1] === undefined) {
        this._set('uw', e.upgFill, 'width', '100%');
        this._set('uc', e.upgFill, 'class', 'max');
        this._set('ut', e.upgText, 'text', plantKid ? 'All plants unlocked! ⭐' : 'Top gun! ⭐');
      } else {
        const next = th[tier + 1];
        const base = th[tier] || 0;
        const f2 = Math.max(0, Math.min(1, (progress - base) / Math.max(1, next - base)));
        this._set('uw', e.upgFill, 'width', (f2 * 100).toFixed(0) + '%');
        this._set('uc', e.upgFill, 'class', '');
        const fresh = plantKid ? nextUnlock(config, tier) : null;
        const label = plantKid ? `Next plant: ${fresh ? fresh.plants.map((p) => p.name).join(' + ') : '?'}` : 'Next gun';
        this._set('ut', e.upgText, 'text', `${label}: ${Math.min(progress, next)} / ${next}`);
      }
      // wheelbarrow hit points
      const showBarrow = held === 'wheelbarrow';
      if (this._cache.ihv !== showBarrow) { this._cache.ihv = showBarrow; e.itemHp.classList.toggle('hidden', !showBarrow); }
      if (showBarrow) {
        const eq = config && config.equipment && config.equipment.wheelbarrow;
        const max = Math.max(1, num(eq && eq.hp, 30));
        const ihp = Math.max(0, num(own.itemHp, max));
        this._set('ihw', e.itemHpFill, 'width', Math.min(100, (ihp / max) * 100).toFixed(0) + '%');
        this._set('iht', e.itemHpText, 'text', `Barrow ${Math.ceil(ihp)}`);
      }
      // icy frost on the screen edges while a Snow Pea has slowed us
      const frosty = !!own.slowed;
      if (this._cache.frost !== frosty) { this._cache.frost = frosty; e.frost.classList.toggle('on', frosty); }
      const streak = num(own.streak, 0) | 0;
      const sb = num(config && config.streakBonus, 10);
      this._set('st', e.streak, 'text', String(streak));
      if (streak > this.lastStreak) { e.streakBox.classList.remove('hot'); void e.streakBox.offsetWidth; e.streakBox.classList.add('hot'); }
      this.lastStreak = streak;
      if (this._cache.sb !== sb) { this._cache.sb = sb; e.streakBox.lastChild.textContent = ` / ${sb}`; }

      // ---- brains (zombie kids buy forts with them), doors, mower parts
      if (team === 'zombie') {
        const brains = Math.floor(num(own.brains, 0));
        this._set('brains', e.brainsCount, 'text', String(brains));
        if (brains > (this.lastBrains || 0)) { e.brainsBox.classList.remove('bump'); void e.brainsBox.offsetWidth; e.brainsBox.classList.add('bump'); }
        this.lastBrains = brains;
        const pm = ctx.parts || { mask: 0, carry: null };
        for (const [k, bit] of [['battery', 1], ['gas', 2], ['plug', 4]]) {
          const have = (pm.mask & bit) !== 0;
          if (this._cache['pt' + k] !== have) { this._cache['pt' + k] = have; e.pt[k].classList.toggle('have', have); }
        }
        const carry = pm.carry ? pm.carry.text : '';
        this._set('pcarry', e.partsCarry, 'text', carry);
        if (this._cache.pcv !== !!carry) { this._cache.pcv = !!carry; e.partsCarry.classList.toggle('hidden', !carry); }
      }
      if (ctx.doors) this._set('doors', e.doorCount, 'text', String(ctx.doors.alive));
      this.root.classList.toggle('driving', !!ctx.mower);

      // ---- sunshine & seeds
      if (team === 'plant') {
        const sun = Math.floor(num(own.sunshine, 0));
        this._set('sun', e.sunCount, 'text', String(sun));
        if (sun > this.lastSun) { e.sunBox.classList.remove('bump'); void e.sunBox.offsetWidth; e.sunBox.classList.add('bump'); }
        this.lastSun = sun;
        this._syncSeeds(config, num(own.tier, 0), sun);
      }

      // ---- the mower's own hit points while we drive it
      const mw = ctx.mower || null;
      const showMw = !!mw;
      if (this._cache.mwv !== showMw) { this._cache.mwv = showMw; e.mowerBox.classList.toggle('hidden', !showMw); }
      if (mw) {
        const mf = Math.max(0, Math.min(1, num(mw.hp, 0) / Math.max(1, num(mw.maxHp, 40))));
        this._set('mwf', e.mowerFill, 'width', (mf * 100).toFixed(0) + '%');
        this._set('mwc', e.mowerFill, 'class', mf < 0.3 ? 'low' : mf < 0.6 ? 'mid' : '');
        this._set('mwt', e.mowerText, 'text', `Mower ${Math.ceil(num(mw.hp, 0))}`);
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
      this._set('ec', e.endCount, 'text', `Back to the lobby in ${left}…`);
    } else if (this.endShown) {
      this.endShown = false;
      e.end.classList.add('hidden');
    }
  }
}
