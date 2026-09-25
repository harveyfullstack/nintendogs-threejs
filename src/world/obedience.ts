// Indoor sports hall set up for an obedience trial: rubber-matted ring with low
// barriers, the judges' table, banners, spotlights and hinted spectator stands.

import * as THREE from 'three';
import { texSize } from '../game/quality';
import type { ObedienceRing } from './types';
import {
  Batch,
  ContactShadows,
  type Kit,
  type Rand,
  box,
  boxUV,
  canvasTex,
  captureEnvironment,
  cyl,
  disposeTree,
  fitShadow,
  lathe,
  makeCanvas,
  makePropMats,
  makeSun,
  paintDogPortrait,
  pictureAtlas,
  placer,
  plankTextures,
  rbox,
  rng,
  stdMat,
  tf,
  tileTextures,
} from './room';

const NAVY = '#1f3a68';
const GOLD = '#e0b24a';
const RED = '#d9483b';

/** Banner / signage painters for a 2x2 atlas. */
type Painter = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: Rand) => void;
const pawIcon = (g: CanvasRenderingContext2D, x: number, y: number, s: number, col: string) => {
  g.fillStyle = col;
  g.beginPath();
  g.ellipse(x, y, 22 * s, 18 * s, 0, 0, 6.283);
  g.fill();
  for (let k = 0; k < 4; k++) {
    g.beginPath();
    g.ellipse(x + (k - 1.5) * 15 * s, y - 27 * s - (k === 1 || k === 2 ? 8 * s : 0), 7.5 * s, 9.5 * s, 0, 0, 6.283);
    g.fill();
  }
};
const text = (g: CanvasRenderingContext2D, t: string, x: number, y: number, size: number, col: string, rot = 0) => {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.font = `bold ${size}px "Arial Rounded MT Bold", "Trebuchet MS", "Verdana", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = col;
  g.fillText(t, 0, 0);
  g.restore();
};
/** Vertical hanging banner (tall, narrow): "OBEDIENCE" with paws and stars. */
const paintBanner: Painter = (g, x, y, w, h) => {
  g.fillStyle = NAVY;
  g.fillRect(x, y, w, h);
  g.fillStyle = GOLD;
  g.fillRect(x, y + h * 0.04, w, h * 0.02);
  g.fillRect(x, y + h * 0.94, w, h * 0.02);
  pawIcon(g, x + w / 2, y + h * 0.2, 2.6, '#ffffff');
  text(g, 'OBEDIENCE', x + w / 2, y + h * 0.58, w * 0.3, '#ffffff', -Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    g.fillStyle = GOLD;
    const sx = x + w * (0.3 + i * 0.2);
    const sy = y + h * 0.86;
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = k % 2 ? w * 0.03 : w * 0.07;
      g.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr);
    }
    g.fill();
  }
};
/** Barrier panel print: repeated paws and a stripe. */
const paintBarrier: Painter = (g, x, y, w, h) => {
  g.fillStyle = '#ffffff';
  g.fillRect(x, y, w, h);
  g.fillStyle = NAVY;
  g.fillRect(x, y + h * 0.62, w, h * 0.38);
  g.fillStyle = RED;
  g.fillRect(x, y + h * 0.56, w, h * 0.06);
  for (let i = 0; i < 6; i++) pawIcon(g, x + w * (0.083 + i * 0.167), y + h * 0.36, 2.2, i % 2 ? RED : NAVY);
  for (let i = 0; i < 2; i++) text(g, 'DOG TRIALS', x + w * (0.25 + i * 0.5), y + h * 0.8, h * 0.2, '#ffffff');
};
/** Big wall sign above the stands. */
const paintWallSign: Painter = (g, x, y, w, h) => {
  g.fillStyle = '#ffffff';
  g.fillRect(x, y, w, h);
  g.fillStyle = RED;
  g.fillRect(x, y, w, h * 0.12);
  g.fillRect(x, y + h * 0.88, w, h * 0.12);
  text(g, 'OBEDIENCE', x + w / 2, y + h * 0.4, h * 0.26, NAVY);
  text(g, 'TRIAL', x + w / 2, y + h * 0.68, h * 0.22, RED);
  pawIcon(g, x + w * 0.1, y + h * 0.56, 3.2, GOLD);
  pawIcon(g, x + w * 0.9, y + h * 0.56, 3.2, GOLD);
};

/** Pennant-style judges' table cloth. */
const paintCloth: Painter = (g, x, y, w, h) => {
  g.fillStyle = NAVY;
  g.fillRect(x, y, w, h);
  g.fillStyle = GOLD;
  g.fillRect(x, y + h * 0.08, w, h * 0.05);
  text(g, 'JUDGES', x + w / 2, y + h * 0.52, h * 0.3, '#ffffff');
  pawIcon(g, x + w * 0.1, y + h * 0.56, 2.4, GOLD);
  pawIcon(g, x + w * 0.9, y + h * 0.56, 2.4, GOLD);
};

/** Wrap a painter so its artwork looks right after the cell is stretched by `aspect` (width / height) on the mesh. */
const stretched = (p: Painter, aspect: number): Painter => (g, x, y, w, h, r) => {
  g.save();
  g.translate(x, y);
  g.scale(1 / aspect, 1);
  p(g, 0, 0, w * aspect, h, r);
  g.restore();
};

function atlas(painters: Painter[], seed: number) {
  const px = 1024;
  const { c, g } = makeCanvas(px);
  const r = rng(seed);
  painters.forEach((p, i) => {
    const s = px / 2;
    const x = (i % 2) * s;
    const y = Math.floor(i / 2) * s;
    g.save();
    g.beginPath();
    g.rect(x, y, s, s);
    g.clip();
    p(g, x, y, s, s, r);
    g.restore();
  });
  return canvasTex(c, true, false);
}
/** UV rect of atlas cell i (full cell). */
const cell = (i: number): [number, number, number, number] => {
  const u0 = (i % 2) * 0.5;
  const v1 = 1 - Math.floor(i / 2) * 0.5;
  return [u0 + 0.002, v1 - 0.5 + 0.002, u0 + 0.5 - 0.002, v1 - 0.002];
};
const withUV = (g: THREE.BufferGeometry, uv: [number, number, number, number]) => {
  const a = g.attributes.uv;
  for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1]));
  return g;
};

/** Seated spectators as one instanced mesh of simple figures. */
function crowd(rows: { x0: number; x1: number; y: number; z: number; ry: number }[], r: Rand) {
  const body = rbox(0.4, 0.5, 0.24, 0.08, 1);
  body.translate(0, 0.3, 0);
  const legs = rbox(0.36, 0.14, 0.4, 0.05, 1);
  legs.translate(0, 0.07, 0.14);
  const head = new THREE.SphereGeometry(0.1, 9, 7);
  head.scale(0.9, 1.1, 1);
  head.translate(0, 0.7, 0.01);
  const neck = cyl(0.045, 0.05, 0.1, 6, true);
  neck.translate(0, 0.58, 0);
  const geo = new THREE.BufferGeometry();
  const merged = [body, legs, head, neck].map((g) => (g.index ? g.toNonIndexed() : g));
  const pos = merged.flatMap((g) => Array.from(g.attributes.position.array as Float32Array));
  const nor = merged.flatMap((g) => Array.from(g.attributes.normal.array as Float32Array));
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  const mat = stdMat('crowd', { roughness: 0.9, color: '#d8d8d8' });
  const spots: THREE.Matrix4[] = [];
  const cols: THREE.Color[] = [];
  const shirts = ['#b8544a', '#3a4f72', '#c9a45a', '#5f8a6c', '#e4e2dc', '#76688f', '#c98a55', '#5a7fae', '#b9b2a8', '#4a4a4a'];
  for (const row of rows) {
    for (let x = row.x0; x < row.x1; x += 0.55 + r() * 0.4) {
      if (r() < 0.4) continue;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x * Math.cos(row.ry) + row.z * Math.sin(row.ry), row.y, -x * Math.sin(row.ry) + row.z * Math.cos(row.ry)),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), row.ry + (r() - 0.5) * 0.5),
        new THREE.Vector3(1, 0.9 + r() * 0.2, 1),
      );
      spots.push(m);
      cols.push(new THREE.Color(shirts[Math.floor(r() * shirts.length)]));
    }
  }
  const inst = new THREE.InstancedMesh(geo, mat, spots.length);
  spots.forEach((m, i) => {
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, cols[i]);
  });
  inst.name = 'crowd';
  inst.castShadow = false;
  inst.receiveShadow = false;
  return inst;
}

export function buildObedienceRing(renderer: THREE.WebGLRenderer): ObedienceRing {
  const group = new THREE.Group();
  group.name = 'obedience';
  const r = rng(123);
  const HW = 15; // hall half-width (x)
  const HD = 13; // hall half-depth (z)
  const HH = 8; // hall height
  const ringC = new THREE.Vector3(0, 0, -1.2);
  const ringHX = 5;
  const ringHZ = 4;
  const m = makePropMats(1100, pictureAtlas([paintDogPortrait], 3));
  const signs = atlas([stretched(paintBanner, 0.5), stretched(paintBarrier, 2.9), stretched(paintWallSign, 2), stretched(paintCloth, 2.8)], 5);
  const signMat = stdMat('signs', { map: signs, roughness: 0.7 });
  const floorT = plankTextures({ px: texSize(1024), rows: 16, minLen: 0.3, maxLen: 0.6, colors: ['#e2bf8e', '#dcb886', '#e6c697', '#d8b280'], seed: 44, dark: '130,90,50', grain: 0.25, seam: 0.3 });
  const hallFloor = stdMat('hallFloor', { map: floorT.map, normalMap: floorT.normalMap, roughnessMap: floorT.roughnessMap, roughness: 0.7, normalScale: new THREE.Vector2(0.4, 0.4), cast: false });
  const matT = tileTextures({ px: 512, cols: 1, rows: 1, grout: 3, colors: ['#4a8a5e'], groutColor: '#2f5f40', seed: 45, rough: 0.8 });
  {
    // EPDM rubber granules
    const cv = matT.map.image as HTMLCanvasElement;
    const g = cv.getContext('2d')!;
    const sr = rng(46);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = ['rgba(20,50,30,0.5)', 'rgba(120,180,130,0.35)', 'rgba(240,240,230,0.25)'][Math.floor(sr() * 3)];
      g.fillRect(sr() * cv.width, sr() * cv.height, 1 + sr() * 1.5, 1 + sr() * 1.5);
    }
    matT.map.needsUpdate = true;
  }
  const ringMat = stdMat('ringMat', { map: matT.map, normalMap: matT.normalMap, roughness: 0.85, cast: false });
  // rubber speckle via a fine noise normal: reuse the plush normal for texture at close range
  const b = new Batch();
  const cs = new ContactShadows(0.45);
  const k: Kit = { b, m, cs, obstacles: [], r };

  // hall shell: floor, walls with padded lower band, ceiling with trusses
  b.add(hallFloor, boxUV(tf(new THREE.PlaneGeometry(HW * 2, HD * 2), 0, 0, 0, 0, -Math.PI / 2), 2.4));
  for (const [x, z, w, ry] of [[0, -HD, HW * 2, 0], [0, HD, HW * 2, Math.PI], [-HW, 0, HD * 2, Math.PI / 2], [HW, 0, HD * 2, -Math.PI / 2]] as const) {
    const P = placer(x, 0, z, ry);
    b.add(m.paint, P(boxUV(tf(box(w, HH, 0.3), 0, HH / 2, -0.15), 1.5)), '#e9e6df');
    b.add(m.paint, P(boxUV(tf(box(w, 1.2, 0.08), 0, 0.6, 0.04), 1.5)), '#2f5d9a');
    // high clerestory windows (bright strips)
    for (let i = 0; i < Math.floor(w / 3); i++) b.add(m.glow, P(tf(new THREE.PlaneGeometry(2.2, 0.9), -w / 2 + 1.5 + i * 3, HH - 1.4, 0.01)), '#dfeaf2');
  }
  b.add(m.paint, tf(box(HW * 2, 0.3, HD * 2), 0, HH + 0.15, 0), '#9aa0a6');
  for (let i = -3; i <= 3; i++) {
    b.add(m.metal, tf(box(0.12, 0.35, HD * 2), i * 3, HH - 0.3, 0), '#5a6068');
    b.add(m.metal, tf(box(HW * 2, 0.06, 0.06), 0, HH - 0.5, i * 2.8), '#5a6068');
  }
  // court lines painted on the hall floor
  const line = (x: number, z: number, w: number, dd: number) => b.add(m.paint, tf(box(w, 0.002, dd), x, 0.001, z), '#f4f4f0');
  line(0, HD - 1.2, HW * 2 - 2.4, 0.05);
  line(0, -HD + 1.2, HW * 2 - 2.4, 0.05);
  line(-HW + 1.2, 0, 0.05, HD * 2 - 2.4);
  line(HW - 1.2, 0, 0.05, HD * 2 - 2.4);

  // ring: rubber matting (1 m tiles) with a white tape boundary
  const mat = tf(new THREE.PlaneGeometry(ringHX * 2 + 0.6, ringHZ * 2 + 0.6), ringC.x, 0.006, ringC.z, 0, -Math.PI / 2);
  b.add(ringMat, boxUV(mat, 1));
  b.add(ringMat, tf(box(ringHX * 2 + 0.6, 0.012, 0.01), ringC.x, 0.003, ringC.z + ringHZ + 0.3));
  cs.rect(ringC.x, ringC.z, ringHX * 2 + 0.6, ringHZ * 2 + 0.6, 0.06, 0, 0.3);
  const tape = (x: number, z: number, w: number, dd: number) => b.add(m.paint, tf(box(w, 0.002, dd), x, 0.0075, z), '#f7f7f2');
  tape(ringC.x, ringC.z - ringHZ, ringHX * 2, 0.05);
  tape(ringC.x, ringC.z + ringHZ, ringHX * 2, 0.05);
  tape(ringC.x - ringHX, ringC.z, 0.05, ringHZ * 2);
  tape(ringC.x + ringHX, ringC.z, 0.05, ringHZ * 2);
  // start marker: a small cross where the dog sits
  const start = new THREE.Vector3(0, 0, 0.2);
  tape(start.x, start.z, 0.3, 0.04);
  tape(start.x, start.z, 0.04, 0.3);

  // low barriers around the ring (gap at the front for the entrance)
  const barrierUV = cell(1);
  const panelW = 1.6;
  const bh = 0.5;
  const barrierRun = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / panelW));
    const ry = -Math.atan2(z1 - z0, x1 - x0);
    for (let i = 0; i < n; i++) {
      const t0 = (i + 0.5) / n;
      const cx = x0 + (x1 - x0) * t0;
      const cz = z0 + (z1 - z0) * t0;
      const P = placer(cx, 0, cz, ry);
      const pw = len / n - 0.06;
      const uv: [number, number, number, number] = [barrierUV[0], barrierUV[1] + 0.12, barrierUV[2], barrierUV[3] - 0.12];
      b.add(signMat, P(withUV(tf(new THREE.PlaneGeometry(pw, bh - 0.08), 0, bh / 2 + 0.02, 0.004), uv)));
      b.add(signMat, P(withUV(tf(new THREE.PlaneGeometry(pw, bh - 0.08), 0, bh / 2 + 0.02, -0.004, Math.PI), uv)));
      b.add(m.paint, P(tf(rbox(pw + 0.04, 0.04, 0.05, 0.015, 2), 0, bh, 0)), '#ffffff');
      b.add(m.paint, P(tf(rbox(pw + 0.04, 0.03, 0.04, 0.01, 2), 0, 0.03, 0)), '#ffffff');
      for (const sx of [-1, 1]) {
        b.add(m.paint, P(tf(rbox(0.04, bh, 0.05, 0.012, 2), sx * (pw / 2 + 0.02), bh / 2, 0)), '#ffffff');
        b.add(m.paint, P(tf(box(0.06, 0.02, 0.3), sx * (pw / 2 + 0.02), 0.01, 0)), '#ffffff');
      }
      cs.rect(cx, cz, pw, 0.1, 0.12, ry, 0.35);
    }
  };
  const bx = ringHX + 0.35;
  const bz = ringHZ + 0.35;
  barrierRun(ringC.x - bx, ringC.z - bz, ringC.x + bx, ringC.z - bz);
  barrierRun(ringC.x + bx, ringC.z - bz, ringC.x + bx, ringC.z + bz);
  barrierRun(ringC.x - bx, ringC.z + bz, ringC.x - bx, ringC.z - bz);
  barrierRun(ringC.x + bx, ringC.z + bz, ringC.x + 1.0, ringC.z + bz);
  barrierRun(ringC.x - 1.0, ringC.z + bz, ringC.x - bx, ringC.z + bz);

  // judges' table inside the far edge of the ring, off to the side
  const jt = placer(2.0, 0, ringC.z - ringHZ + 0.7, 0);
  b.add(m.wood, jt(boxUV(tf(box(1.8, 0.04, 0.75), 0, 0.74, 0), 0.6)), '#d8c7a8');
  const cloth = withUV(tf(new THREE.PlaneGeometry(1.84, 0.66), 0, 0.41, 0.385), cell(3));
  b.add(signMat, jt(cloth));
  b.add(m.fabric, jt(tf(box(0.02, 0.66, 0.75), -0.92, 0.41, 0)), NAVY);
  b.add(m.fabric, jt(tf(box(0.02, 0.66, 0.75), 0.92, 0.41, 0)), NAVY);
  for (const sx of [-0.55, 0.05, 0.6]) {
    // chairs behind the table
    const cP = placer(2.0 + sx, 0, ringC.z - ringHZ + 0.25, 0);
    b.add(m.metal, cP(tf(rbox(0.44, 0.04, 0.42, 0.015, 2), 0, 0.46, 0)), '#26282b');
    b.add(m.metal, cP(tf(rbox(0.44, 0.4, 0.035, 0.015, 2), 0, 0.72, -0.2, 0, -0.1)), '#26282b');
    for (const lx of [-1, 1]) for (const lz of [-1, 1]) b.add(m.metal, cP(tf(cyl(0.012, 0.012, 0.46, 6), lx * 0.19, 0.23, lz * 0.18)), '#8a9096');
  }
  // trophies, clipboard, bell on the table
  const cup = (x: number, s: number) => {
    b.add(m.metal, jt(tf(lathe([[0.001, 0], [0.07 * s, 0], [0.07 * s, 0.03 * s], [0.02 * s, 0.05 * s], [0.02 * s, 0.13 * s], [0.03 * s, 0.15 * s], [0.08 * s, 0.2 * s], [0.09 * s, 0.3 * s], [0.085 * s, 0.3 * s], [0.07 * s, 0.21 * s], [0.001, 0.16 * s]], 24), x, 0.76, 0.05)), GOLD);
    for (const sx of [-1, 1]) b.add(m.metal, jt(tf(new THREE.TorusGeometry(0.035 * s, 0.006 * s, 6, 14, Math.PI), x + sx * 0.09 * s, 0.76 + 0.24 * s, 0.05, 0, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2)), GOLD);
  };
  cup(-0.6, 1.3);
  cup(-0.3, 1.0);
  cup(0.6, 0.9);
  b.add(m.wood, jt(tf(box(0.24, 0.01, 0.32), 0.15, 0.765, 0.1, 0.2)), '#8a5a36');
  b.add(m.paint, jt(tf(box(0.21, 0.004, 0.28), 0.15, 0.772, 0.1, 0.2)), '#ffffff');
  b.add(m.metal, jt(tf(new THREE.SphereGeometry(0.04, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0.35, 0.76, -0.1)), GOLD);
  cs.rect(2.0, ringC.z - ringHZ + 0.55, 1.9, 0.95, 0.2, 0, 0.6);
  k.obstacles.push({ x: 1.4, z: ringC.z - ringHZ + 0.6, r: 0.55 }, { x: 2.6, z: ringC.z - ringHZ + 0.6, r: 0.55 });

  // stands: stepped bleachers at the back and sides
  const stands = (cx: number, cz: number, ry: number, len: number) => {
    const P = placer(cx, 0, cz, ry);
    for (let i = 0; i < 6; i++) {
      b.add(m.paint, P(boxUV(tf(box(len, 0.45, 0.8), 0, 0.225 + i * 0.45, -i * 0.8), 1)), i % 2 ? '#c9ccd1' : '#d4d7db');
      b.add(m.paint, P(boxUV(tf(box(len, 0.06, 0.35), 0, 0.48 + i * 0.45, -i * 0.8 + 0.1), 1)), '#2f5d9a');
    }
    b.add(m.metal, P(tf(box(len, 0.05, 0.05), 0, 3.3, -4.2)), '#8a9096');
  };
  stands(0, -HD + 4.6, 0, 20);
  stands(-HW + 4.4, 0, Math.PI / 2, 12);
  stands(HW - 4.4, 0, -Math.PI / 2, 12);
  const rowsDef: { x0: number; x1: number; y: number; z: number; ry: number }[] = [];
  for (let i = 0; i < 6; i++) rowsDef.push({ x0: -9.5, x1: 9.5, y: 0.48 + i * 0.45, z: -HD + 4.5 - i * 0.8, ry: 0 });
  for (let i = 0; i < 6; i++) {
    rowsDef.push({ x0: -5.6, x1: 5.6, y: 0.48 + i * 0.45, z: -HW + 4.3 - i * 0.8, ry: Math.PI / 2 });
    rowsDef.push({ x0: -5.6, x1: 5.6, y: 0.48 + i * 0.45, z: -HW + 4.3 - i * 0.8, ry: -Math.PI / 2 });
  }
  const people = crowd(rowsDef, r);
  group.add(people);

  // hanging banners and a big wall sign
  const bannerUV = cell(0);
  for (let i = 0; i < 5; i++) {
    const x = -8 + i * 4;
    const g = withUV(tf(new THREE.PlaneGeometry(1.0, 2.6), x, HH - 2.3, -HD + 0.5), [bannerUV[0] + 0.12, bannerUV[1], bannerUV[2] - 0.12, bannerUV[3]]);
    b.add(signMat, g);
    b.add(m.metal, tf(cyl(0.02, 0.02, 1.1, 8), x, HH - 0.98, -HD + 0.5, 0, 0, Math.PI / 2), GOLD);
    b.add(m.metal, tf(cyl(0.005, 0.005, 0.95, 4), x, HH - 0.48, -HD + 0.5), '#888');
  }
  const ws = withUV(tf(new THREE.PlaneGeometry(6, 3), 0, 5.8, -HD + 0.02), cell(2));
  b.add(signMat, ws);
  for (const sx of [-1, 1]) {
    const side = withUV(tf(new THREE.PlaneGeometry(4, 2), sx * (HW - 0.02), 5.6, -1, -sx * Math.PI / 2), cell(2));
    b.add(signMat, side);
  }

  // spotlights on a lighting truss over the ring
  const truss = (z: number) => {
    b.add(m.metal, tf(box(12, 0.08, 0.08), 0, 6.2, z), '#3a3d42');
    b.add(m.metal, tf(box(12, 0.08, 0.08), 0, 5.9, z), '#3a3d42');
    for (let i = -6; i <= 6; i++) b.add(m.metal, tf(box(0.03, 0.34, 0.03), i, 6.05, z, 0, 0, i % 2 ? 0.7 : -0.7), '#3a3d42');
    for (let i = 0; i < 4; i++) {
      const x = -4.5 + i * 3;
      const aim = new THREE.Vector3(x * 0.3, 0, ringC.z).sub(new THREE.Vector3(x, 5.7, z)).normalize();
      const pitch = Math.acos(-aim.y);
      const yaw = Math.atan2(aim.x, aim.z);
      const can = cyl(0.13, 0.16, 0.36, 16);
      b.add(m.metal, tf(can, x, 5.65, z, yaw, Math.PI / 2 - pitch + Math.PI / 2), '#1d1f22');
      const lens = new THREE.CircleGeometry(0.12, 20);
      const lp = new THREE.Vector3(x, 5.65, z).addScaledVector(aim, 0.185);
      b.add(m.glow, tf(lens, lp.x, lp.y, lp.z, yaw, -pitch + Math.PI), '#fff8e8');
      b.add(m.metal, tf(box(0.02, 0.3, 0.02), x, 5.78, z), '#3a3d42');
    }
  };
  truss(ringC.z - 2.5);
  truss(ringC.z + 2.8);

  b.build(group, 'ring');
  cs.build(group);
  // glowing windows and spot lenses should read bright
  m.glow.emissiveIntensity = 1.4;

  // lighting: an overhead "sun" (the rig of spotlights), plus a bright hall fill
  const sun = makeSun('#fff4e2', 3.0, new THREE.Vector3(-0.25, -1, -0.45), ringC.clone(), 2048);
  sun.shadow.radius = 4 * (sun.shadow.mapSize.x / 2048);
  fitShadow(sun, new THREE.Box3(new THREE.Vector3(ringC.x - ringHX - 1, 0, ringC.z - ringHZ - 1), new THREE.Vector3(ringC.x + ringHX + 1, 1.5, ringC.z + ringHZ + 1)), 0.1);
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight('#f2f5fa', '#b9a88c', 1.35));

  const environment = captureEnvironment(renderer, group, new THREE.Vector3(0, 1.5, 0), new THREE.Color('#cfd6dc'));
  return {
    group,
    environment,
    background: new THREE.Color('#cfd6dc'),
    fog: new THREE.Fog('#d9dde0', 14, 45),
    sun,
    bounds: { minX: ringC.x - ringHX + 0.3, maxX: ringC.x + ringHX - 0.3, minZ: ringC.z - ringHZ + 0.3, maxZ: ringC.z + ringHZ - 0.3 },
    obstacles: k.obstacles,
    camera: { position: new THREE.Vector3(0.3, 1.0, start.z + 2.3), target: new THREE.Vector3(0, 0.35, start.z - 0.5), fov: 50 },
    start,
    dispose() {
      disposeTree(group);
      environment.dispose();
    },
  };
}

