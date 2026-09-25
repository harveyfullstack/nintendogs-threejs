// Bright pet-shop kennel where you choose a puppy: a low-fenced pen with soft
// bedding, a few toys, and a cheerful sign on the wall.

import * as THREE from 'three';
import { texSize } from '../game/quality';
import type { Kennel } from './types';
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
  canvasTex,
  captureEnvironment,
  cyl,
  disposeTree,
  dogBed,
  fitShadow,
  gardenTexture,
  lathe,
  makeCanvas,
  makePropMats,
  makeSun,
  moulding,
  onWall,
  paintDogPortrait,
  paintLandscape,
  paintBotanical,
  paintAbstract,
  panelDoor,
  pictureAtlas,
  placer,
  plushTextures,
  rbox,
  rng,

  snakePlant,
  stdMat,
  sunbeam,
  tf,
  tileTextures,
  trailingPlant,
  tube,
  wallFrame,
  windowUnit,
  atlasUV,
  figTree,
} from './room';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Painted wooden shop sign: "Puppy Kennel" with paw prints. */
function signTexture() {
  const W = 1024;
  const H = 384;
  const { c, g } = makeCanvas(W, H);
  g.fillStyle = '#c98f5a';
  g.fillRect(0, 0, W, H);
  // plank lines
  for (let i = 1; i < 4; i++) {
    g.fillStyle = 'rgba(80,45,20,0.35)';
    g.fillRect(0, (H / 4) * i - 2, W, 3);
  }
  for (let i = 0; i < 400; i++) {
    g.strokeStyle = `rgba(90,50,20,${0.05 + Math.random() * 0.08})`;
    g.beginPath();
    const y = Math.random() * H;
    g.moveTo(0, y);
    g.bezierCurveTo(W * 0.3, y + 6, W * 0.6, y - 6, W, y + 3);
    g.stroke();
  }
  // cream panel
  g.fillStyle = '#fff4dc';
  g.beginPath();
  g.roundRect(28, 28, W - 56, H - 56, 40);
  g.fill();
  g.strokeStyle = '#e8766a';
  g.lineWidth = 10;
  g.beginPath();
  g.roundRect(44, 44, W - 88, H - 88, 30);
  g.stroke();
  const paw = (x: number, y: number, s: number, col: string, rot = 0) => {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillStyle = col;
    g.beginPath();
    g.ellipse(0, 0, 22 * s, 18 * s, 0, 0, 6.283);
    g.fill();
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      g.ellipse((k - 1.5) * 15 * s, -27 * s - (k === 1 || k === 2 ? 8 * s : 0), 7.5 * s, 9.5 * s, 0, 0, 6.283);
      g.fill();
    }
    g.restore();
  };
  paw(120, 200, 1.6, '#f2a541', -0.3);
  paw(W - 120, 170, 1.6, '#5fa8d3', 0.3);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 116px "Arial Rounded MT Bold", "Trebuchet MS", "Verdana", sans-serif';
  g.lineWidth = 14;
  g.strokeStyle = '#ffffff';
  g.strokeText('Puppy Kennel', W / 2, H / 2 - 24);
  g.fillStyle = '#6b3e26';
  g.fillText('Puppy Kennel', W / 2, H / 2 - 24);
  g.font = 'bold 44px "Arial Rounded MT Bold", "Trebuchet MS", "Verdana", sans-serif';
  g.fillStyle = '#e8766a';
  g.fillText('Find your new best friend!', W / 2, H / 2 + 72);
  const t = canvasTex(c, true, false);
  return t;
}

