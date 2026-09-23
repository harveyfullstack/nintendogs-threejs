import * as THREE from 'three';
import { Brain, BrainEnv } from '../../dog/brain';
import { DogActor, separateDogs } from '../../dog/actor';
import { h, iconBtn } from '../../ui/dom';
import { SayBox, StatusCard, renderPortrait } from '../../ui/hud';
import { goOutMenu, settingsPanel, statusPanel, suppliesDrawer } from '../../ui/menus';
import { loadRoom, props } from '../../world/loaders';
import type { Bowl, Room } from '../../world/types';
import { FollowCamera } from '../cameraRig';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import type { ItemDef } from '../items';
import { PlayController, PlayDog } from '../play';
import { sound } from '../sound';
import { clamp } from '../state';
import { similarity } from '../tricks';
import { ToyWorld, holdToy } from '../toyPhysics';

export async function createHome(game: Game): Promise<GameScene> {
  const s = new HomeScene(game);
  await s.init();
  return s;
}

class HomeScene implements GameScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.02, 60);
  room!: Room;
  dogs: PlayDog[] = [];
  toys!: ToyWorld;
  play!: PlayController;
  cam!: FollowCamera;
  foodBowl!: Bowl;
  waterBowl!: Bowl;
  card!: StatusCard;
  say!: SayBox;
  private hudTimer = 0;
  private trainBtn!: HTMLButtonElement;
  private banner!: HTMLElement;
  private offs: (() => void)[] = [];
  private nameLesson = 0;
  private portraitDone = false;
  private portraitFor: PlayDog | null = null;

  constructor(readonly game: Game) {}

  get save() { return this.game.save; }

  async init() {
    const game = this.game;
    const room = (this.room = await loadRoom(this.save.roomTheme, game.renderer));
    this.scene.add(room.group);
    if (room.environment) this.scene.environment = room.environment;
    this.scene.background = room.background ?? new THREE.Color('#e9dcc6');
    if (room.fog) this.scene.fog = room.fog;
    this.cam = new FollowCamera(this.camera, room.camera);

    // bowls
    const P = props();
    this.foodBowl = P.makeFoodBowl();
    this.waterBowl = P.makeWaterBowl();
    this.foodBowl.object.position.copy(room.spots.food);
    this.waterBowl.object.position.copy(room.spots.water);
    this.scene.add(this.foodBowl.object, this.waterBowl.object);
    this.foodBowl.setFill(this.save.bowls.food);
    if (this.save.bowls.foodKind) this.foodBowl.setFood?.(this.save.bowls.foodKind);
    this.waterBowl.setFill(this.save.bowls.water);

    this.toys = new ToyWorld(this.scene, room.bounds, room.obstacles);
    this.toys.onBounce = (_t, impact) => sound.sfx('bounce', { volume: Math.min(1, impact / 3) });

    // dogs
    const bowlObstacles = [
      { x: room.spots.food.x, z: room.spots.food.z, r: this.foodBowl.radius },
      { x: room.spots.water.x, z: room.spots.water.z, r: this.waterBowl.radius },
    ];
    const list = this.save.dogs;
    list.forEach((d, i) => {
      const actor = game.actorFor(d);
      game.resetActor(actor);
      actor.bounds = room.bounds;
      actor.obstacles = [...room.obstacles, ...bowlObstacles];
      const spot = this.cam.playerSpot();
      actor.place(spot.x + (i - (list.length - 1) / 2) * 0.45, spot.z - 0.9 - i * 0.2, Math.atan2(this.camera.position.x - spot.x, this.camera.position.z - spot.z + 0.9));
      this.scene.add(actor.group);
      game.applyCoatState(d, actor);
      const brain = new Brain(actor, d, this.brainEnv(i, list.length));
      brain.homeSpot = new THREE.Vector3((room.bounds.minX + room.bounds.maxX) / 2, 0, (room.bounds.minZ + room.bounds.maxZ) / 2).lerp(spot, 0.35);
      this.dogs.push({ save: d, actor, brain });
    });
    const active = this.dogs.find((d) => d.save.id === this.save.activeDog) ?? this.dogs[0];

    this.play = new PlayController(game, this.camera, this.dogs, this.toys, this.scene);
    if (active) this.play.focus = active;
    this.play.onModeChange = (m) => this.onMode(m);
    this.play.onTrickLearned = () => this.card.refresh(this.focusSave());
    this.play.interceptSpeech = (t) => this.nameLessonHear(t);
    this.offs.push(this.cam.attachWheel(game.renderer.domElement));

    this.buildHud();
    // greet
    for (const d of this.dogs) {
      d.brain.excite = 0.8;
      setTimeout(() => d.brain.call(), 400 + Math.random() * 300);
    }
    this.cam.update(0, active ? active.actor.headWorld() : null, true);
    if (active && active.save.nameLearned < 0.5 && active.save.walks === 0 && Object.keys(active.save.tricks).length === 0) {
      setTimeout(() => this.startNameLesson(active), 1600);
    }
    this.needsHints();
  }

  private focusSave() {
    return this.play?.focus?.save ?? this.game.dog;
  }

  private brainEnv(index = 0, count = 1): BrainEnv {
    const game = this.game;
    const room = this.room;
    return {
      roam: true,
      // each dog gets its own place in front of you
      playerSpot: () => {
        const p = this.cam.playerSpot();
        if (count < 2) return p;
        const fwd = this.cam.base.target.clone().sub(this.cam.base.position).setY(0).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        return p.addScaledVector(right, (index - (count - 1) / 2) * 0.4).addScaledVector(fwd, Math.abs(index - (count - 1) / 2) * 0.12);
      },
      cameraPos: () => this.camera.position,
      bed: room.spots.bed,
      foodBowl: {
        pos: room.spots.food, rim: this.foodBowl.rimHeight,
        fill: () => this.save.bowls.food,
        eat: (a) => { this.save.bowls.food = Math.max(0, this.save.bowls.food - a); this.foodBowl.setFill(this.save.bowls.food); },
      },
      waterBowl: {
        pos: room.spots.water, rim: this.waterBowl.rimHeight,
        fill: () => this.save.bowls.water,
        drink: (a) => { this.save.bowls.water = Math.max(0, this.save.bowls.water - a); this.waterBowl.setFill(this.save.bowls.water); },
      },
      toys: () => this.toys.list,
      sound: (actor, kind) => {
        const d = this.saveFor(actor);
        if (d) sound.dog(kind, game.voiceOf(d));
      },
      emote: (actor, kind) => {
        const p = actor.headWorld();
        p.y += actor.model.design.dims.hs * 0.1;
        game.overlay.emote(kind, p, 26);
      },
      pickUpToy: (toy, actor) => {
        toy.carrier = actor;
        toy.resting = false;
        toy.velocity.set(0, 0, 0);
        holdToy(actor, toy);
        if (toy.squeaky) sound.sfx('squeak');
      },
      releaseToy: (toy, actor) => {
        const at = actor.mouthWorld();
        actor.drop();
        this.toys.dropAt(toy as any, at);
      },
      event: (name) => {
        const d = this.focusSave();
        if (name === 'ate' || name === 'drank') { game.ownerPoints(3); game.persist(); }
        if (name === 'fetched' && d) { d.mood = clamp(d.mood + 4); d.affection = clamp(d.affection + 0.5); game.ownerPoints(2); }
        if (name === 'squeak') sound.sfx('squeak');
      },
    };
  }

  private saveFor(actor: DogActor) {
    return this.dogs.find((d) => d.actor === actor)?.save;
  }

  // ------------------------------------------------------------------ HUD

  private buildHud() {
    const game = this.game;
    const layer = game.overlay.layer;
    this.card = new StatusCard(game);
    this.card.refresh(this.focusSave());
    this.say = new SayBox((t) => this.play.hear(t));
    this.trainBtn = iconBtn('bulb', 'Training', () => { sound.sfx('click'); this.play.setMode('training'); });
    const left = h('div', { class: 'hud-left' },
      this.trainBtn,
      iconBtn('whistle', 'Whistle', () => this.play.whistle(), 'green'),
      iconBtn('hand', 'Brush', () => {
        if (!(this.save.inventory.brush > 0)) { game.overlay.toast('You need a brush!'); return; }
        sound.sfx('click'); this.play.setMode('brush');
      }, 'pink'),
    );
    const bottom = h('div', { class: 'hud-bottom' },
      iconBtn('bag', 'Supplies', () => suppliesDrawer(game, (it) => this.useItem(it)), 'orange'),
      iconBtn('door', 'Go Out', () => this.goOut(), 'green'),
      iconBtn('camera', 'Photo', () => this.photo()),
      iconBtn('paw', 'Status', () => statusPanel(game, (d) => { this.save.activeDog = d.id; this.play.focus = this.dogs.find((x) => x.save === d) ?? this.play.focus; this.portraitDone = false; this.card.refresh(d); game.persist(); }), 'pink'),
      iconBtn('gear', 'Settings', () => settingsPanel(game, () => sound.setVolumes(this.save.settings.music, this.save.settings.sfx))),
    );
    this.banner = h('div', { class: 'mode-banner' });
    layer.append(this.card.el, left, bottom, this.say.el, this.banner);
    sound.music('home');
  }

  private onMode(m: string) {
    this.trainBtn.classList.toggle('active', m === 'training');
    const bulb = this.play.bulbActive;
    this.say.blink(bulb);
    if (m === 'training') {
      this.banner.textContent = bulb ? '💡 Say a command now!' : 'Training — guide your pup into a pose (tap 💡 again to stop)';
      this.banner.classList.add('show');
    } else if (m === 'brush') {
      this.banner.textContent = 'Brushing — stroke your pup (tap Brush again to stop)';
      this.banner.classList.add('show');
    } else this.banner.classList.remove('show');
  }

  // ------------------------------------------------------------------ items

  private useItem(it: ItemDef) {
    const game = this.game;
    const inv = this.save.inventory;
    const dog = this.play.focus;
    const consume = () => { if (it.consumable) inv[it.id] = Math.max(0, (inv[it.id] ?? 0) - 1); game.persist(); };
    switch (it.category) {
      case 'food':
      case 'drink': {
        if (it.id === 'waterBottle') {
          this.save.bowls.water = 1;
          this.waterBowl.setFill(1);
          sound.sfx('splash');
          for (const d of this.dogs) d.brain.bowlFilled(true);
          game.ownerPoints(1);
          game.persist();
          return;
        }
        if (it.id === 'jerky') {
          consume();
          dog.brain.call();
          setTimeout(() => {
            sound.dog('crunch', game.voiceOf(dog.save));
            dog.save.hunger = clamp(dog.save.hunger + (it.nourish ?? 0));
            dog.save.mood = clamp(dog.save.mood + (it.treat ?? 0));
            dog.save.affection = clamp(dog.save.affection + 1);
            game.overlay.emote('heart', dog.actor.headWorld(), 20);
            dog.actor.rig.mouthOpen = 1;
            setTimeout(() => (dog.actor.rig.mouthOpen = 0), 400);
            this.card.refresh(dog.save);
          }, 1800);
          game.overlay.toast(`${dog.save.name} gobbles up the treat!`);
          return;
        }
        if (this.save.bowls.food > 0.3) { game.overlay.toast('The bowl still has food in it.'); return; }
        consume();
        this.save.bowls.food = 1;
        this.save.bowls.foodKind = it.food ?? 'dry';
        this.foodBowl.setFood?.(it.food ?? 'dry');
        this.foodBowl.setFill(1);
        sound.sfx('eat');
        for (const d of this.dogs) {
          d.brain.bowlFilled(false);
          if (it.treat) d.save.mood = clamp(d.save.mood + it.treat * 0.5);
        }
        game.ownerPoints(2);
        game.persist();
        return;
      }
      case 'toy':
        if (it.prop?.toy) this.play.holdToy(it.prop.toy);
        return;
      case 'care':
        if (it.id === 'brush') this.play.setMode('brush');
        else if (it.id === 'shampoo') {
          if ((inv.shampoo ?? 0) <= 0) { game.overlay.toast('You are out of shampoo.'); return; }
          game.go('bath', { dogId: dog.save.id });
        }
        return;
      case 'accessory': {
        const acc = it.prop?.accessory ?? null;
        dog.save.accessory = dog.save.accessory === acc ? null : acc;
        game.syncAccessory(dog.save);
        game.overlay.toast(dog.save.accessory ? `${dog.save.name} looks great!` : 'Accessory removed.');
        sound.sfx('pop');
        game.persist();
        return;
      }
    }
  }

  private goOut() {
    const game = this.game;
    goOutMenu(game, (id) => {
      const d = this.focusSave();
      if (id === 'walk') {
        if (d && d.energy < 20) { game.overlay.toast(`${d.name} is too tired for a walk. Let it rest!`); return; }
        game.go('walkmap');
      } else if (id === 'shop') game.go('shop', { kind: 'pet' });
      else if (id === 'secondhand') game.go('shop', { kind: 'secondhand' });
      else if (id === 'kennel') game.go('kennel', { adopting: false });
      else if (id === 'gym') game.go('gym');
    });
  }

  private photo() {
    const game = this.game;
    sound.sfx('camera');
    const flash = h('div', { style: { position: 'absolute', inset: '0', background: '#fff', opacity: '0.9', transition: 'opacity .5s', pointerEvents: 'none' } });
    game.overlay.root.append(flash);
    requestAnimationFrame(() => (flash.style.opacity = '0'));
    setTimeout(() => flash.remove(), 600);
    const src = game.renderer.domElement;
    const w = 640, hgt = Math.round((src.height / src.width) * w);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hgt;
    cv.getContext('2d')!.drawImage(src, 0, 0, w, hgt);
    const url = cv.toDataURL('image/jpeg', 0.82);
    const d = this.focusSave();
    this.save.photos.push({ id: Math.random().toString(36).slice(2), dataUrl: url, date: Date.now(), dogName: d?.name ?? '' });
    if (this.save.photos.length > 12) this.save.photos.shift();
    game.persist();
    game.overlay.toast('📸 Saved to your album!');
  }

  // ------------------------------------------------------------------ name lesson

  private startNameLesson(d: PlayDog) {
    this.nameLesson = 1;
    const game = this.game;
    const body = h('div', { class: 'panel', style: { width: 'min(520px, 92vw)', textAlign: 'center' } },
      h('h2', null, `Welcome home, ${d.save.name}!`),
      h('p', null, `Your puppy doesn't know its name yet. Say “${d.save.name}” out loud (hold 🎤 or the Space bar), or type it and press Enter, a few times until it learns it.`),
      h('div', { class: 'actions', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: () => m.close() }, 'OK!')));
    const m = game.overlay.modal(body);
  }

  private nameLessonHear(text: string): boolean {
    if (!this.nameLesson) return false;
    const d = this.play.focus;
    if (similarity(text, d.save.name) > 0.62) {
      this.nameLesson++;
      d.save.nameLearned = Math.min(1, d.save.nameLearned + 0.34);
      d.brain.call();
      d.actor.rig.headTilt = this.nameLesson % 2 ? 0.3 : -0.3;
      setTimeout(() => (d.actor.rig.headTilt = 0), 1200);
      const n = Math.min(3, this.nameLesson - 1);
      if (n >= 3) {
        this.nameLesson = 0;
        this.game.overlay.toast(`🎉 ${d.save.name} knows its name!`, true);
        sound.sfx('learned');
        this.game.ownerPoints(20);
        setTimeout(() => this.game.overlay.toast('Try petting, or pick a toy from Supplies!'), 3200);
      } else {
        this.game.overlay.toast(`${d.save.name}? ${'●'.repeat(n)}${'○'.repeat(3 - n)}`);
      }
      this.game.persist();
    } else {
      this.game.overlay.toast(`Say “${d.save.name}”!`);
    }
    return true;
  }

  private needsHints() {
    const d = this.focusSave();
    if (!d) return;
    const hints: string[] = [];
    if (d.hunger < 35) hints.push(`${d.name} looks hungry.`);
    if (d.thirst < 35) hints.push(`${d.name} is thirsty.`);
    if (d.clean < 30) hints.push(`${d.name} could use a bath.`);
    if (hints.length) setTimeout(() => this.game.overlay.toast(hints.join(' ')), 2500);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, t: number) {
    for (const d of this.dogs) {
      d.brain.update(dt);
      d.actor.update(dt);
      d.actor.model.uniforms.uTime.value = t;
      d.actor.model.uniforms.uGravity.value.set(0, -d.actor.model.gravity, 0);
    }
    if (this.dogs.length > 1) separateDogs(this.dogs.map((d) => d.actor));
    this.toys.update(dt);
    this.play.update(dt);
    this.foodBowl.update?.(dt, t);
    this.waterBowl.update?.(dt, t);
    const f = this.play.focus;
    const focus = f ? f.actor.headWorld().lerp(f.actor.position, 0.3) : null;
    this.cam.update(dt, focus);
    this.room.update?.(dt, t, f ? f.actor.position : this.room.camera.target);
    this.hudTimer -= dt;
    if (this.hudTimer < 0) {
      this.hudTimer = 0.5;
      this.card.refresh(this.focusSave());
    }
    if (f && f !== this.portraitFor) {
      // calling another dog by name switches whose card is shown
      this.portraitFor = f;
      this.portraitDone = false;
      this.card.refresh(f.save);
    }
    if (!this.portraitDone && t > 0 && f && f.brain.activity !== 'none') {
      this.portraitDone = true;
      requestAnimationFrame(() => this.card.setPortrait(renderPortrait(this.game.renderer, this.scene, f.actor)));
    }
  }

  exit() {
    this.play.dispose();
    this.say.dispose();
    for (const o of this.offs) o();
    for (const d of this.dogs) {
      d.actor.drop();
      d.actor.group.removeFromParent();
    }
    this.foodBowl.dispose();
    this.waterBowl.dispose();
    for (const t of [...this.toys.list]) this.toys.remove(t);
    this.room.dispose();
    this.game.persist();
  }
}
