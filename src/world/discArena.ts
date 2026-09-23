// The Disc Competition field: a long striped lawn with painted distance lines
// every 10 m out to 60 m, a throw line, spectator stands, flags, bunting, sponsor
// boards and a scoreboard. Also exports the "event venue" helpers that the
// agility course reuses.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Bounds, DiscArena } from './types';
import {
  Atlas, Batch, Kit, MeshBuilder, ROUNDED, TreeFactory, addBench, boxGeo, centerText, createFlags, createGrassField,
  createKit, createOutdoorLights, cylGeo, drawBone, drawPaw, fbm2, flagGeo, flatRect, makeCanvas, makeGrassMaterial,
  mul, mulberry32, prepGeometry, roundRect, terrain, tm, type AtlasRect, type Flags,
} from './town';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// =============================================================================
// Venue atlas (banners, flags, painted numbers, arch banners, course numbers)
// =============================================================================

const BANNER_COLS = ['#e8505b', '#f2a33a', '#3a9d5d', '#2a74c9', '#8e5bd9', '#f2c14e'];

export function buildVenueAtlas(atlas: Atlas) {
  // plain white, for vertex-coloured cloth that shares the atlas material
  atlas.add('white', 16, 16, (g, r, w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); });
  // painted distance numbers (transparent background, used with alpha test)
  for (let k = 1; k <= 6; k++) {
    atlas.add('dist' + k, 256, 128, (g, r, w, h) => {
      g.clearRect(0, 0, w, h);
      centerText(g, `${k * 10} m`, w / 2, h / 2 + 4, w - 20, 104, ROUNDED, '#fbfbf6');
    });
  }
  atlas.add('bannerDisc', 1024, 128, (g, r, w, h) => {
    g.fillStyle = '#2a4d9e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2c14e'; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10);
    centerText(g, 'DISC COMPETITION', w / 2, h / 2 + 3, w - 260, 78, ROUNDED, '#ffffff');
    for (const x of [70, w - 70]) {
      g.fillStyle = '#f28c28'; g.beginPath(); g.ellipse(x, h / 2, 46, 20, -0.25, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d06a14'; g.beginPath(); g.ellipse(x, h / 2 - 2, 30, 11, -0.25, 0, Math.PI * 2); g.fill();
    }
  });
  atlas.add('bannerAgility', 1024, 128, (g, r, w, h) => {
    g.fillStyle = '#2f7a4a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2c14e'; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10);
    centerText(g, 'AGILITY TRIAL', w / 2, h / 2 + 3, w - 260, 78, ROUNDED, '#ffffff');
    g.fillStyle = '#fff';
    for (const x of [70, w - 70]) { g.fillRect(x - 40, 30, 10, 70); g.fillRect(x + 30, 30, 10, 70); g.fillRect(x - 40, 56, 80, 10); }
  });
  atlas.add('bannerShop', 512, 128, (g, r, w, h) => {
    g.fillStyle = '#16847d'; g.fillRect(0, 0, w, h);
    centerText(g, 'Pet Supply', w / 2 + 30, h / 2 + 3, w - 150, 70, ROUNDED, '#fff4dc');
    g.fillStyle = '#ffd166'; drawPaw(g, 60, h / 2, 70);
  });
  atlas.add('bannerGo', 512, 128, (g, r, w, h) => {
    g.fillStyle = '#e8505b'; g.fillRect(0, 0, w, h);
    centerText(g, 'Go Puppies!', w / 2, h / 2 + 3, w - 60, 72, ROUNDED, '#ffffff');
  });
  atlas.add('bannerBone', 512, 128, (g, r, w, h) => {
    g.fillStyle = '#f2c14e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    for (let k = 0; k < 4; k++) drawBone(g, 64 + k * 128, h / 2, 90, k % 2 ? 0.3 : -0.3);
  });
  atlas.add('bannerPaws', 512, 128, (g, r, w, h) => {
    g.fillStyle = '#8e5bd9'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let k = 0; k < 7; k++) drawPaw(g, 40 + k * 72, h / 2 + (k % 2 ? 22 : -22), 46);
  });
  BANNER_COLS.forEach((c, k) => {
    atlas.add('flag' + k, 192, 128, (g, r, w, h) => {
      g.fillStyle = c; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      if (k % 3 === 0) drawPaw(g, w / 2, h / 2, 76);
      else if (k % 3 === 1) drawBone(g, w / 2, h / 2, 110, -0.25);
      else { g.beginPath(); g.ellipse(w / 2, h / 2, 50, 22, -0.25, 0, Math.PI * 2); g.fill(); g.fillStyle = c; g.beginPath(); g.ellipse(w / 2, h / 2 - 2, 32, 12, -0.25, 0, Math.PI * 2); g.fill(); }
    });
  });
  for (const word of ['START', 'FINISH']) {
    atlas.add('arch' + word, 512, 128, (g, r, w, h) => {
      g.fillStyle = word === 'START' ? '#2a74c9' : '#e8505b'; roundRect(g, 0, 0, w, h, 20); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 6; roundRect(g, 8, 8, w - 16, h - 16, 16); g.stroke();
      centerText(g, word, w / 2, h / 2 + 4, w - 80, 86, ROUNDED, '#ffffff');
    });
  }
  for (let k = 1; k <= 9; k++) {
    atlas.add('num' + k, 128, 128, (g, r, w, h) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#e8505b'; g.beginPath(); g.arc(w / 2, h / 2, 56, 0, Math.PI * 2); g.fill();
      centerText(g, String(k), w / 2, h / 2 + 4, 80, 84, ROUNDED, '#ffffff');
    });
  }
  atlas.add('tentStripe', 128, 128, (g, r, w, h) => {
    for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? '#ffffff' : '#2a74c9'; g.fillRect((k * w) / 4, 0, w / 4, h); }
  });
}

