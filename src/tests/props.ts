// Every toy, bowl, item, collectible and poop on a floor, with labels and orbit controls.
// ?test=props  (optional &row=toys|bowls|items|collectibles to frame one row)

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createRenderer } from '../game/engine';
import { DogModel } from '../dog/dogModel';
import { getBreed } from '../dog/breeds';
import { DogRig } from '../dog/rig';
import * as Props from '../world/props';
import type { Bowl, CollectibleKind, FoodKind, ItemKind, ToyKind } from '../world/types';

const TOYS: ToyKind[] = ['tennisBall', 'rubberBall', 'frisbee', 'goldDisc', 'rope', 'squeaky', 'plushie', 'bone'];
const ITEMS: ItemKind[] = ['dryFood', 'cannedFood', 'premiumFood', 'jerky', 'milk', 'waterBottle', 'brush', 'shampoo', 'towel', 'showerHead', 'poopBag', 'present'];
const COLLECTIBLES: CollectibleKind[] = ['oldBoot', 'seashell', 'goldNugget', 'trophy', 'marble', 'emptyCan', 'toyCar', 'pocketWatch', 'flower', 'glasses', 'gem', 'feather'];
const FOODS: FoodKind[] = ['dry', 'canned', 'premium', 'jerky', 'milk'];

function triCount(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    n += tris * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
  });
  return Math.round(n);
}

function floorTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d9c7ab';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 4; i++) {
    const y = i * 128;
    ctx.fillStyle = `hsl(30, 36%, ${56 + (i % 2) * 4}%)`;
    ctx.fillRect(0, y, 512, 126);
    for (let k = 0; k < 60; k++) {
      ctx.strokeStyle = `rgba(120, 80, 40, ${0.04 + Math.random() * 0.05})`;
      ctx.beginPath();
      const yy = y + Math.random() * 126;
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(170, yy + Math.random() * 8 - 4, 340, yy + Math.random() * 8 - 4, 512, yy);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(70,45,20,0.35)';
    ctx.fillRect(0, y + 126, 512, 2);
    ctx.fillRect((i * 197) % 512, y, 2, 126);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.anisotropy = 8;
  return t;
}

