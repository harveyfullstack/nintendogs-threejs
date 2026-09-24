import * as THREE from 'three';
import { DogActor, separateDogs } from '../../dog/actor';
import { Brain } from '../../dog/brain';
import { BREEDS, Breed, CoatDef } from '../../dog/breeds';
import { isCompact, touchUI } from '../../ui/device';
import { clear, h } from '../../ui/dom';
import { loadKennel } from '../../world/loaders';
import { FollowCamera } from '../cameraRig';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { sound } from '../sound';
import { maxDogs, newDog } from '../state';

// The kennel: browse breeds, meet three puppies and take one home.
//
// Picking a breed brings out its three puppies. They can be picked by tapping them
// in the pen or with the buttons on the puppy card, and the first one is picked for
// you, so "Take me home!" is always one tap away.

interface Pup { actor: DogActor; brain: Brain; breed: Breed; coat: CoatDef; sex: 'male' | 'female'; price: number }

/** The second colour that makes a coat recognisable (white socks, tan points, spots…). */
const ACCENTS = ['white', 'patch', 'tan', 'black', 'spot', 'mask', 'cream', 'silver', 'pepper', 'ear'];

function coatSwatch(coat: CoatDef): string {
  const base = coat.colors.base;
  const accent = ACCENTS.map((k) => coat.colors[k]).find((c) => c && c.toLowerCase() !== base.toLowerCase());
  return accent ? `linear-gradient(135deg, ${base} 0 56%, ${accent} 56% 100%)` : base;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

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
  const save = game.save;
  const canAdopt = save.dogs.length < Math.max(1, maxDogs(save));

  const pups: Pup[] = [];
  let breed: Breed | null = null;
  let selected: Pup | null = null;
  let status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  /** bumped on every breed change so a half-finished litter stops making puppies */
  let litter = 0;
  let adopted = false;
  let exited = false;

  // ---------- UI ----------
  const layer = game.overlay.layer;
  const list = h('div', { class: 'panel kennel-list' });
  const info = h('div', { class: 'panel kennel-info' });
  // on phones in portrait the puppy card and a sideways breed strip stack at the bottom
  const dock = h('div', { class: 'kennel-ui' }, info, list);
  const back = h('button', { class: 'btn corner-tr', onclick: () => { if (!adopted) game.go(save.dogs.length ? 'home' : 'title'); } }, save.dogs.length ? 'Back home' : 'Back');
  layer.append(dock, back);

  // a marker over the puppy that's picked
  const marker = h('div', { class: 'pup-marker', html: '<svg viewBox="0 0 24 24"><path d="M12 19l-7-8h4V5h6v6h4z"/></svg>' });
  game.overlay.track(marker, () => (selected && !adopted ? selected.actor.headWorld().add(new THREE.Vector3(0, 0.07 + selected.actor.size * 0.25, 0)) : null));

  // On phones the panels cover a big part of the screen: centre the pen in what's left.
  const covered = { left: 0, bottom: 0 };
  const measure = () => {
    covered.left = covered.bottom = 0;
    if (!isCompact() || dock.style.display === 'none') return;
    if (getComputedStyle(dock).display === 'flex') {
      const r = dock.getBoundingClientRect();
      if (r.height) covered.bottom = window.innerHeight - r.top;
    } else {
      const l = list.getBoundingClientRect(), i = info.getBoundingClientRect();
      if (l.width) covered.left = l.right;
      if (i.height) covered.bottom = window.innerHeight - i.top;
    }
  };
  const ro = new ResizeObserver(measure);
  ro.observe(list);
  ro.observe(info);
  window.addEventListener('resize', measure);

  // ---------- breed list ----------
  const cards = new Map<string, HTMLElement>();
  const strip = h('div', { class: 'kennel-breeds' });
  list.append(
    h('h2', null, 'Kennel'),
    h('p', { class: 'intro' }, canAdopt
      ? `Choose a breed to meet its puppies. You have $${save.money.toLocaleString()}.`
      : `You can't take another dog home yet. Earn more Owner Points! (${save.dogs.length}/${maxDogs(save)} dogs)`),
    strip,
  );
  for (const b of BREEDS) {
    const card = h('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => showBreed(b) },
      h('div', { class: 'name' }, b.name),
      h('div', { class: 'meta' }, `${b.size} · from $${b.price}`),
      h('div', { class: 'blurb' }, b.blurb));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showBreed(b); } });
    cards.set(b.id, card);
    strip.append(card);
  }
  /** Highlight the breed and scroll it into view in the list (vertical) or strip (sideways). */
  const markBreed = (id: string) => {
    for (const [bid, c] of cards) c.classList.toggle('selected', bid === id);
    const c = cards.get(id);
    if (!c) return;
    if (strip.scrollWidth > strip.clientWidth + 1) {
      const target = c.offsetLeft - (strip.clientWidth - c.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    } else if (c.offsetTop < strip.scrollTop || c.offsetTop + c.offsetHeight > strip.scrollTop + strip.clientHeight) {
      strip.scrollTo({ top: Math.max(0, c.offsetTop - 8), behavior: 'smooth' });
    }
  };

  // ---------- puppy card ----------
  // Built once and updated in place, so a button never gets swapped out from under a finger.
  const title = h('h2');
  const wallet = h('span', { class: 'wallet', title: 'Your money' });
  const blurb = h('p', { class: 'blurb' });
  const hint = h('p', { class: 'pick-hint' });
  const chips = [0, 1, 2].map((i) => {
    const swatch = h('span', { class: 'swatch' });
    const name = h('span', { class: 'pup-name' });
    const meta = h('span', { class: 'pup-meta' });
    const el = h('button', { class: 'pup-chip', role: 'radio', onclick: () => { const p = pups[i]; if (p) select(p, true); } }, swatch, name, meta);
    return { el, swatch, name, meta };
  });
  const picker = h('div', { class: 'pup-picker', role: 'radiogroup', 'aria-label': 'Puppies' }, ...chips.map((c) => c.el));
  const adoptBtn = h('button', {
    class: 'btn primary adopt-btn',
    onclick: () => {
      if (status === 'failed' && breed) { const b = breed; breed = null; showBreed(b); return; }
      if (selected) adopt(selected);
    },
  });
  const row = h('div', { class: 'pick-row' }, picker, adoptBtn);
  info.append(h('div', { class: 'pick-head' }, title, wallet), blurb, hint, row);

  const renderInfo = () => {
    title.textContent = breed ? breed.name : 'Meet the puppies';
    wallet.textContent = '$' + save.money.toLocaleString();
    blurb.textContent = breed?.blurb ?? '';
    blurb.hidden = !breed;
    hint.classList.toggle('busy', status === 'loading');
    if (!breed) hint.textContent = 'Choose a breed to see its puppies.';
    else if (status === 'failed') hint.textContent = "The puppies couldn't come out. Try again?";
    else if (!canAdopt) hint.textContent = `You can't take another dog home yet. Earn more Owner Points! (${save.dogs.length}/${maxDogs(save)} dogs)`;
    else if (status === 'loading' && !selected) hint.textContent = 'Fetching the puppies…';
    else hint.textContent = `${touchUI ? 'Tap' : 'Click'} a puppy to pick it, then take it home!`;
    row.hidden = !breed;
    chips.forEach((c, i) => {
      const p = pups[i];
      const on = !!p && p === selected;
      c.el.disabled = !p;
      c.el.classList.toggle('pending', !p);
      c.el.classList.toggle('selected', on);
      c.el.setAttribute('aria-checked', on ? 'true' : 'false');
      c.el.setAttribute('aria-label', p ? `${p.coat.name} ${p.sex}, $${p.price}` : 'Puppy on its way');
      c.swatch.style.background = p ? coatSwatch(p.coat) : '';
      c.name.textContent = p ? p.coat.name : '…';
      clear(c.meta);
      if (p) c.meta.append(h('b', { class: p.sex }, p.sex === 'male' ? '♂' : '♀'), ` $${p.price}`);
      else c.meta.textContent = '\u00a0';
    });
    if (status === 'failed') {
      adoptBtn.textContent = 'Try again';
      adoptBtn.disabled = false;
    } else if (!canAdopt) {
      adoptBtn.textContent = 'Just visiting';
      adoptBtn.disabled = true;
    } else if (!selected) {
      adoptBtn.textContent = status === 'loading' ? 'Fetching puppies…' : 'Take me home!';
      adoptBtn.disabled = true;
    } else {
      const afford = save.money >= selected.price;
      adoptBtn.textContent = afford ? `Take me home! · $${selected.price}` : 'Not enough money';
      adoptBtn.disabled = !afford;
    }
  };

  const select = (p: Pup, byUser: boolean) => {
    if (adopted) return;
    if (byUser) sound.sfx('select');
    p.brain.call();
    if (selected === p) return;
    selected = p;
    for (const o of pups) if (o !== p) o.brain.excite = 0.3;
    renderInfo();
  };

  // ---------- puppies ----------
  const clearPups = () => {
    for (const p of pups) { p.actor.group.removeFromParent(); p.actor.dispose(); }
    pups.length = 0;
    selected = null;
  };

  const showBreed = async (b: Breed) => {
    if (adopted || exited) return;
    if (b === breed && status !== 'failed') { sound.sfx('select'); return; }
    const mine = ++litter;
    breed = b;
    status = 'loading';
    sound.sfx('select');
    markBreed(b.id);
    clearPups();
    renderInfo();
    // let the card show "fetching" before the heavy lifting blocks the page
    await nextFrame();
    const coats = [...b.coats];
    while (coats.length < 3) coats.push(b.coats[Math.floor(Math.random() * b.coats.length)]);
    for (let i = 0; i < 3; i++) {
      if (mine !== litter || exited || adopted) return;
      const coat = coats[i];
      let actor: DogActor;
      try {
        actor = new DogActor(b, coat, game.previewQuality);
      } catch (e) {
        console.error('could not make a puppy', b.id, coat.id, e);
        if (mine === litter) { status = 'failed'; renderInfo(); }
        return;
      }
      // someone picked another breed (or left, or adopted) while this one was being made
      if (mine !== litter || exited || adopted) { actor.dispose(); return; }
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
      const pup: Pup = { actor, brain, breed: b, coat, sex: d.sex, price };
      pups.push(pup);
      if (i === 2) status = 'ready';
      // the first puppy is picked for you, so there's always something to take home
      if (!selected) select(pup, false);
      else renderInfo();
      await nextFrame();
    }
    if (mine === litter && breed === b && pups.length === 3) game.overlay.toast(`Meet the ${b.name} puppies!`);
  };

  // ---------- adopting ----------
  const adopt = (p: Pup) => {
    if (adopted || !canAdopt) return;
    if (save.money < p.price) { sound.sfx('error'); game.overlay.toast("You can't afford this puppy yet."); return; }
    const input = h('input', {
      class: 'textfield', placeholder: 'Puppy name', maxlength: 12, 'aria-label': 'Puppy name',
      autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', spellcheck: 'false',
    }) as HTMLInputElement;
    const error = h('p', { class: 'form-error', role: 'alert' });
    const confirmName = () => {
      if (adopted) return;
      const name = input.value.trim().replace(/\s+/g, ' ');
      if (!name) {
        error.textContent = 'Give your puppy a name first!';
        sound.sfx('error');
        input.focus();
        return;
      }
      if (!game.spend(p.price)) { error.textContent = "You don't have enough money."; sound.sfx('error'); return; }
      adopted = true;
      const d = newDog(name, p.breed.id, p.coat.id, p.sex);
      save.dogs.push(d);
      save.activeDog = d.id;
      game.persist(true);
      input.blur();
      m.close();
      dock.style.display = 'none';
      back.style.display = 'none';
      measure();
      p.brain.call();
      sound.sfx('learned');
      game.overlay.toast(`${name} is coming home with you!`, true);
      game.overlay.emote('heart', p.actor.headWorld().add(new THREE.Vector3(0, 0.08, 0)), 20);
      const goHome = () => { if (exited) return; if (game.busy) setTimeout(goHome, 250); else game.go('home'); };
      setTimeout(goHome, 1400);
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') confirmName(); });
    input.addEventListener('input', () => { error.textContent = ''; });
    const m = game.overlay.modal(h('div', { class: 'panel', style: { width: 'min(460px, 92vw)', textAlign: 'center' } },
      h('h2', null, 'Name your puppy'),
      h('p', null, `Pick a name that's easy to say out loud. You'll call your ${p.breed.name} with it!`),
      input,
      error,
      h('div', { class: 'actions', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: confirmName }, `Adopt for $${p.price}`))));
    setTimeout(() => input.focus(), 50);
  };

  // ---------- tapping puppies in the pen ----------
  const ray = new THREE.Raycaster();
  const onDown = (e: PointerEvent) => {
    if (!pups.length || adopted || e.button > 0) return;
    const r = game.renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    let best: Pup | null = null, bd = Infinity;
    for (const p of pups) {
      const hit = p.actor.raycast(ray.ray);
      if (hit && hit.distance < bd) { bd = hit.distance; best = p; }
    }
    if (!best) {
      // fingers are big and puppies wiggle: a tap close to one on screen counts too
      let bestPx = Infinity;
      for (const p of pups) {
        const feet = game.overlay.project(p.actor.position);
        const head = game.overlay.project(p.actor.headWorld());
        if (!feet || !head) continue;
        const cx = (feet.x + head.x) / 2, cy = (feet.y + head.y) / 2;
        const reach = Math.max(44, Math.hypot(head.x - feet.x, head.y - feet.y) * 0.9);
        const dpx = Math.hypot(cx - e.clientX, cy - e.clientY);
        if (dpx < reach && dpx < bestPx) { bestPx = dpx; best = p; }
      }
    }
    if (best) select(best, true);
  };
  game.renderer.domElement.addEventListener('pointerdown', onDown);

  renderInfo();
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
      exited = true;
      litter++;
      ro.disconnect();
      window.removeEventListener('resize', measure);
      game.renderer.domElement.removeEventListener('pointerdown', onDown);
      clearPups();
      k.dispose();
    },
  };
}