// =============================================================================
// Venue helpers
// =============================================================================

export interface Seat { pos: THREE.Vector3; yaw: number }

/** Aluminium bleachers along local x (length L), rows rising towards -z, facing +z. Returns seat spots. */
export function addBleachers(b: Batch, M: THREE.Matrix4, L: number, rows: number, r: () => number, occupancy = 0.65): Seat[] {
  const seats: Seat[] = [];
  const rise = 0.42, depth = 0.78;
  const metal = '#b8bec4', frame = '#7d858c';
  const yaw = Math.atan2(V(0, 0, 1).transformDirection(M).x, V(0, 0, 1).transformDirection(M).z);
  for (let k = 0; k < rows; k++) {
    const y = 0.45 + k * rise, z = -k * depth;
    b.add('metal', boxGeo(L, 0.05, 0.32), mul(M, tm(0, y - 0.05, z)), metal);
    b.add('metal', boxGeo(L, 0.04, 0.32), mul(M, tm(0, y - rise, z + 0.4)), '#9aa1a8');
    b.add('metal', boxGeo(L, rise, 0.02), mul(M, tm(0, y - rise, z + 0.24)), '#8f969c');
    for (let x = -L / 2 + 0.4; x < L / 2 - 0.3; x += 0.62) {
      if (r() < occupancy) seats.push({ pos: V(x + (r() - 0.5) * 0.15, y, z + 0.02).applyMatrix4(M), yaw: yaw + (r() - 0.5) * 0.4 });
    }
  }
  const topY = 0.45 + (rows - 1) * rise, back = -(rows - 1) * depth - 0.2;
  const n = Math.round(L / 3);
  for (let k = 0; k <= n; k++) {
    const x = -L / 2 + (k / n) * L;
    const len = Math.hypot(topY, -back + 0.6);
    b.add('metal', boxGeo(0.08, len, 0.1), mul(M, tm(x, 0, 0.5, 0, -Math.atan2(-back + 0.6, topY))), frame);
    b.add('metal', boxGeo(0.08, topY + 1.0, 0.08), mul(M, tm(x, 0, back)), frame);
    b.add('metal', boxGeo(0.05, 1.0, 0.05), mul(M, tm(x, topY, back + 0.05)), frame);
  }
  b.add('metal', boxGeo(L, 0.05, 0.05), mul(M, tm(0, topY + 0.95, back + 0.05)), frame);
  b.add('metal', boxGeo(L, 0.05, 0.05), mul(M, tm(0, topY + 0.5, back + 0.05)), frame);
  return seats;
}

