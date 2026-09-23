// A grid of generated menu icons (transparent PNGs) over a checkerboard, next to a
// live 3D view rendered with the same renderer to show its state is untouched.
// ?test=icons  (&size=128)

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createRenderer } from '../game/engine';
import * as Props from '../world/props';
import { renderIcon } from '../world/icons';
import type { AccessoryKind, CollectibleKind, FoodKind, ItemKind, ToyKind } from '../world/types';

const TOYS: ToyKind[] = ['tennisBall', 'rubberBall', 'frisbee', 'goldDisc', 'rope', 'squeaky', 'plushie', 'bone'];
const ITEMS: ItemKind[] = ['dryFood', 'cannedFood', 'premiumFood', 'jerky', 'milk', 'waterBottle', 'brush', 'shampoo', 'towel', 'showerHead', 'poopBag', 'present'];
const COLLECTIBLES: CollectibleKind[] = ['oldBoot', 'seashell', 'goldNugget', 'trophy', 'marble', 'emptyCan', 'toyCar', 'pocketWatch', 'flower', 'glasses', 'gem', 'feather'];
const ACCESSORIES: AccessoryKind[] = ['collarRed', 'collarBlue', 'bandana', 'ribbon', 'cap', 'sunglasses', 'bowtie', 'flowerCrown'];
const FOODS: FoodKind[] = ['dry', 'canned', 'premium', 'jerky', 'milk'];

interface Job { section: string; label: string; make: () => { object: THREE.Object3D; dispose(): void } }

export default function (params: URLSearchParams) {
  const size = Number(params.get('size') || 128);
  document.body.style.cssText = 'margin:0;background:#f3efe8;font:12px system-ui,sans-serif;color:#3a2f25';
  const app = document.getElementById('app')!;
  app.style.cssText = 'position:fixed;right:12px;top:12px;width:320px;height:220px;border-radius:10px;overflow:hidden;box-shadow:0 2px 10px #0003';
  const renderer = createRenderer(app);

  // live scene, rendered every frame with the shared renderer
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#cfe3f2');
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
  sun.position.set(0.5, 1.2, 0.8);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -0.3, right: 0.3, top: 0.3, bottom: -0.3 });
  scene.add(sun, new THREE.HemisphereLight('#fff', '#9a8a70', 0.4));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#b8c98f', roughness: 0.9 }));
  floor.receiveShadow = true;
  const liveToy = Props.makeToy('squeaky');
  liveToy.object.position.y = liveToy.rest;
  scene.add(floor, liveToy.object);
  const camera = new THREE.PerspectiveCamera(35, 320 / 220, 0.01, 10);
  camera.position.set(0.14, 0.12, 0.2);
  camera.lookAt(0, 0.035, 0);

  const grid = document.createElement('div');
  grid.style.cssText = 'padding:12px 350px 24px 12px';
  document.body.appendChild(grid);
  const status = document.createElement('div');
  status.style.cssText = 'position:fixed;right:12px;top:244px;width:320px;font:11px monospace;background:#fffc;padding:4px 8px;border-radius:6px;white-space:pre';
  document.body.appendChild(status);

  const jobs: Job[] = [];
  const add = (section: string, label: string, make: Job['make']) => jobs.push({ section, label, make });
  const obj = (o: THREE.Object3D) => ({ object: o, dispose: () => Props.disposeObject(o) });
  TOYS.forEach((k) => add('Toys', k, () => Props.makeToy(k)));
  FOODS.forEach((f) => add('Bowls', 'bowl: ' + f, () => { const b = Props.makeFoodBowl(); b.setFood!(f); b.setFill(1); return b; }));
  add('Bowls', 'water bowl', () => Props.makeWaterBowl());
  ITEMS.forEach((k) => add('Items', k, () => obj(Props.makeItem(k))));
  COLLECTIBLES.forEach((k) => add('Collectibles', k, () => obj(Props.makeCollectible(k))));
  add('Collectibles', 'poop', () => obj(Props.makePoop()));
  const fit = Props.defaultAccessoryFit();
  ACCESSORIES.forEach((k) => add('Accessories', k, () => Props.makeAccessory(k, fit)));

  const sections = new Map<string, HTMLDivElement>();
  const section = (name: string) => {
    let el = sections.get(name);
    if (!el) {
      const h = document.createElement('h3');
      h.textContent = name;
      h.style.cssText = 'margin:14px 0 6px;font-weight:600';
      el = document.createElement('div');
      el.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px';
      grid.append(h, el);
      sections.set(name, el);
    }
    return el;
  };
  const checker = 'background-color:#fff;background-image:linear-gradient(45deg,#e6e1d8 25%,transparent 25%,transparent 75%,#e6e1d8 75%),linear-gradient(45deg,#e6e1d8 25%,transparent 25%,transparent 75%,#e6e1d8 75%);background-size:16px 16px;background-position:0 0,8px 8px';

  let next = 0, totalMs = 0;
  const w = window as any;
  w.__iconsDone = false;
  const timer = new THREE.Timer();
  function frame(ts: number) {
    timer.update(ts);
    const dt = Math.min(0.05, timer.getDelta());
    // make two icons per frame between live renders
    for (let n = 0; n < 2 && next < jobs.length; n++, next++) {
      const job = jobs[next];
      const t0 = performance.now();
      const p = job.make();
      const url = renderIcon(renderer, p.object, size, job.label);
      p.dispose();
      totalMs += performance.now() - t0;
      const card = document.createElement('div');
      card.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px';
      const img = new Image();
      img.src = url;
      img.width = img.height = size;
      img.style.cssText = `${checker};border-radius:8px`;
      const cap = document.createElement('div');
      cap.textContent = job.label;
      card.append(img, cap);
      section(job.section).append(card);
      if (next === jobs.length - 1) w.__iconsDone = true;
    }
    liveToy.object.rotation.y += dt * 0.8;
    renderer.render(scene, camera);
    status.textContent = `icons ${Math.min(next, jobs.length)}/${jobs.length}  avg ${(totalMs / Math.max(1, next)).toFixed(1)} ms\n` +
      `live view: calls ${renderer.info.render.calls} tris ${renderer.info.render.triangles}\n` +
      `tone ${renderer.toneMapping} target ${renderer.getRenderTarget() ? 'RT!' : 'screen'} size ${renderer.getSize(new THREE.Vector2()).toArray().join('x')}`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
