// Bright tiled bathroom with a low, wide enamel tub where the puppy gets its
// shampoo and shower. The camera looks down into the tub from about 0.8 m.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Bathroom } from './types';
import {
  Batch,
  ContactShadows,
  type Dims,
  type Kit,
  type Opening,
  atlasCell,
  box,
  boxUV,
  buildShell,
  captureEnvironment,
  cyl,
  disposeTree,
  fitShadow,
  lathe,
  makePropMats,
  makeSun,
  moulding,
  onWall,
  paintBotanical,
  paintLandscape,
  paintAbstract,
  paintDogPortrait,
  panelDoor,
  physMat,
  pictureAtlas,
  placer,
  plushTextures,
  rbox,
  rng,
  scaleUV,
  stdMat,
  succulent,
  tf,
  tileTextures,
  tube,
  wallFrame,
  wallPoint,
  windowUnit,
} from './room';

/**
 * Basin geometry: a rounded-rectangle (superellipse) tub. The flat inner floor has
 * half-size (a, b) at `floorY`; a fillet runs into the walls, over a rolled rim at
 * `rimY` and down the outside to the ground.
 */
function tubGeometry(a: number, b: number, floorY: number, rimY: number, n = 5, seg = 96) {
  const prof: { s: number; d: number; y: number }[] = [];
  for (let i = 0; i <= 4; i++) prof.push({ s: i / 4, d: 0, y: floorY });
  const f = 0.08;
  for (let i = 1; i <= 6; i++) {
    const ph = (i / 6) * (Math.PI / 2);
    prof.push({ s: 1, d: f * Math.sin(ph), y: floorY + f * (1 - Math.cos(ph)) });
  }
  const wallTop = f + 0.03;
  prof.push({ s: 1, d: wallTop, y: rimY - 0.01 });
  const rr = 0.03;
  for (let i = 0; i <= 8; i++) {
    const ph = Math.PI - (i / 8) * Math.PI;
    prof.push({ s: 1, d: wallTop + rr + rr * Math.cos(ph), y: rimY + rr * Math.sin(ph) });
  }
  const out = wallTop + 2 * rr;
  prof.push({ s: 1, d: out + 0.012, y: rimY * 0.5 });
  prof.push({ s: 1, d: out + 0.02, y: 0.02 });
  prof.push({ s: 1, d: out + 0.005, y: 0 });

  const cols = seg + 1;
  const pos = new Float32Array(prof.length * cols * 3);
  const uv = new Float32Array(prof.length * cols * 2);
  const se = (t: number) => Math.sign(t) * Math.pow(Math.abs(t), 2 / n);
  prof.forEach((p, i) => {
    for (let j = 0; j < cols; j++) {
      const th = (j / seg) * Math.PI * 2;
      const cx = se(Math.cos(th));
      const cz = se(Math.sin(th));
      const k = (i * cols + j) * 3;
      pos[k] = cx * (a * p.s + p.d);
      pos[k + 1] = p.y;
      pos[k + 2] = cz * (b * p.s + p.d);
      uv[(i * cols + j) * 2] = j / seg;
      uv[(i * cols + j) * 2 + 1] = i / (prof.length - 1);
    }
  });
  const idx: number[] = [];
  for (let i = 0; i < prof.length - 1; i++)
    for (let j = 0; j < seg; j++) {
      const p0 = i * cols + j;
      const p1 = p0 + 1;
      const q0 = p0 + cols;
      const q1 = q0 + 1;
      idx.push(p0, p1, q0, p1, q1, q0);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, outerHalf: { x: a + out + 0.02, z: b + out + 0.02 } };
}

/** Hand shower resting in its wall hook (a separate mesh named 'showerHead' so the game can hide it while in use). */
function showerHead(chrome: THREE.Material): THREE.Mesh {
  const handle = cyl(0.014, 0.018, 0.2, 16);
  const head = tf(cyl(0.045, 0.035, 0.03, 32), 0, 0.11, 0.015, 0, 1.1);
  const geo = mergeGeometries([handle, head])!;
  const mesh = new THREE.Mesh(geo, chrome);
  mesh.name = 'showerHead';
  mesh.castShadow = true;
  return mesh;
}

