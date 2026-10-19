// Settings panel (your name + look settings). Opens from the lobby, from the gear button in the HUD, or with the O key
// (also while the mouse is free in a round). Every change applies and saves immediately.
import { settings, resolveGfx, SENS_MIN, SENS_MAX, SENS_STEP } from './settings.js';
import { isTouch } from './touch.js';
import { profile } from './profile.js';

const $ = (id) => document.getElementById(id);

export class Options {
  constructor() {
    this.root = $('settings');
    this.invY = $('set-invy');
    this.invX = $('set-invx');
    this.sens = $('set-sens');
    this.sensVal = $('set-sensval');
    this.gfxHigh = $('set-gfx-high');
    this.gfxLow = $('set-gfx-low');
    this.gfxNote = $('set-gfxds');
    this.nameEl = $('set-name');
    this.leaveBtn = $('set-leave');
    this.onLeave = null; // () => void
    this.onOpen = null; // () => void
    this.onClose = null; // (relock: boolean) => void

    this.sens.min = String(SENS_MIN);
    this.sens.max = String(SENS_MAX);
    this.sens.step = String(SENS_STEP);

    this.invY.addEventListener('click', () => settings.set({ invertY: !settings.values.invertY }));
    this.invX.addEventListener('click', () => settings.set({ invertX: !settings.values.invertX }));
    this.sens.addEventListener('input', () => settings.set({ sens: parseFloat(this.sens.value) }));
    this.gfxHigh.addEventListener('click', () => settings.set({ gfx: 'high' }));
    this.gfxLow.addEventListener('click', () => settings.set({ gfx: 'low' }));
    this.nameEl.addEventListener('change', () => this._commitName());
    this.nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this._commitName(); this.nameEl.blur(); }
    });
    profile.subscribe(() => this._renderName());
    $('set-reset').addEventListener('click', () => settings.reset());
    $('set-done').addEventListener('click', () => this.close());
    this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    this.leaveBtn.addEventListener('click', () => { if (this.onLeave) this.onLeave(); });
    for (const b of [$('optbtn'), ...document.querySelectorAll('[data-open-settings]')]) {
      if (b) b.addEventListener('click', () => this.open());
    }

    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape' && this.isOpen) {
        this.close(false); // Esc isn't a click, so the browser won't let us re-grab the mouse
      } else if (e.code === 'KeyO') {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'))) return; // typing a name
        if (this.isOpen) this.close();
        else this.open();
      }
    });

    settings.subscribe(() => this._render());
    this._render();
  }

  /** "Leave lobby" only shows while we are in one. */
  setInLobby(inLobby) { this.leaveBtn.classList.toggle('hidden', !inLobby); }

  get isOpen() { return !this.root.classList.contains('hidden'); }

  open() {
    if (this.isOpen) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.root.classList.remove('hidden');
    this._render();
    this._renderName(true);
    if (this.onOpen) this.onOpen();
    $('set-done').focus();
  }

  close(relock = true) {
    if (!this.isOpen) return;
    this._commitName();
    this.root.classList.add('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (this.onClose) this.onClose(relock);
  }

  _commitName() {
    const v = this.nameEl.value;
    if (v.trim() === '') this.nameEl.value = profile.name; // empty box: keep the old name
    else this.nameEl.value = profile.set(v);
  }

  _renderName(force = false) {
    if (force || document.activeElement !== this.nameEl) this.nameEl.value = profile.name;
  }

  _render() {
    const v = settings.values;
    this.invY.setAttribute('aria-checked', String(v.invertY));
    this.invX.setAttribute('aria-checked', String(v.invertX));
    if (parseFloat(this.sens.value) !== v.sens) this.sens.value = String(v.sens);
    this.sensVal.textContent = `${v.sens}x`; // sens is already rounded to 2 decimals
    const gfx = resolveGfx(v, isTouch());
    this.gfxHigh.setAttribute('aria-checked', String(gfx === 'high'));
    this.gfxLow.setAttribute('aria-checked', String(gfx === 'low'));
  }

  /** A line under the Graphics choice (e.g. "smooth edges apply after a reload"); null = the usual text. */
  setGfxNote(text) { this.gfxNote.textContent = text || 'Low is smoother on phones and older computers'; }
}
