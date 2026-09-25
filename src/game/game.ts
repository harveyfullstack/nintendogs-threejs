import * as THREE from 'three';
import { DogActor } from '../dog/actor';
import { getBreed } from '../dog/breeds';
import { accessoryFit } from '../dog/fit';
import { touchUI } from '../ui/device';
import { h } from '../ui/dom';
import { describeError, reportError } from '../ui/errors';
import { Overlay } from '../ui/overlay';
import { meshSimplifierReady } from '../dog/meshData';
import { budget } from './quality';
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
  /** what the current scene was opened with (to rebuild it after a GPU reset) */
  private sceneArgs: any = undefined;
  busy = false;
  private lostTimer = 0;

  constructor(container: HTMLElement) {
    this.engine = new Engine(container);
    this.overlay = new Overlay();
    this.engine.onFrame = () => this.overlay.update();
    this.engine.onContextLost = () => this.contextLost();
    this.engine.onContextRestored = () => { void this.contextRestored(); };
    // real time keeps ticking while you play
    setInterval(() => {
      if (!this.save) return;
      simulateTime(this.save);
      writeSave(this.save);
    }, 20000);
    window.addEventListener('beforeunload', () => { if (this.save) writeSave(this.save, true); });
  }

  get renderer() { return this.engine.renderer; }
  /** Fur quality: the player's setting scaled to what the device can take. */
  get quality() { return (this.save?.settings.quality ?? 1) * budget().furQuality; }
  /** Detail for puppies you only look at (title, kennel). Generating a dog blocks the main
   * thread for a second or more on a phone, so those get a lighter mesh there. */
  get previewQuality() { return Math.min(1, this.quality, touchUI ? 0.8 : 1); }

  async preload() {
    // dogs are only built once the mesh simplifier is ready, so none miss their levels of detail
    await Promise.all([loadProps(), loadIcons(), meshSimplifierReady()]);
  }

  register(name: string, f: SceneFactory) {
    this.scenes[name] = f;
  }

  async go(name: string, args?: any) {
    if (this.busy) return;
    this.busy = true;
    let failure: unknown = null;
    try {
      const f = this.scenes[name];
      if (!f) throw new Error('unknown scene ' + name);
      if (this.sceneName) await this.overlay.fadeOut();
      this.overlay.closeModals();
      this.overlay.resetLayer();
      // tear the old scene down first: dog actors are shared between scenes
      const old = this.engine.current;
      if (old) this.engine.retire(old);
      const scene = await f(this, args);
      await this.engine.setScene(scene);
      this.overlay.camera = scene.camera;
      this.sceneName = name;
      this.sceneArgs = args;
      // let a frame render before revealing
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await this.overlay.fadeIn();
    } catch (e) {
      failure = e;
    } finally {
      this.busy = false;
    }
    if (failure) await this.sceneFailed(name, args, failure);
  }

  /** A scene couldn't load: never leave the player on a blank screen, offer a way on. */
  private async sceneFailed(name: string, args: any, e: unknown) {
    reportError(e, `couldn't open ${name}`);
    this.overlay.closeModals();
    await this.overlay.fadeIn();
    const fallback = name !== 'home' && this.save?.dogs.length ? 'home' : name !== 'title' ? 'title' : null;
    const m = this.overlay.modal(h('div', { class: 'panel', style: { width: 'min(440px, 92vw)', textAlign: 'center' } },
      h('h2', null, 'Oops!'),
      h('p', null, "That didn't load properly."),
      h('p', { style: { fontSize: '13px', color: '#7b8193' } }, describeError(e).slice(0, 160)),
      h('div', { class: 'actions', style: { justifyContent: 'center' } },
        fallback ? h('button', { class: 'btn', onclick: () => { m.close(); this.go(fallback); } }, fallback === 'home' ? 'Go home' : 'Title screen') : null,
        h('button', { class: 'btn primary', onclick: () => { m.close(); this.go(name, args); } }, 'Try again'))), { dismiss: false });
  }

  // ---- the GPU went away (the phone reclaimed its memory, a driver reset) --------

  private contextLost() {
    // Free everything now: while the context is lost those calls are silently ignored,
    // whereas after it's restored they'd target objects from the old context. The scene
    // and the dogs are rebuilt when it comes back.
    if (!this.busy) this.dropScene();
    for (const e of this.actors.values()) { try { e.actor.dispose(); } catch { /* already gone */ } }
    this.actors.clear();
    this.overlay.toast('Graphics are resetting…');
    // browsers usually hand the context straight back; if not, offer a reload
    clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => {
      if (!this.engine.contextLost) return;
      this.overlay.modal(h('div', { class: 'panel', style: { width: 'min(440px, 92vw)', textAlign: 'center' } },
        h('h2', null, 'Oops!'),
        h('p', null, 'The graphics stopped working. Reloading the page brings them back; your progress is saved.'),
        h('div', { class: 'actions', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', onclick: () => { this.persist(true); location.reload(); } }, 'Reload'))), { dismiss: false });
    }, 6000);
  }

  /** Everything on the GPU is gone: rebuild the scene (its textures' canvases were freed after upload). */
  private async contextRestored() {
    clearTimeout(this.lostTimer);
    this.overlay.closeModals();
    while (this.busy) await new Promise((r) => setTimeout(r, 100));
    const name = this.lostScene ?? (this.sceneName || 'title');
    const args = this.lostScene ? this.lostArgs : this.sceneArgs;
    this.lostScene = null;
    this.dropScene();
    // no fade-out: there's nothing valid to show until the scene is rebuilt
    this.sceneName = '';
    await this.go(name, args);
  }

  private lostScene: string | null = null;
  private lostArgs: any = undefined;
  /** Tear down the current scene, remembering it so it can be rebuilt. */
  private dropScene() {
    const old = this.engine.current;
    if (!old) return;
    if (this.sceneName) { this.lostScene = this.sceneName; this.lostArgs = this.sceneArgs; }
    try { this.engine.retire(old); } catch (e) { reportError(e, 'scene exit'); }
    this.engine.current = null;
  }

  persist(immediate = false) {
    writeSave(this.save, immediate);
  }

  get dog(): DogSave | undefined {
    return activeDog(this.save);
  }

  /**
   * Cached dog actors: generating a dog takes a second or so (in a worker, see
   * meshPool.ts), so they're reused between scenes.
   */
  async actorFor(d: DogSave): Promise<DogActor> {
    const key = d.breedId + ':' + d.coatId + ':' + this.quality;
    let e = this.actors.get(d.id);
    if (!e || e.key !== key) {
      let pending = this.building.get(d.id);
      if (!pending || pending.key !== key) {
        const breed = getBreed(d.breedId);
        const coat = breed.coats.find((c) => c.id === d.coatId) || breed.coats[0];
        pending = { key, actor: DogActor.create(breed, coat, this.quality) };
        this.building.set(d.id, pending);
      }
      let actor: DogActor;
      try {
        actor = await pending.actor;
      } finally {
        // (a failed build is forgotten, so trying again really tries again)
        if (this.building.get(d.id) === pending) this.building.delete(d.id);
      }
      e = this.actors.get(d.id);
      if (!e || e.key !== key) {
        e?.actor.dispose();
        e = { actor, key, accessory: null };
        this.actors.set(d.id, e);
      } else if (e.actor !== actor) actor.dispose();
    }
    this.syncAccessory(d);
    return e.actor;
  }
  private building = new Map<string, { key: string; actor: Promise<DogActor> }>();

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
