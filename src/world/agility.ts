// Outdoor agility trial for puppies: start and finish arches and eight obstacles
// (hurdles, tire, weave poles, A-frame, tunnel) in a looping order inside a
// roped 30 x 30 m ring, with stands, a judges' tent, flags and a timer board.

import * as THREE from 'three';
import type { AgilityCourse, AgilityObstacle, AgilityObstacleKind, Bounds, Circle } from './types';
import {
  Atlas, Batch, ROUNDED, TreeFactory, addBench, atlasQuad, boxGeo, centerText, createFlags, createGrassField,
  createKit, createOutdoorLights, cylGeo, drawPaw, flatRect, makeCanvas, makeGrassMaterial, mul, mulberry32, roundRect,
  tm, type AtlasRect, type Kit,
} from './town';
import { addAdBoard, addBleachers, addBunting, addFlagPole, addTent, addVenueSurroundings, buildVenueAtlas, createCrowd } from './discArena';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const WHITE = '#f6f5f0';

// Each builder works in a local frame where the dog travels along +z through the origin.

function stripedBar(b: Batch, M: THREE.Matrix4, len: number, r: number, colA: THREE.ColorRepresentation, colB: THREE.ColorRepresentation, segs = 6) {
  const s = len / segs;
  for (let k = 0; k < segs; k++) {
    b.add('trim', new THREE.CylinderGeometry(r, r, s, 10).rotateZ(Math.PI / 2), mul(M, tm(-len / 2 + s * (k + 0.5), 0, 0)), k % 2 ? colA : colB);
  }
}

function hurdle(b: Batch, color: THREE.ColorRepresentation, barY = 0.15) {
  for (const s of [-1, 1]) {
    const x = s * 0.6;
    b.add('trim', boxGeo(0.05, 0.62, 0.05), tm(x, 0, 0), WHITE);
    b.add('trim', boxGeo(0.06, 0.04, 0.55), tm(x, 0, 0), WHITE);
    // wing panel
    const wx = x + s * 0.2;
    b.add('trim', boxGeo(0.04, 0.5, 0.04), tm(x + s * 0.38, 0, 0), WHITE);
    for (const y of [0.1, 0.25, 0.4]) b.add('trim', boxGeo(0.34, 0.07, 0.03), tm(wx, y, 0), color);
    b.add('trim', boxGeo(0.4, 0.04, 0.04), tm(wx, 0.5, 0), WHITE);
    b.add('trim', boxGeo(0.04, 0.03, 0.45), tm(x + s * 0.38, 0, 0), WHITE);
    // bar cups
    b.add('trim', boxGeo(0.07, 0.04, 0.07), tm(x - s * 0.03, barY - 0.04, 0), '#333333');
  }
  stripedBar(b, tm(0, barY, 0), 1.2, 0.018, color, WHITE, 8);
}

function tireJump(b: Batch) {
  const frame = '#2a74c9', tireY = 0.38, R = 0.26, tube = 0.065;
  for (const s of [-1, 1]) {
    b.add('trim', boxGeo(0.06, 1.12, 0.06), tm(s * 0.72, 0, 0), frame);
    b.add('trim', boxGeo(0.07, 0.05, 0.8), tm(s * 0.72, 0, 0), frame);
  }
  b.add('trim', boxGeo(1.5, 0.06, 0.06), tm(0, 1.1, 0), frame);
  const segs = 10;
  for (let k = 0; k < segs; k++) {
    b.add('trim', new THREE.TorusGeometry(R, tube, 8, 5, (Math.PI * 2) / segs).rotateZ((k * Math.PI * 2) / segs), tm(0, tireY, 0), k % 2 ? '#f2c14e' : '#222326');
  }
  const rope = (a: THREE.Vector3, c: THREE.Vector3) => {
    const d = V().subVectors(c, a);
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
    b.add('trim', new THREE.CylinderGeometry(0.008, 0.008, d.length(), 5), new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, V(1, 1, 1)), '#dddddd');
  };
  rope(V(-0.15, tireY + R + tube * 0.5, 0), V(-0.3, 1.08, 0));
  rope(V(0.15, tireY + R + tube * 0.5, 0), V(0.3, 1.08, 0));
  rope(V(-R - tube, tireY, 0), V(-0.69, tireY, 0));
  rope(V(R + tube, tireY, 0), V(0.69, tireY, 0));
}