/** Towel folded over a bar: a strip that hangs down the front, wraps the bar and hangs down the back. */
function drapedTowel(width: number, front: number, back: number, barR: number) {
  const segs = 40;
  const g = new THREE.PlaneGeometry(width, 1, 8, segs);
  const p = g.attributes.position;
  const total = front + Math.PI * (barR + 0.006) + back;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const t = (0.5 - p.getY(i)) * total; // 0 at the front bottom hem
    let y: number;
    let z: number;
    const R = barR + 0.006;
    if (t < front) {
      y = -(front - t);
      z = R;
    } else if (t < front + Math.PI * R) {
      const a = (t - front) / R;
      y = Math.sin(a) * R;
      z = Math.cos(a) * R;
    } else {
      y = -(t - front - Math.PI * R);
      z = -R;
    }
    // soft ripples
    const w = Math.sin((x / width) * 9 + t * 4) * 0.004;
    p.setXYZ(i, x, y, z + (z > 0 ? w : -w));
  }
  g.computeVertexNormals();
  return g;
}

export function buildBathroom(renderer: THREE.WebGLRenderer): Bathroom {
  const d: Dims = { W: 3.2, D: 2.8, H: 2.5, t: 0.14 };
  const win: Opening = { wall: 'R', c: -0.45, w: 0.7, y0: 1.35, y1: 1.95 };
  const door: Opening = { wall: 'F', c: 0.7, w: 0.84, y0: 0, y1: 2.05 };
  const openings = [win, door];
  const group = new THREE.Group();
  group.name = 'bathroom';
  const r = rng(77);
  const art = pictureAtlas([paintBotanical, paintLandscape, paintAbstract, paintDogPortrait], 3);
  const m = makePropMats(700, art);
  // walls/ceiling don't block the key light in here: it stands in for the ceiling lamp
  m.paint.userData.cast = false;

  const subway = tileTextures({ px: 1024, cols: 4, rows: 8, grout: 7, colors: ['#f6f7f6', '#f2f4f3', '#fafaf8'], groutColor: '#d9dcda', seed: 3, stagger: true, rough: 0.1 });
  const wallTile = stdMat('wallTile', { map: subway.map, normalMap: subway.normalMap, roughnessMap: subway.roughnessMap, roughness: 1, normalScale: new THREE.Vector2(0.8, 0.8), cast: false });
  const floorT = tileTextures({ px: 1024, cols: 3, rows: 3, grout: 8, colors: ['#e3e7ea', '#dde2e6', '#e8ebed'], groutColor: '#b9bec2', seed: 4, marble: 1, rough: 0.3 });
  const floorTile = stdMat('floorTile', { map: floorT.map, normalMap: floorT.normalMap, roughnessMap: floorT.roughnessMap, roughness: 1, normalScale: new THREE.Vector2(0.7, 0.7), cast: false });
  const band = tileTextures({ px: 256, cols: 4, rows: 1, grout: 4, colors: ['#6fb3c4', '#5fa6b8'], groutColor: '#e4e8e8', seed: 5, rough: 0.12 });
  const bandTile = stdMat('bandTile', { map: band.map, normalMap: band.normalMap, roughness: 0.15, cast: false });
  const enamel = physMat('enamel', { color: '#eef2f3', roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.06 });
  const chrome = stdMat('chrome', { color: '#e8ecef', metalness: 1, roughness: 0.08 });
  const mirror = stdMat('mirror', { color: '#ffffff', metalness: 1, roughness: 0.02, cast: false });
  const frosted = stdMat('frosted', { color: '#eef5f8', emissive: new THREE.Color('#eaf4fa'), emissiveIntensity: 1.6, roughness: 0.5, cast: false });
  const towelTex = plushTextures(81, 256);
  const towel = stdMat('towel', { map: towelTex.map, normalMap: towelTex.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), vertexColors: true, roughness: 1, side: THREE.DoubleSide });

  const b = new Batch();
  const cs = new ContactShadows(0.45);
  const k: Kit = { b, m, cs, obstacles: [], r };
  buildShell(b, m.paint, d, openings, '#d5ecea', '#fbfcfc');
  // floor tiles in world UVs (0.9 m per texture tile = 30 cm tiles)
  const fl = tf(new THREE.PlaneGeometry(d.W, d.D), 0, 0, 0, 0, -Math.PI / 2);
  b.add(floorTile, boxUV(fl, 0.9));
  // tiled lower walls with a coloured band
  const tileTop = 1.22;
  for (const wall of ['L', 'R', 'B', 'F'] as const) {
    const len = wall === 'L' || wall === 'R' ? d.D : d.W;
    const runs: [number, number][] = [];
    if (wall === 'F') runs.push([-len / 2, door.c - door.w / 2 - 0.085], [door.c + door.w / 2 + 0.085, len / 2]);
    else runs.push([-len / 2, len / 2]);
    for (const [s0, s1] of runs) {
      const sm = (s0 + s1) / 2;
      const wl = s1 - s0;
      b.add(wallTile, boxUV(onWall(tf(box(wl, tileTop, 0.012), 0, tileTop / 2, 0.006), d, wall, sm, 0, 0), 0.6));
      b.add(bandTile, boxUV(onWall(tf(box(wl, 0.07, 0.016), 0, tileTop + 0.035, 0.008), d, wall, sm, 0, 0), 0.3, 0.07));
      b.add(m.paint, onWall(tf(rbox(wl, 0.02, 0.03, 0.008, 2), 0, tileTop + 0.08, 0.012), d, wall, sm, 0, 0), '#ffffff');
    }
  }
  moulding(b, m.paint, d, openings, d.H - 0.06, 0.06, 0.03, '#ffffff', 'round');

  // tub against the back wall
  const tubHalf = { x: 0.5, z: 0.29 };
  const floorY = 0.1;
  const rimY = 0.44;
  const tub = tubGeometry(tubHalf.x, tubHalf.z, floorY, rimY);
  const tubZ = -d.D / 2 + tub.outerHalf.z + 0.01;
  b.add(enamel, tf(tub.geometry, 0, 0, tubZ));
  cs.rect(0, tubZ, tub.outerHalf.x * 2 - 0.1, tub.outerHalf.z * 2 - 0.1, 0.12, 0, 0.8);
  // plug and faucet
  b.add(chrome, tf(cyl(0.022, 0.022, 0.004, 20), -tubHalf.x + 0.12, floorY + 0.002, tubZ));
  const wallZ = -d.D / 2;
  const fy = rimY + 0.2;
  b.add(chrome, tf(cyl(0.035, 0.035, 0.02, 24), 0, fy, wallZ + 0.01, 0, Math.PI / 2));
  b.add(chrome, tube([new THREE.Vector3(0, fy, wallZ + 0.01), new THREE.Vector3(0, fy + 0.03, wallZ + 0.09), new THREE.Vector3(0, fy - 0.015, wallZ + 0.17), new THREE.Vector3(0, fy - 0.05, wallZ + 0.18)], 0.016, 24, 12));
  for (const sx of [-1, 1]) {
    b.add(chrome, tf(cyl(0.028, 0.03, 0.05, 20), sx * 0.17, fy, wallZ + 0.025, 0, Math.PI / 2));
    b.add(chrome, tf(box(0.075, 0.014, 0.014), sx * 0.17, fy, wallZ + 0.055));
    b.add(chrome, tf(box(0.014, 0.075, 0.014), sx * 0.17, fy, wallZ + 0.055));
    b.add(m.ceramic, tf(cyl(0.008, 0.008, 0.004, 12), sx * 0.17, fy, wallZ + 0.064, 0, Math.PI / 2), sx < 0 ? '#d9534f' : '#3c7fc4');
  }
  // hose from the diverter up to the hook
  const hookX = 0.42;
  const hookY = 1.38;
  b.add(chrome, tube([new THREE.Vector3(0.1, fy - 0.03, wallZ + 0.05), new THREE.Vector3(0.18, fy - 0.12, wallZ + 0.1), new THREE.Vector3(0.3, fy - 0.1, wallZ + 0.1), new THREE.Vector3(hookX, fy + 0.2, wallZ + 0.07), new THREE.Vector3(hookX, hookY - 0.14, wallZ + 0.07)], 0.008, 48, 8));
  // shower hook: wall plate and cradle
  b.add(chrome, tf(cyl(0.028, 0.028, 0.012, 20), hookX, hookY, wallZ + 0.006, 0, Math.PI / 2));
  b.add(chrome, tf(box(0.02, 0.02, 0.06), hookX, hookY, wallZ + 0.035));
  b.add(chrome, tf(new THREE.TorusGeometry(0.024, 0.006, 8, 20, Math.PI * 1.3), hookX, hookY - 0.005, wallZ + 0.065, 0, Math.PI / 2, -0.65 * Math.PI));
  const sh = showerHead(chrome);
  sh.position.set(hookX, hookY - 0.04, wallZ + 0.07);
  sh.rotation.x = -0.25;
  group.add(sh);

  // shampoo shelf with bottles and soap
  const shX = -0.52;
  const shY = 0.92;
  b.add(m.wood, boxUV(tf(rbox(0.46, 0.025, 0.13, 0.008, 2), shX, shY, wallZ + 0.065), 0.3), '#e8d4b6');
  for (const sx of [-1, 1]) b.add(chrome, tf(box(0.015, 0.05, 0.1), shX + sx * 0.18, shY - 0.035, wallZ + 0.05));
  const bottle = (x: number, h: number, rad: number, col: string, cap: string, pump: boolean) => {
    const y = shY + 0.0125;
    b.add(m.ceramic, tf(lathe([[0.001, 0], [rad, 0], [rad + 0.004, 0.01], [rad + 0.004, h * 0.75], [rad * 0.6, h * 0.92], [rad * 0.45, h]], 20), x, y, wallZ + 0.065), col);
    b.add(m.ceramic, tf(cyl(rad * 0.45, rad * 0.5, 0.03, 12), x, y + h + 0.015, wallZ + 0.065), cap);
    if (pump) {
      b.add(m.ceramic, tf(cyl(0.005, 0.005, 0.03, 8), x, y + h + 0.045, wallZ + 0.065), cap);
      b.add(m.ceramic, tf(box(0.035, 0.012, 0.016), x + 0.012, y + h + 0.06, wallZ + 0.065), cap);
    }
  };
  bottle(shX - 0.15, 0.17, 0.032, '#f2a6c0', '#ffffff', true);
  bottle(shX - 0.06, 0.13, 0.03, '#a8dcc8', '#2f7a64', false);
  bottle(shX + 0.03, 0.19, 0.028, '#fbe28a', '#e59b2f', true);
  bottle(shX + 0.12, 0.11, 0.035, '#c9b8e8', '#6b58a8', false);
  b.add(m.ceramic, tf(rbox(0.07, 0.025, 0.045, 0.012, 3), shX + 0.19, shY + 0.025, wallZ + 0.07), '#fff2dd');

  // rubber duck on the rim corner
  const duckX = tubHalf.x + 0.1;
  const duckZ = tubZ + tubHalf.z + 0.08;
  const duckY = rimY + 0.03;
  b.add(m.ceramic, tf(new THREE.SphereGeometry(0.035, 20, 14), duckX, duckY + 0.03, duckZ, 0, 0, 0, 1.25, 0.85, 1), '#ffd23f');
  b.add(m.ceramic, tf(new THREE.SphereGeometry(0.024, 18, 12), duckX - 0.03, duckY + 0.07, duckZ), '#ffd23f');
  b.add(m.ceramic, tf(cyl(0.004, 0.012, 0.022, 10), duckX - 0.06, duckY + 0.066, duckZ, 0, 0, Math.PI / 2, 1, 1, 0.6), '#f28c28');
  for (const sz of [-1, 1]) b.add(m.matte, tf(new THREE.SphereGeometry(0.0045, 8, 6), duckX - 0.045, duckY + 0.078, duckZ + sz * 0.012), '#1b1b1b');

  // frosted window with a little plant
  windowUnit(k, d, win, '#ffffff', 2, 0, true);
  b.add(frosted, onWall(tf(new THREE.PlaneGeometry(win.w, win.y1 - win.y0), 0, (win.y1 - win.y0) / 2, -d.t * 0.7), d, 'R', win.c, win.y0, 0));
  succulent(k, d.W / 2 - 0.07, win.y0 + 0.016, win.c + 0.2, '#8fc1cf');

  // towel rack with a draped towel
  const rackZ = 0.45;
  const rackY = 1.05;
  const rp = (s: number, y: number, n: number) => wallPoint(d, 'R', s, y, n);
  for (const s of [rackZ - 0.3, rackZ + 0.3]) {
    const p = rp(s, rackY, 0.04);
    b.add(chrome, tf(cyl(0.022, 0.022, 0.01, 16), rp(s, rackY, 0.005).x, rackY, p.z, 0, 0, Math.PI / 2));
    b.add(chrome, tf(cyl(0.008, 0.008, 0.07, 10), rp(s, rackY, 0.04).x, rackY, p.z, 0, 0, Math.PI / 2));
  }
  const barC = rp(rackZ, rackY, 0.075);
  b.add(chrome, tf(cyl(0.011, 0.011, 0.66, 14), barC.x, barC.y, barC.z, 0, Math.PI / 2));
  b.add(towel, tf(drapedTowel(0.45, 0.55, 0.42, 0.011), barC.x, barC.y, barC.z, -Math.PI / 2), '#f6b8a8');
  // stack of folded towels on a stool beside the tub
  b.add(m.wood, boxUV(tf(cyl(0.16, 0.16, 0.03, 28), 0.95, 0.43, tubZ + 0.05), 0.3), '#e8d4b6');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(m.wood, tf(cyl(0.012, 0.014, 0.42, 8), 0.95 + sx * 0.1, 0.21, tubZ + 0.05 + sz * 0.1, 0, sz * 0.08, -sx * 0.08), '#e8d4b6');
  ['#9fd3dc', '#fff6e4', '#f6b8a8'].forEach((c, i) => b.add(towel, tf(rbox(0.26, 0.05, 0.2, 0.022, 3), 0.95, 0.47 + i * 0.05, tubZ + 0.05, 0.05 * i), c));
  cs.blob(0.95, tubZ + 0.05, 0.25, 0.6);
  k.obstacles.push({ x: 0.95, z: tubZ + 0.05, r: 0.2 });

  // vanity with basin and mirror on the left wall
  const vz = 0.35;
  const vP = placer(-d.W / 2 + 0.24, 0, vz, Math.PI / 2);
  b.add(m.paint, vP(boxUV(tf(box(0.8, 0.72, 0.46), 0, 0.08 + 0.36, 0), 0.5)), '#ffffff');
  b.add(m.paint, vP(tf(box(0.76, 0.08, 0.42), 0, 0.04, -0.02)), '#e9eceb');
  for (const sx of [-1, 1]) {
    b.add(m.paint, vP(boxUV(tf(box(0.37, 0.62, 0.016), sx * 0.19, 0.44, 0.235), 0.5)), '#ffffff');
    b.add(chrome, vP(tf(box(0.012, 0.1, 0.012), sx * 0.04, 0.62, 0.255)));
  }
  b.add(m.ceramic, vP(tf(rbox(0.84, 0.035, 0.5, 0.01, 2), 0, 0.82, 0)), '#f4f1ec');
  b.add(enamel, vP(tf(lathe([[0.001, 0.0], [0.12, 0.0], [0.17, 0.06], [0.2, 0.12], [0.215, 0.13], [0.2, 0.13], [0.18, 0.1]], 32), 0, 0.84, 0.02)));
  b.add(chrome, vP(tube([new THREE.Vector3(0, 0.84, -0.2), new THREE.Vector3(0, 1.08, -0.18), new THREE.Vector3(0, 1.1, -0.08), new THREE.Vector3(0, 1.02, -0.06)], 0.012, 20, 10)));
  const mirrorG = new THREE.PlaneGeometry(0.62, 0.75);
  b.add(mirror, onWall(tf(mirrorG, 0, 0, 0.022), d, 'L', vz, 1.55, 0));
  b.add(m.wood, onWall(tf(rbox(0.7, 0.83, 0.02, 0.01, 2), 0, 0, 0.01), d, 'L', vz, 1.55, 0), '#e8d4b6');
  cs.rect(-d.W / 2 + 0.24, vz, 0.46, 0.8, 0.12, Math.PI / 2, 0.7);
  k.obstacles.push({ x: -d.W / 2 + 0.24, z: vz, r: 0.45 });

  // door, bath mat, a picture
  panelDoor(k, d, door, '#ffffff', '#ffffff', '#c9ccd0', 'six');
  const mat = rbox(0.75, 0.018, 0.48, 0.008, 2);
  scaleUV(mat, 3, 2);
  b.add(towel, tf(mat, 0, 0.009, tubZ + tub.outerHalf.z + 0.34), '#9fd3dc');
  wallFrame(k, d, 'F', -0.7, 1.62, 0.34, 0.44, atlasCell(0, 0.34 / 0.44), '#e8d4b6', 0.025, 0.05);
  // wall/floor AO
  for (const [x, z, w, ry] of [[0, -d.D / 2, d.W, 0], [0, d.D / 2, d.W, 0], [-d.W / 2, 0, d.D, Math.PI / 2], [d.W / 2, 0, d.D, Math.PI / 2]] as const) cs.rect(x, z, w, 0.02, 0.22, ry, 0.35);

  b.build(group, 'bath');
  cs.build(group);

  // lighting: soft key from the ceiling lamp (front, above), bright cool fill
  const tubCenter = new THREE.Vector3(0, floorY, tubZ);
  const sun = makeSun('#fff6ea', 2.0, new THREE.Vector3(-0.3, -0.85, -0.42), tubCenter, 1024);
  sun.shadow.radius = 5;
  sun.shadow.normalBias = 0.01;
  fitShadow(sun, new THREE.Box3(new THREE.Vector3(-1.0, 0, -d.D / 2), new THREE.Vector3(1.2, 1.0, tubZ + 0.9)), 0.05);
  group.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight('#f4f9fb', '#c9d2d4', 1.1);
  group.add(hemi);
  // ceiling lamp (emissive disc)
  b.add(m.glow, tf(new THREE.CircleGeometry(0.2, 32), 0, d.H - 0.012, 0, 0, Math.PI / 2), '#ffffff');
  b.add(m.paint, tf(cyl(0.22, 0.22, 0.02, 32), 0, d.H - 0.01, 0), '#ffffff');
  b.build(group, 'bathLamp');

  const environment = captureEnvironment(renderer, group, new THREE.Vector3(0, 1.0, 0), new THREE.Color('#e8f0f2'));
  return {
    group,
    environment,
    background: new THREE.Color('#e8f0f2'),
    sun,
    bounds: { minX: -tubHalf.x, maxX: tubHalf.x, minZ: tubZ - tubHalf.z, maxZ: tubZ + tubHalf.z },
    obstacles: [],
    camera: { position: new THREE.Vector3(0.08, 0.98, tubZ + 0.66), target: new THREE.Vector3(0, 0.27, tubZ - 0.1), fov: 50 },
    tubCenter,
    tubHalf,
    dispose() {
      disposeTree(group);
      environment.dispose();
    },
  };
}