export interface Crowd { group: THREE.Group; update(time: number): void; dispose(): void }

/** Simple seated spectators (instanced), gently bobbing and cheering. */
export function createCrowd(seats: Seat[], seed = 1): Crowd {
  const group = new THREE.Group();
  group.name = 'crowd';
  const r = mulberry32(seed);
  const paint = (g: THREE.BufferGeometry, c: THREE.ColorRepresentation) => prepGeometry(g, null, c, 'keep');
  const torso = mergeGeometries([
    paint(new THREE.CylinderGeometry(0.15, 0.19, 0.56, 10).translate(0, 0.32, -0.02), 0xffffff),
    paint(new THREE.BoxGeometry(0.08, 0.42, 0.1).rotateX(0.5).translate(-0.21, 0.36, 0.06), 0xffffff),
    paint(new THREE.BoxGeometry(0.08, 0.42, 0.1).rotateX(0.5).translate(0.21, 0.36, 0.06), 0xffffff),
  ])!;
  const head = mergeGeometries([
    paint(new THREE.SphereGeometry(0.11, 12, 10).translate(0, 0.74, 0), 0xffffff),
    paint(new THREE.SphereGeometry(0.117, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.755, -0.012), '#3a2a1e'),
  ])!;
  const legs = mergeGeometries([
    paint(new THREE.BoxGeometry(0.32, 0.14, 0.44).translate(0, 0.07, 0.2), 0xffffff),
    paint(new THREE.BoxGeometry(0.3, 0.44, 0.12).translate(0, -0.17, 0.4), 0xffffff),
    paint(new THREE.BoxGeometry(0.3, 0.08, 0.2).translate(0, -0.38, 0.46), '#3a3a3a'),
  ])!;
  const shirts = ['#e8505b', '#2a74c9', '#f2c14e', '#3a9d5d', '#ffffff', '#f28c28', '#8e5bd9', '#ff8fab', '#5bc0de', '#2d2d30'];
  const skins = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#ffdbac', '#f5d0b0'];
  const pants = ['#2f3e5c', '#4a4a4a', '#b8a07a', '#3c5a8a', '#6b4f3a'];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const meshes = [torso, head, legs].map((g) => {
    const m = new THREE.InstancedMesh(g, mat, seats.length);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  });
  const c = new THREE.Color();
  const phase = seats.map(() => r() * 10);
  const cheer = seats.map(() => r() < 0.25);
  seats.forEach((s, i) => {
    meshes[0].setColorAt(i, c.set(shirts[Math.floor(r() * shirts.length)]));
    meshes[1].setColorAt(i, c.set(skins[Math.floor(r() * skins.length)]));
    meshes[2].setColorAt(i, c.set(pants[Math.floor(r() * pants.length)]));
  });
  const m4 = new THREE.Matrix4();
  const place = (time: number) => {
    seats.forEach((s, i) => {
      const bob = cheer[i] ? Math.max(0, Math.sin(time * 5 + phase[i])) * 0.06 : Math.sin(time * 1.3 + phase[i]) * 0.01;
      m4.copy(tm(s.pos.x, s.pos.y + bob, s.pos.z, s.yaw + Math.sin(time * 0.4 + phase[i]) * 0.15));
      for (const m of meshes) m.setMatrixAt(i, m4);
    });
    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
  };
  place(0);
  for (const m of meshes) m.computeBoundingSphere();
  let last = -1;
  return {
    group,
    update(time) {
      if (time - last < 1 / 30) return;
      last = time;
      place(time);
    },
    dispose() { [torso, head, legs].forEach((g) => g.dispose()); mat.dispose(); },
  };
}

