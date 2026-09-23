import * as THREE from 'three';
import { Brain } from '../../dog/brain';
import { ITEMS } from '../../game/items';
import { h, iconBtn } from '../../ui/dom';
import { SayBox, StatusCard, renderPortrait } from '../../ui/hud';
import { itemVisual } from '../../ui/menus';
import { loadPark } from '../../world/loaders';
import { FollowCamera } from '../cameraRig';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { PlayController, PlayDog } from '../play';
import { sound } from '../sound';
import { clamp } from '../state';
import { ToyWorld, holdToy } from '../toyPhysics';

// The park: off-leash fun with balls and discs on a big lawn.

export async function createPark(game: Game): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.03, 2000);
  const park = await loadPark(game.renderer);
  scene.add(park.group);
  scene.environment = park.environment ?? null;
  scene.background = park.background ?? new THREE.Color('#a9d7f5');
  if (park.fog) scene.fog = park.fog;
  const cam = new FollowCamera(camera, park.camera);
  cam.lateral = 0.7;
  cam.follow = 0.9;

  const d = game.dog!;
  const actor = game.actorFor(d);
  game.resetActor(actor);
  actor.bounds = park.bounds;
  actor.obstacles = park.obstacles;
  const spot = cam.playerSpot(0, 1.2);
  actor.place(spot.x, spot.z - 1.2, Math.atan2(camera.position.x - spot.x, camera.position.z - spot.z));
  scene.add(actor.group);
  game.applyCoatState(d, actor);

  const toys = new ToyWorld(scene, park.bounds, park.obstacles);
  toys.onBounce = (_t, impact) => sound.sfx('bounce', { volume: Math.min(1, impact / 3), surface: 'grass' });
  const brain = new Brain(actor, d, {
    roam: true,
    playerSpot: () => cam.playerSpot(0, 1.0),
    cameraPos: () => camera.position,
    toys: () => toys.list,
    sound: (_a, kind) => sound.dog(kind, game.voiceOf(d)),
    emote: (a, kind) => game.overlay.emote(kind, a.headWorld().add(new THREE.Vector3(0, 0.1, 0)), 24),
    pickUpToy: (toy, a) => { toy.carrier = a; toy.resting = false; holdToy(a, toy); },
    releaseToy: (toy, a) => { const at = a.mouthWorld(); a.drop(); toys.dropAt(toy as any, at); },
    event: (name) => {
      if (name === 'fetched') { d.mood = clamp(d.mood + 5); d.affection = clamp(d.affection + 0.6); game.ownerPoints(3); sound.dog('happy', game.voiceOf(d)); }
    },
  });
  brain.homeSpot = spot.clone();
  const pd: PlayDog = { save: d, actor, brain };
  const play = new PlayController(game, camera, [pd], toys, scene);
  play.throwScale = 2.6;
  const offZoom = cam.attachZoom(game.renderer.domElement);

  // HUD
  const card = new StatusCard(game);
  card.refresh(d);
  const say = new SayBox((t) => play.hear(t), { notify: (t) => game.overlay.toast(t) });
  play.onBulbTap = () => say.activate();
  // the toys scroll sideways on small screens; Go Home stays put
  const toyStrip = h('div', { class: 'hud-scroll' });
  for (const it of ITEMS.filter((i) => i.category === 'toy' && (game.save.inventory[i.id] ?? 0) > 0)) {
    toyStrip.append(h('button', { class: 'icon-btn white toy-btn', title: it.name, 'aria-label': it.name, onclick: () => { sound.sfx('click'); play.holdToy(it.prop!.toy!); } }, itemVisual(game, it.id)));
  }
  const toyBar = h('div', { class: 'hud-bottom' }, toyStrip, iconBtn('home', 'Go Home', () => game.go('home'), 'green'));
  const left = h('div', { class: 'hud-left' }, iconBtn('whistle', 'Whistle', () => play.whistle(), 'green'));
  game.overlay.layer.append(card.el, toyBar, say.el, left);
  game.overlay.toast(`Welcome to the park! Throw a toy for ${d.name}.`);
  sound.music('park');
  brain.call();

  let hudT = 0;
  const lookAt = actor.headWorld();
  camera.position.copy(actor.position).add(new THREE.Vector3(0, 1.05, 2.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), actor.heading));
  camera.lookAt(lookAt);
  cam.base.position.copy(camera.position);
  setTimeout(() => card.setPortrait(renderPortrait(game.renderer, scene, actor)), 1500);
  return {
    scene,
    camera,
    update(dt, t) {
      brain.update(dt);
      actor.update(dt);
      actor.model.uniforms.uGravity.value.set(0, -actor.model.gravity, 0);
      toys.update(dt);
      play.update(dt);
      // chase camera: stay a couple of metres from the pup at owner eye level
      const focus = actor.headWorld().lerp(actor.position, 0.35);
      const away = camera.position.clone().sub(focus).setY(0);
      if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
      const dist = THREE.MathUtils.clamp(away.length(), 2.0, 3.4) * cam.zoom;
      const want = focus.clone().addScaledVector(away.normalize(), dist).setY(0.75 + (cam.zoom - 1) * 0.5);
      camera.position.lerp(want, 1 - Math.exp(-dt * 2.5));
      lookAt.lerp(focus.clone().add(new THREE.Vector3(0, 0.12, 0)), 1 - Math.exp(-dt * 5));
      camera.lookAt(lookAt);
      cam.base.position.copy(camera.position);
      cam.base.target.copy(focus);
      park.update?.(dt, t, actor.position);
      hudT -= dt;
      if (hudT < 0) { hudT = 0.5; card.refresh(d); }
    },
    exit() {
      play.dispose();
      say.dispose();
      offZoom();
      actor.drop();
      actor.group.removeFromParent();
      for (const t of [...toys.list]) toys.remove(t);
      park.dispose();
      game.persist();
    },
  };
}
