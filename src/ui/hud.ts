import * as THREE from 'three';
import type { DogActor } from '../dog/actor';
import { getBreed } from '../dog/breeds';
import type { Game } from '../game/game';
import { voice } from '../game/speech';
import type { DogSave } from '../game/state';
import { ICONS, h, iconBtn, svg } from './dom';
import { renderToDataURL } from '../game/capture';

// The "top screen": portrait, name, hearts, needs, money and clock.

export class StatusCard {
  readonly el: HTMLElement;
  private img: HTMLImageElement;
  private nameEl: HTMLElement;
  private subEl: HTMLElement;
  private heartsEl: HTMLElement;
  private bars: Record<string, HTMLElement> = {};
  private moneyEl: HTMLElement;
  private opEl: HTMLElement;
  private clockEl: HTMLElement;

  constructor(private game: Game) {
    this.img = h('img', { alt: '' });
    this.nameEl = h('div', { class: 'hud-name' });
    this.subEl = h('div', { class: 'hud-sub' });
    this.heartsEl = h('div', { class: 'hearts' });
    const stats = h('div', { class: 'stats' });
    for (const [k, label] of [['hunger', 'Food'], ['thirst', 'Water'], ['clean', 'Clean'], ['energy', 'Energy']] as const) {
      const i = h('i');
      const bar = h('div', { class: 'bar' }, i);
      this.bars[k] = bar;
      stats.append(h('span', null, label), bar);
    }
    this.moneyEl = h('div', { class: 'money' });
    this.opEl = h('div', { class: 'op' });
    this.clockEl = h('div', { class: 'clock' });
    this.el = h('div', { class: 'hud-top' },
      h('div', { class: 'hud-portrait' }, this.img),
      h('div', { style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: '120px' } }, this.nameEl, this.subEl, this.heartsEl),
      stats,
      h('div', { class: 'hud-right' }, this.moneyEl, this.opEl, this.clockEl),
    );
  }

  setPortrait(url: string) {
    if (url) this.img.src = url;
  }

  refresh(d: DogSave | undefined) {
    const s = this.game.save;
    if (d) {
      const breed = getBreed(d.breedId);
      this.nameEl.innerHTML = '';
      this.nameEl.append(d.name, h('span', { class: 'sex ' + d.sex }, d.sex === 'male' ? '♂' : '♀'));
      this.subEl.textContent = breed.name;
      const hearts = Math.round(d.affection / 20);
      this.heartsEl.innerHTML = '';
      for (let i = 0; i < 5; i++) this.heartsEl.append(h('span', { class: i < hearts ? 'on' : '' }, '♥'));
      for (const k of ['hunger', 'thirst', 'clean', 'energy'] as const) {
        const v = d[k];
        const bar = this.bars[k];
        (bar.firstChild as HTMLElement).style.width = v + '%';
        bar.className = 'bar' + (v < 25 ? ' bad' : v < 50 ? ' warn' : '');
      }
    }
    this.moneyEl.textContent = '$' + s.money.toLocaleString();
    this.opEl.textContent = s.ownerPoints.toLocaleString() + ' Owner Pts';
    const now = new Date();
    this.clockEl.textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}

/** Speech box: hold the mic (or Space) to talk, or type and press Enter. */
export class SayBox {
  readonly el: HTMLElement;
  private mic: HTMLButtonElement;
  private input: HTMLInputElement;
  private offs: (() => void)[] = [];

  constructor(onSay: (text: string) => void) {
    this.input = h('input', { placeholder: voice.supported ? 'Hold 🎤 or type…' : 'Type a command…', maxlength: 40 });
    this.mic = h('button', { class: 'mic', title: 'Hold to talk (or hold Space)' }, svg(ICONS.mic));
    this.el = h('div', { class: 'say' }, this.input, this.mic);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.input.value.trim();
        this.input.value = '';
        if (t) onSay(t);
      }
      if (e.key === 'Escape') this.input.blur();
    });
    const start = () => {
      if (!voice.supported) { this.input.focus(); return; }
      voice.start();
      this.mic.classList.add('listening');
    };
    const stop = () => {
      voice.stop();
      this.mic.classList.remove('listening');
    };
    this.mic.addEventListener('pointerdown', (e) => { e.preventDefault(); start(); });
    this.mic.addEventListener('pointerup', stop);
    this.mic.addEventListener('pointerleave', stop);
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement !== this.input && !e.repeat) { e.preventDefault(); start(); }
      else if (e.key === 'Enter' && document.activeElement !== this.input) { this.input.focus(); }
    };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space' && document.activeElement !== this.input) stop(); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    this.offs.push(() => window.removeEventListener('keydown', kd), () => window.removeEventListener('keyup', ku));
    this.offs.push(voice.on((text, final) => { if (final) onSay(text); }));
  }

  blink(on: boolean) {
    this.mic.classList.toggle('blink', on);
  }

  dispose() {
    for (const o of this.offs) o();
  }
}

export { iconBtn };

/** Render a close-up of a dog's face into a data URL for the HUD. */
export function renderPortrait(renderer: THREE.WebGLRenderer, scene: THREE.Scene, actor: DogActor, size = 160): string {
  const head = actor.headWorld();
  const d = actor.model.design.dims;
  const fwd = new THREE.Vector3(Math.sin(actor.heading), 0, Math.cos(actor.heading));
  const target = head.clone().addScaledVector(fwd, 0.05 * d.hs).add(new THREE.Vector3(0, 0.01, 0));
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  cam.position.copy(target).addScaledVector(fwd, 0.42 * d.hs).addScaledVector(side, 0.14 * d.hs).add(new THREE.Vector3(0, 0.05, 0));
  cam.lookAt(target);
  return renderToDataURL(renderer, scene, cam, size, size);
}