/** Flag pole with a waving flag (flag geometry is pushed to `flags`). */
export function addFlagPole(b: Batch, flags: THREE.BufferGeometry[], M: THREE.Matrix4, h: number, rect: AtlasRect, phase: number) {
  b.add('metal', cylGeo(0.03, 0.045, h, 8), M, '#eeeeea');
  b.add('metal', new THREE.SphereGeometry(0.06, 10, 8).translate(0, h + 0.04, 0), M, '#e2b13c');
  flags.push(flagGeo(1.2, 0.8, mul(M, tm(0.03, h - 0.1, 0)), 0xffffff, rect, phase));
}

/** Triangular pennant hanging from a string, for bunting (waves with the flag shader). */
function pennantGeo(M: THREE.Matrix4, w: number, h: number, color: THREE.ColorRepresentation, phase: number, white: AtlasRect): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pts = [[-w / 2, 0, 0], [0, 0, 0], [w / 2, 0, 0], [-w / 4, -h / 2, 0.5], [w / 4, -h / 2, 0.5], [0, -h, 1]];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(([x, y]) => [x, y, 0]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [0, 0, 1]), 3));
  const cu = (white.u0 + white.u1) / 2, cv = (white.v0 + white.v1) / 2;
  g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap(() => [cu, cv]), 2));
  g.setIndex([0, 3, 1, 1, 3, 4, 1, 4, 2, 3, 5, 4]);
  const wave = new Float32Array(pts.flatMap(([, , t]) => [t, phase]));
  prepGeometry(g, M, color, 'keep');
  g.setAttribute('aFlag', new THREE.BufferAttribute(wave, 2));
  return g;
}

/** String of pennants from a to b with some sag. */
export function addBunting(b: Batch, flags: THREE.BufferGeometry[], a: THREE.Vector3, c: THREE.Vector3, sag: number, seed: number, white: AtlasRect) {
  const d = V().subVectors(c, a);
  const len = d.length();
  const n = Math.max(2, Math.round(len / 0.55));
  const yaw = Math.atan2(-d.z, d.x);
  let prev = a.clone();
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const p = a.clone().lerp(c, t);
    p.y -= Math.sin(t * Math.PI) * sag;
    const seg = V().subVectors(p, prev);
    const sl = seg.length();
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), seg.clone().normalize());
    const m = new THREE.Matrix4().compose(prev.clone().add(p).multiplyScalar(0.5), q, V(1, 1, 1));
    b.add('trim', new THREE.CylinderGeometry(0.008, 0.008, sl, 4), m, '#f4f4f0');
    if (k < n) flags.push(pennantGeo(tm(p.x, p.y, p.z, yaw), 0.3, 0.38, BANNER_COLS[(k + seed) % BANNER_COLS.length], k * 0.7 + seed, white));
    prev = p;
  }
}

/** Striped canopy tent (square, pyramid roof) at M. */
export function addTent(b: Batch, M: THREE.Matrix4, w: number, colA: THREE.ColorRepresentation = '#2a74c9', colB: THREE.ColorRepresentation = '#ffffff') {
  const h = 2.3, peak = 3.2;
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.add('metal', cylGeo(0.035, 0.035, h, 8), mul(M, tm((x * w) / 2, 0, (z * w) / 2)), '#dddddd');
  const n = 8;
  for (let side = 0; side < 4; side++) {
    const S = mul(M, tm(0, 0, 0, (side * Math.PI) / 2));
    for (let k = 0; k < n; k++) {
      const x0 = -w / 2 + (k / n) * w, x1 = -w / 2 + ((k + 1) / n) * w;
      const mb = new MeshBuilder();
      const tri = [V(x0, h, w / 2), V(x1, h, w / 2), V(0, peak, 0)];
      mb.poly(tri);
      mb.poly([...tri].reverse());
      b.add('trim', mb.geometry(), S, k % 2 ? colA : colB, 'keep');
      b.add('trim', boxGeo(x1 - x0, 0.28, 0.01), mul(S, tm((x0 + x1) / 2, h - 0.28, w / 2)), k % 2 ? colA : colB);
    }
  }
}