/** Simple toys for the pen (static decoration). */
function penToys(k: Kit, cx: number, y: number, cz: number) {
  const { b, m } = k;
  // tennis ball
  b.add(m.plush, tf(new THREE.SphereGeometry(0.033, 20, 14), cx - 0.8, y + 0.033, cz + 0.45), '#d7e84a');
  // red rubber ball
  b.add(m.ceramic, tf(new THREE.SphereGeometry(0.045, 24, 16), cx + 0.65, y + 0.045, cz + 0.5), '#e2443d');
  // rope toy with knots
  const rope = [new THREE.Vector3(cx + 0.2, y + 0.022, cz - 0.1), new THREE.Vector3(cx + 0.3, y + 0.022, cz - 0.05), new THREE.Vector3(cx + 0.4, y + 0.022, cz - 0.12), new THREE.Vector3(cx + 0.5, y + 0.022, cz - 0.08)];
  b.add(m.fabric, tube(rope, 0.014, 24, 8), '#3b7dd8');
  for (const p of [rope[0], rope[3]]) b.add(m.fabric, tf(new THREE.SphereGeometry(0.028, 14, 10), p.x, p.y + 0.006, p.z), '#f4f0e6');
  // bone
  const bx = cx - 0.3;
  const bz = cz + 0.15;
  b.add(m.ceramic, tf(cyl(0.018, 0.018, 0.14, 12), bx, y + 0.02, bz, 0.6, 0, Math.PI / 2), '#f1e6d0');
  for (const s of [-1, 1])
    for (const t of [-1, 1]) {
      const ex = bx + Math.cos(0.6) * s * 0.07;
      const ez = bz - Math.sin(0.6) * s * 0.07;
      b.add(m.ceramic, tf(new THREE.SphereGeometry(0.022, 12, 10), ex + Math.sin(0.6) * t * 0.014, y + 0.022, ez + Math.cos(0.6) * t * 0.014), '#f1e6d0');
    }
  // teddy plush
  const tx = cx + 0.95;
  const tz = cz - 0.5;
  b.add(m.plush, tf(new THREE.SphereGeometry(0.06, 18, 14), tx, y + 0.06, tz, 0, 0, 0, 1, 1.1, 0.9), '#b98a5e');
  b.add(m.plush, tf(new THREE.SphereGeometry(0.045, 18, 14), tx, y + 0.15, tz + 0.01), '#b98a5e');
  for (const s of [-1, 1]) {
    b.add(m.plush, tf(new THREE.SphereGeometry(0.018, 10, 8), tx + s * 0.035, y + 0.19, tz), '#b98a5e');
    b.add(m.plush, tf(new THREE.SphereGeometry(0.022, 10, 8), tx + s * 0.055, y + 0.03, tz + 0.04), '#b98a5e');
  }
  b.add(m.plush, tf(new THREE.SphereGeometry(0.018, 10, 8), tx, y + 0.14, tz + 0.05), '#e8d2b4');
  // squeaky duck-ish toy
  b.add(m.ceramic, tf(new THREE.SphereGeometry(0.035, 18, 12), cx - 0.95, y + 0.03, cz - 0.45, 0, 0, 0, 1.2, 0.8, 1), '#ff8fb1');
  b.add(m.ceramic, tf(new THREE.SphereGeometry(0.022, 14, 10), cx - 0.98, y + 0.07, cz - 0.45), '#ff8fb1');
}

/** Low white fence around an inner rectangle (half-size hx, hz) with pastel post caps. */
function penFence(k: Kit, cx: number, cz: number, hx: number, hz: number, h: number) {
  const { b, m } = k;
  const caps = ['#f6a6b2', '#8fd0e6', '#ffd66b', '#a8dca0'];
  const t = 0.06;
  const ox = hx + t / 2;
  const oz = hz + t / 2;
  let ci = 0;
  const post = (x: number, z: number) => {
    b.add(m.paint, tf(rbox(t, h, t, 0.012, 2), x, h / 2, z), '#ffffff');
    b.add(m.ceramic, tf(new THREE.SphereGeometry(0.038, 16, 12), x, h + 0.02, z), caps[ci++ % caps.length]);
  };
  const side = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ry = -Math.atan2(z1 - z0, x1 - x0);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    for (const y of [0.06, h - 0.05]) b.add(m.paint, tf(rbox(len, 0.04, 0.035, 0.012, 2), mx, y, mz, ry), '#ffffff');
    const n = Math.round(len / 0.075);
    for (let i = 1; i < n; i++) {
      const f = i / n;
      b.add(m.paint, tf(cyl(0.011, 0.011, h - 0.1, 8), x0 + (x1 - x0) * f, 0.06 + (h - 0.1) / 2, z0 + (z1 - z0) * f), '#ffffff');
    }
    const posts = Math.max(1, Math.round(len / 0.8));
    for (let i = 0; i < posts; i++) post(x0 + ((x1 - x0) * i) / posts, z0 + ((z1 - z0) * i) / posts);
  };
  side(cx - ox, cz - oz, cx + ox, cz - oz);
  side(cx + ox, cz - oz, cx + ox, cz + oz);
  side(cx + ox, cz + oz, cx - ox, cz + oz);
  side(cx - ox, cz + oz, cx - ox, cz - oz);
  k.cs.rect(cx, cz, hx * 2 + 0.1, hz * 2 + 0.1, 0.12, 0, 0.35);
}

