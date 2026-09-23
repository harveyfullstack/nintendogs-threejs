// Town test page, plus the shared harness used by the park / disc / agility pages.
// ?test=town            street-level view at Home; buttons jump to each POI
// ?test=town&walk=1     the puppy walks the sidewalks with a follow camera
// WASD / QE fly the camera, drag to orbit.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createRenderer } from '../game/engine';
import { DogModel } from '../dog/dogModel';
import { getBreed } from '../dog/breeds';
import { DogRig } from '../dog/rig';
import type { Place } from '../world/types';
import { buildTown } from '../world/town';
import { TOWN, blockRect, pitch, poiEntrance } from '../world/townLayout';

export interface TestCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  place: Place;
  dog: DogModel;
  rig: DogRig;
  focus: THREE.Vector3;
  setView(pos: THREE.Vector3, target: THREE.Vector3): void;
  setDog(pos: THREE.Vector3, yaw?: number): void;
}

export interface OutdoorTestOptions {
  title: string;
  build(renderer: THREE.WebGLRenderer): Place;
  dog?: THREE.Vector3;
  dogYaw?: number;
  buttons?: { label: string; action(ctx: TestCtx): void }[];
  onFrame?(ctx: TestCtx, dt: number, t: number): void;
  onReady?(ctx: TestCtx): void;
}