/** Sponsor board: a low panel with an atlas banner on both faces, along local x. */
export function addAdBoard(b: Batch, M: THREE.Matrix4, w: number, h: number, rect: { u0: number; v0: number; u1: number; v1: number }) {
  b.add('trim', boxGeo(w, h, 0.06), M, '#f4f4f0');
  const q = new THREE.PlaneGeometry(w - 0.04, h - 0.04);
  const uv = q.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, rect.u0 + uv.getX(i) * (rect.u1 - rect.u0), rect.v0 + uv.getY(i) * (rect.v1 - rect.v0));
  b.add('facade', q.clone(), mul(M, tm(0, h / 2, 0.032)), 0xffffff, 'keep');
  b.add('facade', q, mul(M, tm(0, h / 2, -0.032, Math.PI)), 0xffffff, 'keep');
  for (const x of [-w / 2 + 0.2, w / 2 - 0.2]) b.add('metal', boxGeo(0.05, 0.3, 0.5), mul(M, tm(x, 0, -0.25)), '#888888');
}

/** Terrain with rolling hills around a flat venue rectangle, plus a belt of trees. */
export function addVenueSurroundings(kit: Kit, group: THREE.Group, flat: Bounds, seed: number, far: Batch, trees: TreeFactory, clear: Bounds) {
  const land = terrain({ flat, hole: flat, extent: 320, cell: 8, hillStart: 20, hillEnd: 250, hillHeight: 38, seed });
  const mesh = new THREE.Mesh(land.geometry, kit.materials.grass);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  group.add(mesh);
  kit.geometries.push(land.geometry);
  const r = mulberry32(seed * 7 + 1);
  for (let x = flat.minX - 300; x < flat.maxX + 300; x += 8) {
    for (let z = flat.minZ - 300; z < flat.maxZ + 300; z += 8) {
      const px = x + (r() - 0.5) * 7, pz = z + (r() - 0.5) * 7;
      if (px > clear.minX && px < clear.maxX && pz > clear.minZ && pz < clear.maxZ) continue;
      const dx = Math.max(flat.minX - px, 0, px - flat.maxX), dz = Math.max(flat.minZ - pz, 0, pz - flat.maxZ);
      const d = Math.hypot(dx, dz);
      if (d > 280) continue;
      const cl = fbm2(px / 50, pz / 50, 3, seed);
      const p = d < 30 ? 0.3 * (cl > 0.45 ? 1.6 : 0.5) : 0.1 * (cl > 0.5 ? 2 : 0.35);
      if (r() > p) continue;
      const kind = d > 50 && r() < 0.5 ? 'conifer' : r() < 0.2 ? 'conifer' : r() < 0.6 ? 'round' : 'oval';
      trees.add(far, kind, px, pz, { lod: d < 30 ? 0 : 1, shadow: false, y: land.height(px, pz) - 0.1, scale: 0.95 + r() * 0.4 });
    }
  }
}

