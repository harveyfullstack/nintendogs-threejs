import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BREEDS, getBreed } from './dog/breeds';
import { DogModel } from './dog/dogModel';
import { DogRig } from './dog/rig';
import { createRenderer } from './game/engine';

export function startViewer(params: URLSearchParams) {
  document.body.style.margin = '0';
  document.body.style.background = '#222';
  const app = document.getElementById('app')!;
  app.style.cssText = 'position:fixed;inset:0';
  const renderer = createRenderer(app);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d9d2c6');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const sun = new THREE.DirectionalLight('#fff3e0', 2.4);
  sun.position.set(1.2, 2.2, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -0.6; sun.shadow.camera.right = 0.6;
  sun.shadow.camera.top = 0.6; sun.shadow.camera.bottom = -0.6;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.01;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#fff8ee', '#8a7560', 0.6));

  const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.MeshStandardMaterial({ color: '#bfae95', roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const breedIds = (params.get('viewer') || 'labrador').split(',');
  const coatIdx = Number(params.get('coat') || 0);
  const dogs: DogModel[] = [];
  const rigs: DogRig[] = [];
  const info: string[] = [];
  breedIds.forEach((spec, i) => {
    const [id, ci] = spec.split(':');
    const breed = id && id !== '1' ? getBreed(id) : BREEDS[0];
    const cidx = ci !== undefined ? Number(ci) : coatIdx;
    const dog = new DogModel(breed, breed.coats[Math.min(cidx, breed.coats.length - 1)], { quality: Number(params.get('q') || 1) });
    dog.root.position.x = (i - (breedIds.length - 1) / 2) * Number(params.get('spacing') || 0.5);
    scene.add(dog.root);
    dogs.push(dog);
    const rig = new DogRig(dog);
    rig.solvePoses();
    const poseList = (params.get('poses') || '').split(',');
    rig.setPose(poseList[i] || params.get('pose') || 'stand', 100);
    rig.cur.set(rig.target);
    rig.speed = Number(params.get('speed') || 0);
    rig.wagAmp = Number(params.get('wag') || 0.3);
    rig.panting = Number(params.get('pant') || 0);
    rig.happy = Number(params.get('happy') || 0);
    rigs.push(rig);
    info.push(`${breed.id}: ${dog.buildMs.toFixed(0)}ms, ${dog.vertexCount} verts, ${dog.triangleCount} tris`);
  });
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;left:8px;bottom:8px;color:#fff;font:12px monospace;background:#0008;padding:4px 8px;white-space:pre';
  div.id = 'info';
  div.textContent = info.join('\n');
  document.body.appendChild(div);
  (window as any).__dogs = dogs;

  const H = dogs[0].design.dims.H;
  const target = new THREE.Vector3(0, H * 0.75, 0);
  const views = params.get('views') || 'quad';
  const cams: THREE.PerspectiveCamera[] = [];
  const dist = Number(params.get('dist') || 0) || Math.max(0.8, dogs[0].design.dims.BL * 3.6) * Math.max(1, breedIds.length * 0.7);
  const makeCam = (dir: THREE.Vector3, zoom = 1, tgt = target) => {
    const c = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    c.position.copy(tgt).addScaledVector(dir.normalize(), dist / zoom);
    c.lookAt(tgt);
    cams.push(c);
    return c;
  };
  let controls: OrbitControls | null = null;
  if (views === 'head') {
    const dd = dogs[0].design.dims;
    const headT = new THREE.Vector3(0, dd.atlas[1] + 0.01, dd.atlas[2] + 0.07 * dd.hs);
    const hd = 0.42 * dd.hs;
    const hc = (dir: THREE.Vector3) => { const c = new THREE.PerspectiveCamera(30, 1, 0.01, 50); c.position.copy(headT).addScaledVector(dir.normalize(), hd); c.lookAt(headT); cams.push(c); };
    hc(new THREE.Vector3(1, 0.05, 0));
    hc(new THREE.Vector3(0.7, 0.25, 1));
    hc(new THREE.Vector3(0, 0.08, 1));
    hc(new THREE.Vector3(0.02, 1, 0.25));
  } else if (views === 'quad') {
    makeCam(new THREE.Vector3(1, 0.15, 0));
    makeCam(new THREE.Vector3(0.9, 0.35, 1));
    makeCam(new THREE.Vector3(0, 0.1, 1));
    const headT = new THREE.Vector3(0, dogs[0].design.dims.atlas[1], dogs[0].design.dims.atlas[2] + 0.06);
    makeCam(new THREE.Vector3(0.6, 0.25, 1), 3.2, headT);
  } else {
    const c = makeCam(new THREE.Vector3(0.9, 0.35, 1));
    controls = new OrbitControls(c, renderer.domElement);
    controls.target.copy(target);
  }

  const timer = new THREE.Timer();
  (window as any).__rigs = rigs;
  function frame() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    timer.update();
    const t = timer.getElapsed();
    const dt = Math.min(0.05, timer.getDelta());
    for (const r of rigs) r.update(params.has('freeze') ? 0.0001 : dt);
    for (const d of dogs) {
      d.uniforms.uTime.value = t;
      const g = d.gravity;
      d.uniforms.uGravity.value.set(0, -g, 0);
    }
    renderer.setScissorTest(true);
    if (cams.length === 4) {
      const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
      const rects = [[0, hh], [hw, hh], [0, 0], [hw, 0]];
      cams.forEach((c, i) => {
        c.aspect = hw / hh; c.updateProjectionMatrix();
        renderer.setViewport(rects[i][0], rects[i][1], hw, hh);
        renderer.setScissor(rects[i][0], rects[i][1], hw, hh);
        renderer.render(scene, c);
      });
    } else {
      cams[0].aspect = w / h; cams[0].updateProjectionMatrix();
      renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
      controls?.update();
      renderer.render(scene, cams[0]);
    }
    requestAnimationFrame(frame);
  }
  frame();
}
