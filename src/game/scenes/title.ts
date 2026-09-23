import * as THREE from 'three';
import { DogActor, separateDogs } from '../../dog/actor';
import { Brain } from '../../dog/brain';
import { getBreed } from '../../dog/breeds';
import { h } from '../../ui/dom';
import { loadRoom } from '../../world/loaders';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { sound } from '../sound';
import { newDog, newSave } from '../state';

// Title: puppies playing in the living room behind the logo.

export async function createTitle(game: Game): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 60);
  const room = await loadRoom('default', game.renderer);
  scene.add(room.group);
  scene.environment = room.environment ?? null;
  scene.background = room.background ?? new THREE.Color('#e9dcc6');

  const pups: { actor: DogActor; brain: Brain }[] = [];
  const picks: [string, number][] = [['labrador', 0], ['shiba', 0], ['beagle', 0]];
  const center = room.camera.target.clone().setY(0);
  const fake = newDog('Pup', 'labrador', 'yellow', 'male');
  for (const [i, [id, ci]] of picks.entries()) {
    const breed = getBreed(id);
    const actor = new DogActor(breed, breed.coats[ci], Math.min(1, game.quality));
    actor.bounds = room.bounds;
    actor.obstacles = room.obstacles;
    actor.place(center.x + (i - 1) * 0.6, center.z + (i === 1 ? 0.3 : 0), Math.PI + (i - 1) * 0.5);
    scene.add(actor.group);
    const save = { ...fake, energy: 100, playful: 0.8 };
    const brain = new Brain(actor, save, {
      roam: true,
      playerSpot: () => center,
      cameraPos: () => camera.position,
      toys: () => [],
      sound: () => {},
      emote: () => {},
    });
    brain.homeSpot = center;
    pups.push({ actor, brain });
  }

  const ui = h('div', { class: 'title-screen' });
  const logo = h('div', { class: 'logo' }, 'nintendo', h('span', { class: 'dogs' }, 'gs'), h('small', null, 'THREE.JS EDITION'));
  const press = h('div', { class: 'press' }, 'Click to start');
  ui.append(logo, press);
  game.overlay.layer.append(ui);

  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    await sound.init();
    sound.sfx('select');
    press.remove();
    showMenu();
  };
  ui.addEventListener('pointerdown', start);
  game.renderer.domElement.addEventListener('pointerdown', start, { once: true });

  const showMenu = () => {
    const s = game.save;
    const buttons = h('div', { style: { display: 'flex', gap: '14px' } });
    if (s.dogs.length) {
      buttons.append(h('button', { class: 'btn primary', style: { fontSize: '22px', padding: '14px 34px' }, onclick: () => { sound.sfx('select'); game.go('home'); } }, `Continue`));
    }
    buttons.append(h('button', { class: 'btn', style: { fontSize: '22px', padding: '14px 34px' }, onclick: () => newGame() }, s.dogs.length ? 'New Game' : 'Start'));
    ui.append(buttons);
    if (s.dogs.length) ui.append(h('div', { class: 'press', style: { animation: 'none', fontSize: '17px' } }, `${s.ownerName ? s.ownerName + ' · ' : ''}${s.dogs.map((d) => d.name).join(', ')}`));
  };

  const newGame = () => {
    sound.sfx('select');
    if (game.save.dogs.length && !confirm('Start a new game? Your current save will be replaced.')) return;
    const input = h('input', { class: 'textfield', placeholder: 'Your name', maxlength: 14 }) as HTMLInputElement;
    const go = () => {
      const name = input.value.trim() || 'Owner';
      m.close();
      game.save = newSave(name);
      game.persist(true);
      sound.sfx('select');
      game.overlay.toast(`Welcome, ${name}! Let's find you a puppy.`);
      game.go('kennel', { adopting: true });
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
    const m = game.overlay.modal(h('div', { class: 'panel', style: { width: 'min(460px, 92vw)', textAlign: 'center' } },
      h('h2', null, 'Hello there!'),
      h('p', null, "What's your name?"),
      input,
      h('div', { class: 'actions', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: go }, 'OK'))));
    setTimeout(() => input.focus(), 50);
  };

  sound.music('title');
  let t = 0;
  return {
    scene,
    camera,
    update(dt) {
      t += dt;
      for (const p of pups) {
        p.brain.update(dt);
        p.actor.update(dt);
        p.actor.model.uniforms.uGravity.value.set(0, -p.actor.model.gravity, 0);
      }
      separateDogs(pups.map((p) => p.actor));
      const r = 1.7;
      const a = Math.sin(t * 0.08) * 0.5;
      camera.position.set(center.x + Math.sin(a) * r, 0.55, center.z + Math.cos(a) * r);
      camera.lookAt(center.x, 0.18, center.z);
      room.update?.(dt, t, center);
    },
    exit() {
      for (const p of pups) { p.actor.group.removeFromParent(); p.actor.dispose(); }
      room.dispose();
    },
  };
}
