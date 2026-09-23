// Accessories fitted to several breeds so the fit can be checked across sizes.
// ?test=accessories              each dog wears a different pair
// ?test=accessories&set=1..4      everyone wears the same pair
// ?test=accessories&acc=cap,collarRed   custom list for every dog
// &pose=sit  &dog=0..3 (frame one dog's head)

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createRenderer } from '../game/engine';
import { DogModel } from '../dog/dogModel';
import { getBreed } from '../dog/breeds';
import { DogRig } from '../dog/rig';
import { accessoryFit } from '../dog/fit';
import { makeAccessory } from '../world/props';
import type { Accessory, AccessoryKind } from '../world/types';

const BREEDS = ['labrador', 'chihuahua', 'shiba', 'dachshund'];
const SETS: AccessoryKind[][][] = [
  [['collarRed', 'cap'], ['bandana', 'sunglasses'], ['bowtie', 'flowerCrown'], ['collarBlue', 'ribbon']],
  [['collarRed', 'ribbon']],
  [['bandana', 'cap']],
  [['bowtie', 'sunglasses']],
  [['collarBlue', 'flowerCrown']],
];

export default function (params: URLSearchParams) {
  document.body.style.margin = '0';
  const app = document.getElementById('app')!;
  app.style.cssText = 'position:fixed;inset:0';
  const renderer = createRenderer(app);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e7e0d4');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
  sun.position.set(0.8, 2.2, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1.1, right: 1.1, top: 0.8, bottom: -0.8, near: 0.5, far: 5 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.004;
  scene.add(sun, new THREE.HemisphereLight('#fffaf0', '#8a7560', 0.4));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.MeshStandardMaterial({ color: '#c9b79b', roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const setIdx = Number(params.get('set') || 0);
  const custom = params.get('acc')?.split(',').filter(Boolean) as AccessoryKind[] | undefined;
  const dogs: DogModel[] = [], rigs: DogRig[] = [], worn: Accessory[] = [];
  const info: string[] = [];
  BREEDS.forEach((id, i) => {
    const breed = getBreed(id);
    const dog = new DogModel(breed, breed.coats[0]);
    const rig = new DogRig(dog);
    rig.solvePoses();
    rig.setPose(params.get('pose') || 'stand', 100);
    rig.cur.set(rig.target);
    rig.wagAmp = 0.25;
    dog.root.position.set((i - 1.5) * 0.42, 0, 0);
    dog.root.rotation.y = 0.35;
    scene.add(dog.root);
    dogs.push(dog);
    rigs.push(rig);
    const fit = accessoryFit(dog);
    const set = SETS[setIdx] || SETS[0];
    const kinds = custom?.length ? custom : set[i % set.length];
    for (const k of kinds) {
      const acc = makeAccessory(k, fit);
      dog.bones[acc.bone].add(acc.object);
      worn.push(acc);
    }
    const f = (v: THREE.Vector3) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
    info.push(`${id}: ${kinds.join(' + ')}\n  neckR ${fit.neckRadius.toFixed(3)} collar ${f(fit.collarCenter)} axis ${f(fit.neckAxis)}\n  hs ${fit.headScale.toFixed(2)} top ${f(fit.headTop)} eyes ${f(fit.eyeCenter)} sp ${fit.eyeSpacing.toFixed(3)}`);
  });

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  const view = (p: THREE.Vector3, t: THREE.Vector3) => { camera.position.copy(p); controls.target.copy(t); controls.update(); };
  view(new THREE.Vector3(0.35, 0.55, 1.7), new THREE.Vector3(0, 0.17, 0));
  const w = window as any;
  /** frame dog i's head; side: 0 front-right, 1 side, 2 front, 3 top/back */
  w.__focusDog = (i: number, side = 0, zoom = 1) => {
    const dog = dogs[i];
    dog.root.updateMatrixWorld(true);
    const head = dog.bones.head.getWorldPosition(new THREE.Vector3());
    const neck = dog.bones.neck.getWorldPosition(new THREE.Vector3());
    const t = head.clone().lerp(neck, 0.35);
    const hs = dog.design.dims.hs;
    const dirs = [new THREE.Vector3(0.8, 0.35, 1), new THREE.Vector3(1, 0.15, -0.1), new THREE.Vector3(0.05, 0.1, 1), new THREE.Vector3(-0.6, 0.9, -0.5)];
    const d = dirs[side].normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), dog.root.rotation.y);
    view(t.clone().addScaledVector(d, (0.42 * hs) / zoom), t);
  };
  w.__view = (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => view(new THREE.Vector3(px, py, pz), new THREE.Vector3(tx, ty, tz));
  w.__dogs = dogs;
  if (params.has('dog')) w.__focusDog(Number(params.get('dog')), Number(params.get('side') || 0));

  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;left:8px;top:8px;font:11px monospace;color:#222;background:#fffc;padding:4px 8px;white-space:pre';
  if (params.has('noinfo')) div.style.display = 'none';
  document.body.appendChild(div);

  const timer = new THREE.Timer();
  let time = 0;
  function frame(ts: number) {
    timer.update(ts);
    const dt = Math.min(0.05, timer.getDelta());
    time += dt;
    const W = app.clientWidth, H = app.clientHeight;
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    rigs.forEach((r) => r.update(params.has('freeze') ? 0.0001 : dt));
    for (const d of dogs) {
      d.uniforms.uTime.value = time;
      d.uniforms.uGravity.value.set(0, -d.gravity, 0);
    }
    controls.update();
    renderer.render(scene, camera);
    div.textContent = `calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}\n` + info.join('\n');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
