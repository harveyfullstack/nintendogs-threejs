// The free-play park: a big fenced lawn for fetch and frisbee, ringed by a winding
// gravel path, trees, benches, flower beds and a pond, with the neighbourhood's
// houses across the road outside the fence and hills beyond.

import * as THREE from 'three';
import { physicalMaterial } from './materials';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Circle, Place } from './types';
import {
  Atlas, Batch, CAR_COLORS, FlowerSink, GREENS, MeshBuilder, ROUNDED, SERIF, TreeFactory, TreeKind,
  addBench, addFencePost, addIronFence, addStreetLamp, boxGeo, buildFacadeAtlas, buildLot, canvasTexture,
  centerText, createCars, createGrassField, createKit, createOutdoorLights, cylGeo, drawBone, drawPaw, fbm2,
  flatRect, hash2, hedgeGeo, makeCanvas, mul, mulberry32, prepGeometry, roundRect, shrubGeo, signBoard, terrain, tm,
  woodBoard, type CarPlacement, type LotCtx, farBatch,
} from './town';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Half-size of the fenced park and the ring of streets around it. */
const PARK = 40;
const FENCE = 39;
const ROAD_IN = 42.6, ROAD_OUT = 49.4, LOTS = 52, LOT_D = 11;

function gravelCanvas(size = 256): HTMLCanvasElement {
  const c = makeCanvas(size);
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9b58f';
  g.fillRect(0, 0, size, size);
  const r = mulberry32(3);
  for (let i = 0; i < 2600; i++) {
    const x = r() * size, y = r() * size, s = 1 + r() * 3.2;
    const l = 55 + r() * 30;
    g.fillStyle = `hsl(${30 + r() * 20},${12 + r() * 18}%,${l}%)`;
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) {
      g.beginPath(); g.ellipse(x + dx, y + dy, s, s * (0.6 + r() * 0.4), r() * 3, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}

/** Tileable ripple normal map for the pond. */
function waterNormalCanvas(size = 256): HTMLCanvasElement {
  const c = makeCanvas(size);
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const h = (x: number, y: number) => fbm2((x / size) * 6, (y / size) * 6, 4, 17, 6);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 9, dy = (h(x, y + 1) - h(x, y - 1)) * 9;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Ribbon along a polyline in the xz-plane, with UVs in metres (u across, v along). */
function ribbon(pts: THREE.Vector3[], width: number, y: number, closed: boolean): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let dist = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t = V().subVectors(next, prev).setY(0).normalize();
    const nx = -t.z, nz = t.x;
    if (i > 0) dist += pts[i].distanceTo(pts[i - 1]);
    const p = pts[i];
    pos.push(p.x + (nx * width) / 2, y, p.z + (nz * width) / 2, p.x - (nx * width) / 2, y, p.z - (nz * width) / 2);
    uv.push(0, dist, width, dist);
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure it faces up whatever the winding
  const nrm = g.attributes.normal;
  if (nrm.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

function pondOutline(cx: number, cz: number, R: number, n = 48): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const r = R * (1 + 0.16 * Math.sin(a * 2 + 0.7) + 0.08 * Math.sin(a * 3 + 2.1) + 0.05 * Math.sin(a * 5));
    pts.push(new THREE.Vector2(cx + Math.cos(a) * r * 1.2, cz + Math.sin(a) * r * 0.85));
  }
  return pts;
}

function rockGeo(seed: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5, 1);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.75 + hash2(Math.round(x * 50) + seed, Math.round(z * 50) + Math.round(y * 30), 3) * 0.4;
    p.setXYZ(i, x * k * 1.2, y * k * 0.6, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function parkAtlas(atlas: Atlas) {
  buildFacadeAtlas(atlas);
  atlas.add('parkSign', 512, 128, (g, r, w, h) => {
    g.fillStyle = '#f0e6c8'; roundRect(g, 0, 0, w, h, 24); g.fill();
    g.fillStyle = '#2f6b3a'; roundRect(g, 8, 8, w - 16, h - 16, 18); g.fill();
    centerText(g, 'Park', w / 2, h / 2 + 4, w - 160, 84, SERIF, '#f6ecd0');
    g.fillStyle = '#9fd36b';
    for (const x of [70, w - 70]) { g.beginPath(); g.ellipse(x, h / 2, 34, 18, -0.6, 0, Math.PI * 2); g.fill(); }
  });
  atlas.add('notice', 384, 256, (g, r, w, h) => {
    woodBoard(g, w, h, '#7a5230', 7);
    g.fillStyle = '#f6f1e3'; roundRect(g, 18, 18, w - 36, h - 36, 10); g.fill();
    centerText(g, 'Dog Park', w / 2, 58, w - 80, 46, ROUNDED, '#2f6b3a');
    g.fillStyle = '#e8505b'; drawPaw(g, 58, 58, 34); drawPaw(g, w - 58, 58, 34);
    const lines = ['Off-leash play welcome', 'Please clean up after', 'your puppy. Have fun!'];
    lines.forEach((t, k) => centerText(g, t, w / 2, 112 + k * 36, w - 70, 26, ROUNDED, '#4a3a2a', '600'));
  });
  atlas.add('waste', 128, 160, (g, r, w, h) => {
    g.fillStyle = '#2f6b3a'; roundRect(g, 0, 0, w, h, 14); g.fill();
    g.fillStyle = '#fff'; drawPaw(g, w / 2, 52, 56);
    centerText(g, 'Bags', w / 2, 118, w - 20, 30, ROUNDED, '#fff');
  });
  atlas.add('bone', 128, 64, (g, r, w, h) => {
    g.fillStyle = '#f2c14e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; drawBone(g, w / 2, h / 2, 90);
  });
}

export function buildPark(renderer: THREE.WebGLRenderer): Place {
  const group = new THREE.Group();
  group.name = 'park';
  const kit = createKit();
  const atlas = new Atlas(2048, 1024);
  parkAtlas(atlas);
  atlas.material(kit, 'facade');
  kit.mat('gravel', new THREE.MeshStandardMaterial({ map: canvasTexture(gravelCanvas(), 1.6), roughness: 0.95, vertexColors: true }));
  const waterNormal = canvasTexture(waterNormalCanvas(), 9, false);
  kit.tex(waterNormal);
  // low specular intensity caps the grazing-angle sky reflection so the pond reads as water, not ice
  kit.mat('water', physicalMaterial({ color: '#1b3f38', roughness: 0.1, metalness: 0, specularIntensity: 0.35, normalMap: waterNormal, normalScale: new THREE.Vector2(0.18, 0.18) }));

  const b = new Batch([44, 44], { x: -66, z: -66 });
  b.aliases = { metal: 'trim', paint: 'trim', dirt: 'concrete' };
  b.noCast = new Set(['facade', 'grass', 'sidewalk', 'asphalt', 'gravel']);
  b.chunked = new Set(['trim', 'foliage', 'leafCard', 'bark']);
  const far = farBatch();
  const trees = new TreeFactory(4);
  const flowers = new FlowerSink();
  const shrubs = Array.from({ length: 6 }, (_, k) => shrubGeo(k * 13 + 1, 1, 0.8));
  const cars: CarPlacement[] = [];
  const ctx: LotCtx = { b, atlas, flowers, shrubs, trees, cars };
  const obstacles: Circle[] = [];
  const r = mulberry32(8);

  // ------------------------------------------------------------------ ground
  const pondC = { x: 26, z: -25 };
  const outline = pondOutline(pondC.x, pondC.z, 6.2);
  const groundShape = new THREE.Shape([new THREE.Vector2(-PARK, -PARK), new THREE.Vector2(PARK, -PARK), new THREE.Vector2(PARK, PARK), new THREE.Vector2(-PARK, PARK)]);
  groundShape.holes.push(new THREE.Path(outline));
  const ground = new THREE.ShapeGeometry(groundShape);
  // shape is in xy; lay it down so shape y becomes world z
  ground.rotateX(Math.PI / 2);
  const gp = ground.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setY(i, 0);
  ground.computeVertexNormals();
  if (ground.attributes.normal.getY(0) < 0) {
    const idx = ground.index!;
    for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
    ground.computeVertexNormals();
  }
  b.anchor = { x: 0, z: 0 };
  b.add('grass', ground, null, 0xffffff, 'box');
  // lot lawns around the streets
  const L1 = LOTS + LOT_D + 1;
  for (const [x0, z0, x1, z1] of [[-L1, -L1, L1, -LOTS], [-L1, LOTS, L1, L1], [LOTS, -LOTS, L1, LOTS], [-L1, -LOTS, -LOTS, LOTS]]) {
    b.anchor = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
    b.add('grass', flatRect(x0, z0, x1, z1, 0), null, 0xffffff, 'box');
  }

  // pond: muddy basin, water, rocks, reeds and lily pads
  b.anchor = pondC;
  {
    const rings = [[1, 0], [0.8, -0.28], [0.5, -0.5], [0.2, -0.6]];
    const pos: number[] = [], idx: number[] = [];
    const n = outline.length;
    rings.forEach(([s, y]) => outline.forEach((p) => pos.push(pondC.x + (p.x - pondC.x) * s, y, pondC.z + (p.y - pondC.z) * s)));
    pos.push(pondC.x, -0.62, pondC.z);
    for (let k = 0; k < rings.length - 1; k++) {
      for (let i = 0; i < n; i++) {
        const a = k * n + i, bb = k * n + ((i + 1) % n), c = a + n, d = bb + n;
        idx.push(a, bb, c, bb, d, c);
      }
    }
    const centre = rings.length * n;
    for (let i = 0; i < n; i++) idx.push((rings.length - 1) * n + i, (rings.length - 1) * n + ((i + 1) % n), centre);
    const basin = new THREE.BufferGeometry();
    basin.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    basin.setIndex(idx);
    basin.computeVertexNormals();
    if (basin.attributes.normal.getY(centre) < 0) {
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
      basin.setIndex(idx);
      basin.computeVertexNormals();
    }
    b.add('concrete', basin, null, '#5b4a36', 'box');
  }
  const waterShape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)));
  const waterGeo = new THREE.ShapeGeometry(waterShape, 8).rotateX(Math.PI / 2).translate(0, -0.08, 0);
  prepGeometry(waterGeo, null, 0xffffff, 'box');
  const wn = waterGeo.attributes.normal;
  for (let i = 0; i < wn.count; i++) wn.setXYZ(i, 0, 1, 0);
  if (waterGeo.index) {
    const idx = waterGeo.index;
    for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
  }
  const water = new THREE.Mesh(waterGeo, kit.materials.water);
  water.receiveShadow = true;
  water.name = 'pond';
  group.add(water);
  const rockT = [rockGeo(1), rockGeo(2), rockGeo(3)];
  outline.forEach((p, k) => {
    if (k % 2 && r() < 0.5) return;
    const s = 0.5 + r() * 0.7;
    const out = V(p.x - pondC.x, 0, p.y - pondC.z).normalize();
    b.addClone('concrete', rockT[k % 3], tm(p.x + out.x * 0.15, 0.02, p.y + out.z * 0.15, r() * 6, 0, 0, s), new THREE.Color().setHSL(0.08, 0.05, 0.45 + r() * 0.2), 'box');
  });
  for (let k = 0; k < 7; k++) {
    const p = outline[(k * 7 + 3) % outline.length];
    const out = V(p.x - pondC.x, 0, p.y - pondC.z).normalize();
    for (let j = 0; j < 14; j++) {
      const x = p.x - out.x * (0.2 + r() * 0.7) + (r() - 0.5) * 0.9, z = p.y - out.z * (0.2 + r() * 0.7) + (r() - 0.5) * 0.9;
      const h = 0.7 + r() * 0.7;
      b.add('trim', new THREE.ConeGeometry(0.018, h, 4).translate(0, h / 2, 0), tm(x, -0.1, z, 0, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3), new THREE.Color().setHSL(0.24 + r() * 0.05, 0.45, 0.28 + r() * 0.12));
      if (r() < 0.3) b.add('trim', cylGeo(0.022, 0.022, 0.16, 6), tm(x, h - 0.2, z), '#6b4a2e');
    }
  }
  for (let k = 0; k < 11; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 4.2;
    const x = pondC.x + Math.cos(a) * d * 1.1, z = pondC.z + Math.sin(a) * d * 0.7;
    const s = 0.22 + r() * 0.16;
    b.add('trim', new THREE.CircleGeometry(s, 14, 0.25, Math.PI * 2 - 0.5).rotateX(-Math.PI / 2), tm(x, -0.07, z, r() * 6), new THREE.Color().setHSL(0.27, 0.5, 0.3 + r() * 0.1));
    if (r() < 0.4) flowers.add(x, -0.05, z, FlowerSink.COLORS[1], 1.3);
  }
  // the pond is a no-go area for the dog
  obstacles.push({ x: pondC.x, z: pondC.z, r: 5.8 }, { x: pondC.x - 5.5, z: pondC.z + 0.5, r: 2.6 }, { x: pondC.x + 5.5, z: pondC.z - 0.5, r: 2.6 });

  // ------------------------------------------------------------------ paths
  const ctrl: THREE.Vector3[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rad = 24.5 + Math.sin(a * 3 + 0.6) * 1.8 + Math.sin(a * 5 + 1.3) * 0.9;
    ctrl.push(V(Math.cos(a) * rad, 0, Math.sin(a) * rad));
  }
  const loop = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal').getSpacedPoints(240).slice(0, 240);
  b.anchor = { x: 0, z: 0 };
  b.add('gravel', ribbon(loop, 2.4, 0.014, true), null, 0xffffff, 'keep');
  let south = loop[0];
  for (const p of loop) if (Math.abs(p.x) < Math.abs(south.x) + 0.01 && p.z > 0 && Math.abs(p.x) < 2) south = p.z > south.z || south.z <= 0 ? p : south;
  const branch = [V(0, 0, PARK + 0.2), V(0, 0, south.z - 0.6)];
  b.add('gravel', ribbon(branch, 2.4, 0.01, false), null, 0xffffff, 'keep');
  // stone edging along the loop
  for (const side of [-1, 1]) {
    const edge = loop.map((p, i) => {
      const nx = loop[(i + 1) % loop.length].z - loop[(i - 1 + loop.length) % loop.length].z;
      const nz = -(loop[(i + 1) % loop.length].x - loop[(i - 1 + loop.length) % loop.length].x);
      const l = Math.hypot(nx, nz);
      return V(p.x + (nx / l) * 1.25 * side, 0, p.z + (nz / l) * 1.25 * side);
    });
    b.add('concrete', ribbon(edge, 0.12, 0.03, true), null, '#b9b2a4', 'box');
  }

  // ------------------------------------------------------------------ fence, hedge, gate
  const iron = '#232826';
  const fenceRun = (xa: number, za: number, xb: number, zb: number) => {
    const len = Math.hypot(xb - xa, zb - za);
    const ang = Math.atan2(-(zb - za), xb - xa);
    const n = Math.max(1, Math.round(len / 2.6));
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const px = xa + (xb - xa) * t0, pz = za + (zb - za) * t0;
      b.anchor = { x: px, z: pz };
      addIronFence(b, tm(px, 0, pz, ang), len / n, 1.3, iron);
      addFencePost(b, tm(px, 0, pz), 1.45, iron);
    }
    addFencePost(b, tm(xb, 0, zb), 1.45, iron);
  };
  const gate = 1.6;
  fenceRun(-FENCE, FENCE, -gate - 0.3, FENCE);
  fenceRun(gate + 0.3, FENCE, FENCE, FENCE);
  fenceRun(FENCE, FENCE, FENCE, -FENCE);
  fenceRun(FENCE, -FENCE, -FENCE, -FENCE);
  fenceRun(-FENCE, -FENCE, -FENCE, FENCE);
  const hedge = (x0: number, z0: number, len: number, ang: number, seed: number) => {
    b.anchor = { x: x0, z: z0 };
    b.add('foliage', hedgeGeo(len, 0.9, 0.8, seed), tm(x0, 0, z0, ang), GREENS[seed % GREENS.length], 'box');
  };
  for (let k = 0; k < 8; k++) {
    const x0 = -FENCE + 0.8 + k * 9.6;
    hedge(x0, -FENCE + 0.8, 9.4, 0, k);
    hedge(-FENCE + 0.8, -FENCE + 0.8 + (k + 1) * 9.6, 9.4, Math.PI / 2, k + 3);
    hedge(FENCE - 0.8, -FENCE + 0.8 + k * 9.6, 9.4, -Math.PI / 2, k + 5);
  }
  for (let k = 0; k < 4; k++) {
    hedge(-FENCE + 0.8 + k * 9.25, FENCE - 0.8, k === 3 ? 7.4 : 9.2, 0, k + 7);
    hedge(gate + 1.2 + k * 9.25, FENCE - 0.8, k === 3 ? 7.4 : 9.2, 0, k + 9);
  }
  b.anchor = { x: 0, z: FENCE };
  for (const sx of [-1, 1]) {
    const P = tm(sx * (gate + 0.3), 0, FENCE);
    b.add('brick', boxGeo(0.6, 2.0, 0.6), P, '#ffffff');
    b.add('concrete', boxGeo(0.74, 0.1, 0.74), mul(P, tm(0, 2.0, 0)), '#cfc9bd');
    b.add('concrete', new THREE.SphereGeometry(0.17, 12, 8).translate(0, 2.25, 0), P, '#cfc9bd');
    addIronFence(b, mul(P, tm(-sx * 0.32, 0, -0.05, sx * 1.2 + (sx < 0 ? Math.PI : 0))), 1.4, 1.25, iron);
  }
  b.add('trim', new THREE.TorusGeometry(gate + 0.3, 0.055, 6, 28, Math.PI), tm(0, 2.05, FENCE), iron);
  b.add('trim', new THREE.TorusGeometry(gate + 0.1, 0.03, 6, 28, Math.PI), tm(0, 2.05, FENCE), iron);
  for (const sx of [-0.6, 0.6]) b.add('trim', boxGeo(0.015, 0.45, 0.015), tm(sx, 3.15, FENCE), iron);
  signBoard(b, tm(0, 3.12, FENCE), 1.9, 0.48, atlas.rects.parkSign, '#1f3f27');
  // notice board and waste station by the gate
  const NB = tm(-3.6, 0, FENCE - 3.2, 0.25);
  for (const sx of [-0.62, 0.62]) b.add('trim', boxGeo(0.1, 1.9, 0.1), mul(NB, tm(sx, 0, 0)), '#6b4526');
  signBoard(b, mul(NB, tm(0, 1.55, 0)), 1.2, 0.8, atlas.rects.notice, '#6b4526', false);
  b.add('trim', boxGeo(1.5, 0.08, 0.3), mul(NB, tm(0, 1.95, 0)), '#6b4526');
  obstacles.push({ x: -3.6, z: FENCE - 3.2, r: 0.8 });
  const WS = tm(3.4, 0, FENCE - 2.9, -0.3);
  b.add('trim', boxGeo(0.08, 1.3, 0.08), WS, '#2f3b36');
  b.add('facade', (() => { const g = new THREE.PlaneGeometry(0.34, 0.42); const uv = g.attributes.uv; const R = atlas.rects.waste; for (let i = 0; i < uv.count; i++) uv.setXY(i, R.u0 + uv.getX(i) * (R.u1 - R.u0), R.v0 + uv.getY(i) * (R.v1 - R.v0)); return g; })(), mul(WS, tm(0, 1.1, 0.05)), 0xffffff, 'keep');
  b.add('trim', boxGeo(0.3, 0.3, 0.2), mul(WS, tm(0, 0.6, 0.1)), '#3f7a4a');
  b.add('trim', cylGeo(0.26, 0.24, 0.85, 14), tm(4.3, 0, FENCE - 2.6), '#3f5a4a');
  obstacles.push({ x: 3.4, z: FENCE - 2.9, r: 0.35 }, { x: 4.3, z: FENCE - 2.6, r: 0.4 });

  // ------------------------------------------------------------------ benches, lamps, beds, trees
  const tangentAt = (i: number) => V().subVectors(loop[(i + 1) % loop.length], loop[(i - 1 + loop.length) % loop.length]).normalize();
  const benchIdx = [14, 50, 88, 125, 172, 212];
  for (const i of benchIdx) {
    const p = loop[i], t = tangentAt(i);
    const inward = V(-p.x, 0, -p.z).normalize();
    let nrm = V(-t.z, 0, t.x);
    if (nrm.dot(inward) > 0) nrm.negate();
    const pos = p.clone().addScaledVector(nrm, 2.0);
    const yaw = Math.atan2(-nrm.x, -nrm.z);
    b.anchor = { x: pos.x, z: pos.z };
    addBench(b, tm(pos.x, 0, pos.z, yaw), '#a06d40');
    b.add('concrete', flatRect(-1.1, -0.55, 1.1, 0.55, 0.012), tm(pos.x, 0, pos.z, yaw), '#c9b58f');
    obstacles.push({ x: pos.x, z: pos.z, r: 0.95 });
  }
  const lampIdx = [0, 30, 60, 90, 120, 150, 180, 210];
  for (const i of lampIdx) {
    const p = loop[i], t = tangentAt(i);
    let nrm = V(-t.z, 0, t.x);
    if (nrm.dot(V(p.x, 0, p.z)) < 0) nrm.negate();
    const pos = p.clone().addScaledVector(nrm, 1.75);
    const yaw = Math.atan2(-nrm.x, -nrm.z);
    b.anchor = { x: pos.x, z: pos.z };
    addStreetLamp(b, tm(pos.x, 0, pos.z, yaw));
    obstacles.push({ x: pos.x, z: pos.z, r: 0.25 });
  }
  const beds: [number, number, number][] = [[-5.2, 31.5, 2.2], [5.2, 31.5, 2.2], [-30, -30, 3.0], [-31, 29, 2.6], [30.5, 30, 2.6], [0, -31, 2.4]];
  for (const [x, z, rad] of beds) {
    b.anchor = { x, z };
    b.add('concrete', new THREE.CircleGeometry(rad, 28).rotateX(-Math.PI / 2).translate(0, 0.02, 0), tm(x, 0, z), '#4b3727');
    b.add('concrete', new THREE.RingGeometry(rad, rad + 0.15, 28).rotateX(-Math.PI / 2).translate(0, 0.04, 0), tm(x, 0, z), '#c3bcae');
    const ns = Math.round(rad * 3.2);
    for (let k = 0; k < ns; k++) {
      const a = (k / ns) * Math.PI * 2 + r(), d = rad * (0.45 + r() * 0.3);
      b.addClone('foliage', shrubs[k % shrubs.length], tm(x + Math.cos(a) * d, 0, z + Math.sin(a) * d, r() * 6, 0, 0, 0.6 + r() * 0.3), GREENS[k % 5], 'box');
    }
    b.addClone('foliage', shrubs[2], tm(x, 0, z, 0, 0, 0, 0.9), '#4f8a39', 'box');
    const pal = [FlowerSink.COLORS[Math.floor(r() * 10)], FlowerSink.COLORS[Math.floor(r() * 10)], FlowerSink.COLORS[Math.floor(r() * 10)]];
    const n = Math.round(rad * rad * 42);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * (rad - 0.15);
      flowers.add(x + Math.cos(a) * d, 0.12 + r() * 0.25, z + Math.sin(a) * d, pal[Math.floor(r() * 3)], 0.9 + r() * 0.5);
    }
    obstacles.push({ x, z, r: rad + 0.1 });
  }
  // picnic table by the pond
  {
    const T = tm(15.5, 0, -31.5, 0.4);
    b.anchor = { x: 15.5, z: -31.5 };
    const wood = '#9c6a3c';
    b.add('trim', boxGeo(1.9, 0.06, 0.8), mul(T, tm(0, 0.74, 0)), wood);
    for (const sz of [-0.62, 0.62]) b.add('trim', boxGeo(1.9, 0.05, 0.28), mul(T, tm(0, 0.44, sz)), wood);
    for (const sx of [-0.75, 0.75]) for (const s of [-1, 1]) b.add('trim', boxGeo(0.07, 0.95, 0.07), mul(T, tm(sx, -0.1, 0, 0, s * 0.62)), wood);
    obstacles.push({ x: 15.5, z: -31.5, r: 1.3 });
  }
  // trees in a loose ring between the path and the fence
  const treeSpots: [number, number, TreeKind][] = [];
  for (let k = 0; k < 34; k++) {
    const a = (k / 34) * Math.PI * 2 + (r() - 0.5) * 0.12;
    const d = 31 + r() * 4.5;
    const x = Math.cos(a) * d * (1 + 0.1 * Math.abs(Math.cos(a))), z = Math.sin(a) * d * (1 + 0.1 * Math.abs(Math.sin(a)));
    if (Math.abs(x) > FENCE - 1.8 || Math.abs(z) > FENCE - 1.8) continue;
    if (Math.hypot(x - pondC.x, z - pondC.z) < 10) continue;
    if (Math.abs(x) < 4.5 && z > 25) continue;
    if (beds.some(([bx, bz, br]) => Math.hypot(x - bx, z - bz) < br + 2.2)) continue;
    const roll = r();
    treeSpots.push([x, z, roll < 0.12 ? 'blossom' : roll < 0.3 ? 'conifer' : roll < 0.62 ? 'round' : 'oval']);
  }
  treeSpots.push([34.5, -34.5, 'conifer'], [-34.5, -34.5, 'conifer'], [34, 34.5, 'round'], [-34.5, 34, 'oval'], [20, -18.5, 'blossom'], [-20.5, 19.5, 'blossom']);
  for (const [x, z, kind] of treeSpots) {
    b.anchor = { x, z };
    obstacles.push(trees.add(b, kind, x, z, { scale: 1.05 + r() * 0.25, near: true }));
  }

  // ------------------------------------------------------------------ streets and houses outside the fence
  const white = '#f1f0ea';
  const road = (x0: number, z0: number, x1: number, z1: number) => {
    b.anchor = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
    const mb = new MeshBuilder();
    mb.polyUp([V(x0, -0.12, z0), V(x1, -0.12, z0), V(x1, -0.12, z1), V(x0, -0.12, z1)]);
    b.add('asphalt', mb.geometry(), null, 0xffffff, 'box');
  };
  const walk = (x0: number, z0: number, x1: number, z1: number) => {
    b.anchor = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
    const w = Math.min(Math.abs(x1 - x0), Math.abs(z1 - z0));
    const mb = new MeshBuilder();
    mb.polyUp([V(x0, 0, z0), V(x1, 0, z0), V(x1, 0, z1), V(x0, 0, z1)], (p) => [(p.x - x0) / w, (p.z - z0) / w]);
    b.add('sidewalk', mb.geometry(), null, 0xffffff, 'keep');
  };
  road(-ROAD_OUT, -ROAD_OUT, ROAD_OUT, -ROAD_IN); road(-ROAD_OUT, ROAD_IN, ROAD_OUT, ROAD_OUT);
  road(ROAD_IN, -ROAD_IN, ROAD_OUT, ROAD_IN); road(-ROAD_OUT, -ROAD_IN, -ROAD_IN, ROAD_IN);
  walk(-ROAD_IN, -ROAD_IN, ROAD_IN, -PARK); walk(-ROAD_IN, PARK, ROAD_IN, ROAD_IN);
  walk(PARK, -PARK, ROAD_IN, PARK); walk(-ROAD_IN, -PARK, -PARK, PARK);
  walk(-LOTS, -LOTS, LOTS, -ROAD_OUT); walk(-LOTS, ROAD_OUT, LOTS, LOTS);
  walk(ROAD_OUT, -ROAD_OUT, LOTS, ROAD_OUT); walk(-LOTS, -ROAD_OUT, -ROAD_OUT, ROAD_OUT);
  for (const s of [-1, 1]) {
    for (const [len, off] of [[2 * ROAD_IN, ROAD_IN], [2 * ROAD_OUT, ROAD_OUT]] as const) {
      const cc = s * (off + (off === ROAD_IN ? -0.1 : 0.1));
      b.anchor = { x: 0, z: cc };
      b.add('concrete', boxGeo(len, 0.14, 0.2), tm(0, -0.14, cc), '#dcd8d0');
      b.anchor = { x: cc, z: 0 };
      b.add('concrete', boxGeo(0.2, 0.14, len), tm(cc, -0.14, 0), '#dcd8d0');
    }
    for (let a = -40; a < 40; a += 6) {
      const mid = s * (ROAD_IN + ROAD_OUT) / 2;
      b.anchor = { x: a, z: mid };
      b.add('paint', flatRect(a, mid - 0.06, a + 3, mid + 0.06, -0.108), null, '#e3b32e');
      b.anchor = { x: mid, z: a };
      b.add('paint', flatRect(mid - 0.06, a, mid + 0.06, a + 3, -0.108), null, '#e3b32e');
    }
  }
  // crossing at the gate
  for (let k = -3; k <= 3; k++) {
    b.anchor = { x: 0, z: 46 };
    b.add('paint', flatRect(k * 0.9 - 0.22, ROAD_IN + 0.25, k * 0.9 + 0.22, ROAD_OUT - 0.25, -0.108), null, white);
  }
  // houses facing the park
  const sides: [number, number, number][] = [[0, -LOTS, 0], [LOTS, 0, -Math.PI / 2], [0, LOTS, Math.PI], [-LOTS, 0, Math.PI / 2]];
  sides.forEach(([x, z, rot], si) => {
    const M = tm(x, 0, z, rot);
    for (let k = -3; k <= 3; k++) {
      const c = V(k * 14, 0, -5).applyMatrix4(M);
      b.anchor = { x: c.x, z: c.z };
      buildLot(ctx, M, { W: 14, D: LOT_D, offset: k * 14, seed: 500 + si * 31 + k * 7, streetSide: 0, rot, blockers: [] });
      if (k < 3) {
        const t = V(k * 14 + 7, 0, -0.5).applyMatrix4(M);
        trees.add(b, r() < 0.6 ? 'round' : 'oval', t.x, t.z);
      }
      if (k % 2 === 0) {
        const lp = V(k * 14 + 2.5, 0, 1.0).applyMatrix4(M);
        addStreetLamp(b, tm(lp.x, 0, lp.z, rot + Math.PI));
      }
    }
    if (si % 2 === 0) {
      const cp = V(-12 + si * 4, 0, 4.4).applyMatrix4(M);
      cars.push({ x: cp.x, y: -0.12, z: cp.z, rot: rot + Math.PI / 2, color: CAR_COLORS[si * 3 % CAR_COLORS.length] });
    }
  });
  for (const [x, z] of [[-58, -58], [58, -58], [58, 58], [-58, 58]]) {
    b.anchor = { x, z };
    trees.add(b, 'round', x, z, { scale: 1.2 });
  }

  // ------------------------------------------------------------------ hills and far trees
  const outer = { minX: -L1, maxX: L1, minZ: -L1, maxZ: L1 };
  const land = terrain({ flat: outer, hole: outer, extent: 320, cell: 8, hillStart: 25, hillEnd: 260, hillHeight: 40, seed: 21 });
  const landMesh = new THREE.Mesh(land.geometry, kit.materials.grass);
  landMesh.receiveShadow = true;
  landMesh.name = 'terrain';
  group.add(landMesh);
  kit.geometries.push(land.geometry);
  const tr = mulberry32(77);
  for (let x = -L1 - 300; x < L1 + 300; x += 9) {
    for (let z = -L1 - 300; z < L1 + 300; z += 9) {
      const px = x + (tr() - 0.5) * 8, pz = z + (tr() - 0.5) * 8;
      const d = Math.max(Math.abs(px), Math.abs(pz)) - L1;
      if (d < 3 || d > 280) continue;
      const cl = fbm2(px / 60, pz / 60, 3, 5);
      const p = d < 20 ? 0.5 : 0.12 * (cl > 0.5 ? 2 : 0.4);
      if (tr() > p) continue;
      trees.add(far, d > 60 && tr() < 0.5 ? 'conifer' : tr() < 0.5 ? 'round' : 'oval', px, pz, { lod: d < 25 ? 0 : 1, shadow: false, y: land.height(px, pz) - 0.1, scale: 0.9 + tr() * 0.4 });
    }
  }

  // ------------------------------------------------------------------ assemble
  const meshes = [...b.build(kit.materials, group), ...far.build(kit.materials, group)];
  const flowerMesh = flowers.build();
  if (flowerMesh) group.add(flowerMesh);
  const carSet = createCars(cars);
  group.add(carSet.group);
  shrubs.forEach((s) => s.dispose());
  rockT.forEach((s) => s.dispose());
  trees.dispose();

  // lush grass blades around the dog, masked off the paths, beds and pond
  const maskC = makeCanvas(512);
  const mg = maskC.getContext('2d')!;
  const S = 512 / (2 * PARK);
  const toPx = (x: number, z: number): [number, number] => [(x + PARK) * S, (z + PARK) * S];
  mg.fillStyle = '#fff';
  mg.fillRect(0, 0, 512, 512);
  mg.strokeStyle = '#000';
  mg.fillStyle = '#000';
  mg.lineWidth = 2.9 * S;
  mg.lineJoin = 'round';
  mg.beginPath();
  loop.forEach((p, i) => { const [x, y] = toPx(p.x, p.z); if (i) mg.lineTo(x, y); else mg.moveTo(x, y); });
  mg.closePath();
  mg.stroke();
  mg.beginPath(); mg.moveTo(...toPx(0, PARK)); mg.lineTo(...toPx(0, south.z)); mg.stroke();
  mg.beginPath();
  outline.forEach((p, i) => { const [x, y] = toPx(p.x, p.y); if (i) mg.lineTo(x, y); else mg.moveTo(x, y); });
  mg.closePath();
  mg.fill();
  mg.lineWidth = 1.0 * S;
  mg.stroke();
  for (const [x, z, rad] of beds) { mg.beginPath(); mg.arc(...toPx(x, z), (rad + 0.2) * S, 0, Math.PI * 2); mg.fill(); }
  const maskTex = kit.tex(new THREE.CanvasTexture(maskC));
  maskTex.colorSpace = THREE.NoColorSpace;
  // canvas rows run +z downwards, matching the texture's flipped v
  maskTex.flipY = false;
  const grass = createGrassField({ count: 90000, tile: 20, height: [0.04, 0.1], width: 0.022, mask: { texture: maskTex, rect: [-PARK, -PARK, 2 * PARK, 2 * PARK] } });
  group.add(grass.mesh);

  const lights = createOutdoorLights(renderer, { fogNear: 60, fogFar: 380, shadowSize: 18, sunIntensity: 2.8, hemi: 0.4 });
  group.add(lights.group);

  return {
    group,
    environment: lights.environment,
    background: lights.background,
    fog: lights.fog,
    sun: lights.sun,
    bounds: { minX: -FENCE + 1.2, maxX: FENCE - 1.2, minZ: -FENCE + 1.2, maxZ: FENCE - 1.2 },
    obstacles,
    camera: { position: V(2.5, 1.3, 6.5), target: V(0, 0.3, 0), fov: 50 },
    update(dt, time, focus) {
      lights.update(time, focus);
      grass.update(time, focus);
      waterNormal.offset.x = time * 0.012;
      waterNormal.offset.y = time * 0.007;
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      if (flowerMesh) { flowerMesh.geometry.dispose(); (flowerMesh.material as THREE.Material).dispose(); flowerMesh.dispose(); }
      waterGeo.dispose();
      carSet.dispose();
      grass.dispose();
      lights.dispose();
      kit.dispose();
    },
  };
}