export default function (params: URLSearchParams) {
  document.body.style.margin = '0';
  const app = document.getElementById('app')!;
  app.style.cssText = 'position:fixed;inset:0';
  const renderer = createRenderer(app);
  const labels = new CSS2DRenderer();
  labels.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  document.body.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9e2d6');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;

  const sun = new THREE.DirectionalLight('#fff1dc', 2.1);
  sun.position.set(1.2, 2.4, 1.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -1.6; sc.right = 1.6; sc.top = 1.3; sc.bottom = -1.3; sc.near = 0.5; sc.far = 6;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.004;
  sun.shadow.radius = 3;
  scene.add(sun, new THREE.HemisphereLight('#fffaf0', '#9c8466', 0.35));

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.7 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const stats: string[] = [];
  const byName = new Map<string, THREE.Object3D>();
  const label = (obj: THREE.Object3D, text: string, y = -0.02) => {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'font:11px system-ui,sans-serif;color:#3a2f25;background:#fffc;padding:1px 5px;border-radius:6px;white-space:nowrap';
    const l = new CSS2DObject(d);
    l.position.set(0, y, 0.09);
    obj.add(l);
  };
  const place = (obj: THREE.Object3D, x: number, z: number, text: string, y = 0) => {
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.add(obj);
    scene.add(holder);
    label(holder, text, -y);
    byName.set(text, obj);
    stats.push(`${text}: ${triCount(obj)} tris`);
    return holder;
  };

  // --- toys ---
  const toys = TOYS.map((k) => Props.makeToy(k));
  const toyZ = -0.62;
  toys.forEach((t, i) => {
    t.object.position.y = t.rest;
    place(t.object, -0.95 + i * 0.25, toyZ, t.kind);
  });
  // a second, animated rope and a squeezing duck
  const tug = Props.makeToy('rope');
  const tugHolder = place(tug.object, 1.2, toyZ, 'rope setEnds');
  const squeeze = Props.makeToy('squeaky');
  squeeze.object.position.y = squeeze.rest;
  place(squeeze.object, 1.2, toyZ + 0.25, 'squeaky (squeezed)');

  // --- bowls ---
  const bowls: Bowl[] = [];
  let bx = -1.25;
  for (const f of FOODS) {
    for (const fill of [1, 0.5]) {
      const b = Props.makeFoodBowl();
      b.setFood!(f);
      b.setFill(fill);
      bowls.push(b);
      place(b.object, bx, -0.3, `${f} ${fill === 1 ? 'full' : 'half'}`);
      bx += 0.215;
    }
  }
  for (const fill of [1, 0.5]) {
    const b = Props.makeWaterBowl();
    b.setFill(fill);
    bowls.push(b);
    place(b.object, bx, -0.3, `water ${fill === 1 ? 'full' : 'half'}`);
    bx += 0.215;
  }

  // --- items & collectibles (optional while under construction) ---
  const P = Props as Record<string, unknown>;
  if (typeof P.makeItem === 'function') {
    ITEMS.forEach((k, i) => place(Props.makeItem(k), -1.3 + i * 0.235, 0.08, k));
  }
  if (typeof P.makeCollectible === 'function') {
    COLLECTIBLES.forEach((k, i) => place(Props.makeCollectible(k), -1.3 + i * 0.235, 0.45, k));
  }
  if (typeof P.makePoop === 'function') place(Props.makePoop(), 1.55, 0.45, 'poop');

  // stand-in dog for scale
  const breed = getBreed('labrador');
  const dog = new DogModel(breed, breed.coats[0]);
  const rig = new DogRig(dog);
  rig.solvePoses();
  rig.setPose('sit', 100);
  rig.cur.set(rig.target);
  dog.root.position.set(1.55, 0, -0.25);
  dog.root.rotation.y = -0.6;
  scene.add(dog.root);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  const rows: Record<string, [number[], number[]]> = {
    all: [[0.15, 2.1, 2.5], [0.15, 0, -0.1]],
    toys: [[0.1, 0.75, 0.55], [0.1, 0.02, -0.62]],
    bowls: [[0.0, 0.8, 0.7], [0.0, 0.02, -0.3]],
    items: [[0.0, 0.85, 1.15], [0.0, 0.06, 0.08]],
    collectibles: [[0.0, 0.85, 1.5], [0.0, 0.04, 0.45]],
  };
  const view = (p: number[], t: number[]) => {
    camera.position.set(p[0], p[1], p[2]);
    controls.target.set(t[0], t[1], t[2]);
    controls.update();
  };
  const row = rows[params.get('row') || 'all'] || rows.all;
  view(row[0], row[1]);

  const info = document.createElement('div');
  info.style.cssText = 'position:fixed;left:8px;top:8px;font:11px monospace;color:#222;background:#fffc;padding:4px 8px;white-space:pre;max-height:95vh;overflow:auto';
  document.body.appendChild(info);
  const w = window as any;
  w.__view = (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => view([px, py, pz], [tx, ty, tz]);
  /** frame one labelled prop from the front-right */
  w.__focus = (name: string, zoom = 1) => {
    const o = byName.get(name);
    if (!o) return;
    const box = new THREE.Box3().setFromObject(o);
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const r = Math.max(sz.x, sz.y, sz.z) * 0.5 + 0.01;
    const d = new THREE.Vector3(0.55, 0.6, 1).normalize().multiplyScalar((r / Math.tan((17.5 * Math.PI) / 180)) * 1.25 / zoom);
    view([c.x + d.x, c.y + d.y, c.z + d.z], [c.x, c.y, c.z]);
  };
  w.__scene = scene;
  w.__camera = camera;
  w.__renderer = renderer;
  w.__stats = stats;
  if (params.has('nolabels')) labels.domElement.style.display = 'none';
  if (params.has('noinfo')) info.style.display = 'none';

  const timer = new THREE.Timer();
  let time = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  function frame(ts: number) {
    timer.update(ts);
    const dt = Math.min(0.05, timer.getDelta());
    time += dt;
    const W = app.clientWidth, H = app.clientHeight;
    renderer.setSize(W, H, false);
    labels.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();

    // tug rope: ends swing around above the floor
    const s = Math.sin(time * 1.3);
    a.set(-0.1 + 0.05 * s, 0.12 + 0.05 * Math.sin(time * 2.1), 0.02 * Math.cos(time));
    b.set(0.1 - 0.06 * Math.sin(time * 0.9 + 1), 0.1 + 0.06 * Math.cos(time * 1.7), -0.03 * s);
    tug.setEnds!(a, b);
    tugHolder.userData.t = time;
    squeeze.update!(dt, Math.sin(time * 3) > 0.3 ? 1 : 0);
    for (const t of toys) t.update?.(dt, 0);
    for (const bw of bowls) bw.update?.(dt, time);
    rig.update(dt);
    dog.uniforms.uTime.value = time;
    dog.uniforms.uGravity.value.set(0, -dog.gravity, 0);
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    info.textContent = `calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}\n` + stats.join('\n');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