function weavePoles(b: Batch, n: number, spacing: number) {
  const len = (n - 1) * spacing;
  b.add('trim', boxGeo(0.07, 0.02, len + 0.3), tm(0, 0, 0), '#9aa1a8');
  for (let k = 0; k < n; k++) {
    const z = -len / 2 + k * spacing;
    b.add('trim', boxGeo(0.4, 0.015, 0.05), tm(0, 0, z), '#9aa1a8');
    b.add('trim', cylGeo(0.013, 0.013, 0.62, 8), tm(0, 0.02, z), WHITE);
    for (const y of [0.12, 0.3, 0.48]) b.add('trim', cylGeo(0.0145, 0.0145, 0.07, 8), tm(0, y, z), k % 2 ? '#e8505b' : '#2a74c9');
  }
}

function aFrame(b: Batch, half: number, peak: number, width: number) {
  const slope = Math.hypot(half, peak);
  const ang = Math.atan2(peak, half);
  const contact = 0.45;
  for (const s of [-1, 1]) {
    // s = -1 is the up ramp (z < 0), s = 1 the down ramp
    const along = (t: number) => V(0, peak * (1 - t / slope) , s * (half * t) / slope);
    const piece = (t0: number, t1: number, col: THREE.ColorRepresentation) => {
      const mid = along((t0 + t1) / 2);
      const g = new THREE.BoxGeometry(width, 0.05, t1 - t0).rotateX(s * ang);
      b.add('trim', g, tm(mid.x, mid.y + 0.02, mid.z), col);
    };
    piece(0, slope - contact, '#2a74c9');
    piece(slope - contact, slope, '#f2c14e');
    for (let t = 0.2; t < slope - 0.05; t += 0.28) {
      const p = along(t);
      b.add('trim', new THREE.BoxGeometry(width - 0.04, 0.02, 0.025).rotateX(s * ang), tm(p.x, p.y + 0.055, p.z), WHITE);
    }
    for (const sx of [-1, 1]) {
      const mid = along(slope / 2);
      b.add('trim', new THREE.BoxGeometry(0.04, 0.09, slope).rotateX(s * ang), tm(sx * (width / 2 + 0.02), mid.y + 0.01, mid.z), '#e8e8e4');
    }
  }
  // spreader chains and apex hinge
  for (const sx of [-1, 1]) b.add('trim', boxGeo(0.02, 0.02, half * 1.0), tm(sx * (width / 2 - 0.05), peak * 0.45, 0), '#777777');
  b.add('trim', new THREE.CylinderGeometry(0.03, 0.03, width + 0.06, 10).rotateZ(Math.PI / 2), tm(0, peak + 0.03, 0), '#888888');
}

function tunnel(b: Batch, len: number, R: number) {
  const segZ = Math.round(len / 0.125);
  const outer = new THREE.CylinderGeometry(R, R, len, 24, segZ, true).rotateX(Math.PI / 2);
  const inner = new THREE.CylinderGeometry(R - 0.015, R - 0.015, len, 24, segZ, true).rotateX(Math.PI / 2);
  for (const [g, s] of [[outer, 1], [inner, -1]] as const) {
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const rib = Math.cos((z / 0.25) * Math.PI * 2);
      const k = 1 + rib * 0.07 * s;
      p.setXYZ(i, x * k, y * k, z);
      const v = s > 0 ? 0.78 + rib * 0.22 : 0.55;
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    if (s < 0) {
      const idx = g.index!;
      for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
      g.computeVertexNormals();
    }
    b.add('trim', g, tm(0, R, 0), '#2e6fd0', 'keep');
  }
  // rims and sandbags
  for (const z of [-len / 2, len / 2]) b.add('trim', new THREE.TorusGeometry(R, 0.02, 6, 24), tm(0, R, z), '#f2c14e');
  for (const z of [-len / 3, 0, len / 3]) {
    // a strap draped over the top of the tube
    const bag = new THREE.CylinderGeometry(R + 0.05, R + 0.05, 0.28, 16, 1, true, -Math.PI * 0.5, Math.PI).rotateX(-Math.PI / 2);
    b.add('trim', bag, tm(0, R, z), '#1d3570');
    for (const s of [-1, 1]) b.add('trim', boxGeo(0.14, 0.12, 0.3), tm(s * (R + 0.08), 0, z), '#1d3570');
  }
}

