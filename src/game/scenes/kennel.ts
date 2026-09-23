import * as THREE from 'three';
import { DogActor, separateDogs } from '../../dog/actor';
import { Brain } from '../../dog/brain';
import { BREEDS, Breed, CoatDef } from '../../dog/breeds';
import { isCompact } from '../../ui/device';
import { clear, h } from '../../ui/dom';
import { loadKennel } from '../../world/loaders';
import { FollowCamera } from '../cameraRig';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { sound } from '../sound';
import { maxDogs, newDog } from '../state';

// The kennel: browse breeds, meet three puppies and take one home.

interface Pup { actor: DogActor; brain: Brain; breed: Breed; coat: CoatDef; sex: 'male' | 'female'; price: number }

export async function createKennel(game: Game, args?: { adopting?: boolean }): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 60);
  const k = await loadKennel(game.renderer);
  scene.add(k.group);
  scene.environment = k.environment ?? null;
  scene.background = k.background ?? new THREE.Color('#f3ead8');
  if (k.fog) scene.fog = k.fog;
  const cam = new FollowCamera(camera, k.camera);
  cam.follow = 0.35;
  cam.lateral = 0.25;
  const bounds = {
    minX: k.penCenter.x - k.penHalf.x, maxX: k.penCenter.x + k.penHalf.x,
    minZ: k.penCenter.z - k.penHalf.z, maxZ: k.penCenter.z + k.penHalf.z,
  };
  const front = new THREE.Vector3(k.penCenter.x, k.penCenter.y, bounds.maxZ - 0.25);
  const pups: Pup[] = [];
  let selected: Pup | null = null;
  let loadingBreed = false;
  const save = game.save;
  const canAdopt = save.dogs.length < Math.max(1, maxDogs(save));

  // ---------- UI ----------
  const layer = game.overlay.layer;
  const list = h('div', { class: 'panel kennel-list' });
  const info = h('div', { class: 'panel kennel-info', style: { display: 'none' } });
  const back = h('button', { class: 'btn corner-tr', onclick: () => game.go(save.dogs.length ? 'home' : 'title') }, save.dogs.length ? 'Back home' : 'Back');
  layer.append(list, info, back);

  // on phones the panels cover a big part of the screen: centre the pen in what's left
  const covered = { left: 0, bottom: 0 };
  const measure = () => {
    covered.left = covered.bottom = 0;
    if (!isCompact()) return;
    const r = list.getBoundingClientRect();
    if (r.width > window.innerWidth * 0.7) {
      // bottom sheet, with the puppy card above it
      const i = info.getBoundingClientRect();
      covered.bottom = window.innerHeight - (i.height ? Math.min(r.top, i.top) : r.top);
    } else {
      covered.left = r.right;
      const i = info.getBoundingClientRect();
      if (i.height) covered.bottom = window.innerHeight - i.top;
    }
  };
  const ro = new ResizeObserver(measure);
  ro.observe(list);
  ro.observe(info);

  let listScroll = 0;
  const renderList = (active?: string) => {
    listScroll = list.querySelector('.kennel-breeds')?.scrollTop ?? listScroll;
    clear(list);
    list.append(h('h2', null, 'Kennel'),
      h('p', { class: 'intro' }, canAdopt
        ? `Choose a breed to meet its puppies. You have $${save.money.toLocaleString()}.`
        : `You can't take another dog home yet. Earn more Owner Points! (${save.dogs.length}/${maxDogs(save)} dogs)`));
    const wrap = h('div', { class: 'kennel-breeds' });
    for (const b of BREEDS) {
      const row = h('div', { class: 'card' + (b.id === active ? ' selected' : ''), onclick: () => showBreed(b) },
        h('div', { class: 'name' }, b.name),
        h('div', { class: 'meta' }, `${b.size} · from $${b.price}`),
        h('div', { class: 'blurb' }, b.blurb));
      wrap.append(row);
    }
    list.append(wrap);
    wrap.scrollTop = listScroll;
  };

  const showInfo = (p: Pup | null) => {
    selected = p;
    clear(info);
    if (!p) { info.style.display = 'none'; return; }
    info.style.display = '';
    const afford = save.money >= p.price;
    info.append(
      h('h2', null, p.breed.name),
      h('p', null, `${p.coat.name} · `, h('b', { style: { color: p.sex === 'male' ? '#3d8fe0' : '#f0609a' } }, p.sex === 'male' ? '♂ Male' : '♀ Female')),
      h('p', { class: 'price' }, `$${p.price}`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', disabled: !canAdopt || !afford ? true : undefined, onclick: () => adopt(p) }, afford ? 'Take me home!' : 'Not enough money')),
    );
  };

  // ---------- puppies ----------
  const clearPups = () => {
    for (const p of pups) { p.actor.group.removeFromParent(); p.actor.dispose(); }
    pups.length = 0;
    showInfo(null);
  };

  const showBreed = async (b: Breed) => {
    if (loadingBreed) return;
    loadingBreed = true;
    sound.sfx('select');
    renderList(b.id);
    clearPups();
    game.overlay.toast(`Meet the ${b.name} puppies!`);
    await new Promise((r) => setTimeout(r, 30));
    const coats = [...b.coats];
    while (coats.length < 3) coats.push(b.coats[Math.floor(Math.random() * b.coats.length)]);
    for (let i = 0; i < 3; i++) {
      const coat = coats[i];
      const actor = new DogActor(b, coat, Math.min(1, game.quality));
      actor.bounds = bounds;
      actor.floorY = k.penCenter.y;
      const x = k.penCenter.x + (i - 1) * Math.min(0.6, k.penHalf.x * 0.6);
      actor.place(x, k.penCenter.z + (Math.random() - 0.5) * 0.3, Math.PI * (Math.random() - 0.5) + Math.atan2(camera.position.x - x, camera.position.z - k.penCenter.z));
      scene.add(actor.group);
      const d = newDog('pup', b.id, coat.id, Math.random() < 0.5 ? 'male' : 'female');
      d.energy = 90;
      const brain = new Brain(actor, d, {
        roam: true,
        playerSpot: () => front,
        cameraPos: () => camera.position,
        toys: () => [],
        sound: (_a, kind) => sound.dog(kind, b.voice, { volume: 0.6 }),
        emote: (a, kind) => game.overlay.emote(kind, a.headWorld().add(new THREE.Vector3(0, 0.08, 0)), 20),
      });
      brain.homeSpot = k.penCenter.clone();
      const price = Math.round(b.price * (0.9 + i * 0.07) / 10) * 10;
      pups.push({ actor, brain, breed: b, coat, sex: d.sex, price });
      await new Promise((r) => setTimeout(r, 0));
    }
    loadingBreed = false;
  };

  const adopt = (p: Pup) => {
    const input = h('input', { class: 'textfield', placeholder: 'Puppy name', maxlength: 12, autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', spellcheck: 'false' }) as HTMLInputElement;
    const confirmName = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      if (!game.spend(p.price)) return;
      const d = newDog(name, p.breed.id, p.coat.id, p.sex);
      save.dogs.push(d);
      save.activeDog = d.id;
      game.persist(true);
      m.close();
      sound.sfx('learned');
      game.overlay.toast(`${name} is coming home with you!`, true);
      setTimeout(() => game.go('home'), 1200);
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') confirmName(); });
    const m = game.overlay.modal(h('div', { class: 'panel', style: { width: 'min(460px, 92vw)', textAlign: 'center' } },
      h('h2', null, 'Name your puppy'),
      h('p', null, `Pick a name that's easy to say out loud. You'll call your ${p.breed.name} with it!`),
      input,
      h('div', { class: 'actions', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: confirmName }, `Adopt for $${p.price}`))));
    setTimeout(() => input.focus(), 50);
  };

  // clicking a puppy calls it to the front
  const ray = new THREE.Raycaster();
  const onDown = (e: PointerEvent) => {
    const r = game.renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    let best: Pup | null = null, bd = Infinity;
    for (const p of pups) {
      const hit = p.actor.raycast(ray.ray);
      if (hit && hit.distance < bd) { bd = hit.distance; best = p; }
    }
    if (best) {
      sound.sfx('select');
      best.brain.call();
      showInfo(best);
      for (const p of pups) if (p !== best) p.brain.excite = 0.3;
    }
  };
  game.renderer.domElement.addEventListener('pointerdown', onDown);

  renderList();
  sound.music('kennel');
  if (args?.adopting) setTimeout(() => showBreed(BREEDS[0]), 300);

  return {
    scene,
    camera,
    viewInset: () => covered,
    update(dt, t) {
      for (const p of pups) {
        p.brain.update(dt);
        p.actor.update(dt);
        p.actor.model.uniforms.uGravity.value.set(0, -p.actor.model.gravity, 0);
      }
      separateDogs(pups.map((p) => p.actor));
      const focus = selected ? selected.actor.headWorld() : k.penCenter.clone().setY(k.penCenter.y + 0.15);
      cam.update(dt, focus);
      k.update?.(dt, t, focus);
    },
    exit() {
      ro.disconnect();
      game.renderer.domElement.removeEventListener('pointerdown', onDown);
      clearPups();
      k.dispose();
    },
  };
}
