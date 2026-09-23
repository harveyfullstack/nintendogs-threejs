import * as THREE from 'three';
import { DogActor } from '../dog/actor';
import { getBreed } from '../dog/breeds';
import { accessoryFit } from '../dog/fit';
import { Overlay } from '../ui/overlay';
import { loadIcons, loadProps, props } from '../world/loaders';
import type { Accessory } from '../world/types';
import { Engine, GameScene } from './engine';
import { sound } from './sound';
import { DogSave, SaveData, activeDog, simulateTime, writeSave } from './state';

// Global game context shared by every scene.

export type SceneFactory = (game: Game, args?: any) => GameScene | Promise<GameScene>;

export class Game {
  readonly engine: Engine;
  readonly overlay: Overlay;
  save!: SaveData;
  private actors = new Map<string, { actor: DogActor; key: string; accessory: Accessory | null }>();
  private scenes: Record<string, SceneFactory> = {};
  sceneName = '';
  busy = false;

  constructor(container: HTMLElement) {
    this.engine = new Engine(container);
    this.overlay = new Overlay();
    this.engine.onFrame = () => this.overlay.update();
    // real time keeps ticking while you play
    setInterval(() => {
      if (!this.save) return;
      simulateTime(this.save);
      writeSave(this.save);
    }, 20000);
    window.addEventListener('beforeunload', () => { if (this.save) writeSave(this.save, true); });
  }

  get renderer() { return this.engine.renderer; }
  get quality() { return this.save?.settings.quality ?? 1; }

  async preload() {
    await Promise.all([loadProps(), loadIcons()]);
  }

  register(name: string, f: SceneFactory) {
    this.scenes[name] = f;
  }

  async go(name: string, args?: any) {
    if (this.busy) return;
    this.busy = true;
    try {
      const f = this.scenes[name];
      if (!f) throw new Error('unknown scene ' + name);
      if (this.sceneName) await this.overlay.fadeOut();
      this.overlay.closeModals();
      this.overlay.resetLayer();
      // tear the old scene down first: dog actors are shared between scenes
      const old = this.engine.current;
      if (old) {
        old.exit?.();
        this.engine.current = null;
      }
      const scene = await f(this, args);
      await this.engine.setScene(scene);
      this.overlay.camera = scene.camera;
      this.sceneName = name;
      // let a frame render before revealing
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await this.overlay.fadeIn();
    } finally {
      this.busy = false;
    }
  }

  persist(immediate = false) {
    writeSave(this.save, immediate);
  }

  get dog(): DogSave | undefined {
    return activeDog(this.save);
  }

  /** Cached dog actors: generating a dog takes ~0.5 s so they're reused between scenes. */
  actorFor(d: DogSave): DogActor {
    const key = d.breedId + ':' + d.coatId + ':' + this.quality;
    let e = this.actors.get(d.id);
    if (!e || e.key !== key) {
      e?.actor.dispose();
      const breed = getBreed(d.breedId);
      const coat = breed.coats.find((c) => c.id === d.coatId) || breed.coats[0];
      const actor = new DogActor(breed, coat, this.quality);
      e = { actor, key, accessory: null };
      this.actors.set(d.id, e);
    }
    this.syncAccessory(d);
    return e.actor;
  }

  syncAccessory(d: DogSave) {
    const e = this.actors.get(d.id);
    if (!e) return;
    if ((e.accessory?.kind ?? null) === d.accessory) return;
    if (e.accessory) { e.accessory.object.removeFromParent(); e.accessory.dispose(); e.accessory = null; }
    if (d.accessory) {
      const acc = props().makeAccessory(d.accessory, accessoryFit(e.actor.model));
      e.actor.model.bones[acc.bone].add(acc.object);
      e.accessory = acc;
    }
  }

  dropActor(id: string) {
    const e = this.actors.get(id);
    if (e) { e.actor.dispose(); this.actors.delete(id); }
  }

  /** Reset transient actor state before placing it in a new scene. */
  resetActor(a: DogActor) {
    a.group.removeFromParent();
    a.stop();
    a.face(null);
    a.jump = null;
    a.drop();
    a.bounds = null;
    a.obstacles = [];
    a.floorY = 0;
    const rig = a.rig;
    rig.overlay = {};
    rig.rootRoll = 0;
    rig.rootLift = 0;
    rig.look = { point: null, weight: 0 };
    rig.eyesClosed = 0;
    rig.mouthOpen = 0;
    rig.tongueOut = 0;
    rig.happy = 0;
    rig.setPose('stand', 50);
    rig.cur.set(rig.target);
    a.model.uniforms.uWet.value = 0;
    a.model.uniforms.uSoap.value = 0;
  }

  earn(amount: number, reason?: string) {
    this.save.money += amount;
    sound.sfx('coin');
    if (reason) this.overlay.toast(`+$${amount} ${reason}`);
    this.persist();
  }

  spend(amount: number): boolean {
    if (this.save.money < amount) return false;
    this.save.money -= amount;
    this.persist();
    return true;
  }

  ownerPoints(n: number) {
    this.save.ownerPoints += n;
  }

  voiceOf(d: DogSave) {
    return getBreed(d.breedId).voice;
  }

  /** Update fur shader state (wetness, dirt) from the dog's stats. */
  applyCoatState(d: DogSave, a: DogActor) {
    a.model.uniforms.uDirt.value = THREE.MathUtils.clamp((60 - d.clean) / 60, 0, 1);
  }
}