/** Bunting: triangular flags along a sagging line between two points. */
function bunting(k: Kit, a: THREE.Vector3, bb: THREE.Vector3, sag: number, colors: string[]) {
  const pts: THREE.Vector3[] = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(new THREE.Vector3().lerpVectors(a, bb, t).add(new THREE.Vector3(0, -Math.sin(Math.PI * t) * sag, 0)));
  }
  k.b.add(k.m.matte, tube(pts, 0.004, 40, 4), '#f4f0e6');
  const curve = new THREE.CatmullRomCurve3(pts);
  const flags = Math.round(a.distanceTo(bb) / 0.24);
  for (let i = 0; i < flags; i++) {
    const p = curve.getPoint((i + 0.5) / flags);
    const tan = curve.getTangent((i + 0.5) / flags);
    const g = new THREE.BufferGeometry();
    const w = 0.09;
    const v = [-w, 0, 0, w, 0, 0, 0, -0.17, 0];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setIndex([0, 2, 1]);
    const ang = Math.atan2(tan.y, Math.hypot(tan.x, tan.z));
    k.b.add(k.m.fabric, tf(g, p.x, p.y, p.z, -Math.atan2(tan.z, tan.x), 0.08, ang), colors[i % colors.length]);
  }
}

/** Bag of dog food standing on a shelf. */
function foodBag(k: Kit, x: number, y: number, z: number, col: string, label: string) {
  const { b, m } = k;
  b.add(m.matte, tf(rbox(0.22, 0.3, 0.1, 0.03, 3), x, y + 0.15, z), col);
  b.add(m.matte, tf(box(0.16, 0.11, 0.004), x, y + 0.14, z + 0.051), label);
  b.add(m.matte, tf(new THREE.SphereGeometry(0.03, 12, 8), x, y + 0.15, z + 0.054, 0, 0, 0, 1, 1, 0.2), '#8a5a32');
}

