import * as THREE from 'three';
import type { DogActor, DogHit } from '../dog/actor';
import type { Brain } from '../dog/brain';
import { screenScale, touchUI } from '../ui/device';
import { h } from '../ui/dom';
import { props } from '../world/loaders';
import type { ToyKind } from '../world/types';
import type { Game } from './game';
import { sound } from './sound';
import { DogSave, clamp } from './state';
import { TRICKS, TrickId, getTrick, normalizeWords, similarity } from './tricks';
import type { ToyEntry, ToyWorld } from './toyPhysics';

// Touch-screen style interactions shared by the home and park scenes:
// petting, leading with your hand, throwing toys, tug of war, brushing,
// and teaching tricks.

export interface PlayDog {
  save: DogSave;
  actor: DogActor;
  brain: Brain;
}

export type PlayMode = 'normal' | 'training' | 'brush';

interface Sample { t: number; x: number; y: number }

const PRAISE = ['good boy', 'good girl', 'good dog', 'good', 'well done', 'yes', 'clever', 'nice', 'great job', 'atta boy', 'atta girl', 'awesome'];
const SCOLD = ['no', 'bad', 'stop', 'bad dog', 'quiet', 'hey'];

export class PlayController {
  mode: PlayMode = 'normal';
  focus: PlayDog;
  handToy: ToyEntry | null = null;
  throwScale = 1;
  enabled = true;
  onModeChange: ((m: PlayMode) => void) | null = null;
  onTrickLearned: ((d: PlayDog, trick: TrickId) => void) | null = null;
  onNameHeard: ((d: PlayDog) => void) | null = null;
  /** optional hook for scenes that want to intercept speech (tutorials) */
  interceptSpeech: ((text: string) => boolean) | null = null;
  /** the light bulb was tapped: a good moment to start listening */
  onBulbTap: (() => void) | null = null;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private down = false;
  /** the pointer driving the current stroke; other fingers are ignored */
  private pointerId = -1;
  /** fingers currently on the 3D view; two or more means a pinch, so hands off until they lift */
  private touches = new Set<number>();
  private pinching = false;
  private lastPointer = touchUI ? 'touch' : 'mouse';
  private downOn: 'dog' | 'floor' | 'toy' | 'none' = 'none';
  private petDog: PlayDog | null = null;
  private lastHit: DogHit | null = null;
  private lastHitT = 0;
  private samples: Sample[] = [];
  private gesture: { start: DogHit | null; startT: number; path: Sample[]; dog: PlayDog | null } | null = null;
  private tapHistory: { t: number; region: string }[] = [];
  private brush: THREE.Object3D | null = null;
  private bulb: { dog: PlayDog; trick: TrickId; until: number; remove: () => void } | null = null;
  private whistles: number[] = [];
  private ring: HTMLElement;
  private tugPoint = new THREE.Vector3();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private cleanup: (() => void)[] = [];

  constructor(
    readonly game: Game,
    readonly camera: THREE.PerspectiveCamera,
    readonly dogs: PlayDog[],
    readonly toys: ToyWorld,
    readonly world: THREE.Object3D,
  ) {
    this.focus = dogs[0];
    (window as any).__play = this; // debug/recording hook
    this.ring = h('div', { class: 'touch-ring', style: { opacity: '0' } });
    game.overlay.layer.append(this.ring);
    this.attach();
    for (const d of dogs) {
      d.brain.onBarkListeners.push(() => this.onDogBark(d));
      d.brain.onSpontaneous = (trick) => { if (this.mode === 'training' && !this.bulb) this.showBulb(d, trick); };
    }
  }

  // ---------------------------------------------------------------- events

