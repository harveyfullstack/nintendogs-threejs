import * as THREE from 'three';
import type { DogActor } from '../dog/actor';
import { getBreed } from '../dog/breeds';
import type { Game } from '../game/game';
import { voice } from '../game/speech';
import type { DogSave } from '../game/state';
import { touchUI } from './device';
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
      h('div', { class: 'hud-id' }, this.nameEl, this.subEl, this.heartsEl),
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

/**
 * Speech box: hold the mic (or Space) to talk, or type and press Enter. On touch
 * screens the mic is tap-to-talk (it stops by itself after a phrase) and a
 * keyboard button opens the text field only when it's wanted.
 */
export class SayBox {
  readonly el: HTMLElement;
  private mic: HTMLButtonElement;
  private kbd: HTMLButtonElement | null = null;
  private input: HTMLInputElement;
  private offs: (() => void)[] = [];
  private readonly compact = touchUI;
  private typing = false;

  constructor(private onSay: (text: string) => void, private opts: { notify?: (text: string) => void; solo?: boolean } = {}) {
    const compact = this.compact;
    this.input = h('input', {
      placeholder: compact ? 'Say something…' : voice.supported ? 'Hold 🎤 or type…' : 'Type a command…',
      maxlength: 40, enterkeyhint: 'send', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
      'aria-label': 'Talk to your dog',
    });
    this.mic = h('button', { class: 'mic', title: compact ? 'Tap to talk' : 'Hold to talk (or hold Space)', 'aria-label': 'Talk' }, svg(ICONS.mic));
    if (compact) this.kbd = h('button', { class: 'kbd', title: 'Type a command', 'aria-label': 'Type a command' }, svg(ICONS.keyboard));
    this.el = h('div', { class: 'say' + (compact ? ' compact' : '') + (opts.solo ? ' solo' : '') }, this.input, this.kbd, this.mic);
    this.mic.classList.toggle('off', !voice.available);

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.submit();
      if (e.key === 'Escape') this.input.blur();
    });
    this.input.addEventListener('blur', () => {
      // tapping away closes an empty text field (after any button tap that caused the blur has run)
      setTimeout(() => { if (this.typing && document.activeElement !== this.input && !this.input.value.trim()) this.closeTyping(); }, 180);
    });
    if (this.kbd) {
      const kbd = this.kbd;
      kbd.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the text field focused
      kbd.addEventListener('click', () => {
        if (!this.typing) this.openTyping();
        else if (this.input.value.trim()) this.submit();
        else this.closeTyping();
      });
    }

    // mouse: push to talk. touch: tap to talk (starting on the tap's end, which counts as a user gesture)
    this.mic.addEventListener('pointerdown', (e) => { e.preventDefault(); if (e.pointerType === 'mouse') this.listen(); });
    this.mic.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') voice.stop();
      else if (voice.listening) voice.stop();
      else this.listen();
    });
    this.mic.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') voice.stop(); });
    this.mic.addEventListener('contextmenu', (e) => e.preventDefault());

    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.activeElement !== this.input && !e.repeat) { e.preventDefault(); this.listen(); }
      else if (e.key === 'Enter' && document.activeElement !== this.input) this.openTyping();
    };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space' && document.activeElement !== this.input) voice.stop(); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    this.offs.push(() => window.removeEventListener('keydown', kd), () => window.removeEventListener('keyup', ku));
    this.offs.push(voice.on((text, final) => { if (final) onSay(text); }));
    this.offs.push(voice.onState((on) => this.mic.classList.toggle('listening', on)));
    this.offs.push(voice.onError((err) => {
      this.mic.classList.toggle('off', !voice.available);
      if (!voice.available) {
        this.opts.notify?.('The microphone is blocked here, so type your commands instead.');
        this.openTyping();
      } else if (err === 'network') this.opts.notify?.('Voice commands need an internet connection.');
      else if (err === 'no-speech' && this.compact) this.opts.notify?.("Didn't catch that. Tap 🎤 and speak up!");
    }));
  }

  private listen() {
    if (!voice.available) {
      this.opts.notify?.(voice.supported ? 'The microphone is blocked here, so type your commands instead.' : "This browser can't do voice commands, so type them instead.");
      this.openTyping();
      return;
    }
    voice.start();
  }

  private submit() {
    const t = this.input.value.trim();
    this.input.value = '';
    if (t) this.onSay(t);
    // on phones, get the keyboard out of the way so you can see the reaction
    if (this.compact) this.closeTyping();
  }

  private openTyping() {
    if (this.compact && this.kbd) {
      this.typing = true;
      this.el.classList.add('typing');
      this.kbd.replaceChildren(svg(ICONS.send));
    }
    this.input.focus();
  }

  private closeTyping() {
    this.typing = false;
    this.el.classList.remove('typing');
    this.kbd?.replaceChildren(svg(ICONS.keyboard));
    this.input.blur();
  }

  /** Start listening (or open the text field): call from a tap. */
  activate() {
    if (voice.available) voice.start();
    else this.openTyping();
  }

  blink(on: boolean) {
    this.mic.classList.toggle('blink', on);
  }

  dispose() {
    voice.stop();
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