function arch(b: Batch, rect: AtlasRect, color: THREE.ColorRepresentation) {
  const R = 1.55, tube = 0.17, segs = 12;
  for (let k = 0; k < segs; k++) {
    b.add('trim', new THREE.TorusGeometry(R, tube, 10, 4, Math.PI / segs).rotateZ((k * Math.PI) / segs), tm(0, 0.05, 0), k % 2 ? WHITE : color);
  }
  for (const s of [-1, 1]) {
    b.add('trim', cylGeo(tube + 0.03, tube + 0.06, 0.12, 14), tm(s * R, 0, 0), '#333333');
    b.add('trim', boxGeo(0.12, 0.9, 0.12), tm(s * (R - 0.45), 0, 0.3), '#3a3a3a');
    b.add('trim', boxGeo(0.14, 0.1, 0.1), tm(s * (R - 0.45), 0.55, 0.36), '#e8505b');
  }
  for (const [ry, dz] of [[0, 0.2], [Math.PI, -0.2]] as const) {
    b.add('trim', boxGeo(2.1, 0.62, 0.04), tm(0, R - 0.1, dz * 0.9, ry), WHITE);
    b.add('facade', atlasQuad(2.0, 0.5, rect), tm(0, R + 0.2, dz, ry), 0xffffff, 'keep');
  }
}

function timerCanvas(): HTMLCanvasElement {
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d')!;
  g.fillStyle = '#10182e'; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#3a9d5d'; g.lineWidth = 8; roundRect(g, 8, 8, 496, 240, 18); g.stroke();
  centerText(g, 'AGILITY', 256, 52, 420, 44, ROUNDED, '#9fd36b');
  g.font = 'bold 110px "Courier New", monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#1f2a18'; g.fillText('88:88', 256, 160);
  g.fillStyle = '#ff9d2e'; g.fillText('00:00', 256, 160);
  g.fillStyle = '#fff'; drawPaw(g, 60, 52, 34); drawPaw(g, 452, 52, 34);
  return c;
}

