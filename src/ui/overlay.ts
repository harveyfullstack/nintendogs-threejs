import * as THREE from 'three';
import { clear, h } from './dom';
import type { Emote } from '../dog/brain';

// Screen-space layer on top of the 3D view: toasts, modals, emotes, fades.

const EMOTE_GLYPH: Record<Emote, string> = {
  heart: '💗', sparkle: '✨', note: '🎵', zzz: '💤', question: '❓', exclaim: '❗', anger: '💢', bulb: '💡', sweat: '💦',
};

const _v = new THREE.Vector3();

/**
 * Close when a tap both starts and ends on the backdrop itself. Closing on the
 * click (not on pointerdown) means the tap is used up here, so on touch screens
 * it can't land as a "ghost click" on the HUD button underneath.
 */
function dismissOnOutsideTap(back: HTMLElement, close: () => void) {
  let armed = false;
  back.addEventListener('pointerdown', (e) => { armed = e.target === back; });
  back.addEventListener('click', (e) => { if (armed && e.target === back) close(); armed = false; });
}

export class Overlay {
  readonly root: HTMLElement;
  readonly layer: HTMLElement; // scene specific HUD goes here
  private emotes: HTMLElement;
  private toasts: HTMLElement;
  private modals: HTMLElement;
  private fade: HTMLElement;
  private heardEl: HTMLElement;
  private heardTimer = 0;
  private tracked: { el: HTMLElement; get: () => THREE.Vector3 | null; offY: number }[] = [];
  camera: THREE.Camera | null = null;

  constructor() {
    this.root = h('div', { id: 'ui' });
    document.body.appendChild(this.root);
    this.emotes = h('div', { class: 'emotes' });
    this.layer = h('div', { class: 'passthrough', style: { position: 'absolute', inset: '0' } });
    this.toasts = h('div', { class: 'toasts' });
    this.modals = h('div', { class: 'passthrough', style: { position: 'absolute', inset: '0' } });
    this.fade = h('div', { class: 'fade' });
    this.heardEl = h('div', { class: 'heard' });
    this.root.append(this.emotes, this.layer, this.heardEl, this.toasts, this.modals, this.fade);
  }

  /** Clear the scene-specific layer (HUD) */
  resetLayer() {
    clear(this.layer);
    this.tracked = [];
    clear(this.emotes);
  }

  toast(text: string, big = false) {
    const t = h('div', { class: 'toast' + (big ? ' big' : '') }, text);
    this.toasts.append(t);
    setTimeout(() => t.remove(), 3100);
  }

  heard(text: string) {
    this.heardEl.textContent = '“' + text + '”';
    this.heardEl.classList.add('show');
    clearTimeout(this.heardTimer);
    this.heardTimer = window.setTimeout(() => this.heardEl.classList.remove('show'), 2200);
  }

  modal(content: HTMLElement, opts: { dismiss?: boolean; onClose?: () => void } = {}) {
    const back = h('div', { class: 'backdrop' }, content);
    const close = () => { back.remove(); opts.onClose?.(); };
    if (opts.dismiss !== false) dismissOnOutsideTap(back, close);
    this.modals.append(back);
    return { close, el: back };
  }

  drawer(content: HTMLElement, onClose?: () => void) {
    const wrap = h('div', { class: 'drawer-wrap' });
    const d = h('div', { class: 'drawer' }, content);
    wrap.append(d);
    const close = () => { wrap.remove(); onClose?.(); };
    dismissOnOutsideTap(wrap, close);
    this.modals.append(wrap);
    return { close, el: d };
  }

  closeModals() {
    clear(this.modals);
  }

  get hasModal() { return this.modals.childElementCount > 0; }

  async fadeOut(ms = 350) {
    this.fade.classList.add('on');
    await new Promise((r) => setTimeout(r, ms));
  }

  async fadeIn(ms = 350) {
    this.fade.classList.remove('on');
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Spawn an emote at a world position. */
  emote(kind: Emote, world: THREE.Vector3, jitter = 0) {
    if (!this.camera) return;
    const p = this.project(world);
    if (!p) return;
    const el = h('div', { class: 'emote' + (kind === 'sparkle' ? ' sparkle' : '') }, EMOTE_GLYPH[kind]);
    el.style.left = p.x + (Math.random() - 0.5) * jitter + 'px';
    el.style.top = p.y + (Math.random() - 0.5) * jitter + 'px';
    this.emotes.append(el);
    setTimeout(() => el.remove(), 1500);
  }

  /** An element that follows a world point every frame until removed. */
  track(el: HTMLElement, get: () => THREE.Vector3 | null, offY = 0) {
    this.emotes.append(el);
    const t = { el, get, offY };
    this.tracked.push(t);
    return () => { el.remove(); this.tracked = this.tracked.filter((x) => x !== t); };
  }

  project(world: THREE.Vector3): { x: number; y: number } | null {
    if (!this.camera) return null;
    _v.copy(world).project(this.camera);
    if (_v.z > 1) return null;
    const w = this.root.clientWidth, hh = this.root.clientHeight;
    return { x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * hh };
  }

  update() {
    for (const t of this.tracked) {
      const w = t.get();
      const p = w ? this.project(w) : null;
      if (!p) { t.el.style.display = 'none'; continue; }
      t.el.style.display = '';
      t.el.style.left = p.x + 'px';
      t.el.style.top = p.y + t.offY + 'px';
    }
  }
}
