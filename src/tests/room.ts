// Room test page: ?test=room&theme=default|japanese|modern
// Optional: &cam=x,y,z&target=x,y,z  &dog=x,z,yaw  &breed=labrador  &spots=1  &nodog=1
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createRenderer } from '../game/engine';
import { buildRoom, ROOM_THEMES } from '../world/room';
import type { Place } from '../world/types';
import { DogModel } from '../dog/dogModel';
import { getBreed } from '../dog/breeds';
import { DogRig } from '../dog/rig';

const vec = (s: string | null) => (s ? new THREE.Vector3(...(s.split(',').map(Number) as [number, number, number])) : null);

export interface PlaceTestOptions {
  title: string;
  dog: { x: number; y?: number; z: number; yaw: number };
  markers?: THREE.Vector3[];
  extraInfo?: string;
}

/** Shared harness for the location test pages: renderer, orbit camera, stand-in dog and a stats HUD. */
export function runPlaceTest(params: URLSearchParams, build: (r: THREE.WebGLRenderer) => Place, opts: PlaceTestOptions) {
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  const app = document.getElementById('app')!;
  app.style.cssText = 'position:fixed;inset:0';
  const renderer = createRenderer(app);
  const scene = new THREE.Scene();
  const t0 = performance.now();
  const place = build(renderer);
  const buildMs = performance.now() - t0;
  scene.add(place.group);
  scene.environment = place.environment ?? null;
  scene.background = place.background ?? null;
  scene.fog = place.fog ?? null;

  const camera = new THREE.PerspectiveCamera(place.camera.fov ?? 50, 1, 0.03, 80);
  camera.position.copy(vec(params.get('cam')) ?? place.camera.position);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(vec(params.get('target')) ?? place.camera.target);
  controls.enableDamping = true;
  controls.update();

  let dog: DogModel | null = null;
  let rig: DogRig | null = null;
  if (!params.has('nodog')) {
    const b = getBreed(params.get('breed') || 'labrador');
    dog = new DogModel(b, b.coats[Number(params.get('coat') || 0)]);
    rig = new DogRig(dog);
    rig.solvePoses();
    if (params.get('pose')) rig.setPose(params.get('pose')!, 100);
    dog.uniforms.uGravity.value.set(0, -dog.gravity, 0);
    const dp = params.get('dog')?.split(',').map(Number);
    dog.root.position.set(dp?.[0] ?? opts.dog.x, opts.dog.y ?? 0, dp?.[1] ?? opts.dog.z);
    dog.root.rotation.y = dp?.[2] ?? opts.dog.yaw;
    scene.add(dog.root);
  }

  if (params.has('spots') && opts.markers) {
    for (const p of opts.markers) {
      const mk = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 12), new THREE.MeshBasicMaterial({ color: 0xff2266 }));
      mk.position.copy(p).add(new THREE.Vector3(0, 0.3, 0));
      mk.rotation.x = Math.PI;
      scene.add(mk);
    }
  }

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:8px;top:8px;color:#fff;font:12px/1.35 monospace;background:#0009;padding:6px 9px;border-radius:4px;white-space:pre;pointer-events:none';
  document.body.appendChild(hud);

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const stats = { calls: 0, triangles: 0, fps: 0, buildMs: Math.round(buildMs) };
  Object.assign(window as any, { __place: place, __scene: scene, __cam: camera, __controls: controls, __dog: dog, __rig: rig, __renderer: renderer, __stats: stats });

  const timer = new THREE.Timer();
  let acc = 0;
  let frames = 0;
  const focus = new THREE.Vector3();
  const loop = (ts: number) => {
    timer.update(ts);
    const dt = Math.min(0.05, timer.getDelta());
    const t = timer.getElapsed();
    if (rig && dog) {
      rig.update(dt);
      dog.uniforms.uTime.value = t;
      focus.copy(dog.root.position);
    }
    place.update?.(dt, t, focus);
    controls.update();
    renderer.render(scene, camera);
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    frames++;
    acc += dt;
    if (acc > 0.5) {
      stats.fps = frames / acc;
      frames = 0;
      acc = 0;
      hud.textContent =
        `${opts.title}\n` +
        `draw calls ${stats.calls}   triangles ${stats.triangles.toLocaleString()}\n` +
        `fps ${stats.fps.toFixed(0)}   build ${buildMs.toFixed(0)} ms` +
        (opts.extraInfo ? `\n${opts.extraInfo}` : '');
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return { scene, camera, controls, place, dog };
}

export default function (params: URLSearchParams) {
  const theme = params.get('theme') || 'default';
  const info = ROOM_THEMES.find((t) => t.id === theme);
  let spots: THREE.Vector3[] = [];
  runPlaceTest(
    params,
    (r) => {
      const room = buildRoom(theme, r);
      spots = Object.values(room.spots);
      return room;
    },
    {
      title: `room: ${info?.name ?? theme} (${ROOM_THEMES.map((t) => t.id).join(' | ')})`,
      dog: { x: -0.35, z: -0.3, yaw: 0.6 },
      get markers() {
        return spots;
      },
    },
  );
}