export function buildAgilityCourse(renderer: THREE.WebGLRenderer): AgilityCourse {
  const group = new THREE.Group();
  group.name = 'agility';
  const kit: Kit = createKit();
  const atlas = new Atlas(2048, 1024);
  buildVenueAtlas(atlas);
  const facade = atlas.material(kit, 'facade');
  kit.mat('field', makeGrassMaterial(2.4, new THREE.Vector4(0.7071, 0.7071, 2.5, 0.08)));
  const A = atlas.rects;
  const r = mulberry32(5);
  const b = new Batch(0);
  b.aliases = { metal: 'trim', paint: 'trim' };
  b.noCast = new Set(['field', 'facade']);
  const far = new Batch(0);
  const trees = new TreeFactory(4);
  const flagGeos: THREE.BufferGeometry[] = [];
  const obstacles: Circle[] = [];
  const meshes: THREE.Mesh[] = [];

  const flat: Bounds = { minX: -32, maxX: 32, minZ: -32, maxZ: 32 };
  b.add('field', flatRect(flat.minX, flat.minZ, flat.maxX, flat.maxZ, 0), null, 0xffffff, 'box');

  // ------------------------------------------------------------------ the course
  const N = V(0, 0, -1), E = V(1, 0, 0), S = V(0, 0, 1), W = V(-1, 0, 0);
  const plan: { kind: AgilityObstacleKind; at: [number, number]; dir: THREE.Vector3; length: number; color?: string }[] = [
    { kind: 'start', at: [-8, 9], dir: N, length: 0.4 },
    { kind: 'hurdle', at: [-8, 4.5], dir: N, length: 0.3, color: '#e8505b' },
    { kind: 'tire', at: [-8, -0.5], dir: N, length: 0.3 },
    { kind: 'weave', at: [-8, -6.5], dir: N, length: 4.2 },
    { kind: 'hurdle', at: [-2.5, -10.5], dir: E, length: 0.3, color: '#2a74c9' },
    { kind: 'aframe', at: [3.5, -10.5], dir: E, length: 3.0 },
    { kind: 'hurdle', at: [9, -5.5], dir: S, length: 0.3, color: '#f2a33a' },
    { kind: 'tunnel', at: [9, 0.8], dir: S, length: 3.6 },
    { kind: 'hurdle', at: [4.5, 7.5], dir: W, length: 0.3, color: '#3a9d5d' },
    { kind: 'finish', at: [-1.5, 9.2], dir: W, length: 0.4 },
  ];
  const course: AgilityObstacle[] = [];
  let number = 0;
  for (const p of plan) {
    const ob = new Batch(0);
    ob.aliases = b.aliases;
    switch (p.kind) {
      case 'hurdle': hurdle(ob, p.color!); break;
      case 'tire': tireJump(ob); break;
      case 'weave': weavePoles(ob, 8, 0.6); break;
      case 'aframe': aFrame(ob, 1.5, 0.55, 0.8); break;
      case 'tunnel': tunnel(ob, p.length, 0.27); break;
      case 'start': arch(ob, A.archSTART, '#2a74c9'); break;
      case 'finish': arch(ob, A.archFINISH, '#e8505b'); break;
    }
    const object = new THREE.Group();
    object.name = 'agility-' + p.kind;
    meshes.push(...ob.build(kit.materials, object));
    const yaw = Math.atan2(p.dir.x, p.dir.z);
    object.position.set(p.at[0], 0, p.at[1]);
    object.rotation.y = yaw;
    group.add(object);
    course.push({ kind: p.kind, position: V(p.at[0], 0, p.at[1]), dir: p.dir.clone(), length: p.length, object });
    // side posts the dog should not bump into
    const side = V(p.dir.z, 0, -p.dir.x);
    const post = (d: number, rad: number) => obstacles.push({ x: p.at[0] + side.x * d, z: p.at[1] + side.z * d, r: rad });
    if (p.kind === 'hurdle') { post(-0.8, 0.25); post(0.8, 0.25); }
    if (p.kind === 'tire') { post(-0.72, 0.15); post(0.72, 0.15); }
    if (p.kind === 'start' || p.kind === 'finish') { post(-1.55, 0.3); post(1.55, 0.3); }
    // numbered marker to the right of each numbered obstacle
    if (p.kind !== 'start' && p.kind !== 'finish') {
      number++;
      const off = p.kind === 'tunnel' || p.kind === 'aframe' ? 0.9 : 1.25;
      const mx = p.at[0] + side.x * off - p.dir.x * (p.length / 2 + 0.3), mz = p.at[1] + side.z * off - p.dir.z * (p.length / 2 + 0.3);
      const M = tm(mx, 0, mz, yaw + Math.PI);
      for (const s of [1, -1]) {
        const lean = mul(M, tm(0, 0, s * 0.09, s < 0 ? Math.PI : 0, -0.25));
        b.add('trim', boxGeo(0.34, 0.42, 0.02), mul(lean, tm(0, 0, 0)), WHITE);
        b.add('facade', atlasQuad(0.3, 0.3, A['num' + number]), mul(lean, tm(0, 0.23, 0.012)), 0xffffff, 'keep');
      }
      obstacles.push({ x: mx, z: mz, r: 0.3 });
    }
  }

  // ------------------------------------------------------------------ ring, stands, tent, flags
  const ring = 15;
  const ropePost = (x: number, z: number) => {
    b.add('trim', cylGeo(0.035, 0.04, 0.75, 8), tm(x, 0, z), WHITE);
    b.add('trim', new THREE.SphereGeometry(0.05, 8, 6).translate(0, 0.77, 0), tm(x, 0, z), '#e8505b');
  };
  const rope = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 2.5));
    for (let k = 0; k < n; k++) {
      const ax = x0 + ((x1 - x0) * k) / n, az = z0 + ((z1 - z0) * k) / n;
      const bx = x0 + ((x1 - x0) * (k + 1)) / n, bz = z0 + ((z1 - z0) * (k + 1)) / n;
      ropePost(ax, az);
      const seg = Math.hypot(bx - ax, bz - az);
      const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(bx - ax, 0, bz - az).normalize());
      b.add('trim', new THREE.CylinderGeometry(0.012, 0.012, seg, 5), new THREE.Matrix4().compose(V((ax + bx) / 2, 0.66, (az + bz) / 2), q, V(1, 1, 1)), '#f4f1e6');
    }
    ropePost(x1, z1);
  };
  rope(-ring, -ring, ring, -ring);
  rope(ring, -ring, ring, ring);
  rope(ring, ring, -3, ring);
  rope(-7, ring, -ring, ring);
  rope(-ring, ring, -ring, -ring);
  // stands on the north side, sponsor boards in front
  const seats = addBleachers(b, tm(0, 0, -19.5, 0), 26, 5, r);
  const crowd = createCrowd(seats, 9);
  group.add(crowd.group);
  const boards = [A.bannerAgility, A.bannerShop, A.bannerGo, A.bannerPaws];
  for (let k = -2; k <= 2; k++) addAdBoard(b, tm(k * 6.4, 0, -17, 0), 6.2, 0.9, boards[(k + 4) % boards.length]);
  // judges' tent and timer on the east side
  addTent(b, tm(20, 0, 4, Math.PI / 2), 4, '#3a9d5d');
  const T = tm(20, 0, 4, -Math.PI / 2);
  b.add('trim', boxGeo(2.2, 0.05, 0.8), mul(T, tm(0, 0.74, 0)), WHITE);
  for (const [x, z] of [[-1, -0.35], [1, -0.35], [-1, 0.35], [1, 0.35]]) b.add('trim', boxGeo(0.04, 0.74, 0.04), mul(T, tm(x, 0, z)), '#888');
  addTent(b, tm(20, 0, -3, Math.PI / 2), 4, '#e8505b');
  addBench(b, tm(20, 0, -3, -Math.PI / 2), '#a06d40');
  const timer = kit.tex(new THREE.CanvasTexture(timerCanvas()));
  timer.colorSpace = THREE.SRGBColorSpace;
  const screenMat = kit.mat('screen', new THREE.MeshStandardMaterial({ map: timer, emissiveMap: timer, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.4 }));
  const TB = tm(5, 0, 19, Math.PI);
  for (const x of [-1.3, 1.3]) b.add('trim', boxGeo(0.14, 2.2, 0.14), mul(TB, tm(x, 0, -0.1)), '#50565c');
  b.add('trim', boxGeo(3.3, 1.75, 0.25), mul(TB, tm(0, 1.9, -0.1)), '#2b3036');
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 1.55), screenMat);
  screen.applyMatrix4(mul(TB, tm(0, 2.775, 0.03)));
  screen.name = 'timer';
  group.add(screen);
  kit.geometries.push(screen.geometry);
  // flags at the ring corners and bunting on the ring
  let fk = 0;
  for (const [x, z] of [[-ring - 1, -ring - 1], [ring + 1, -ring - 1], [ring + 1, ring + 1], [-ring - 1, ring + 1], [-ring - 1, 0], [ring + 1, 0]]) {
    addFlagPole(b, flagGeos, tm(x, 0, z, Math.atan2(-x, -z) + Math.PI / 2), 4.5, A['flag' + (fk % 6)], fk * 1.3);
    fk++;
  }
  const corners = [V(-ring - 1, 3.9, -ring - 1), V(-ring - 1, 3.9, 0), V(-ring - 1, 3.9, ring + 1), V(ring + 1, 3.9, ring + 1), V(ring + 1, 3.9, 0), V(ring + 1, 3.9, -ring - 1)];
  for (let k = 0; k < corners.length - 1; k++) {
    if (k === 2) continue;
    addBunting(b, flagGeos, corners[k], corners[k + 1], 0.8, k * 5, A.white);
  }
  // benches for handlers by the entrance, trees around
  addBench(b, tm(-12, 0, 19, Math.PI), '#a06d40');
  addBench(b, tm(-8, 0, 19, Math.PI), '#a06d40');
  for (const [x, z] of [[-26, -24], [-22, -28], [24, -26], [28, -20], [-28, 10], [-27, 24], [26, 22], [18, 27], [-12, 27], [0, 29], [28, 8]]) {
    trees.add(b, r() < 0.2 ? 'conifer' : r() < 0.5 ? 'oval' : 'round', x + (r() - 0.5) * 2, z + (r() - 0.5) * 2, { scale: 1.1 + r() * 0.3 });
  }
  addVenueSurroundings(kit, group, flat, 47, far, trees, flat);

  meshes.push(...b.build(kit.materials, group), ...far.build(kit.materials, group));
  trees.dispose();
  const flags = createFlags(flagGeos, facade.map);
  group.add(flags.mesh);

  // short grass blades around the dog (obstacle bases sit on top of them)
  const grass = createGrassField({ count: 50000, tile: 16, height: [0.03, 0.07] });
  group.add(grass.mesh);

  const lights = createOutdoorLights(renderer, { fogNear: 60, fogFar: 400, shadowSize: 18, sunIntensity: 2.8, hemi: 0.4, sunDir: V(0.45, 0.75, 0.5) });
  group.add(lights.group);

  return {
    group,
    environment: lights.environment,
    background: lights.background,
    fog: lights.fog,
    sun: lights.sun,
    bounds: { minX: -ring + 0.5, maxX: ring - 0.5, minZ: -ring + 0.5, maxZ: ring - 0.5 },
    obstacles,
    camera: { position: V(0, 7.5, 21), target: V(0, 0, 0), fov: 50 },
    course,
    update(dt, time, focus) {
      lights.update(time, focus);
      flags.update(time);
      crowd.update(time);
      grass.update(time, focus);
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      flags.dispose();
      crowd.dispose();
      grass.dispose();
      lights.dispose();
      kit.dispose();
    },
  };
}