  private attach() {
    const el = this.game.renderer.domElement;
    const down = (e: PointerEvent) => this.pointerDown(e);
    const move = (e: PointerEvent) => this.pointerMove(e);
    const up = (e: PointerEvent) => this.pointerUp(e);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.cleanup.push(() => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    });
  }

  dispose() {
    for (const c of this.cleanup) c();
    this.bulb?.remove();
    this.ring.remove();
    this.brush?.removeFromParent();
  }

  private setRay(e: PointerEvent) {
    const r = this.game.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private hitDog(): { dog: PlayDog; hit: DogHit } | null {
    let best: { dog: PlayDog; hit: DogHit } | null = null;
    for (const d of this.dogs) {
      if (!d.actor.group.parent) continue;
      const hit = d.actor.raycast(this.raycaster.ray);
      if (hit && (!best || hit.distance < best.hit.distance)) best = { dog: d, hit };
    }
    return best;
  }

  private hitFloor(): THREE.Vector3 | null {
    this.floorPlane.constant = -this.toys.floorY;
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.floorPlane, p);
  }

  private hitToy(): ToyEntry | null {
    let best: ToyEntry | null = null, bd = Infinity;
    for (const t of this.toys.list) {
      if (t.inHand || t.carrier) continue;
      const c = t.object.getWorldPosition(new THREE.Vector3());
      const d = this.raycaster.ray.distanceToPoint(c);
      const dist = c.distanceTo(this.raycaster.ray.origin);
      if (d < Math.max(0.06, t.radius * 1.6) && dist < bd) { bd = dist; best = t; }
    }
    return best;
  }

  private pointerDown(e: PointerEvent) {
    if (!this.enabled || e.button > 0) return;
    this.lastPointer = e.pointerType;
    if (e.pointerType !== 'mouse') {
      // a primary touch starts a fresh sequence, so nothing lost from the last one can wedge us
      if (e.isPrimary) { this.cancelStroke(); this.touches.clear(); this.pinching = false; }
      this.touches.add(e.pointerId);
      if (this.touches.size > 1) { this.cancelStroke(); this.pinching = true; return; }
    }
    if (this.pinching || this.down) return;
    this.pointerId = e.pointerId;
    this.setRay(e);
    this.down = true;
    this.samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
    sound.init();
    if (this.handToy) {
      this.downOn = 'toy';
      this.moveHandToy();
      if (this.handToy.kind === 'squeaky') { sound.sfx('squeak'); this.excite(0.5); }
      return;
    }
    const toy = this.hitToy();
    const dh = this.hitDog();
    if (toy && (!dh || toy.object.getWorldPosition(new THREE.Vector3()).distanceTo(this.raycaster.ray.origin) < dh.hit.distance)) {
      // pick up a toy lying on the floor
      this.takeToy(toy);
      this.downOn = 'toy';
      return;
    }
    if (dh) {
      this.downOn = 'dog';
      this.petDog = dh.dog;
      this.focus = dh.dog;
      this.lastHit = dh.hit;
      this.lastHitT = performance.now();
      if (this.mode === 'training') {
        this.gesture = { start: dh.hit, startT: performance.now(), path: [{ t: performance.now(), x: e.clientX, y: e.clientY }], dog: dh.dog };
      } else {
        this.touchDog(dh.dog, dh.hit, true);
        if (this.mode === 'brush') this.moveBrush(dh.hit);
      }
      return;
    }
    const f = this.hitFloor();
    if (this.mode === 'training') {
      // gestures may start off the dog (circles for spin, flicks for jump)
      this.gesture = { start: null, startT: performance.now(), path: [{ t: performance.now(), x: e.clientX, y: e.clientY }], dog: this.focus };
    }
    if (f) {
      this.downOn = 'floor';
      this.setHand(f.setY(this.toys.floorY + 0.12));
      this.showRing(e);
    }
  }

  private pointerMove(e: PointerEvent) {
    if (!this.enabled || this.pinching) return;
    if (this.down ? e.pointerId !== this.pointerId : e.pointerType !== 'mouse') return;
    this.setRay(e);
    const now = performance.now();
    if (this.down) {
      this.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (this.samples.length > 2 && now - this.samples[0].t > 120) this.samples.shift();
    }
    if (this.handToy) {
      this.moveHandToy();
      this.game.renderer.domElement.style.cursor = 'grabbing';
      return;
    }
    if (this.gesture && this.down) this.gesture.path.push({ t: now, x: e.clientX, y: e.clientY });
    if (!this.down) {
      // hover cursor
      const dh = this.hitDog();
      this.game.renderer.domElement.style.cursor = dh ? (this.mode === 'brush' ? 'none' : 'pointer') : (this.hitToy() ? 'grab' : 'default');
      if (this.mode === 'brush') this.moveBrush(dh?.hit ?? null);
      return;
    }
    if (this.downOn === 'dog' && this.mode !== 'training') {
      const dh = this.hitDog();
      if (dh && dh.dog === this.petDog) this.touchDog(dh.dog, dh.hit, false);
      if (this.mode === 'brush') this.moveBrush(dh?.hit ?? null);
    } else if (this.downOn === 'floor') {
      const f = this.hitFloor();
      if (f) this.setHand(f.setY(this.toys.floorY + 0.12));
      this.showRing(e);
    }
  }

  private pointerUp(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (this.pinching) {
      if (!this.touches.size) this.pinching = false;
      return;
    }
    if (!this.down || e.pointerId !== this.pointerId) return;
    this.down = false;
    if (this.handToy && this.downOn === 'toy') {
      if (e.type === 'pointercancel') this.samples = [];
      this.releaseHandToy();
    }
    if (this.gesture && e.type !== 'pointercancel') this.classifyGesture();
    this.gesture = null;
    if (this.petDog) { this.petDog.brain.setPet(null); this.petDog = null; }
    this.setHand(null);
    this.ring.style.opacity = '0';
    this.downOn = 'none';
    // no hover on touch screens, so don't leave the brush floating where the finger lifted
    if (e.pointerType !== 'mouse' && this.brush) this.brush.visible = false;
  }

  /** A second finger landed (pinch zoom): drop whatever the first one was doing, but keep a held toy. */
  private cancelStroke() {
    if (!this.down) return;
    this.down = false;
    this.gesture = null;
    this.samples = [];
    if (this.petDog) { this.petDog.brain.setPet(null); this.petDog = null; }
    this.setHand(null);
    this.ring.style.opacity = '0';
    this.downOn = 'none';
  }

  private showRing(e: PointerEvent) {
    this.ring.style.opacity = '1';
    this.ring.style.left = e.clientX + 'px';
    this.ring.style.top = e.clientY + 'px';
  }

  private setHand(p: THREE.Vector3 | null) {
    const d = this.nearestDog(p);
    for (const x of this.dogs) x.brain.setHand(x === d ? p : null);
  }

  private nearestDog(p: THREE.Vector3 | null): PlayDog | null {
    if (!p) return null;
    let best: PlayDog | null = null, bd = Infinity;
    for (const d of this.dogs) {
      const dist = d.actor.distanceTo(p) - (d === this.focus ? 0.5 : 0);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  // ---------------------------------------------------------------- petting & brushing

  private touchDog(d: PlayDog, hit: DogHit, first: boolean) {
    const now = performance.now();
    let speed = 0;
    if (!first && this.lastHit) {
      const dt = Math.max(1, now - this.lastHitT) / 1000;
      speed = hit.point.distanceTo(this.lastHit.point) / dt;
    }
    this.lastHit = hit;
    this.lastHitT = now;
    const region = hit.region;
    if (first) {
      if (region === 'tail') {
        d.brain.env.emote(d.actor, 'anger');
        d.actor.face(this.camera.position);
        sound.dog('yip', this.game.voiceOf(d.save));
        return;
      }
      if (region === 'muzzle') {
        if (Math.random() < 0.5) sound.dog('sneeze', this.game.voiceOf(d.save));
        d.actor.rig.overlay.head = [-0.2, 0, 0];
        setTimeout(() => delete d.actor.rig.overlay.head, 300);
      }
      if (region === 'frontPaw' && d.brain.posture === 'sit') {
        d.actor.rig.setPose('shake', 6);
        setTimeout(() => d.actor.rig.setPose('sit', 5), 1200);
      }
    }
    if (this.mode === 'brush') {
      if (speed > 0.05) {
        const u = d.actor.model.uniforms;
        u.uFluff.value = Math.min(1, u.uFluff.value + speed * 0.02);
        d.save.clean = clamp(d.save.clean + speed * 0.05);
        if (Math.random() < 0.3) { this.game.overlay.emote('sparkle', hit.point, 30); sound.sfx('brush', { volume: 0.4 }); }
      }
    }
    d.brain.setPet({ point: hit.point.clone(), region, speed: speed * (this.mode === 'brush' ? 1.3 : 1), idle: 0 });
  }

  private moveBrush(hit: DogHit | null) {
    if (!this.brush) return;
    if (!hit) { this.brush.visible = false; return; }
    this.brush.visible = true;
    this.brush.position.copy(hit.point).addScaledVector(hit.normal, 0.02);
    this.brush.lookAt(hit.point.clone().addScaledVector(hit.normal, 1));
  }

  setMode(m: PlayMode) {
    if (this.mode === m) m = 'normal';
    this.mode = m;
    if (this.brush) { this.brush.removeFromParent(); this.brush = null; }
    if (m === 'brush') {
      this.brush = props().makeItem('brush');
      this.brush.scale.setScalar(0.8);
      this.world.add(this.brush);
      this.brush.visible = false;
    }
    if (m !== 'training') this.clearBulb();
    // in training the pup comes over and pays attention instead of wandering off
    for (const d of this.dogs) d.brain.attentive = m === 'training' && d === this.focus;
    if (m === 'training') this.focus.brain.call();
    this.game.renderer.domElement.style.cursor = 'default';
    this.onModeChange?.(m);
  }

  // ---------------------------------------------------------------- toys

  holdToy(kind: ToyKind) {
    if (this.handToy) this.dropHandToy();
    if (this.lastPointer !== 'mouse') {
      // no cursor to hang it on: hold it low in the middle of the screen, ready to flick
      this.ndc.set(0, -0.45);
      this.raycaster.setFromCamera(this.ndc, this.camera);
    }
    // reuse an existing world toy of that kind
    let e = this.toys.list.find((t) => t.kind === kind && !t.carrier && !t.inHand);
    if (!e) e = this.toys.add(props().makeToy(kind), new THREE.Vector3());
    this.takeToy(e);
  }

  private takeToy(e: ToyEntry) {
    if (e.carrier) return;
    this.handToy = e;
    e.inHand = true;
    e.resting = false;
    e.velocity.set(0, 0, 0);
    this.world.attach(e.object);
    this.moveHandToy();
    for (const d of this.dogs) {
      d.brain.excite = Math.max(d.brain.excite, 0.5);
      d.actor.rig.look = { point: e.object.position, weight: 1 };
    }
    if (e.kind === 'rope') {
      const d = this.focus;
      d.brain.startTug(e, () => this.ropeFarEnd(e));
    }
  }

  private ropeFarEnd(e: ToyEntry) {
    // the end of the rope the dog should bite: 30cm from the hand towards the dog
    const hand = e.object.getWorldPosition(new THREE.Vector3());
    const d = this.focus.actor.position.clone().setY(hand.y).sub(hand);
    const len = d.length();
    if (len > 1e-3) d.multiplyScalar(Math.min(0.3, len) / len);
    return hand.add(d).setY(this.focus.actor.floorY + this.focus.actor.size * 0.55);
  }

  private moveHandToy() {
    const e = this.handToy;
    if (!e) return;
    const dist = 0.55 * Math.max(1, this.throwScale * 0.7);
    const p = this.raycaster.ray.at(dist, new THREE.Vector3());
    p.y = Math.max(p.y, this.toys.floorY + e.radius + 0.02);
    e.object.position.copy(p);
    if (e.glide) e.object.rotation.set(0.25, 0, 0);
  }

  private releaseHandToy() {
    const e = this.handToy!;
    const s = this.samples;
    let vx = 0, vy = 0;
    if (s.length >= 2) {
      const a = s[0], b = s[s.length - 1];
      const dt = Math.max(16, b.t - a.t) / 1000;
      vx = (b.x - a.x) / dt;
      vy = (b.y - a.y) / dt;
    }
    // swipe speeds are in screen pixels, so a phone flick covers less ground than a mouse one
    const k = screenScale();
    vx /= k;
    vy /= k;
    const flick = Math.hypot(vx, vy);
    if (e.kind === 'rope' && this.focus.brain.tugging) {
      // let go: the dog wins the rope
      e.inHand = false;
      this.handToy = null;
      this.focus.brain.env.pickUpToy?.(e, this.focus.actor);
      this.focus.brain.excite = 1;
      this.game.overlay.emote('note', this.focus.actor.headWorld(), 20);
      return;
    }
    this.handToy = null;
    const from = e.object.position.clone();
    if (flick > 260 && vy < 150) {
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const power = THREE.MathUtils.clamp(flick / 900, 0.4, 3.2) * this.throwScale;
      const side = THREE.MathUtils.clamp(vx / Math.max(200, Math.abs(vy)), -1, 1) * 0.5;
      const dir = fwd.clone().addScaledVector(right, side).normalize();
      const up = Math.min(e.glide ? 2.2 : 6, e.glide ? 0.35 + power * 0.25 : 0.8 + power * 0.9);
      const speed = Math.min(e.glide ? (e.kind === 'goldDisc' ? 17 : 14) : 12, (e.glide ? 2.2 : 1.6) * power);
      const vel = dir.multiplyScalar(speed).add(new THREE.Vector3(0, up, 0));
      this.toys.throw(e, from, vel);
      sound.sfx('throw', { volume: Math.min(1, power / 2) });
      // the most eager dog chases it
      const chaser = this.pickChaser();
      chaser?.brain.toyThrown(e);
      for (const d of this.dogs) if (d !== chaser) d.brain.excite = Math.min(1, d.brain.excite + 0.3);
    } else {
      this.toys.throw(e, from, new THREE.Vector3(0, 0, 0));
      if (e.kind === 'rope') this.focus.brain.startTug(e, () => this.ropeFarEnd(e));
    }
  }

  private dropHandToy() {
    const e = this.handToy;
    if (!e) return;
    this.handToy = null;
    this.toys.throw(e, e.object.position.clone(), new THREE.Vector3());
  }

  putAwayHandToy() {
    const e = this.handToy;
    if (!e) return;
    this.handToy = null;
    this.toys.remove(e);
  }

  private pickChaser(): PlayDog | null {
    let best: PlayDog | null = null, bs = -Infinity;
    for (const d of this.dogs) {
      const s = d.save.energy * 0.01 + d.save.playful + (d === this.focus ? 0.5 : 0) + Math.random() * 0.3;
      if (s > bs) { bs = s; best = d; }
    }
    return best;
  }

  private excite(n: number) {
    for (const d of this.dogs) d.brain.excite = Math.min(1, d.brain.excite + n);
  }

  // ---------------------------------------------------------------- whistle & voice

  whistle() {
    sound.sfx('whistle');
    const now = performance.now();
    this.whistles = this.whistles.filter((t) => now - t < 4000);
    this.whistles.push(now);
    for (const d of this.dogs) {
      if (this.mode === 'training' && this.whistles.length >= 3 && Math.random() < 0.5 && d === this.focus) {
        d.brain.performTrick('howl');
        this.showBulb(d, 'howl');
        this.whistles = [];
      } else d.brain.call();
    }
  }

  hear(raw: string) {
    const text = normalizeWords(raw);
    if (!text) return;
    this.game.overlay.heard(raw);
    if (this.interceptSpeech?.(text)) return;
    // teaching a trick word
    if (this.bulb) {
      this.teach(this.bulb.dog, this.bulb.trick, text);
      return;
    }
    // which dog? a name at the start of the phrase selects the dog
    let named: PlayDog | null = null, nameScore = 0, rest = text;
    for (const d of this.dogs) {
      const words = text.split(' ');
      for (let n = 1; n <= Math.min(3, words.length); n++) {
        const s = similarity(words.slice(0, n).join(' '), d.save.name);
        if (s > nameScore) { nameScore = s; named = d; rest = words.slice(n).join(' '); }
      }
      const whole = similarity(text, d.save.name);
      if (whole > nameScore) { nameScore = whole; named = d; rest = ''; }
    }
    if (named && nameScore > 0.62) {
      this.focus = named;
      this.onNameHeard?.(named);
      const knows = named.save.nameLearned;
      named.save.nameLearned = Math.min(1, knows + 0.08);
      if (!rest) {
        if (Math.random() < 0.25 + knows) {
          named.brain.call();
          this.game.ownerPoints(1);
        } else named.brain.confused();
        return;
      }
    }
    const target = named && nameScore > 0.62 ? named : this.focus;
    const phrase = rest || text;
    // tricks
    let best: TrickId | null = null, bs = 0;
    for (const [id, p] of Object.entries(target.save.tricks)) {
      if (!p || !p.learned) continue;
      const s = similarity(phrase, p.command);
      if (s > bs) { bs = s; best = id as TrickId; }
    }
    if (best && bs > 0.62) {
      const p = target.save.tricks[best]!;
      const chance = 0.55 + p.mastery * 0.4 + (target.save.mood - 50) / 400;
      if (Math.random() < chance) {
        target.brain.performTrick(best, () => {
          p.mastery = Math.min(1, p.mastery + 0.06);
          this.game.ownerPoints(2);
          this.game.persist();
        });
      } else {
        target.brain.confused();
      }
      return;
    }
    if (PRAISE.some((w) => similarity(phrase, w) > 0.8)) {
      target.save.mood = clamp(target.save.mood + 5);
      target.brain.excite = Math.min(1, target.brain.excite + 0.4);
      this.game.overlay.emote('heart', target.actor.headWorld(), 20);
      sound.dog('happy', this.game.voiceOf(target.save));
      return;
    }
    if (SCOLD.some((w) => similarity(phrase, w) > 0.85)) {
      target.actor.rig.earPerk = -1;
      target.brain.excite = 0;
      target.brain.sit();
      setTimeout(() => (target.actor.rig.earPerk = 0), 1500);
      return;
    }
    target.brain.confused();
  }

  // ---------------------------------------------------------------- training

  private onDogBark(d: PlayDog) {
    if (this.mode !== 'training' || this.bulb) return;
    if (d.brain.activity === 'trick') return;
    this.showBulb(d, 'speak');
  }

  private classifyGesture() {
    const g = this.gesture;
    if (!g || !g.dog) return;
    const d = g.dog;
    const posture = d.brain.posture;
    const p = g.path;
    const dur = (p[p.length - 1].t - g.startT) / 1000;
    // measure strokes relative to the screen so they're as easy on a phone as on a monitor
    const k = screenScale();
    const dx = (p[p.length - 1].x - p[0].x) / k;
    const dy = (p[p.length - 1].y - p[0].y) / k;
    const len = p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0) / k;
    const region = g.start?.region ?? null;
    const isTap = len < (this.lastPointer === 'mouse' ? 12 : 20) && dur < 0.4;
    const now = performance.now();
    let trick: TrickId | null = null;

    // circle around the head -> spin
    const headScreen = this.game.overlay.project(d.actor.headWorld());
    if (!trick && posture === 'stand' && headScreen && len > 250) {
      let ang = 0;
      for (let i = 1; i < p.length; i++) {
        const a0 = Math.atan2(p[i - 1].y - headScreen.y, p[i - 1].x - headScreen.x);
        const a1 = Math.atan2(p[i].y - headScreen.y, p[i].x - headScreen.x);
        let da = a1 - a0;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        ang += da;
      }
      if (Math.abs(ang) > Math.PI * 1.6) trick = 'spin';
    }
    if (!trick && isTap && region) {
      this.tapHistory = this.tapHistory.filter((t) => now - t.t < 700);
      this.tapHistory.push({ t: now, region });
      if (posture === 'sit' && region === 'frontPaw') trick = 'shake';
      else if (posture === 'down' && this.tapHistory.length >= 2 && ['side', 'back', 'belly', 'rump', 'chest'].includes(region)) trick = 'playdead';
    }
    if (!trick && !isTap) {
      const down = dy > 50 && dy > Math.abs(dx) * 0.8;
      const up = dy < -50 && -dy > Math.abs(dx) * 0.8;
      const sideways = Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.2;
      const speed = len / Math.max(0.05, dur);
      if (posture === 'stand') {
        if (down && region && region !== 'frontPaw' && region !== 'hindPaw' && region !== 'chin') trick = 'sit';
        else if (up && speed > 900) trick = 'jump';
        else if (up && (region === 'head' || region === 'muzzle' || region === 'chin' || region === 'ear' || region === 'neck')) trick = 'standup';
      } else if (posture === 'sit') {
        if (down && (region === 'head' || region === 'neck' || region === 'muzzle' || region === 'ear' || region === 'back')) trick = 'down';
        else if (up && (region === 'head' || region === 'muzzle' || region === 'chin' || region === 'neck' || region === 'ear')) trick = 'beg';
      } else if (posture === 'down') {
        if (sideways && region) trick = 'rollover';
      }
    }
    if (trick) {
      d.brain.trainHold(trick);
      this.showBulb(d, trick);
    } else if (!isTap && region) {
      d.brain.setPet({ point: g.start!.point, region, speed: 0.3, idle: 0 });
      setTimeout(() => d.brain.setPet(null), 200);
    }
  }

  showBulb(d: PlayDog, trick: TrickId) {
    this.clearBulb();
    sound.sfx('lightbulb');
    const img = h('div', { class: 'bulb', html: BULB_SVG, title: 'Say a command!', onclick: () => this.onBulbTap?.() });
    const remove = this.game.overlay.track(img, () => {
      const p = d.actor.headWorld();
      p.y += d.actor.model.design.dims.hs * 0.14;
      return p;
    });
    this.bulb = { dog: d, trick, until: performance.now() + 9000, remove };
    const prog = d.save.tricks[trick];
    const def = getTrick(trick)!;
    if (prog && prog.reps > 0) this.game.overlay.toast(`💡 Say “${prog.command}”!`);
    else this.game.overlay.toast(`💡 ${d.save.name} did something new! Say a word for “${def.name}”.`);
    this.onModeChange?.(this.mode);
  }

  clearBulb() {
    if (this.bulb) { this.bulb.remove(); this.bulb = null; this.onModeChange?.(this.mode); }
  }

  get bulbActive() { return !!this.bulb; }

  private teach(d: PlayDog, trick: TrickId, word: string) {
    const def = getTrick(trick)!;
    const s = d.save;
    let p = s.tricks[trick];
    if (!p) p = s.tricks[trick] = { command: '', reps: 0, learned: false, mastery: 0 };
    this.clearBulb();
    d.brain.endTrainHold();
    // settle back into the starting posture so the owner can repeat the lesson
    setTimeout(() => {
      const from = def.from === 'any' ? 'stand' : def.from;
      if (this.mode === 'training') d.brain.resetPosture(from);
    }, 1400);
    if (p.learned && similarity(word, p.command) > 0.62) {
      p.mastery = Math.min(1, p.mastery + 0.1);
      this.game.overlay.toast(`${s.name} already knows “${p.command}”. Good practice!`);
      this.game.overlay.emote('heart', d.actor.headWorld(), 20);
      this.game.persist();
      return;
    }
    if (p.reps === 0 || !p.command) {
      p.command = word;
      p.reps = 1;
    } else if (similarity(word, p.command) > 0.62) {
      p.reps++;
    } else {
      p.reps = Math.max(0, p.reps - 1);
      if (p.reps === 0) p.command = word, p.reps = 1;
      else {
        this.game.overlay.toast(`Hmm? ${s.name} looks confused. Last time you said “${p.command}”.`);
        d.brain.confused();
        this.game.persist();
        return;
      }
    }
    sound.dog('happy', this.game.voiceOf(s));
    this.game.overlay.emote('sparkle', d.actor.headWorld(), 30);
    if (p.reps >= def.reps) {
      p.learned = true;
      p.mastery = 0.3;
      s.trainerPoints += 10;
      this.game.ownerPoints(25);
      sound.sfx('learned');
      this.game.overlay.toast(`🎉 ${s.name} learned “${p.command}”! (${def.name})`, true);
      this.onTrickLearned?.(d, trick);
    } else {
      this.game.overlay.toast(`💡 “${p.command}” ${'●'.repeat(p.reps)}${'○'.repeat(def.reps - p.reps)}`);
    }
    this.game.persist();
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number) {
    const now = performance.now();
    if (this.bulb && now > this.bulb.until) {
      this.clearBulb();
      this.game.overlay.toast('The moment passed… try again!');
    }
    // petting idle time
    for (const d of this.dogs) {
      const p = d.brain.pet;
      if (p) p.idle += dt;
    }
    // rope follows the hand and the dog's mouth
    const e = this.handToy;
    if (e && e.kind === 'rope' && e.toy.setEnds) {
      const hand = e.object.position.clone();
      const dog = this.focus;
      if (dog.brain.tugging) {
        dog.actor.mouthWorld(this.tugPoint);
        this.world.worldToLocal(this.tugPoint);
        e.toy.setEnds(new THREE.Vector3(), this.tugPoint.clone().sub(hand));
        // pulling makes the dog pull back
        const d = dog.actor.distanceTo(hand);
        if (d > dog.actor.model.design.dims.noseTip[2] + 0.35 && Math.random() < dt * 2) sound.sfx('rope', { volume: 0.5 });
      } else {
        e.toy.setEnds(new THREE.Vector3(), new THREE.Vector3(0.3, -0.15, 0));
      }
    }
    // brush fluff relaxes over time
    for (const d of this.dogs) {
      const u = d.actor.model.uniforms;
      u.uFluff.value = Math.max(0, u.uFluff.value - dt * 0.02);
    }
  }
}

const BULB_SVG = `<svg viewBox="0 0 64 64"><defs><radialGradient id="bg" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#fffbe0"/><stop offset=".6" stop-color="#ffe066"/><stop offset="1" stop-color="#ffb800"/></radialGradient></defs><circle cx="32" cy="26" r="18" fill="url(#bg)" stroke="#e59a00" stroke-width="2.5"/><rect x="24" y="42" width="16" height="10" rx="3" fill="#b8c2cc" stroke="#7d8894" stroke-width="2"/><path d="M26 46h12M27 50h10" stroke="#7d8894" stroke-width="2"/><path d="M26 30c2-6 10-6 12 0" fill="none" stroke="#e59a00" stroke-width="2.5" stroke-linecap="round"/><path d="M32 2v5M10 10l4 4M54 10l-4 4M4 28h5M55 28h5" stroke="#ffd23f" stroke-width="3" stroke-linecap="round"/></svg>`;

export { TRICKS };