export function runOutdoorTest(params: URLSearchParams, o: OutdoorTestOptions): TestCtx {
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  const app = document.getElementById('app')!;
  app.style.cssText = 'position:fixed;inset:0';
  const renderer = createRenderer(app);
  const scene = new THREE.Scene();
  const t0 = performance.now();
  const place = o.build(renderer);
  const buildMs = performance.now() - t0;
  scene.add(place.group);
  if (place.environment) scene.environment = place.environment;
  if (place.background) scene.background = place.background;
  if (place.fog) scene.fog = place.fog;

  const camera = new THREE.PerspectiveCamera(place.camera.fov ?? 50, 1, 0.1, 2000);
  camera.position.copy(place.camera.position);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(place.camera.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;

  const breed = getBreed(params.get('breed') || 'labrador');
  const dog = new DogModel(breed, breed.coats[0]);
  const rig = new DogRig(dog);
  rig.solvePoses();
  scene.add(dog.root);
  const focus = new THREE.Vector3();

  const ctx: TestCtx = {
    renderer, scene, camera, controls, place, dog, rig, focus,
    setView(pos, target) { camera.position.copy(pos); controls.target.copy(target); controls.update(); },
    setDog(pos, yaw) { dog.root.position.copy(pos); if (yaw !== undefined) dog.root.rotation.y = yaw; },
  };
  ctx.setDog(o.dog ?? new THREE.Vector3().copy(place.camera.target).setY(0), o.dogYaw ?? 0);

  // WASD / QE fly
  const keys = new Set<string>();
  addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
  const fly = (dt: number) => {
    if (!keys.size) return;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();
    move.set(0, 0, 0);
    if (keys.has('w')) move.add(fwd);
    if (keys.has('s')) move.sub(fwd);
    if (keys.has('d')) move.add(right);
    if (keys.has('a')) move.sub(right);
    if (keys.has('e')) move.y += 1;
    if (keys.has('q')) move.y -= 1;
    const speed = (keys.has('shift') ? 30 : 8) * dt;
    move.multiplyScalar(speed);
    camera.position.add(move);
    controls.target.add(move);
  };

  // overlay
  const info = document.createElement('div');
  info.style.cssText = 'position:fixed;left:8px;top:8px;color:#fff;font:12px/1.4 monospace;background:#0009;padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none;z-index:10';
  document.body.appendChild(info);
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:8px;top:8px;display:flex;flex-direction:column;gap:4px;z-index:10';
  document.body.appendChild(bar);
  for (const btn of o.buttons ?? []) {
    const el = document.createElement('button');
    el.textContent = btn.label;
    el.style.cssText = 'font:13px sans-serif;padding:5px 10px;border-radius:5px;border:0;background:#fffe;cursor:pointer';
    el.onclick = () => btn.action(ctx);
    bar.appendChild(el);
  }
  o.onReady?.(ctx);

  const stats = { calls: 0, tris: 0, mainCalls: 0, mainTris: 0, fps: 0, buildMs };
  (window as any).__t = { ...ctx, stats, THREE };
  const timer = new THREE.Timer();
  let acc = 0, frames = 0, measureMain = false;
  const frame = (ts: number) => {
    timer.update(ts);
    const dt = Math.min(0.05, timer.getDelta());
    const t = timer.getElapsed();
    fly(dt);
    o.onFrame?.(ctx, dt, t);
    controls.update();
    rig.update(dt);
    dog.uniforms.uTime.value = t;
    dog.uniforms.uGravity.value.set(0, -dog.gravity, 0);
    focus.copy(dog.root.position);
    place.update?.(dt, t, focus);
    const w = app.clientWidth, h = app.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // every half second render one frame without the shadow pass to measure the main pass alone
    renderer.shadowMap.autoUpdate = !measureMain;
    renderer.render(scene, camera);
    renderer.shadowMap.autoUpdate = true;
    if (measureMain) {
      stats.mainCalls = renderer.info.render.calls;
      stats.mainTris = renderer.info.render.triangles;
      measureMain = false;
    } else {
      stats.calls = renderer.info.render.calls;
      stats.tris = renderer.info.render.triangles;
    }
    acc += dt; frames++;
    if (acc > 0.5) {
      stats.fps = frames / acc;
      acc = 0; frames = 0;
      measureMain = true;
      info.textContent = `${o.title}\n` +
        `draw calls ${stats.calls} (main pass ${stats.mainCalls})\n` +
        `triangles  ${(stats.tris / 1000).toFixed(0)}k (main pass ${(stats.mainTris / 1000).toFixed(0)}k)\n` +
        `fps ${stats.fps.toFixed(0)}   build ${buildMs.toFixed(0)} ms\n` +
        `cam ${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return ctx;
}

/** Sidewalk loop around a block (centreline of the sidewalk), clockwise. */
function blockLoop(c: number, r: number): THREE.Vector3[] {
  const rect = blockRect(c, r, TOWN);
  const s = TOWN.sidewalk / 2;
  return [
    new THREE.Vector3(rect.minX - s, 0, rect.minZ - s),
    new THREE.Vector3(rect.maxX + s, 0, rect.minZ - s),
    new THREE.Vector3(rect.maxX + s, 0, rect.maxZ + s),
    new THREE.Vector3(rect.minX - s, 0, rect.maxZ + s),
  ];
}

export default function (params: URLSearchParams) {
  const P = pitch(TOWN);
  let walking = params.has('walk');
  let route = blockLoop(0, 1);
  let leg = 0, legT = 0;
  const camPos = new THREE.Vector3(), camTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const streetView = (ctx: TestCtx, x: number, z: number, lookX: number, lookZ: number) => {
    walking = false;
    const dir = new THREE.Vector3(lookX - x, 0, lookZ - z).normalize();
    ctx.setDog(new THREE.Vector3(x, 0, z), Math.atan2(dir.x, dir.z));
    ctx.rig.speed = 0;
    ctx.setView(new THREE.Vector3(x - dir.x * 3.4, 1.75, z - dir.z * 3.4), new THREE.Vector3(x + dir.x * 4, 0.9, z + dir.z * 4));
  };

  /** Stand on the sidewalk in front of a POI, looking along the sidewalk with the building beside. */
  const poiView = (ctx: TestCtx, kind: string) => {
    const poi = TOWN.pois.find((p) => p.kind === kind)!;
    const e = poiEntrance(poi);
    const along = poi.side === 'n' || poi.side === 's' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const out = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[poi.side];
    walking = false;
    ctx.setDog(new THREE.Vector3(e.x, 0, e.z), Math.atan2(-out[0], -out[1]));
    ctx.rig.speed = 0;
    ctx.setView(
      new THREE.Vector3(e.x + out[0] * 5.5 - along.x * 7, 1.8, e.z + out[1] * 5.5 - along.z * 7),
      new THREE.Vector3(e.x - out[0] * 4, 2.2, e.z - out[1] * 4),
    );
  };

  const ctx = runOutdoorTest(params, {
    title: 'Town',
    build: (r) => buildTown(TOWN, r),
    buttons: [
      { label: 'Walk around block', action: () => { walking = true; route = blockLoop(0, 1); leg = 0; legT = 0; } },
      { label: 'Walk (Pet Supply block)', action: () => { walking = true; route = blockLoop(1, 2); leg = 0; legT = 0; } },
      ...TOWN.pois.map((p) => ({ label: p.name, action: (c: TestCtx) => poiView(c, p.kind) })),
      { label: 'Street corner', action: (c: TestCtx) => streetView(c, P + 4.7, P + 12, P + 4.7, 2 * P) },
      { label: 'Overview', action: (c: TestCtx) => { walking = false; c.setView(new THREE.Vector3(-40, 70, 220), new THREE.Vector3(90, 0, 72)); } },
    ],
    onFrame(c, dt) {
      if (!walking) return;
      const a = route[leg], b = route[(leg + 1) % route.length];
      const len = a.distanceTo(b);
      const speed = 1.1;
      legT += (speed * dt) / len;
      if (legT >= 1) { legT -= 1; leg = (leg + 1) % route.length; }
      const p0 = route[leg], p1 = route[(leg + 1) % route.length];
      tmp.lerpVectors(p0, p1, legT);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      let dy = yaw - c.dog.root.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      c.dog.root.rotation.y += dy * Math.min(1, dt * 5);
      c.dog.root.position.copy(tmp);
      c.rig.speed = speed * 0.35;
      c.rig.turnRate = dy * 3;
      const f = new THREE.Vector3(Math.sin(c.dog.root.rotation.y), 0, Math.cos(c.dog.root.rotation.y));
      camPos.copy(tmp).addScaledVector(f, -3.3).setY(1.75);
      camTarget.copy(tmp).addScaledVector(f, 4).setY(0.7);
      c.camera.position.lerp(camPos, Math.min(1, dt * 4));
      c.controls.target.lerp(camTarget, Math.min(1, dt * 4));
    },
  });
  if (params.has('poi')) poiView(ctx, params.get('poi')!);
  (window as any).__town = { poiView: (k: string) => poiView(ctx, k), streetView: (x: number, z: number, lx: number, lz: number) => streetView(ctx, x, z, lx, lz) };
}