export function buildKennel(renderer: THREE.WebGLRenderer): Kennel {
  const d: Dims = { W: 6.4, D: 5.2, H: 3.0, t: 0.16 };
  const win: Opening = { wall: 'L', c: -0.2, w: 2.6, y0: 0.55, y1: 2.45 };
  const door: Opening = { wall: 'R', c: 1.1, w: 1.0, y0: 0, y1: 2.15 };
  const openings = [win, door];
  const group = new THREE.Group();
  group.name = 'kennel';
  const r = rng(91);
  const art = pictureAtlas([paintDogPortrait, paintLandscape, paintBotanical, paintAbstract], 13);
  const m = makePropMats(900, art);
  const tiles = tileTextures({ px: texSize(1024), cols: 2, rows: 2, grout: 3, colors: ['#f6efe0', '#cfe6ef'], groutColor: '#d6d0c4', seed: 9, checker: true, rough: 0.35 });
  const floorMat = stdMat('floorTile', { map: tiles.map, normalMap: tiles.normalMap, roughnessMap: tiles.roughnessMap, roughness: 1, normalScale: new THREE.Vector2(0.3, 0.3), cast: false });
  const fleece = plushTextures(92, 256);
  const beddingMat = stdMat('bedding', { map: fleece.map, normalMap: fleece.normalMap, normalScale: new THREE.Vector2(1.2, 1.2), vertexColors: true, roughness: 1, cast: false });
  const signMat = stdMat('sign', { map: signTexture(), roughness: 0.6 });

  const b = new Batch();
  const cs = new ContactShadows(0.45);
  const k: Kit = { b, m, cs, obstacles: [], r };
  buildShell(b, m.paint, d, openings, '#fff4de', '#fffaf2');
  b.add(floorMat, boxUV(tf(new THREE.PlaneGeometry(d.W, d.D), 0, 0, 0, 0, -Math.PI / 2), 0.8));
  // pastel wainscot band and rails
  for (const wall of ['L', 'R', 'B', 'F'] as const) {
    const len = wall === 'L' || wall === 'R' ? d.D : d.W;
    const runs: [number, number][] = wall === 'R' ? [[-len / 2, door.c - door.w / 2 - 0.085], [door.c + door.w / 2 + 0.085, len / 2]] : [[-len / 2, len / 2]];
    for (const [s0, s1] of runs) {
      const top = wall === 'L' ? 0.47 : 1.0;
      if (wall === 'L') {
        // below the window only up to the sill, full height elsewhere
        const a0 = win.c - win.w / 2 - 0.085;
        const a1 = win.c + win.w / 2 + 0.085;
        for (const [x0, x1, h] of [[s0, a0, 1.0], [a0, a1, top], [a1, s1, 1.0]] as const) {
          b.add(m.paint, onWall(tf(box(x1 - x0, h, 0.012), 0, h / 2, 0.006), d, wall, (x0 + x1) / 2, 0, 0), '#a9d6e5');
          if (h === 1.0) b.add(m.paint, onWall(tf(rbox(x1 - x0, 0.045, 0.04, 0.012, 2), 0, h, 0.012), d, wall, (x0 + x1) / 2, 0, 0), '#ffffff');
        }
      } else {
        b.add(m.paint, onWall(tf(box(s1 - s0, top, 0.012), 0, top / 2, 0.006), d, wall, (s0 + s1) / 2, 0, 0), '#a9d6e5');
        b.add(m.paint, onWall(tf(rbox(s1 - s0, 0.045, 0.04, 0.012, 2), 0, top, 0.012), d, wall, (s0 + s1) / 2, 0, 0), '#ffffff');
      }
    }
  }
  moulding(b, m.paint, d, openings, 0, 0.1, 0.018, '#ffffff', 'round', 0.085);
  moulding(b, m.paint, d, [], d.H - 0.07, 0.07, 0.03, '#ffffff', 'round');
  for (const [x, z, w, ry] of [[0, -d.D / 2, d.W, 0], [0, d.D / 2, d.W, 0], [-d.W / 2, 0, d.D, Math.PI / 2], [d.W / 2, 0, d.D, Math.PI / 2]] as const) cs.rect(x, z, w, 0.02, 0.25, ry, 0.4);

  // pen: fleece bedding, fence, beds, toys
  const penCenter = new THREE.Vector3(0, 0.03, -0.45);
  const penHalf = { x: 1.2, z: 0.8 };
  const bed = rbox(penHalf.x * 2 + 0.04, 0.06, penHalf.z * 2 + 0.04, 0.025, 3);
  boxUV(bed, 0.35);
  b.add(beddingMat, tf(bed, penCenter.x, 0, penCenter.z), '#f7ead0');
  penFence(k, penCenter.x, penCenter.z, penHalf.x + 0.02, penHalf.z + 0.02, 0.5);
  dogBed(k, penCenter.x - penHalf.x + 0.32, penCenter.z - penHalf.z + 0.32, '#f2a6b4', '#fff3e6', 0.3);
  dogBed(k, penCenter.x + penHalf.x - 0.32, penCenter.z - penHalf.z + 0.32, '#8fc9e0', '#fff3e6', 0.3);
  // the beds sit on the bedding
  penToys(k, penCenter.x, penCenter.y, penCenter.z);

  // back wall: the sign, bunting and puppy photos
  const signG = new THREE.PlaneGeometry(2.5, 0.94);
  b.add(signMat, onWall(tf(signG, 0, 0, 0.035), d, 'B', 0, 1.72, 0));
  b.add(m.wood, onWall(boxUV(tf(rbox(2.58, 1.02, 0.03, 0.012, 2), 0, 0, 0.015), 0.5), d, 'B', 0, 1.72, 0), '#8a5a36');
  cs.wall(0, 1.7, -d.D / 2 + 0.002, 2.58, 1.02, 0.06, 0, 0.35);
  bunting(k, new THREE.Vector3(-d.W / 2 + 0.1, 2.75, -d.D / 2 + 0.06), new THREE.Vector3(-0.1, 2.75, -d.D / 2 + 0.06), 0.25, ['#f6a6b2', '#8fd0e6', '#ffd66b', '#a8dca0', '#c9b1e8']);
  bunting(k, new THREE.Vector3(0.1, 2.75, -d.D / 2 + 0.06), new THREE.Vector3(d.W / 2 - 0.1, 2.75, -d.D / 2 + 0.06), 0.25, ['#ffd66b', '#a8dca0', '#c9b1e8', '#f6a6b2', '#8fd0e6']);
  wallFrame(k, d, 'B', -2.25, 1.35, 0.4, 0.4, atlasCell(0), '#ffffff', 0.03, 0.04);
  wallFrame(k, d, 'B', 2.25, 1.35, 0.4, 0.4, atlasCell(0), '#ffffff', 0.03, 0.04);

  // right wall: door and shelves of food and toys
  panelDoor(k, d, door, '#ffffff', '#ffffff', '#c9a36a');
  const shP = placer(d.W / 2 - 0.2, 0, -1.0, -Math.PI / 2);
  const shelfW = 1.6;
  for (const sx of [-1, 1]) b.add(m.wood, shP(boxUV(tf(box(0.03, 1.8, 0.36), sx * (shelfW / 2 - 0.015), 0.9, 0), 0.5)), '#d9b88c');
  for (const y of [0.1, 0.62, 1.14, 1.66]) b.add(m.wood, shP(boxUV(tf(box(shelfW, 0.03, 0.36), 0, y, 0), 0.5)), '#d9b88c');
  const bagCols: [string, string][] = [['#e8766a', '#fff4dc'], ['#5fa8d3', '#fff4dc'], ['#f2a541', '#ffffff'], ['#79b86a', '#fff4dc']];
  for (let i = 0; i < 5; i++) {
    const [c1, c2] = bagCols[i % bagCols.length];
    const lx = -shelfW / 2 + 0.2 + i * 0.3;
    const p = new THREE.Vector3(lx, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2).add(new THREE.Vector3(d.W / 2 - 0.2, 0, -1.0));
    foodBag(k, p.x, 0.115, p.z, c1, c2);
    const p2 = new THREE.Vector3(lx + 0.05, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2).add(new THREE.Vector3(d.W / 2 - 0.2, 0, -1.0));
    if (i % 2 === 0) foodBag(k, p2.x, 0.635, p2.z, bagCols[(i + 1) % 4][0], '#ffffff');
  }
  for (let i = 0; i < 6; i++) {
    const lx = -shelfW / 2 + 0.18 + i * 0.25;
    const p = new THREE.Vector3(lx, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2).add(new THREE.Vector3(d.W / 2 - 0.2, 0, -1.0));
    b.add(i % 2 ? m.ceramic : m.plush, tf(new THREE.SphereGeometry(0.05, 16, 12), p.x, 1.2, p.z), ['#e2443d', '#d7e84a', '#5fa8d3', '#ff8fb1', '#ffd66b', '#79b86a'][i]);
    b.add(m.ceramic, tf(lathe([[0.001, 0], [0.07, 0], [0.08, 0.05], [0.07, 0.055]], 20), p.x, 1.675, p.z), ['#f6a6b2', '#8fd0e6', '#ffd66b'][i % 3]);
  }
  cs.rect(d.W / 2 - 0.2, -1.0, 0.36, shelfW, 0.1, 0, 0.7);

  // front / left: plants, bench, window
  windowUnit(k, d, win, '#ffffff', 3, 0.5);
  figTree(k, -d.W / 2 + 0.45, -d.D / 2 + 0.45, 1.6, 'taper', '#f6a6b2');
  snakePlant(k, -d.W / 2 + 0.4, d.D / 2 - 0.4, '#8fd0e6');
  trailingPlant(k, -d.W / 2 + 0.08, win.y0 + 0.016, win.c + 0.8, '#ffd66b', 0.6);
  const bench = placer(-1.2, 0, d.D / 2 - 0.3, Math.PI);
  b.add(m.wood, bench(boxUV(tf(rbox(1.4, 0.05, 0.38, 0.01, 2), 0, 0.44, 0), 0.5)), '#d9b88c');
  for (const sx of [-1, 1]) b.add(m.wood, bench(boxUV(tf(box(0.05, 0.42, 0.34), sx * 0.6, 0.21, 0), 0.5)), '#d9b88c');
  b.add(m.fabric, bench(tf(rbox(1.3, 0.05, 0.34, 0.02, 2), 0, 0.49, 0)), '#f2a6b4');
  cs.rect(-1.2, d.D / 2 - 0.3, 1.4, 0.38, 0.1, 0, 0.6);
  b.add(m.ceramic, tf(cyl(0.2, 0.2, 0.004, 40), 0, d.H - 0.002, 0), '#ffffff');
  b.add(m.glow, tf(new THREE.CircleGeometry(0.19, 32), 0, d.H - 0.005, 0, 0, Math.PI / 2), '#ffffff');

  b.build(group, 'kennel');
  cs.build(group);

  const sunDir = new THREE.Vector3(0.75, -0.6, -0.25);
  const sun = makeSun('#fff0d8', 3.0, sunDir, penCenter.clone().setY(0));
  fitShadow(sun, new THREE.Box3(new THREE.Vector3(-d.W / 2 - d.t, 0, -d.D / 2 - d.t), new THREE.Vector3(d.W / 2 + d.t, d.H + d.t, d.D / 2 + d.t)), 0.05);
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight('#fbf8f2', '#d8ccb8', 1.5));
  // garden outside the window
  const garden = gardenTexture(33, { sky: ['#78b4e6', '#eef5f9'], far: ['#9cb9a8', '#a9c4b4', '#8fae9c'], trees: ['#4d7a35', '#5f8d3f', '#3f6a2d', '#6f9c48'], lawn: '#7aa84c', flowers: ['#f2a7b6', '#f7d65c', '#ffffff'] });
  const outside = new THREE.MeshBasicMaterial({ map: garden, fog: false });
  outside.color.setScalar(1.25);
  const plane = new THREE.PlaneGeometry(36, 16);
  atlasUV(plane, 0, 0.125, 1, 1);
  const lawn = new THREE.PlaneGeometry(36, 11);
  atlasUV(lawn, 0, 0.01, 1, 0.1);
  const n = -(d.t + 11);
  const bd = new THREE.Mesh(mergeGeometries([onWall(tf(plane, 0, -0.35 + 8, 0), d, 'L', 0, 0, n), onWall(tf(lawn, 0, -0.35, 5.5, 0, -Math.PI / 2), d, 'L', 0, 0, n)])!, outside);
  bd.name = 'outside';
  group.add(bd);
  const beam = sunbeam(d, win, sunDir, '#ffe8c8', 0.035, 160);
  group.add(beam.group);
  beam.group.visible = false;

  const environment = captureEnvironment(renderer, group, new THREE.Vector3(0, 1.0, 0), new THREE.Color('#e6eef2'));
  beam.group.visible = true;
  const size = new THREE.Vector2();
  return {
    group,
    environment,
    background: new THREE.Color('#cfe2f0'),
    sun,
    bounds: { minX: penCenter.x - penHalf.x, maxX: penCenter.x + penHalf.x, minZ: penCenter.z - penHalf.z, maxZ: penCenter.z + penHalf.z },
    obstacles: [],
    camera: { position: new THREE.Vector3(0, 1.55, 2.3), target: new THREE.Vector3(0, 0.42, -1.0), fov: 50 },
    penCenter,
    penHalf,
    update(_dt, time) {
      renderer.getDrawingBufferSize(size);
      beam.update(time, size.y);
    },
    dispose() {
      disposeTree(group);
      environment.dispose();
    },
  };
}