/** Glowing scoreboard canvas. */
function scoreCanvas(): HTMLCanvasElement {
  const c = makeCanvas(1024, 512);
  const g = c.getContext('2d')!;
  g.fillStyle = '#10182e'; g.fillRect(0, 0, 1024, 512);
  g.strokeStyle = '#f2c14e'; g.lineWidth = 10; roundRect(g, 16, 16, 992, 480, 28); g.stroke();
  centerText(g, 'DISC COMPETITION', 512, 92, 900, 84, ROUNDED, '#f2c14e');
  g.fillStyle = '#233157'; roundRect(g, 60, 160, 420, 290, 20); g.fill(); roundRect(g, 544, 160, 420, 290, 20); g.fill();
  centerText(g, 'SCORE', 270, 205, 380, 46, ROUNDED, '#9fc3ff');
  centerText(g, 'THROW', 754, 205, 380, 46, ROUNDED, '#9fc3ff');
  const dots = (txt: string, x: number) => {
    g.font = `bold 150px "Courier New", monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#3b1f10'; g.fillText('888', x, 340);
    g.fillStyle = '#ff9d2e'; g.fillText(txt, x, 340);
  };
  dots('000', 270);
  dots('1/3', 754);
  g.fillStyle = '#fff'; drawPaw(g, 120, 92, 60); drawPaw(g, 904, 92, 60);
  return c;
}

// =============================================================================
// The arena
// =============================================================================

export function buildDiscArena(renderer: THREE.WebGLRenderer): DiscArena {
  const group = new THREE.Group();
  group.name = 'disc-arena';
  const kit = createKit();
  const atlas = new Atlas(2048, 1024);
  buildVenueAtlas(atlas);
  const facade = atlas.material(kit, 'facade');
  kit.mat('decal', new THREE.MeshStandardMaterial({ map: facade.map, alphaTest: 0.5, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  kit.mat('field', makeGrassMaterial(2.4, new THREE.Vector4(1, 0, 3, 0.09)));
  const b = new Batch(0);
  b.aliases = { metal: 'trim', paint: 'trim' };
  b.noCast = new Set(['field', 'decal', 'facade']);
  const far = new Batch(0);
  const trees = new TreeFactory(4);
  const flagGeos: THREE.BufferGeometry[] = [];
  const r = mulberry32(42);
  const A = atlas.rects;

  const lineSpacing = 10;
  const throwLine = V(0, 0, 0);
  const halfW = 18;
  const flat: Bounds = { minX: -40, maxX: 40, minZ: -24, maxZ: 96 };
  b.add('field', flatRect(flat.minX, flat.minZ, flat.maxX, flat.maxZ, 0), null, 0xffffff, 'box');

  // painted lines and numbers
  const white = '#f7f7f2';
  const line = (x0: number, z0: number, x1: number, z1: number, col: THREE.ColorRepresentation = white) => b.add('paint', flatRect(x0, z0, x1, z1, 0.012), null, col);
  for (let k = 1; k <= 6; k++) {
    const z = k * lineSpacing;
    line(-halfW, z - 0.08, halfW, z + 0.08);
    for (const x of [-10, 0, 10]) {
      // painted long along z so the numbers read well from the throw line
      const q = new THREE.PlaneGeometry(3.2, 2.6);
      const uv = q.attributes.uv, R = A['dist' + k];
      for (let i = 0; i < uv.count; i++) uv.setXY(i, R.u0 + uv.getX(i) * (R.u1 - R.u0), R.v0 + uv.getY(i) * (R.v1 - R.v0));
      q.rotateX(-Math.PI / 2).rotateY(Math.PI);
      b.add('decal', q, tm(x, 0.014, z + 1.9), 0xffffff, 'keep');
    }
    // small distance flags at the line ends
    for (const x of [-halfW - 0.6, halfW + 0.6]) {
      b.add('metal', cylGeo(0.012, 0.012, 0.9, 6), tm(x, 0, z), '#f4f4f0');
      flagGeos.push(flagGeo(0.4, 0.28, tm(x, 0.88, z, x < 0 ? 0 : Math.PI), BANNER_COLS[k % BANNER_COLS.length], A.white, k));
    }
  }
  for (let z = 5; z < 60; z += 10) line(-halfW, z - 0.03, halfW, z + 0.03, '#e9eee4');
  line(-halfW - 0.08, -3, -halfW + 0.08, 64);
  line(halfW - 0.08, -3, halfW + 0.08, 64);
  line(-halfW, 63.92, halfW, 64.08);
  // throw line and box
  line(-4, -0.1, 4, 0.1, '#e8505b');
  line(-4, -3.08, 4, -2.92);
  line(-4.08, -3, -3.92, 0);
  line(3.92, -3, 4.08, 0);

  // sponsor boards along both sides and behind the far end
  const boards = [A.bannerDisc, A.bannerShop, A.bannerGo, A.bannerBone, A.bannerPaws, A.bannerDisc];
  for (const s of [-1, 1]) {
    for (let k = 0; k < 11; k++) {
      const z = -4 + k * 6.6;
      addAdBoard(b, tm(s * (halfW + 3), 0, z + 3.2, s * Math.PI / 2), 6.4, 0.9, boards[(k + (s > 0 ? 2 : 0)) % boards.length]);
    }
  }
  for (let k = -2; k <= 2; k++) addAdBoard(b, tm(k * 6.6, 0, 72, Math.PI), 6.4, 0.9, boards[(k + 5) % boards.length]);

  // stands with spectators, bunting along their fronts
  const seats = [
    ...addBleachers(b, tm(-26, 0, 22, Math.PI / 2), 36, 6, r),
    ...addBleachers(b, tm(26, 0, 22, -Math.PI / 2), 36, 6, r),
  ];
  const crowd = createCrowd(seats, 3);
  group.add(crowd.group);
  for (const s of [-1, 1]) {
    for (let k = 0; k <= 6; k++) {
      const z = 2 + k * 6.66;
      addFlagPole(b, flagGeos, tm(s * 23.2, 0, z, s < 0 ? 0 : Math.PI), 4.2, A['flag' + ((k + (s > 0 ? 3 : 0)) % 6)], k * 1.3 + s);
      if (k < 6) addBunting(b, flagGeos, V(s * 23.2, 3.7, z), V(s * 23.2, 3.7, z + 6.66), 0.5, k * 3 + (s > 0 ? 1 : 0), A.white);
    }
  }

  // scoreboard at the far end
  const score = kit.tex(new THREE.CanvasTexture(scoreCanvas()));
  score.colorSpace = THREE.SRGBColorSpace;
  score.anisotropy = 8;
  const screenMat = kit.mat('screen', new THREE.MeshStandardMaterial({ map: score, emissiveMap: score, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.4 }));
  const SB = tm(0, 0, 80, Math.PI);
  for (const x of [-3.6, 3.6]) b.add('metal', boxGeo(0.35, 3.4, 0.35), mul(SB, tm(x, 0, -0.3)), '#50565c');
  b.add('metal', boxGeo(9.8, 5.2, 0.5), mul(SB, tm(0, 3.2, -0.3)), '#2b3036');
  b.add('metal', boxGeo(10.2, 0.25, 0.8), mul(SB, tm(0, 8.4, -0.3)), '#f2c14e');
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(9.2, 4.6), screenMat);
  screen.applyMatrix4(mul(SB, tm(0, 5.8, -0.04)));
  screen.name = 'scoreboard';
  group.add(screen);
  kit.geometries.push(screen.geometry);
  for (const [x, k] of [[-7.5, 0], [7.5, 3], [-9.5, 1], [9.5, 4]] as const) addFlagPole(b, flagGeos, tm(x, 0, 79, Math.PI), 6.5, A['flag' + k], x);

  // judges' tent, table and benches behind the throw area
  addTent(b, tm(-8.5, 0, -9, 0), 4);
  addTent(b, tm(8.5, 0, -9, 0), 4, '#e8505b');
  const T = tm(-8.5, 0, -9);
  b.add('trim', boxGeo(2.2, 0.05, 0.8), mul(T, tm(0, 0.74, 0.4)), '#f4f4f0');
  for (const [x, z] of [[-1, 0.05], [1, 0.05], [-1, 0.75], [1, 0.75]]) b.add('metal', boxGeo(0.04, 0.74, 0.04), mul(T, tm(x, 0, z)), '#888');
  b.add('trim', new THREE.CylinderGeometry(0.12, 0.12, 0.35, 16).translate(0, 0.94, 0), mul(T, tm(0.6, 0, 0.4)), '#f2c14e');
  b.add('trim', boxGeo(0.3, 0.02, 0.22), mul(T, tm(-0.5, 0.77, 0.4)), '#ffffff');
  addBench(b, tm(8.5, 0, -9.5, 0), '#a06d40');
  addBench(b, tm(3.5, 0, -12, 0), '#a06d40');
  addBench(b, tm(-3.5, 0, -12, 0), '#a06d40');
  // trees behind the throw area and the scoreboard (the stands frame the sides)
  for (const [x, z] of [[-18, -16], [-12, -19], [0, -21], [12, -19], [18, -16], [-30, -12], [30, -12], [-20, 88], [20, 88], [-32, 84], [32, 84], [-36, 60], [36, 60], [-36, 0], [36, 0]]) {
    trees.add(b, r() < 0.2 ? 'conifer' : r() < 0.5 ? 'oval' : 'round', x + (r() - 0.5) * 2, z + (r() - 0.5) * 2, { scale: 1.1 + r() * 0.3 });
  }
  addVenueSurroundings(kit, group, flat, 31, far, trees, { minX: -40, maxX: 40, minZ: -24, maxZ: 96 });

  const meshes = [...b.build(kit.materials, group), ...far.build(kit.materials, group)];
  trees.dispose();
  const flags: Flags = createFlags(flagGeos, facade.map);
  group.add(flags.mesh);

  // short mowed grass blades around the dog, kept off the painted lines
  const maskC = makeCanvas(256, 512);
  const mg = maskC.getContext('2d')!;
  mg.fillStyle = '#fff'; mg.fillRect(0, 0, 256, 512);
  mg.fillStyle = '#000';
  const sx = 256 / (flat.maxX - flat.minX), sz = 512 / (flat.maxZ - flat.minZ);
  const rect = (x0: number, z0: number, x1: number, z1: number) => mg.fillRect((x0 - flat.minX) * sx, (z0 - flat.minZ) * sz, (x1 - x0) * sx, (z1 - z0) * sz);
  for (let k = 1; k <= 6; k++) {
    rect(-halfW, k * 10 - 0.25, halfW, k * 10 + 0.25);
    for (const x of [-10, 0, 10]) rect(x - 1.5, k * 10 + 0.7, x + 1.5, k * 10 + 3.1);
  }
  rect(-4.2, -0.3, 4.2, 0.3); rect(-4.2, -3.2, 4.2, -2.8);
  rect(-halfW - 0.2, -3, -halfW + 0.2, 64); rect(halfW - 0.2, -3, halfW + 0.2, 64);
  const maskTex = kit.tex(new THREE.CanvasTexture(maskC));
  maskTex.colorSpace = THREE.NoColorSpace;
  maskTex.flipY = false;
  const grass = createGrassField({ count: 50000, tile: 16, height: [0.03, 0.07], mask: { texture: maskTex, rect: [flat.minX, flat.minZ, flat.maxX - flat.minX, flat.maxZ - flat.minZ] } });
  group.add(grass.mesh);

  const lights = createOutdoorLights(renderer, { fogNear: 70, fogFar: 420, shadowSize: 20, sunIntensity: 2.8, hemi: 0.4, sunDir: V(-0.5, 0.75, -0.35) });
  group.add(lights.group);

  return {
    group,
    environment: lights.environment,
    background: lights.background,
    fog: lights.fog,
    sun: lights.sun,
    bounds: { minX: -halfW - 1, maxX: halfW + 1, minZ: -6, maxZ: 70 },
    obstacles: [],
    camera: { position: V(0, 1.7, -6.5), target: V(0, 0.4, 14), fov: 50 },
    throwLine,
    lineSpacing,
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

