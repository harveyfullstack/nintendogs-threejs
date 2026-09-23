// The suburban neighbourhood you walk your puppy through, plus the shared
// "outdoor kit" (procedural textures, batching, sky + sun, trees, grass blades,
// houses, benches, fences) that the park, disc arena and agility course reuse.
//
// Everything static is merged into a handful of meshes per material and per
// spatial chunk, so the whole town costs well under a hundred draw calls and the
// shadow pass only touches the chunks near the dog.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Bounds, Circle, TownLayout, TownWorld } from './types';
import { blockRect, pitch } from './townLayout';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// =============================================================================
// Random numbers and noise
// =============================================================================

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1]; tiles with the given periods when they are > 0. */
export function noise2(x: number, y: number, seed = 0, px = 0, py = px): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const w = (i: number, j: number) => {
    let a = xi + i, b = yi + j;
    if (px > 0) a = ((a % px) + px) % px;
    if (py > 0) b = ((b % py) + py) % py;
    return hash2(a, b, seed);
  };
  const a = w(0, 0), b = w(1, 0), c = w(0, 1), d = w(1, 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm2(x: number, y: number, octaves = 4, seed = 0, px = 0, py = px): number {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x, y, seed + o * 31, px, py);
    norm += amp;
    x *= 2; y *= 2; px *= 2; py *= 2; amp *= 0.5;
  }
  return sum / norm;
}

function noise3(x: number, y: number, z: number, seed = 0): number {
  const zi = Math.floor(z), fz = z - zi;
  const w = fz * fz * (3 - 2 * fz);
  const a = noise2(x + zi * 17.31, y - zi * 9.73, seed);
  const b = noise2(x + (zi + 1) * 17.31, y - (zi + 1) * 9.73, seed);
  return a + (b - a) * w;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// =============================================================================
// Canvas textures
// =============================================================================

export function makeCanvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function fillPixels(c: HTMLCanvasElement, fn: (x: number, y: number, o: number[]) => void) {
  const g = c.getContext('2d')!;
  const img = g.createImageData(c.width, c.height);
  const d = img.data;
  const o = [0, 0, 0, 255];
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      o[3] = 255;
      fn(x, y, o);
      const i = (y * c.width + x) * 4;
      d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o[3];
    }
  }
  g.putImageData(img, 0, 0);
}

/** Texture whose UVs are given in metres: one repeat covers `tile` metres. */
export function canvasTexture(c: HTMLCanvasElement, tile = 1, color = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.repeat.set(1 / tile, 1 / tile);
  return t;
}

/** Calls draw() at every wrapped copy that touches the canvas, so strokes tile seamlessly. */
function wrapDraw(w: number, h: number, x: number, y: number, r: number, draw: (x: number, y: number) => void) {
  for (const dx of [-w, 0, w]) {
    for (const dy of [-h, 0, h]) {
      const px = x + dx, py = y + dy;
      if (px + r >= 0 && px - r <= w && py + r >= 0 && py - r <= h) draw(px, py);
    }
  }
}

export function grassCanvas(size = 512, seed = 1): HTMLCanvasElement {
  const c = makeCanvas(size);
  fillPixels(c, (x, y, o) => {
    const n = fbm2((x / size) * 8, (y / size) * 8, 4, seed, 8);
    const m = noise2((x / size) * 40, (y / size) * 40, seed + 9, 40);
    const t = n * 0.75 + m * 0.25;
    o[0] = 62 + t * 46; o[1] = 100 + t * 52; o[2] = 30 + t * 18;
  });
  const g = c.getContext('2d')!;
  const r = mulberry32(seed * 97 + 3);
  g.lineCap = 'round';
  const n = Math.floor(size * size * 0.075);
  for (let i = 0; i < n; i++) {
    const x = r() * size, y = r() * size, a = r() * Math.PI * 2, l = 2.5 + r() * 7;
    const hue = 72 + r() * 32, sat = 38 + r() * 30, lit = 20 + r() * 30;
    g.strokeStyle = `hsl(${hue},${sat}%,${lit}%)`;
    g.lineWidth = 0.8 + r() * 1.3;
    const dx = Math.cos(a) * l, dy = Math.sin(a) * l;
    wrapDraw(size, size, x, y, l, (px, py) => {
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + dx, py + dy); g.stroke();
    });
  }
  return c;
}

function concreteCanvas(size = 256, seed = 2, base = [200, 196, 188]): HTMLCanvasElement {
  const c = makeCanvas(size);
  fillPixels(c, (x, y, o) => {
    const n = fbm2((x / size) * 6, (y / size) * 6, 5, seed, 6);
    const s = hash2(x, y, seed);
    const v = 0.8 + n * 0.28 + (s > 0.975 ? -0.12 : s < 0.02 ? 0.07 : 0);
    o[0] = base[0] * v; o[1] = base[1] * v; o[2] = base[2] * v;
  });
  return c;
}

/** 2x2 sidewalk slabs covering one sidewalk width square, with joints and wear. */
function sidewalkCanvas(size = 512): HTMLCanvasElement {
  const c = makeCanvas(size);
  const half = size / 2;
  fillPixels(c, (x, y, o) => {
    const sx = Math.floor(x / half), sy = Math.floor(y / half);
    const slab = (hash2(sx, sy, 5) - 0.5) * 0.07;
    const n = fbm2((x / size) * 10, (y / size) * 10, 5, 3, 10);
    const stain = fbm2((x / size) * 3, (y / size) * 3, 3, 8, 3);
    const sp = hash2(x, y, 9);
    let v = 0.8 + slab + n * 0.14 - Math.max(0, stain - 0.62) * 0.35 + (sp > 0.985 ? -0.09 : sp < 0.01 ? 0.05 : 0);
    const jx = Math.min(x % half, half - (x % half));
    const jy = Math.min(y % half, half - (y % half));
    const j = Math.min(jx, jy);
    if (j < 1.6) v *= 0.52;
    else if (j < 5) v *= 0.92 + ((j - 1.6) / 3.4) * 0.08;
    o[0] = 208 * v; o[1] = 203 * v; o[2] = 193 * v;
  });
  const g = c.getContext('2d')!;
  const r = mulberry32(44);
  g.strokeStyle = 'rgba(70,66,60,0.55)';
  g.lineWidth = 1;
  for (let k = 0; k < 5; k++) {
    let x = r() * size, y = r() * size;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 8; s++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; g.lineTo(x, y); }
    g.stroke();
  }
  return c;
}

function asphaltCanvas(size = 512): HTMLCanvasElement {
  const c = makeCanvas(size);
  fillPixels(c, (x, y, o) => {
    const n = fbm2((x / size) * 8, (y / size) * 8, 5, 21, 8);
    const big = fbm2((x / size) * 2, (y / size) * 2, 3, 22, 2);
    const s = hash2(x, y, 23);
    let v = 0.3 + n * 0.09 + (big - 0.5) * 0.06;
    if (s > 0.9) v += (s - 0.9) * 1.6;
    else if (s < 0.06) v -= 0.05;
    o[0] = v * 250; o[1] = v * 252; o[2] = v * 258;
  });
  const g = c.getContext('2d')!;
  const r = mulberry32(5);
  g.strokeStyle = 'rgba(28,28,30,0.35)';
  for (let k = 0; k < 2; k++) {
    let x = r() * size, y = r() * size;
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 10; s++) { x += (r() - 0.5) * 22 + 8; y += (r() - 0.5) * 22; g.lineTo(x, y); }
    g.stroke();
  }
  return c;
}

/** Horizontal lap siding, near white so vertex colours set the paint colour. 8 boards per tile. */
function sidingCanvas(size = 256): HTMLCanvasElement {
  const c = makeCanvas(size);
  const bh = size / 8;
  fillPixels(c, (x, y, o) => {
    const b = y % bh;
    const board = Math.floor(y / bh);
    let v = 0.97 - (b / bh) * 0.1;
    if (b > bh - 3) v = 0.6 + (bh - 1 - b) * 0.08;
    if (b < 1) v = 1;
    v += (fbm2((x / size) * 3 + board * 5.1, (y / size) * 60, 2, 4, 3, 60) - 0.5) * 0.05;
    const jx = Math.floor(hash2(board, 1, 3) * size);
    if (Math.abs(x - jx) < 1) v *= 0.82;
    o[0] = o[1] = o[2] = 250 * v;
  });
  return c;
}

/** Running-bond brick; 16 courses x 5 bricks per tile. */
function brickCanvas(size = 512, palette: [number, number, number] = [150, 72, 52]): HTMLCanvasElement {
  const c = makeCanvas(size);
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9c1b3';
  g.fillRect(0, 0, size, size);
  const rows = 16, cols = 5;
  const rh = size / rows, bw = size / cols;
  const r = mulberry32(12);
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let k = -1; k <= cols; k++) {
      const x0 = k * bw + off;
      const t = 0.8 + r() * 0.35;
      const burnt = r() < 0.12 ? 0.75 : 1;
      g.fillStyle = `rgb(${palette[0] * t * burnt},${palette[1] * t * burnt * (0.95 + r() * 0.1)},${palette[2] * t * burnt})`;
      g.fillRect(x0 + 1.5, row * rh + 1.5, bw - 3, rh - 3);
    }
  }
  const img = g.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = 0.88 + fbm2((x / size) * 32, (y / size) * 32, 2, 7, 32) * 0.2 + (hash2(x, y, 3) - 0.5) * 0.1;
      img.data[i] *= v; img.data[i + 1] *= v; img.data[i + 2] *= v;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Architectural shingles, grey so vertex colours tint them. 8 rows per tile. */
function shingleCanvas(size = 512): HTMLCanvasElement {
  const c = makeCanvas(size);
  const rows = 8, rh = size / rows, tabs = 6, tw = size / tabs;
  fillPixels(c, (x, y, o) => {
    const row = Math.floor(y / rh);
    const off = hash2(row, 0, 41) * tw;
    const xx = (x + off) % size;
    const tab = Math.floor(xx / tw);
    const inRow = y % rh;
    let v = 0.62 + hash2(tab, row, 42) * 0.3;
    const gx = xx % tw;
    if (gx < 2) v *= 0.35;
    if (inRow > rh - 5) v *= 0.45 + (rh - inRow) * 0.08;
    else if (inRow < 3) v *= 1.06;
    v *= 0.9 + hash2(x, y, 43) * 0.18;
    o[0] = o[1] = o[2] = Math.min(255, 248 * v);
  });
  return c;
}

function barkCanvas(w = 128, h = 256): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  fillPixels(c, (x, y, o) => {
    const n = fbm2((x / w) * 8, (y / h) * 3, 4, 61, 8, 3);
    const f = fbm2((x / w) * 16, (y / h) * 2, 2, 62, 16, 2);
    let v = 0.55 + n * 0.5;
    if (f < 0.38) v *= 0.55;
    o[0] = 118 * v; o[1] = 104 * v; o[2] = 90 * v;
  });
  return c;
}

function leafShape(g: CanvasRenderingContext2D, x: number, y: number, len: number, a: number) {
  const w = len * 0.42;
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  g.moveTo(-len / 2, 0);
  g.quadraticCurveTo(0, -w, len / 2, 0);
  g.quadraticCurveTo(0, w, -len / 2, 0);
  g.fill();
  g.restore();
}

/** Dense, low-saturation leaf texture; the vertex colour supplies the hue. */
function leafCanvas(size = 512): HTMLCanvasElement {
  const c = makeCanvas(size);
  const g = c.getContext('2d')!;
  g.fillStyle = '#4c5049';
  g.fillRect(0, 0, size, size);
  const r = mulberry32(81);
  for (let i = 0; i < 3400; i++) {
    const x = r() * size, y = r() * size, len = 9 + r() * 12, a = r() * Math.PI * 2;
    const l = 42 + r() * 50;
    g.fillStyle = `hsl(${75 + r() * 30},${6 + r() * 9}%,${l}%)`;
    wrapDraw(size, size, x, y, len, (px, py) => leafShape(g, px, py, len, a));
  }
  return c;
}

/** Leaf cluster sprite with alpha, for the fringe cards around canopies. */
function leafCardCanvas(size = 256): HTMLCanvasElement {
  const c = makeCanvas(size);
  const g = c.getContext('2d')!;
  const r = mulberry32(82);
  g.strokeStyle = '#5b5040';
  g.lineWidth = 2;
  for (let k = 0; k < 5; k++) {
    const a = r() * Math.PI * 2;
    g.beginPath(); g.moveTo(size / 2, size / 2); g.lineTo(size / 2 + Math.cos(a) * size * 0.4, size / 2 + Math.sin(a) * size * 0.4); g.stroke();
  }
  for (let i = 0; i < 90; i++) {
    const rad = Math.sqrt(r()) * size * 0.4, a = r() * Math.PI * 2;
    const x = size / 2 + Math.cos(a) * rad, y = size / 2 + Math.sin(a) * rad;
    const len = 20 + r() * 20;
    g.fillStyle = `hsl(${75 + r() * 30},${6 + r() * 9}%,${48 + r() * 44}%)`;
    leafShape(g, x, y, len, a + (r() - 0.5) * 1.5);
  }
  return c;
}

// =============================================================================
// Materials
// =============================================================================

const NO_FLIP_NORMAL = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

/**
 * World-space macro variation for lawns (breaks up texture tiling), with optional
 * mowing stripes: stripe = (dirX, dirZ, bandWidth, strength).
 */
export function makeGrassMaterial(tile = 2.4, stripe?: THREE.Vector4): THREE.MeshStandardMaterial {
  const map = canvasTexture(grassCanvas(512, 1), tile);
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, vertexColors: true });
  const uStripe = { value: stripe ?? new THREE.Vector4(1, 0, 4, 0) };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uStripe = uStripe;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMacroXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMacroXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vMacroXZ;
uniform vec4 uStripe;
float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1, 0)), f.x), mix(mHash(i + vec2(0, 1)), mHash(i + vec2(1, 1)), f.x), f.y);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float m1 = mNoise(vMacroXZ * 0.045);
  float m2 = mNoise(vMacroXZ * 0.17 + 7.3);
  float m3 = mNoise(vMacroXZ * 0.6 - 3.1);
  float m = m1 * 0.6 + m2 * 0.3 + m3 * 0.1;
  diffuseColor.rgb *= mix(0.8, 1.14, m);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 1.06, 0.62), smoothstep(0.58, 0.9, m2) * 0.45);
  float band = step(0.5, fract(dot(vMacroXZ, uStripe.xy) / (2.0 * uStripe.z)));
  diffuseColor.rgb *= 1.0 + uStripe.w * (band * 2.0 - 1.0);
}`);
  };
  mat.customProgramCacheKey = () => 'macro-grass';
  return mat;
}

/** Keeps textures and materials together so they can be disposed with the place. */
export class Kit {
  readonly materials: Record<string, THREE.Material> = {};
  readonly textures: THREE.Texture[] = [];
  readonly geometries: THREE.BufferGeometry[] = [];

  tex<T extends THREE.Texture>(t: T): T {
    this.textures.push(t);
    return t;
  }

  mat<T extends THREE.Material>(name: string, m: T): T {
    this.materials[name] = m;
    return m;
  }

  dispose() {
    for (const m of Object.values(this.materials)) {
      const anyM = m as any;
      for (const k of ['map', 'bumpMap', 'roughnessMap', 'normalMap', 'alphaMap', 'emissiveMap']) anyM[k]?.dispose?.();
      m.dispose();
    }
    for (const t of this.textures) t.dispose();
    for (const g of this.geometries) g.dispose();
  }
}

/** The standard set of outdoor materials used by the Batch keys below. */
export function createKit(): Kit {
  const kit = new Kit();
  kit.mat('grass', makeGrassMaterial(2.4));
  const siding = canvasTexture(sidingCanvas(), 1.28);
  kit.mat('siding', new THREE.MeshStandardMaterial({ map: siding, roughness: 0.78, vertexColors: true }));
  const brickC = brickCanvas();
  kit.mat('brick', new THREE.MeshStandardMaterial({
    map: canvasTexture(brickC, 1.2), bumpMap: canvasTexture(brickC, 1.2, false), bumpScale: 1.2, roughness: 0.9, vertexColors: true,
  }));
  const shingleC = shingleCanvas();
  kit.mat('roof', new THREE.MeshStandardMaterial({
    map: canvasTexture(shingleC, 2), bumpMap: canvasTexture(shingleC, 2, false), bumpScale: 1.5, roughness: 0.88, vertexColors: true,
  }));
  kit.mat('trim', new THREE.MeshStandardMaterial({ roughness: 0.55, vertexColors: true }));
  kit.mat('metal', new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.55, vertexColors: true }));
  kit.mat('concrete', new THREE.MeshStandardMaterial({ map: canvasTexture(concreteCanvas(), 2), roughness: 0.92, vertexColors: true }));
  const swC = sidewalkCanvas();
  kit.mat('sidewalk', new THREE.MeshStandardMaterial({
    map: canvasTexture(swC, 1), bumpMap: canvasTexture(swC, 1, false), bumpScale: 1.4, roughness: 0.9, vertexColors: true,
  }));
  const asC = asphaltCanvas();
  kit.mat('asphalt', new THREE.MeshStandardMaterial({
    map: canvasTexture(asC, 5), bumpMap: canvasTexture(asC, 5, false), bumpScale: 1.2, roughness: 0.93, vertexColors: true,
  }));
  kit.mat('paint', new THREE.MeshStandardMaterial({
    roughness: 0.75, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  kit.mat('foliage', new THREE.MeshStandardMaterial({ map: canvasTexture(leafCanvas(), 1.3), roughness: 0.85, vertexColors: true }));
  const card = new THREE.MeshStandardMaterial({
    map: canvasTexture(leafCardCanvas(), 1), roughness: 0.8, vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide,
  });
  card.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL);
  };
  card.customProgramCacheKey = () => 'leaf-card';
  kit.mat('leafCard', card);
  kit.mat('bark', new THREE.MeshStandardMaterial({ map: canvasTexture(barkCanvas(), 1), roughness: 0.95, vertexColors: true }));
  kit.mat('dirt', new THREE.MeshStandardMaterial({ map: canvasTexture(concreteCanvas(128, 9, [120, 92, 66]), 1.5), roughness: 1, vertexColors: true }));
  return kit;
}

// =============================================================================
// Geometry helpers and batching
// =============================================================================

/** Translation, Y/X/Z rotation (radians) and scale in one matrix. */
export function tm(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  return new THREE.Matrix4().compose(V(x, y, z), q, V(sx, sy, sz));
}

export const mul = (a: THREE.Matrix4, b: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(a, b);

/** Box with its bottom face at y = 0. */
export function boxGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
}

export function cylGeo(rTop: number, rBot: number, h: number, seg = 12, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open).translate(0, h / 2, 0);
}

/** World-space box projection: UVs in metres picked by the dominant normal axis. */
function boxUV(g: THREE.BufferGeometry) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = x; v = z; } else if (nx >= nz) { u = z; v = y; } else { u = x; v = y; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

const KEEP_ATTRS = new Set(['position', 'normal', 'uv', 'color']);
const _col = new THREE.Color();

/** Normalises a geometry so everything in a bucket can be merged. Mutates `g`. */
export function prepGeometry(g: THREE.BufferGeometry, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation, uv: 'box' | 'keep'): THREE.BufferGeometry {
  if (m) g.applyMatrix4(m);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (uv === 'box') boxUV(g);
  else if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  _col.set(color);
  const ca = g.attributes.color as THREE.BufferAttribute | undefined;
  if (!ca) {
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  } else if (_col.r !== 1 || _col.g !== 1 || _col.b !== 1) {
    for (let i = 0; i < n; i++) ca.setXYZ(i, ca.getX(i) * _col.r, ca.getY(i) * _col.g, ca.getZ(i) * _col.b);
  }
  for (const name of Object.keys(g.attributes)) if (!KEEP_ATTRS.has(name)) g.deleteAttribute(name);
  if (!g.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.clearGroups();
  g.morphAttributes = {};
  return g;
}

/**
 * Collects static geometry by material key and (optionally) spatial chunk, then
 * merges each bucket into a single mesh. Keys look like 'trim' or 'foliage:noshadow'.
 */
export class Batch {
  private buckets = new Map<string, THREE.BufferGeometry[]>();
  /** When set, geometry added is assigned to the chunk containing this point. */
  anchor: { x: number; z: number } | null = null;
  /** Material keys that share another key's bucket (fewer draw calls). */
  aliases: Record<string, string> = {};
  /** Materials whose meshes never cast shadows (ground surfaces, decals). */
  noCast = new Set<string>();
  /** If set, only these (triangle-heavy) materials are split into chunks; the rest stay one mesh each. */
  chunked: Set<string> | null = null;

  /** chunkSize 0 disables chunking; otherwise chunks are chunkSize (or [sx, sz]) metres, starting at origin. */
  constructor(readonly chunkSize: number | [number, number] = 0, readonly origin = { x: 0, z: 0 }) {}

  add(key: string, g: THREE.BufferGeometry, m: THREE.Matrix4 | null = null, color: THREE.ColorRepresentation = 0xffffff, uv: 'box' | 'keep' = 'box') {
    prepGeometry(g, m, color, uv);
    const [base, flag] = key.split(':');
    const alias = this.aliases[base];
    let bucket = alias ? (flag && !alias.includes(':') ? alias + ':' + flag : alias) : key;
    const [sx, sz] = typeof this.chunkSize === 'number' ? [this.chunkSize, this.chunkSize] : this.chunkSize;
    if (sx > 0 && (!this.chunked || this.chunked.has(bucket.split(':')[0]))) {
      let cx: number, cz: number;
      if (this.anchor) { cx = this.anchor.x; cz = this.anchor.z; } else {
        g.computeBoundingBox();
        const bb = g.boundingBox!;
        cx = (bb.min.x + bb.max.x) / 2; cz = (bb.min.z + bb.max.z) / 2;
      }
      bucket += `|${Math.floor((cx - this.origin.x) / sx)},${Math.floor((cz - this.origin.z) / sz)}`;
    }
    let list = this.buckets.get(bucket);
    if (!list) this.buckets.set(bucket, (list = []));
    list.push(g);
  }

  /** Clone-and-add, for reusable template geometry. */
  addClone(key: string, g: THREE.BufferGeometry, m: THREE.Matrix4 | null, color: THREE.ColorRepresentation = 0xffffff, uv: 'box' | 'keep' = 'keep') {
    this.add(key, g.clone(), m, color, uv);
  }

  build(materials: Record<string, THREE.Material>, parent: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [bucket, list] of this.buckets) {
      const key = bucket.split('|')[0];
      const [matName, flag] = key.split(':');
      const mat = materials[matName];
      if (!mat) throw new Error('Batch: no material ' + matName);
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!geo) continue;
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = bucket;
      mesh.castShadow = flag !== 'noshadow' && flag !== 'nocast' && !this.noCast.has(matName);
      mesh.receiveShadow = flag !== 'noshadow';
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

/** Accumulates flat polygons (walls, roofs, gables) with explicit UVs. */
export class MeshBuilder {
  private p: number[] = [];
  private n: number[] = [];
  private t: number[] = [];
  private i: number[] = [];

  get empty() { return this.i.length === 0; }

  /** Convex polygon, counter-clockwise when seen from its front. */
  poly(pts: V3[], uv: (p: V3) => [number, number] = planeUV(polyNormal(pts))) {
    const base = this.p.length / 3;
    const nr = polyNormal(pts);
    for (const q of pts) {
      this.p.push(q.x, q.y, q.z);
      this.n.push(nr.x, nr.y, nr.z);
      const [u, v] = uv(q);
      this.t.push(u, v);
    }
    for (let k = 1; k < pts.length - 1; k++) this.i.push(base, base + k, base + k + 1);
  }

  /** Like poly() but flips the winding if needed so the face points upwards. */
  polyUp(pts: V3[], uv?: (p: V3) => [number, number]) {
    this.poly(polyNormal(pts).y < 0 ? [...pts].reverse() : pts, uv);
  }

  /** Planar polygon with thickness: `top` gets the face, `rest` the underside and edges. */
  slab(pts: V3[], thick: number, rest: MeshBuilder) {
    const nr = polyNormal(pts);
    const bot = pts.map((q) => q.clone().addScaledVector(nr, -thick));
    this.poly(pts);
    rest.poly([...bot].reverse());
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      const ab = bot[k], bb = bot[(k + 1) % pts.length];
      rest.poly([a, ab, bb, b]);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setIndex(this.i);
    return g;
  }
}

function polyNormal(pts: V3[]): V3 {
  const n = V();
  for (let k = 1; k < pts.length - 1; k++) {
    n.add(V().subVectors(pts[k], pts[0]).cross(V().subVectors(pts[k + 1], pts[0])));
  }
  return n.normalize();
}

/** UVs in metres on a plane: u runs horizontally, v up the slope (or along z for flat faces). */
export function planeUV(n: V3): (p: V3) => [number, number] {
  if (Math.abs(n.y) > 0.999) return (p) => [p.x, -p.z * Math.sign(n.y)];
  const up = V(0, 1, 0);
  const s = up.clone().addScaledVector(n, -n.dot(up)).normalize();
  const h = V().crossVectors(s, n).normalize();
  return (p) => [p.dot(h), p.dot(s)];
}

/** Quad with UVs mapped into an atlas rect, facing +z, centred at the origin. */
export function atlasQuad(w: number, h: number, r: AtlasRect): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  return g;
}

/** Any flat shape (in the xy-plane) with UVs mapped from its bounding box into an atlas rect. */
export function atlasShape(shape: THREE.Shape, r: AtlasRect, segments = 16): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(shape, segments);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), v = (p.getY(i) - bb.min.y) / (bb.max.y - bb.min.y);
    uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
  }
  return g;
}

// =============================================================================
// Texture atlas for windows, doors, shop fronts and signs
// =============================================================================

export interface AtlasRect { x: number; y: number; w: number; h: number; u0: number; v0: number; u1: number; v1: number }

type AtlasDraw = (g: CanvasRenderingContext2D, rough: CanvasRenderingContext2D, w: number, h: number) => void;

/**
 * Shelf-packed canvas atlas with a matching half-resolution roughness canvas.
 * Add every region before calling material(), which crops the canvases to the used height.
 */
export class Atlas {
  color: HTMLCanvasElement;
  rough: HTMLCanvasElement;
  private cx = 0;
  private cy = 0;
  private rowH = 0;
  readonly rects: Record<string, AtlasRect> = {};

  constructor(readonly width = 2048, public height = 1024) {
    this.color = makeCanvas(width, height);
    // roughness only needs half resolution
    this.rough = makeCanvas(width / 2, height / 2);
    const r = this.rough.getContext('2d')!;
    r.fillStyle = 'rgb(150,150,150)';
    r.fillRect(0, 0, width / 2, height / 2);
  }

  add(name: string, w: number, h: number, draw: AtlasDraw): AtlasRect {
    const pad = 4;
    if (this.cx + w + pad > this.width) { this.cx = 0; this.cy += this.rowH + pad; this.rowH = 0; }
    if (this.cy + h > this.height) throw new Error('Atlas full at ' + name);
    const x = this.cx, y = this.cy;
    this.cx += w + pad;
    this.rowH = Math.max(this.rowH, h);
    const g = this.color.getContext('2d')!;
    const r = this.rough.getContext('2d')!;
    for (const c of [g, r]) {
      c.save();
      if (c === r) c.scale(0.5, 0.5);
      c.translate(x, y); c.beginPath(); c.rect(0, 0, w, h); c.clip();
    }
    draw(g, r, w, h);
    g.restore(); r.restore();
    const rect: AtlasRect = {
      x, y, w, h,
      u0: (x + 0.5) / this.width, u1: (x + w - 0.5) / this.width,
      v0: 1 - (y + h - 0.5) / this.height, v1: 1 - (y + 0.5) / this.height,
    };
    this.rects[name] = rect;
    return rect;
  }

  /** Crops unused rows off the bottom and updates every rect's v coordinates to match. */
  private crop() {
    const used = Math.ceil((this.cy + this.rowH + 4) / 8) * 8;
    if (used >= this.height) return;
    const c = makeCanvas(this.width, used), r = makeCanvas(this.width / 2, used / 2);
    c.getContext('2d')!.drawImage(this.color, 0, 0);
    r.getContext('2d')!.drawImage(this.rough, 0, 0);
    this.color = c;
    this.rough = r;
    this.height = used;
    for (const rect of Object.values(this.rects)) {
      rect.v0 = 1 - (rect.y + rect.h - 0.5) / used;
      rect.v1 = 1 - (rect.y + 0.5) / used;
    }
  }

  material(kit: Kit, name: string): THREE.MeshStandardMaterial {
    this.crop();
    const map = kit.tex(new THREE.CanvasTexture(this.color));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    const rough = kit.tex(new THREE.CanvasTexture(this.rough));
    return kit.mat(name, new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: 1, vertexColors: true }));
  }
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Paw print icon centred at (x, y) with overall size s. */
export function drawPaw(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.beginPath();
  g.ellipse(x, y + s * 0.15, s * 0.28, s * 0.22, 0, 0, Math.PI * 2);
  g.fill();
  const toes: [number, number][] = [[-0.3, -0.16], [-0.11, -0.33], [0.11, -0.33], [0.3, -0.16]];
  for (const [tx, ty] of toes) {
    g.beginPath();
    g.ellipse(x + tx * s, y + ty * s, s * 0.1, s * 0.13, tx * 0.8, 0, Math.PI * 2);
    g.fill();
  }
}

export function drawBone(g: CanvasRenderingContext2D, x: number, y: number, s: number, a = 0) {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.fillRect(-s * 0.35, -s * 0.09, s * 0.7, s * 0.18);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    g.beginPath(); g.arc(sx * s * 0.38, sy * s * 0.1, s * 0.13, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** Glass pane with a sky reflection, into the colour and roughness canvases. */
export function glass(g: CanvasRenderingContext2D, r: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dark = 0) {
  const grd = g.createLinearGradient(x, y, x + w * 0.4, y + h);
  grd.addColorStop(0, `rgb(${120 - dark},${150 - dark},${170 - dark})`);
  grd.addColorStop(0.45, `rgb(${58 - dark / 2},${74 - dark / 2},${88 - dark / 2})`);
  grd.addColorStop(1, `rgb(${40 - dark / 3},${50 - dark / 3},${60 - dark / 3})`);
  g.fillStyle = grd;
  g.fillRect(x, y, w, h);
  r.fillStyle = 'rgb(28,28,28)';
  r.fillRect(x, y, w, h);
}

function curtains(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, open = 0.32) {
  g.save();
  g.globalAlpha = 0.9;
  const cw = w * open;
  for (const side of [0, 1]) {
    const x0 = side ? x + w - cw : x;
    g.fillStyle = color;
    g.beginPath();
    if (side) { g.moveTo(x0 + cw, y); g.lineTo(x0, y); g.quadraticCurveTo(x0 + cw * 0.5, y + h * 0.6, x0 + cw * 0.3, y + h); g.lineTo(x0 + cw, y + h); } else {
      g.moveTo(x0, y); g.lineTo(x0 + cw, y); g.quadraticCurveTo(x0 + cw * 0.5, y + h * 0.6, x0 + cw * 0.7, y + h); g.lineTo(x0, y + h);
    }
    g.fill();
    g.globalAlpha = 0.25;
    g.fillStyle = '#000';
    for (let k = 1; k < 4; k++) g.fillRect(x0 + (cw * k) / 4, y, 2, h);
    g.globalAlpha = 0.9;
  }
  g.restore();
}

/** Builds the shared facade atlas: house windows, doors, garage doors. Shop fronts and signs are added by the town. */
export function buildFacadeAtlas(atlas: Atlas) {
  const frameCol = '#f4f1ea';
  const curtainCols = ['#f3ede0', '#c94b4b', '#6f93c9', '#e9c46a'];
  for (let v = 0; v < 4; v++) {
    atlas.add('win' + v, 160, 224, (g, r, w, h) => {
      const f = 12;
      g.fillStyle = frameCol; g.fillRect(0, 0, w, h);
      r.fillStyle = 'rgb(140,140,140)'; r.fillRect(0, 0, w, h);
      const mid = h / 2;
      for (const [y0, y1] of [[f, mid - 3], [mid + 3, h - f]]) {
        glass(g, r, f, y0, w - 2 * f, y1 - y0, v * 6);
      }
      if (v === 2) {
        g.fillStyle = '#efe7d6';
        g.fillRect(f, f, w - 2 * f, h * 0.38);
        g.fillStyle = 'rgba(0,0,0,0.12)';
        for (let y = f; y < f + h * 0.38; y += 6) g.fillRect(f, y, w - 2 * f, 1);
      } else {
        curtains(g, f, f, w - 2 * f, h - 2 * f, curtainCols[v], v === 1 ? 0.28 : 0.34);
      }
      if (v === 3) {
        g.fillStyle = '#6b4a2e'; g.fillRect(w / 2 - 14, h - f - 22, 28, 20);
        g.fillStyle = '#3f7a35';
        for (let k = 0; k < 7; k++) { g.beginPath(); g.ellipse(w / 2 + (k - 3) * 7, h - f - 30 - (k % 2) * 8, 9, 14, (k - 3) * 0.3, 0, Math.PI * 2); g.fill(); }
      }
      // sashes and muntins
      g.fillStyle = frameCol;
      g.fillRect(0, mid - 5, w, 10);
      g.fillRect(w / 2 - 3, f, 6, h - 2 * f);
      g.fillRect(f, (f + mid) / 2 - 2, w - 2 * f, 4);
      g.fillRect(f, (mid + h - f) / 2 - 2, w - 2 * f, 4);
      r.fillStyle = 'rgb(140,140,140)';
      r.fillRect(0, mid - 5, w, 10); r.fillRect(w / 2 - 3, f, 6, h - 2 * f);
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2; g.strokeRect(f, f, w - 2 * f, h - 2 * f);
    });
  }
  const doorCols = ['#b8323a', '#2f4f7f', '#3f6e4a', '#8a5a36', '#e7d9b8'];
  doorCols.forEach((col, v) => {
    atlas.add('door' + v, 128, 272, (g, r, w, h) => {
      g.fillStyle = col; g.fillRect(0, 0, w, h);
      r.fillStyle = 'rgb(110,110,110)'; r.fillRect(0, 0, w, h);
      // fanlight
      glass(g, r, 16, 14, w - 32, 38);
      g.fillStyle = col; for (let k = 1; k < 3; k++) g.fillRect(16 + ((w - 32) * k) / 3 - 2, 14, 4, 38);
      // raised panels
      const panels: [number, number, number, number][] = [[16, 64, 42, 80], [70, 64, 42, 80], [16, 156, 42, 96], [70, 156, 42, 96]];
      for (const [x, y, pw, ph] of panels) {
        g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x, y, pw, ph);
        g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(x + 3, y + 3, pw - 6, ph - 6);
        g.fillStyle = col; g.fillRect(x + 6, y + 6, pw - 12, ph - 12);
      }
      g.fillStyle = '#d8b24a';
      g.beginPath(); g.arc(w - 18, 150, 6, 0, Math.PI * 2); g.fill();
      r.fillStyle = 'rgb(60,60,60)'; r.beginPath(); r.arc(w - 18, 150, 6, 0, Math.PI * 2); r.fill();
      g.fillRect(w / 2 - 10, 120, 20, 5);
    });
  });
  atlas.add('garage', 320, 224, (g, r, w, h) => {
    g.fillStyle = '#f2efe8'; g.fillRect(0, 0, w, h);
    const rows = 4, rh = h / rows;
    for (let row = 0; row < rows; row++) {
      g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, row * rh, w, 2);
      for (let k = 0; k < 4; k++) {
        const x = 10 + k * ((w - 20) / 4), pw = (w - 20) / 4 - 10;
        if (row === 0) { glass(g, r, x + 4, row * rh + 12, pw - 8, rh - 24); continue; }
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x + 4, row * rh + 10, pw - 8, rh - 20);
        g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(x + 6, row * rh + 12, pw - 12, rh - 24);
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(w / 2 - 12, h - 30, 24, 5);
  });
  atlas.add('round', 128, 128, (g, r, w, h) => {
    g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, w, h);
    g.save(); g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 10, 0, Math.PI * 2); g.clip();
    glass(g, r, 0, 0, w, h);
    curtains(g, 0, 0, w, h, '#f7d6e0', 0.3);
    g.restore();
    g.fillStyle = '#f4f1ea'; g.fillRect(w / 2 - 3, 0, 6, h); g.fillRect(0, h / 2 - 3, w, 6);
  });
}

// =============================================================================
// Sky, sun and fog
// =============================================================================

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uCloud;
varying vec3 vDir;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n21(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * n21(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  float s = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 30.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.08);
  if (h > 0.0 && uCloud > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 1.3 + vec2(uTime * 0.006, uTime * 0.002);
    float c = fbm(uv);
    float cov = smoothstep(0.62 - uCloud * 0.2, 0.86 - uCloud * 0.1, c) * smoothstep(0.0, 0.18, h);
    float lit = 0.8 + 0.35 * fbm(uv * 2.0 + 3.0) + pow(s, 6.0) * 0.4;
    vec3 cc = mix(vec3(0.72, 0.78, 0.88), vec3(1.05, 1.03, 1.0), clamp(lit - 0.5, 0.0, 1.0));
    col = mix(col, cc, cov * 0.92);
  }
  col = mix(col, uHorizon, smoothstep(0.08, -0.02, h));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface OutdoorLightsOptions {
  sunDir?: THREE.Vector3;
  sunIntensity?: number;
  shadowSize?: number;
  fogNear?: number;
  fogFar?: number;
  horizon?: THREE.ColorRepresentation;
  zenith?: THREE.ColorRepresentation;
  clouds?: number;
  hemi?: number;
}

export interface OutdoorLights {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  fog: THREE.Fog;
  background: THREE.Color;
  environment: THREE.Texture;
  update(time: number, focus: THREE.Vector3): void;
  dispose(): void;
}

/** Sky dome (always behind everything), warm sun with a focus-following shadow box, hemisphere fill and fog. */
export function createOutdoorLights(renderer: THREE.WebGLRenderer, o: OutdoorLightsOptions = {}): OutdoorLights {
  const group = new THREE.Group();
  group.name = 'outdoor-lights';
  const horizon = new THREE.Color(o.horizon ?? '#d3e3ea');
  const zenith = new THREE.Color(o.zenith ?? '#3f86d8');
  const sunDir = (o.sunDir ?? V(-0.55, 0.72, 0.42)).clone().normalize();
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: zenith }, uHorizon: { value: horizon }, uSunDir: { value: sunDir },
      uTime: { value: 0 }, uCloud: { value: o.clouds ?? 0.55 },
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
  });
  const skyGeo = new THREE.SphereGeometry(1, 48, 24);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.name = 'sky';
  group.add(sky);

  // image-based lighting from the same sky over a grassy ground
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(skyGeo, skyMat));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.16, 0.2, 0.1) }));
  ground.position.y = -3;
  envScene.add(ground);
  const environment = pmrem.fromScene(envScene, 0.02, 0.1, 200).texture;
  pmrem.dispose();
  ground.geometry.dispose();
  (ground.material as THREE.Material).dispose();

  const sun = new THREE.DirectionalLight(0xfff0dc, o.sunIntensity ?? 2.7);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const S = o.shadowSize ?? 22;
  const cam = sun.shadow.camera;
  cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
  cam.near = 1; cam.far = 160;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  group.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x5a6a3c, o.hemi ?? 0.45);
  group.add(hemi);

  const fog = new THREE.Fog(horizon, o.fogNear ?? 40, o.fogFar ?? 320);

  const fwd = sunDir.clone().negate();
  const right = V().crossVectors(fwd, V(0, 1, 0)).normalize();
  const up = V().crossVectors(right, fwd).normalize();
  const texel = (2 * S) / 2048;
  const snapped = V();

  const update = (time: number, focus: THREE.Vector3) => {
    skyMat.uniforms.uTime.value = time;
    // snap the shadow box to whole texels so the shadows don't shimmer as it moves
    const a = Math.round(focus.dot(right) / texel) * texel;
    const b = Math.round(focus.dot(up) / texel) * texel;
    const c = focus.dot(fwd);
    snapped.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(fwd, c);
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(sunDir, 70);
    sun.target.updateMatrixWorld();
  };
  update(0, V());

  return {
    group, sun, fog, background: horizon.clone(), environment, update,
    dispose() {
      skyGeo.dispose();
      skyMat.dispose();
      environment.dispose();
      sun.shadow.map?.dispose();
    },
  };
}

// =============================================================================
// Trees
// =============================================================================

export type TreeKind = 'round' | 'oval' | 'conifer' | 'blossom' | 'small';

interface TreeTemplate {
  bark: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  cards: THREE.BufferGeometry | null;
  trunkRadius: number;
  crown: number;
}

const LEAF_TINTS: Record<TreeKind, string[]> = {
  round: ['#5a9a32', '#68a338', '#4f8f30', '#76a83e'],
  oval: ['#4f9238', '#5c9c3e', '#68a234'],
  conifer: ['#4a7a45', '#52824c', '#447241'],
  blossom: ['#ffb3cf', '#ffc6dc', '#ffa8c8'],
  small: ['#6fab40', '#7fb548', '#5fa23c'],
};

function canopyBlobs(r: () => number, C: V3, R: number, sy: number, blobs: number, detail: number, bottomY: number): THREE.BufferGeometry {
  // detail 0 blobs are only used far away; give them a little more size to cover gaps
  const parts: THREE.BufferGeometry[] = [];
  const seed = Math.floor(r() * 1000);
  for (let b = 0; b < blobs; b++) {
    const dir = V(r() - 0.5, (r() - 0.5) * 0.9, r() - 0.5).normalize();
    const dist = R * (0.3 + r() * 0.38) * (b === 0 ? 0 : 1);
    const center = V(C.x + dir.x * dist, C.y + dir.y * dist * sy, C.z + dir.z * dist);
    const rad = R * (b === 0 ? 0.66 : 0.42 + r() * 0.2);
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(rad, detail);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g = mergeVertices(g);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const len = Math.hypot(x, y, z);
      const k = 1 + (noise3(x * 1.7 + center.x, y * 1.7 + center.y, z * 1.7, seed) - 0.5) * 0.45;
      p.setXYZ(i, center.x + (x / len) * rad * k, Math.max(bottomY, center.y + (y / len) * rad * k * (0.85 + sy * 0.15)), center.z + (z / len) * rad * k);
    }
    g.computeVertexNormals();
    parts.push(g);
  }
  const geo = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  shadeFoliage(geo, C, R, sy);
  return geo;
}

/** Radial "volume" normals plus height/depth ambient occlusion in vertex colours. */
function shadeFoliage(geo: THREE.BufferGeometry, C: V3, R: number, sy: number) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const col = new Float32Array(p.count * 3);
  const tmp = V();
  for (let i = 0; i < p.count; i++) {
    tmp.set(p.getX(i) - C.x, (p.getY(i) - C.y) / sy, p.getZ(i) - C.z);
    const d = tmp.length() / R;
    tmp.normalize();
    const nx = n.getX(i) * 0.35 + tmp.x * 0.65, ny = n.getY(i) * 0.35 + tmp.y * 0.65, nz = n.getZ(i) * 0.35 + tmp.z * 0.65;
    const l = Math.hypot(nx, ny, nz);
    n.setXYZ(i, nx / l, ny / l, nz / l);
    const hgt = smooth(-1, 1, tmp.y);
    const ao = (0.55 + 0.45 * hgt) * (0.7 + 0.3 * Math.min(1, d));
    col[i * 3] = ao; col[i * 3 + 1] = ao; col[i * 3 + 2] = ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function leafCards(r: () => number, C: V3, R: number, sy: number, count: number, size: number, bottomY: number): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const cols: number[] = [];
  const up = V(0, 1, 0);
  for (let k = 0; k < count; k++) {
    const dir = V(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    if (dir.y < -0.5) dir.y *= 0.4;
    dir.normalize();
    const rr = R * (0.88 + r() * 0.25);
    const c = V(C.x + dir.x * rr, Math.max(bottomY + size * 0.3, C.y + dir.y * rr * sy), C.z + dir.z * rr);
    const t1 = V().crossVectors(dir, Math.abs(dir.y) > 0.9 ? V(1, 0, 0) : up).normalize();
    const t2 = V().crossVectors(dir, t1).normalize();
    const a = r() * Math.PI * 2, s = size * (0.75 + r() * 0.5);
    const ax = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a)).multiplyScalar(s / 2);
    const ay = t1.clone().multiplyScalar(-Math.sin(a)).addScaledVector(t2, Math.cos(a)).multiplyScalar(s / 2);
    // tilt the card a bit so it isn't perfectly tangent
    const pts = [
      c.clone().sub(ax).sub(ay), c.clone().add(ax).sub(ay), c.clone().add(ax).add(ay), c.clone().sub(ax).add(ay),
    ];
    const uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    let q = 0;
    mb.poly(pts, () => uvs[q++]);
    const hgt = smooth(-1, 1, dir.y);
    const ao = 0.6 + 0.4 * hgt;
    for (let v = 0; v < 4; v++) cols.push(ao, ao, ao);
  }
  const g = mb.geometry();
  // radial normals for soft volumetric shading
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const d = V(p.getX(i) - C.x, (p.getY(i) - C.y) / sy, p.getZ(i) - C.z).normalize();
    n.setXYZ(i, d.x, d.y, d.z);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return g;
}

function trunkGeo(r: () => number, h: number, rBot: number, rTop: number, seg: number, branches: V3[], hseg = 4): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = new THREE.CylinderGeometry(rTop, rBot, h, seg, hseg, true).translate(0, h / 2, 0);
  const p = t.attributes.position;
  const ph = r() * 6;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const flare = 1 + Math.max(0, 0.35 - y) * 1.6;
    p.setXYZ(i, p.getX(i) * flare + Math.sin(y * 0.9 + ph) * 0.05 * y, y, p.getZ(i) * flare + Math.cos(y * 0.7 + ph) * 0.04 * y);
  }
  t.computeVertexNormals();
  const uv = t.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, (uv.getY(i) * h) / 1.1);
  parts.push(t);
  const top = V(Math.sin(h * 0.9 + ph) * 0.05 * h, h, Math.cos(h * 0.7 + ph) * 0.04 * h);
  for (const end of branches) {
    const dir = V().subVectors(end, top);
    const len = dir.length();
    const b = new THREE.CylinderGeometry(rTop * 0.35, rTop * 0.8, len, 5, 1, true).translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.normalize());
    b.applyQuaternion(q).translate(top.x, top.y - 0.15, top.z);
    const buv = b.attributes.uv;
    for (let i = 0; i < buv.count; i++) buv.setXY(i, buv.getX(i), (buv.getY(i) * len) / 1.1);
    parts.push(b);
  }
  const g = mergeGeometries(parts, false)!;
  parts.forEach((x) => x.dispose());
  // darker at the base
  const pp = g.attributes.position;
  const col = new Float32Array(pp.count * 3);
  for (let i = 0; i < pp.count; i++) {
    const v = 0.7 + 0.3 * smooth(0, 1.2, pp.getY(i));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function makeTreeTemplate(kind: TreeKind, seed: number, lod: number): TreeTemplate {
  const r = mulberry32(seed * 7919 + kind.length * 31 + lod);
  const hi = lod === 0;
  if (kind === 'conifer') {
    // stacked, drooping tiers with ragged rims and lumpy surfaces
    const H = 7 + r() * 3, R = 2.0 + r() * 0.5, trunkH = 0.9;
    const parts: THREE.BufferGeometry[] = [];
    const layers = hi ? 8 : 4;
    const seed = Math.floor(r() * 1000);
    for (let k = 0; k < layers; k++) {
      const f = k / layers;
      const rad = R * Math.pow(1 - f, 0.85) + 0.22;
      const y0 = trunkH + f * (H - trunkH) * 0.9;
      const lh = ((H - trunkH) / layers) * 2.2;
      let g: THREE.BufferGeometry = new THREE.ConeGeometry(rad, lh, hi ? 18 : 8, hi ? 3 : 1, true);
      g.deleteAttribute('uv'); g.deleteAttribute('normal');
      g = mergeVertices(g);
      const p = g.attributes.position;
      const rot = r() * 6;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const t = (lh / 2 - y) / lh; // 0 at the tip, 1 at the rim
        const a = Math.atan2(z, x) + rot;
        const lump = 1 + (noise3(x * 2.1, y * 2.1 + k * 3, z * 2.1, seed) - 0.5) * 0.35 * t;
        const rim = t > 0.99 ? 1 + (Math.sin(a * 9) * 0.5 + 0.5) * 0.28 + (r() - 0.5) * 0.2 : 1;
        const droop = t > 0.99 ? 0.18 + (Math.sin(a * 9 + 1.5) * 0.5 + 0.5) * 0.22 : 0;
        p.setXYZ(i, x * lump * rim, y + lh / 2 + y0 - droop - t * t * 0.1, z * lump * rim);
      }
      g.computeVertexNormals();
      parts.push(g);
    }
    const leaves = mergeGeometries(parts, false)!;
    parts.forEach((x) => x.dispose());
    shadeFoliage(leaves, V(0, trunkH + (H - trunkH) * 0.35, 0), R, 1.6);
    return { bark: trunkGeo(r, trunkH + 1.5, 0.2, 0.1, hi ? 7 : 5, [], hi ? 3 : 1), leaves, cards: null, trunkRadius: 0.22, crown: R };
  }
  const small = kind === 'small';
  const trunkH = small ? 1.1 + r() * 0.4 : kind === 'blossom' ? 1.7 + r() * 0.4 : 2.9 + r() * 0.5;
  const R = small ? 1.0 + r() * 0.3 : kind === 'oval' ? 1.9 + r() * 0.4 : kind === 'blossom' ? 2.0 + r() * 0.3 : 2.4 + r() * 0.5;
  const sy = kind === 'oval' ? 1.45 : kind === 'blossom' ? 0.8 : 0.95;
  const C = V(0, trunkH + R * sy * 0.8, 0);
  const blobs = hi ? (small ? 4 : 6) : 6;
  const leaves = canopyBlobs(r, C, R, sy, blobs, hi ? 1 : 0, trunkH + 0.1);
  const branches: V3[] = [];
  const nb = small ? 2 : 4;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * Math.PI * 2 + r();
    branches.push(V(Math.cos(a) * R * 0.45, C.y + (r() - 0.3) * R * 0.4, Math.sin(a) * R * 0.45));
  }
  const rBot = small ? 0.08 : 0.17 + r() * 0.04;
  const bark = trunkGeo(r, trunkH + R * 0.4, rBot, rBot * 0.62, hi ? 8 : 5, hi ? branches : [], hi ? 4 : 1);
  const cards = hi ? leafCards(r, C, R, sy, small ? 32 : 70, small ? 0.6 : 1.15, trunkH + 0.1) : null;
  return { bark, leaves, cards, trunkRadius: rBot, crown: R };
}

/** Caches a few variants per tree kind and stamps them into a Batch. */
export class TreeFactory {
  private cache = new Map<string, TreeTemplate>();

  constructor(private variants = 4) {}

  template(kind: TreeKind, variant: number, lod: number): TreeTemplate {
    const key = `${kind}/${variant % this.variants}/${lod}`;
    let t = this.cache.get(key);
    if (!t) this.cache.set(key, (t = makeTreeTemplate(kind, variant % this.variants, lod)));
    return t;
  }

  /**
   * Adds a tree to the batch; returns its trunk obstacle circle.
   * `lod` 1 is a cheap distant tree; `shadow` false keeps it out of the shadow pass.
   */
  add(batch: Batch, kind: TreeKind, x: number, z: number, o: { seed?: number; scale?: number; lod?: number; shadow?: boolean; y?: number; tint?: THREE.ColorRepresentation } = {}): Circle {
    const seed = o.seed ?? Math.floor(hash2(Math.round(x * 10), Math.round(z * 10), 5) * 1000);
    const t = this.template(kind, seed, o.lod ?? 0);
    const s = o.scale ?? 0.9 + hash2(seed, 3, 1) * 0.25;
    const m = tm(x, o.y ?? 0, z, hash2(seed, 7, 2) * Math.PI * 2, 0, 0, s);
    const suffix = o.shadow === false ? ':noshadow' : '';
    const tints = LEAF_TINTS[kind];
    const tint = new THREE.Color(o.tint ?? tints[seed % tints.length]);
    tint.multiplyScalar(0.9 + hash2(seed, 9, 4) * 0.2);
    batch.addClone('bark' + suffix, t.bark, m, 0xffffff, 'keep');
    batch.add('foliage' + suffix, t.leaves.clone(), m, tint, 'box');
    if (t.cards) batch.addClone('leafCard' + suffix, t.cards, m, tint, 'keep');
    return { x, z, r: t.trunkRadius * s + 0.25 };
  }

  dispose() {
    for (const t of this.cache.values()) { t.bark.dispose(); t.leaves.dispose(); t.cards?.dispose(); }
    this.cache.clear();
  }
}

/** Soft rounded leafy blob for shrubs and bushes (origin at the ground). */
export function shrubGeo(seed: number, w: number, h: number, d = w, detail = 1): THREE.BufferGeometry {
  const r = mulberry32(seed);
  const n = 2;
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < n; k++) {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5, detail);
    g.deleteAttribute('uv'); g.deleteAttribute('normal');
    g = mergeVertices(g);
    const ox = (r() - 0.5) * 0.4, oz = (r() - 0.5) * 0.4, s = 0.8 + r() * 0.3;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k2 = 1 + (noise3(x * 4, y * 4, z * 4, seed + k) - 0.5) * 0.35;
      p.setXYZ(i, (ox + x * s * k2) * w, Math.max(0, (0.45 + y * s * k2) * h), (oz + z * s * k2) * d);
    }
    g.computeVertexNormals();
    parts.push(g);
  }
  const g = mergeGeometries(parts, false)!;
  parts.forEach((x) => x.dispose());
  shadeFoliage(g, V(0, h * 0.35, 0), Math.max(w, d) * 0.55, h / Math.max(w, d));
  return g;
}

/** A hedge running along +x from 0 to len (origin at ground, centred in z). */
export function hedgeGeo(len: number, h: number, d: number, seed = 1): THREE.BufferGeometry {
  const segX = Math.max(2, Math.round(len * 1.6));
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(len, h, d, segX, 3, 2);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // round the top edges
    const ty = (y + h / 2) / h;
    const zr = Math.abs(z) / (d / 2);
    const round = ty > 0.7 ? 1 - (ty - 0.7) * 0.9 * zr : 1;
    const nse = 1 + (noise3(x * 2.3, y * 2.3, z * 2.3, seed) - 0.5) * 0.28;
    p.setXYZ(i, x + len / 2, Math.max(0, (y + h / 2) * (ty > 0.9 ? 0.97 + zr * -0.05 : 1)), z * round * nse);
  }
  g.computeVertexNormals();
  shadeFoliage(g, V(len / 2, h * 0.3, 0), Math.max(h, d) * 0.7, 1);
  // shadeFoliage expects a round canopy; restore mostly-geometric normals for a boxy hedge
  const n = g.attributes.normal;
  const g2 = g.clone();
  g2.computeVertexNormals();
  const n2 = g2.attributes.normal;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i) * 0.4 + n2.getX(i) * 0.6, y = n.getY(i) * 0.4 + n2.getY(i) * 0.6 + 0.15, z = n.getZ(i) * 0.4 + n2.getZ(i) * 0.6;
    const l = Math.hypot(x, y, z);
    n.setXYZ(i, x / l, y / l, z / l);
  }
  g2.dispose();
  return g;
}

// =============================================================================
// Grass blades (a wrapping patch of instanced blades that follows the focus)
// =============================================================================

export interface GrassFieldOptions {
  count?: number;
  /** side of the square patch that follows the focus (m) */
  tile?: number;
  height?: [number, number];
  width?: number;
  /** optional density mask (red channel), mapped over rect [minX, minZ, sizeX, sizeZ] */
  mask?: { texture: THREE.Texture; rect: [number, number, number, number] };
  base?: THREE.ColorRepresentation;
  tip?: THREE.ColorRepresentation;
  seed?: number;
}

export interface GrassField {
  mesh: THREE.Mesh;
  update(time: number, focus: THREE.Vector3): void;
  dispose(): void;
}

export function createGrassField(o: GrassFieldOptions = {}): GrassField {
  const count = o.count ?? 60000;
  const tile = o.tile ?? 20;
  const [hMin, hMax] = o.height ?? [0.05, 0.11];
  const r = mulberry32(o.seed ?? 3);
  const geo = new THREE.InstancedBufferGeometry();
  // 5-vertex tapered blade: x across (-0.5..0.5), y along (0..1)
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.32, 0.5, 0, 0.32, 0.5, 0, 0, 1, 0], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  geo.setIndex([0, 1, 3, 0, 3, 2, 2, 3, 4]);
  const blade = new Float32Array(count * 4);
  const tint = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    blade[i * 4] = r() * tile;
    blade[i * 4 + 1] = r() * tile;
    const tall = r();
    blade[i * 4 + 2] = hMin + (hMax - hMin) * tall * tall;
    blade[i * 4 + 3] = r() * Math.PI * 2;
    tint[i * 2] = 0.82 + r() * 0.36;
    tint[i * 2 + 1] = r() < 0.12 ? 0.3 + r() * 0.5 : r() * 0.15;
  }
  geo.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blade, 4));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 2));
  geo.instanceCount = count;

  const uniforms = {
    uFocus: { value: V() },
    uTile: { value: tile },
    uTime: { value: 0 },
    uWidth: { value: o.width ?? 0.02 },
    uFade: { value: tile * 0.5 },
    uMask: { value: o.mask?.texture ?? null },
    uMaskRect: { value: new THREE.Vector4(...(o.mask?.rect ?? [0, 0, 1, 1])) },
    uUseMask: { value: o.mask ? 1 : 0 },
    uBase: { value: new THREE.Color(o.base ?? '#3f6a24') },
    uTip: { value: new THREE.Color(o.tip ?? '#a7c95f') },
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aBlade;
attribute vec2 aTint;
uniform vec3 uFocus;
uniform float uTile, uTime, uWidth, uFade, uUseMask;
uniform sampler2D uMask;
uniform vec4 uMaskRect;
varying float vGrassT;
varying vec2 vGrassTint;`)
      .replace('#include <beginnormal_vertex>', `
vec2 gOrigin = uFocus.xz - 0.5 * uTile;
vec2 gP = gOrigin + mod(aBlade.xy - gOrigin, uTile);
vec2 gDir = vec2(cos(aBlade.w), sin(aBlade.w));
vec3 objectNormal = normalize(vec3(gDir.y * 0.3, 1.0, -gDir.x * 0.3));`)
      .replace('#include <begin_vertex>', `
float gDist = length(gP - uFocus.xz);
float gFade = 1.0 - smoothstep(uFade * 0.65, uFade, gDist);
float gMask = 1.0;
if (uUseMask > 0.5) gMask = texture2D(uMask, (gP - uMaskRect.xy) / uMaskRect.zw).r;
float gH = aBlade.z * gFade * smoothstep(0.25, 0.75, gMask);
float gT = position.y;
float gWind = sin(uTime * 1.5 + gP.x * 0.31 + gP.y * 0.23) * 0.6 + sin(uTime * 2.6 + gP.x * 0.8 - gP.y * 0.5) * 0.25;
vec2 gLean = vec2(cos(aBlade.w * 2.3 + 1.0), sin(aBlade.w * 2.3 + 1.0)) * 0.35 + vec2(0.45, 0.2) * gWind;
float gBend = gT * gT * gH;
vec3 transformed = vec3(gP.x + gDir.x * position.x * uWidth + gLean.x * gBend, gT * gH * (1.0 - 0.1 * gT), gP.y + gDir.y * position.x * uWidth + gLean.y * gBend);
if (gH < 0.004) transformed = vec3(gP.x, -5.0, gP.y);
vGrassT = gT;
vGrassTint = aTint;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uBase, uTip;
varying float vGrassT;
varying vec2 vGrassTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(uBase, uTip, smoothstep(0.0, 1.0, vGrassT)) * vGrassTint.x;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.35, 1.1, 0.45), vGrassTint.y);`)
      .replace('#include <normal_fragment_begin>', NO_FLIP_NORMAL);
  };
  mat.customProgramCacheKey = () => 'grass-blades';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'grass-blades';
  return {
    mesh,
    update(time, focus) {
      uniforms.uTime.value = time;
      uniforms.uFocus.value.copy(focus);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// =============================================================================
// Distant terrain (rolling hills around a flat centre)
// =============================================================================

export interface TerrainOptions {
  /** flat rectangle that is cut out (vertices strictly inside are pushed down) */
  hole?: Bounds;
  /** flat rectangle that stays at y = 0 */
  flat: Bounds;
  extent: number;
  cell: number;
  /** straight road corridors kept flat: [x0, z0, x1, z1] */
  corridors?: [number, number, number, number][];
  hillStart?: number;
  hillEnd?: number;
  hillHeight?: number;
  seed?: number;
}

export function distToRect(x: number, z: number, b: Bounds) {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
  return Math.hypot(dx, dz);
}

export function distToSegment(x: number, z: number, s: [number, number, number, number]) {
  const [x0, z0, x1, z1] = s;
  const dx = x1 - x0, dz = z1 - z0;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (x0 + t * dx), z - (z0 + t * dz));
}

/** Returns a height function and the terrain geometry (grass UVs in metres, vertex colour variation). */
export function terrain(o: TerrainOptions): { geometry: THREE.BufferGeometry; height(x: number, z: number): number } {
  const seed = o.seed ?? 5;
  const hs = o.hillStart ?? 50, he = o.hillEnd ?? 260, hh = o.hillHeight ?? 34;
  const height = (x: number, z: number) => {
    const d = distToRect(x, z, o.flat);
    if (d <= 0) return 0;
    let h = smooth(hs, he, d) * hh * (0.35 + 0.9 * fbm2(x / 160, z / 160, 4, seed)) + smooth(8, 60, d) * 1.2 * (fbm2(x / 30, z / 30, 3, seed + 3) - 0.3);
    if (o.corridors) {
      let cd = Infinity;
      for (const c of o.corridors) cd = Math.min(cd, distToSegment(x, z, c));
      h *= smooth(9, 80, cd);
      // sink the ground under the road so the asphalt never z-fights with it
      if (cd < 10) return -0.45 * (1 - smooth(8, 10, cd));
    }
    return Math.max(0, h);
  };
  const f = o.flat;
  const x0 = f.minX - o.extent, z0 = f.minZ - o.extent;
  const nx = Math.ceil((f.maxX - f.minX + 2 * o.extent) / o.cell), nz = Math.ceil((f.maxZ - f.minZ + 2 * o.extent) / o.cell);
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * o.cell, z = z0 + j * o.cell;
      let y = height(x, z);
      const h = o.hole;
      if (h && x > h.minX + 0.01 && x < h.maxX - 0.01 && z > h.minZ + 0.01 && z < h.maxZ - 0.01) y = -3;
      pos.push(x, y, z);
      const v = 0.85 + fbm2(x / 50, z / 50, 3, seed + 11) * 0.3;
      const dry = smooth(0.55, 0.75, fbm2(x / 90, z / 90, 2, seed + 13));
      col.push(v * (1 + dry * 0.25), v * (1 + dry * 0.05), v * (1 - dry * 0.35));
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const uv: number[] = [];
  for (let k = 0; k < pos.length; k += 3) uv.push(pos[k], -pos[k + 2]);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { geometry: g, height };
}

// =============================================================================
// Small props shared by several places
// =============================================================================

/** Park bench facing +z, centred at the origin. Adds to trim/metal buckets. */
export function addBench(b: Batch, M: THREE.Matrix4, wood: THREE.ColorRepresentation = '#9a6a3f', iron: THREE.ColorRepresentation = '#2e3a33') {
  const L = 1.6;
  for (let k = 0; k < 3; k++) b.add('trim', boxGeo(L, 0.035, 0.1), mul(M, tm(0, 0.43, 0.14 - k * 0.12)), wood);
  for (let k = 0; k < 3; k++) b.add('trim', boxGeo(L, 0.1, 0.03), mul(M, tm(0, 0.55 + k * 0.13, -0.24, 0, -0.18)), wood);
  for (const sx of [-0.68, 0.68]) {
    b.add('metal', boxGeo(0.05, 0.45, 0.05), mul(M, tm(sx, 0, 0.18)), iron);
    b.add('metal', boxGeo(0.05, 0.9, 0.05), mul(M, tm(sx, 0, -0.22, 0, -0.18)), iron);
    b.add('metal', boxGeo(0.05, 0.04, 0.5), mul(M, tm(sx, 0.4, -0.02)), iron);
    b.add('metal', boxGeo(0.05, 0.04, 0.42), mul(M, tm(sx, 0.64, 0.06)), iron);
  }
}

/** Old-fashioned street lamp at the origin; the arm reaches along +z. */
export function addStreetLamp(b: Batch, M: THREE.Matrix4, color: THREE.ColorRepresentation = '#2f3b36') {
  b.add('metal', cylGeo(0.13, 0.16, 0.5, 10), M, color);
  b.add('metal', cylGeo(0.055, 0.075, 4.3, 8), mul(M, tm(0, 0.5, 0)), color);
  b.add('metal', cylGeo(0.09, 0.09, 0.12, 8), mul(M, tm(0, 4.7, 0)), color);
  b.add('metal', boxGeo(0.05, 0.05, 1.0), mul(M, tm(0, 4.65, 0.5)), color);
  b.add('metal', boxGeo(0.03, 0.03, 0.6), mul(M, tm(0, 4.3, 0.28, 0, -0.9)), color);
  b.add('metal', cylGeo(0.05, 0.26, 0.2, 10), mul(M, tm(0, 4.45, 1.0)), color);
  b.add('trim', new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mul(M, tm(0, 4.46, 1.0)), '#fff6d8');
}

/** Iron fence panel along +x from 0 to len (posts at both ends added by the caller). */
export function addIronFence(b: Batch, M: THREE.Matrix4, len: number, h = 1.3, color: THREE.ColorRepresentation = '#262b2a') {
  if (len <= 0.05) return;
  b.add('metal', boxGeo(len, 0.04, 0.04), mul(M, tm(len / 2, 0.12, 0)), color);
  b.add('metal', boxGeo(len, 0.04, 0.04), mul(M, tm(len / 2, h - 0.12, 0)), color);
  const n = Math.max(1, Math.round(len / 0.15));
  for (let k = 0; k < n; k++) {
    const x = ((k + 0.5) / n) * len;
    b.add('metal', boxGeo(0.02, h - 0.05, 0.02), mul(M, tm(x, 0, 0)), color);
    b.add('metal', new THREE.ConeGeometry(0.025, 0.08, 4).translate(0, h, 0), mul(M, tm(x, 0, 0)), color);
  }
}

export function addFencePost(b: Batch, M: THREE.Matrix4, h = 1.45, color: THREE.ColorRepresentation = '#262b2a') {
  b.add('metal', boxGeo(0.09, h, 0.09), M, color);
  b.add('metal', new THREE.SphereGeometry(0.06, 10, 6).translate(0, h + 0.04, 0), M, color);
}

/** White (or coloured) picket fence along +x from 0 to len. */
export function addPicketFence(b: Batch, M: THREE.Matrix4, len: number, color: THREE.ColorRepresentation = '#f6f3ea', h = 0.95) {
  if (len < 0.2) return;
  const picket = picketGeo(h);
  b.add('trim', boxGeo(len, 0.07, 0.035), mul(M, tm(len / 2, 0.2, -0.03)), color);
  b.add('trim', boxGeo(len, 0.07, 0.035), mul(M, tm(len / 2, h - 0.25, -0.03)), color);
  const posts = Math.max(1, Math.round(len / 2.2));
  for (let k = 0; k <= posts; k++) {
    b.add('trim', boxGeo(0.09, h + 0.08, 0.09), mul(M, tm((k / posts) * len, 0, -0.03)), color);
    b.add('trim', boxGeo(0.12, 0.04, 0.12), mul(M, tm((k / posts) * len, h + 0.08, -0.03)), color);
  }
  const n = Math.max(1, Math.floor(len / 0.165));
  for (let k = 0; k < n; k++) b.addClone('trim', picket, mul(M, tm(((k + 0.5) / n) * len, 0, 0)), color, 'box');
  picket.dispose();
}

function picketGeo(h: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const w = 0.075;
  s.moveTo(-w / 2, 0.03); s.lineTo(w / 2, 0.03); s.lineTo(w / 2, h - 0.07); s.lineTo(0, h); s.lineTo(-w / 2, h - 0.07); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false });
  g.translate(0, 0, 0);
  return g;
}

/** Flat patch (y = lift) given by a polygon in the xz-plane. */
export function flatShape(pts: [number, number][], lift = 0): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ShapeGeometry(s, 12);
  g.rotateX(-Math.PI / 2);
  g.translate(0, lift, 0);
  return g;
}

/** Flat rectangle on the ground (min/max corners), facing up. */
export function flatRect(x0: number, z0: number, x1: number, z1: number, y = 0): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, y, (z0 + z1) / 2);
}

// =============================================================================
// Animated flags (one merged mesh; vertices wave along their normal)
// =============================================================================

/** Flag cloth of w x h metres hanging from a pole along its left edge at the origin (in the xy-plane). */
export function flagGeo(w: number, h: number, M: THREE.Matrix4, color: THREE.ColorRepresentation, rect?: AtlasRect, phase = 0): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 10, 5).translate(w / 2, -h / 2, 0);
  const uv = g.attributes.uv, p = g.attributes.position;
  const wave = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    wave[i * 2] = p.getX(i) / w;
    wave[i * 2 + 1] = phase;
    if (rect) uv.setXY(i, rect.u0 + uv.getX(i) * (rect.u1 - rect.u0), rect.v0 + uv.getY(i) * (rect.v1 - rect.v0));
  }
  prepGeometry(g, M, color, 'keep');
  g.setAttribute('aFlag', new THREE.BufferAttribute(wave, 2));
  return g;
}

export interface Flags { mesh: THREE.Mesh; update(time: number): void; dispose(): void }

export function createFlags(geos: THREE.BufferGeometry[], map: THREE.Texture | null = null, amp = 0.12): Flags {
  const geo = mergeGeometries(geos, false)!;
  geos.forEach((g) => g.dispose());
  const uTime = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ map, vertexColors: true, side: THREE.DoubleSide, roughness: 0.75 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aFlag;\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
float fw = aFlag.x;
transformed += objectNormal * (sin(uTime * 4.2 + aFlag.y - fw * 5.5) * 0.7 + sin(uTime * 7.1 + aFlag.y * 2.0 - fw * 9.0) * 0.3) * ${amp.toFixed(3)} * fw;`);
  };
  mat.customProgramCacheKey = () => 'flag-wave';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'flags';
  return { mesh, update: (t) => { uTime.value = t; }, dispose: () => { geo.dispose(); mat.dispose(); } };
}

// =============================================================================
// Instanced flowers
// =============================================================================

export class FlowerSink {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly scale: number[] = [];
  static readonly COLORS = ['#e84a5f', '#ff8fab', '#ffd166', '#f7f3e3', '#9b5de5', '#f28482', '#ff9f1c', '#c77dff', '#ffffff', '#e63946'].map((c) => new THREE.Color(c));

  add(x: number, y: number, z: number, color: THREE.Color, s = 1) {
    this.pos.push(x, y, z);
    this.col.push(color.r, color.g, color.b);
    this.scale.push(s);
  }

  /** Scatters flowers over a rectangle given in the local frame M. */
  scatter(M: THREE.Matrix4, x0: number, z0: number, x1: number, z1: number, density: number, r: () => number, palette?: THREE.Color[], y0 = 0.14, y1 = 0.32) {
    const n = Math.round(Math.abs((x1 - x0) * (z1 - z0)) * density);
    const pal = palette ?? [FlowerSink.COLORS[Math.floor(r() * 10)], FlowerSink.COLORS[Math.floor(r() * 10)]];
    const p = V();
    for (let i = 0; i < n; i++) {
      p.set(x0 + r() * (x1 - x0), y0 + r() * (y1 - y0), z0 + r() * (z1 - z0)).applyMatrix4(M);
      this.add(p.x, p.y, p.z, pal[Math.floor(r() * pal.length)], 0.8 + r() * 0.5);
    }
  }

  build(): THREE.InstancedMesh | null {
    const n = this.scale.length;
    if (!n) return null;
    // five-petal flower head: a fan with a darker centre
    const pos: number[] = [0, 0.012, 0], col: number[] = [0.55, 0.45, 0.15], idx: number[] = [];
    const seg = 10;
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const rr = 0.026 + 0.034 * (k % 2 ? 0.15 : 1);
      pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      col.push(1, 1, 1);
      if (k > 0) idx.push(0, k + 1, k);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = V(), p = V(), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      e.set((hash2(i, 1, 2) - 0.5) * 0.7, hash2(i, 2, 2) * 6.28, (hash2(i, 3, 2) - 0.5) * 0.7);
      q.setFromEuler(e);
      s.setScalar(this.scale[i]);
      p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]));
    }
    mesh.receiveShadow = true;
    mesh.name = 'flowers';
    mesh.computeBoundingSphere();
    return mesh;
  }
}

// =============================================================================
// Cars (instanced: paint / glass / trim)
// =============================================================================

export interface CarPlacement { x: number; y?: number; z: number; rot: number; color: THREE.ColorRepresentation }

function carGeometries() {
  // 4.2 m long, 1.78 m wide hatchback; the side profile is extruded across the width
  const W = 1.78, bev = 0.07;
  const body = new THREE.Shape();
  body.moveTo(-2.02, 0.28);
  body.lineTo(-2.1, 0.55);
  body.quadraticCurveTo(-2.1, 0.9, -1.92, 0.94);
  body.lineTo(-1.3, 0.97);
  body.lineTo(1.1, 0.96);
  body.quadraticCurveTo(1.85, 0.9, 2.02, 0.78);
  body.quadraticCurveTo(2.12, 0.6, 2.06, 0.34);
  body.lineTo(1.78, 0.26);
  body.absarc(1.3, 0.3, 0.44, 0, Math.PI, false);
  body.lineTo(-0.86, 0.26);
  body.absarc(-1.3, 0.3, 0.44, 0, Math.PI, false);
  body.lineTo(-2.02, 0.28);
  const toCar = (g: THREE.BufferGeometry, width: number) => g.translate(0, 0, -width / 2).rotateY(-Math.PI / 2);
  const paint = toCar(new THREE.ExtrudeGeometry(body, { depth: W - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 6 }), W - 2 * bev);
  const cab = new THREE.Shape();
  cab.moveTo(-1.62, 0.9);
  cab.lineTo(1.12, 0.9);
  cab.quadraticCurveTo(0.6, 1.28, 0.3, 1.39);
  cab.lineTo(-0.95, 1.41);
  cab.quadraticCurveTo(-1.45, 1.3, -1.62, 0.9);
  const glassW = W - 0.16;
  const glass = toCar(new THREE.ExtrudeGeometry(cab, { depth: glassW - 0.08, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 1, curveSegments: 5 }), glassW - 0.08);
  const paintParts: THREE.BufferGeometry[] = [paint];
  // roof panel and pillars
  paintParts.push(new THREE.BoxGeometry(glassW + 0.03, 0.05, 1.3).translate(0, 1.415, -0.32));
  for (const sx of [-1, 1]) {
    const x = sx * (glassW / 2 + 0.005);
    // B-pillar and mirrors; the other pillars are hidden behind the tinted glass
    paintParts.push(new THREE.BoxGeometry(0.04, 0.46, 0.1).translate(x, 1.15, -0.25));
    paintParts.push(new THREE.BoxGeometry(0.14, 0.09, 0.2).translate(sx * (W / 2 + 0.05), 1.0, 0.95));
  }
  const trimParts: THREE.BufferGeometry[] = [];
  const colored = (g: THREE.BufferGeometry, c: THREE.ColorRepresentation) => { prepGeometry(g, null, c, 'keep'); return g; };
  for (const sx of [-1, 1]) {
    for (const sz of [-1.3, 1.3]) {
      trimParts.push(colored(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14).rotateZ(Math.PI / 2).translate(sx * (W / 2 - 0.14), 0.33, sz), '#1b1b1d'));
      trimParts.push(colored(new THREE.CylinderGeometry(0.2, 0.2, 0.25, 10).rotateZ(Math.PI / 2).translate(sx * (W / 2 - 0.135), 0.33, sz), '#b9bcc0'));
    }
    trimParts.push(colored(new THREE.BoxGeometry(0.42, 0.13, 0.06).translate(sx * 0.58, 0.7, 2.07), '#f6f4ea'));
    trimParts.push(colored(new THREE.BoxGeometry(0.36, 0.13, 0.06).translate(sx * 0.6, 0.72, -2.1), '#b3141b'));
  }
  trimParts.push(colored(new THREE.BoxGeometry(W - 0.1, 0.16, 0.12).translate(0, 0.36, 2.1), '#2b2d30'));
  trimParts.push(colored(new THREE.BoxGeometry(W - 0.1, 0.16, 0.12).translate(0, 0.36, -2.1), '#2b2d30'));
  trimParts.push(colored(new THREE.BoxGeometry(0.8, 0.14, 0.04).translate(0, 0.56, 2.1), '#1e2022'));
  trimParts.push(colored(new THREE.BoxGeometry(0.48, 0.12, 0.03).translate(0, 0.5, -2.16), '#f4f4f0'));
  paintParts[0] = toCreasedNormals(paint, 0.7);
  const norm = (list: THREE.BufferGeometry[]) => {
    for (const g of list) prepGeometry(g, null, 0xffffff, 'keep');
    const m = mergeGeometries(list, false)!;
    list.forEach((g) => g.dispose());
    return m;
  };
  const glassSmooth = toCreasedNormals(glass, 0.7);
  prepGeometry(glassSmooth, null, 0xffffff, 'keep');
  return { paint: norm(paintParts), glass: glassSmooth, trim: norm(trimParts) };
}

export function createCars(list: CarPlacement[]): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'cars';
  const geos = carGeometries();
  const mats = {
    paint: new THREE.MeshPhysicalMaterial({ roughness: 0.32, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 }),
    glass: new THREE.MeshStandardMaterial({ color: '#1c2630', roughness: 0.05, metalness: 0.3 }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 }),
  };
  const m = new THREE.Matrix4(), c = new THREE.Color();
  for (const part of ['paint', 'glass', 'trim'] as const) {
    const mesh = new THREE.InstancedMesh(geos[part], mats[part], list.length);
    list.forEach((car, i) => {
      m.copy(tm(car.x, car.y ?? 0, car.z, car.rot));
      mesh.setMatrixAt(i, m);
      if (part === 'paint') mesh.setColorAt(i, c.set(car.color));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return {
    group,
    dispose() {
      Object.values(geos).forEach((g) => g.dispose());
      Object.values(mats).forEach((x) => x.dispose());
    },
  };
}

// =============================================================================
// Town atlas: shop fronts, POI signs, street signs
// =============================================================================

export const ROUNDED = '"Arial Rounded MT Bold", "Varela Round", "Trebuchet MS", sans-serif';
export const SERIF = 'Georgia, "Times New Roman", serif';

export function fitFont(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, family: string, weight = 'bold') {
  let s = size;
  do { g.font = `${weight} ${s}px ${family}`; s -= 2; } while (g.measureText(text).width > maxW && s > 8);
}

export function centerText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, family: string, color: string, weight = 'bold') {
  fitFont(g, text, maxW, size, family, weight);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y);
}

export function woodBoard(g: CanvasRenderingContext2D, w: number, h: number, base: string, seed = 1) {
  g.fillStyle = base;
  roundRect(g, 0, 0, w, h, Math.min(w, h) * 0.18);
  g.fill();
  const r = mulberry32(seed);
  g.save();
  g.clip();
  g.globalAlpha = 0.18;
  g.strokeStyle = '#3b2412';
  for (let k = 0; k < 26; k++) {
    const y = r() * h;
    g.lineWidth = 1 + r() * 2;
    g.beginPath(); g.moveTo(0, y);
    g.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 10, w * 0.7, y + (r() - 0.5) * 10, w, y + (r() - 0.5) * 6);
    g.stroke();
  }
  g.restore();
  g.globalAlpha = 1;
}

export function trophy(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.beginPath();
  g.moveTo(x - s * 0.35, y - s * 0.45); g.lineTo(x + s * 0.35, y - s * 0.45);
  g.quadraticCurveTo(x + s * 0.32, y + s * 0.05, x, y + s * 0.1);
  g.quadraticCurveTo(x - s * 0.32, y + s * 0.05, x - s * 0.35, y - s * 0.45);
  g.fill();
  g.fillRect(x - s * 0.06, y + s * 0.08, s * 0.12, s * 0.2);
  g.fillRect(x - s * 0.25, y + s * 0.28, s * 0.5, s * 0.12);
  g.lineWidth = s * 0.07;
  g.strokeStyle = g.fillStyle as string;
  g.beginPath(); g.arc(x - s * 0.36, y - s * 0.28, s * 0.14, Math.PI * 0.5, Math.PI * 1.5); g.stroke();
  g.beginPath(); g.arc(x + s * 0.36, y - s * 0.28, s * 0.14, -Math.PI * 0.5, Math.PI * 0.5); g.stroke();
}

const STREET_NAMES_X = ['Acorn St', 'Maple St', 'Oak St', 'Cherry Ln', 'Birch St', 'Willow Way', 'Meadow Rd', 'Brook St'];
const STREET_NAMES_Z = ['Hill Ave', 'Park Ave', 'Elm Ave', 'Rose Ave', 'Pine Ave', 'Cedar Ave', 'Lake Ave', 'Fern Ave', 'Ivy Ave'];

function buildTownAtlas(atlas: Atlas) {
  buildFacadeAtlas(atlas);
  // the player's front door: red with a heart window
  atlas.add('homeDoor', 128, 272, (g, r, w, h) => {
    g.fillStyle = '#c4373d'; g.fillRect(0, 0, w, h);
    r.fillStyle = 'rgb(100,100,100)'; r.fillRect(0, 0, w, h);
    for (const [x, y, pw, ph] of [[16, 130, 42, 118], [70, 130, 42, 118]]) {
      g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(x, y, pw, ph);
      g.fillStyle = '#c4373d'; g.fillRect(x + 5, y + 5, pw - 10, ph - 10);
    }
    g.save();
    g.beginPath();
    const cx = w / 2, cy = 62;
    g.moveTo(cx, cy + 36);
    g.bezierCurveTo(cx - 50, cy + 2, cx - 30, cy - 38, cx, cy - 14);
    g.bezierCurveTo(cx + 30, cy - 38, cx + 50, cy + 2, cx, cy + 36);
    g.clip();
    glass(g, r, 0, 0, w, h);
    g.restore();
    g.fillStyle = '#e5c060'; drawPaw(g, w / 2, 118, 18);
    g.beginPath(); g.arc(w - 18, 160, 6, 0, Math.PI * 2); g.fill();
  });
  atlas.add('shopDoor', 128, 272, (g, r, w, h) => {
    g.fillStyle = '#2f5d4a'; g.fillRect(0, 0, w, h);
    r.fillStyle = 'rgb(100,100,100)'; r.fillRect(0, 0, w, h);
    glass(g, r, 14, 14, w - 28, 140, -20);
    g.fillStyle = '#2f5d4a'; g.fillRect(w / 2 - 3, 14, 6, 140); g.fillRect(14, 82, w - 28, 5);
    g.fillStyle = '#fff'; roundRect(g, 30, 96, 68, 26, 5); g.fill();
    centerText(g, 'OPEN', 64, 110, 60, 18, ROUNDED, '#c0392b');
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(16, 172, w - 32, 84);
    g.fillStyle = '#d8b24a'; g.beginPath(); g.arc(w - 18, 160, 6, 0, Math.PI * 2); g.fill();
  });
  atlas.add('glassDoor', 176, 288, (g, r, w, h) => {
    g.fillStyle = '#aeb3b8'; g.fillRect(0, 0, w, h);
    r.fillStyle = 'rgb(80,80,80)'; r.fillRect(0, 0, w, h);
    for (const x0 of [8, w / 2 + 3]) glass(g, r, x0, 10, w / 2 - 11, h - 22, -10);
    g.fillStyle = '#d7dadd'; g.fillRect(14, 150, w / 2 - 24, 8); g.fillRect(w / 2 + 10, 150, w / 2 - 24, 8);
    g.fillStyle = '#fff'; roundRect(g, 20, 60, 56, 22, 4); g.fill();
    centerText(g, 'OPEN', 48, 72, 50, 16, ROUNDED, '#1f8a82');
    g.fillStyle = 'rgba(255,255,255,0.85)'; drawPaw(g, w * 0.75, 90, 30);
  });
  atlas.add('archWin', 128, 224, (g, r, w, h) => {
    g.fillStyle = '#efe6d2'; g.fillRect(0, 0, w, h);
    glass(g, r, 12, 12, w - 24, h - 24);
    curtains(g, 12, 60, w - 24, h - 72, '#e9d8a6', 0.25);
    g.fillStyle = '#efe6d2';
    g.fillRect(w / 2 - 3, 12, 6, h - 24); g.fillRect(12, h / 2, w - 24, 6);
  });
  atlas.add('petWindow', 512, 256, (g, r, w, h) => {
    g.fillStyle = '#efe4cf'; g.fillRect(0, 0, w, h);
    const rnd = mulberry32(17);
    const bagCols = ['#d94f3d', '#3d7dd9', '#f2b33d', '#4caf6a', '#8e5bd9', '#f07b3f'];
    for (const sy of [86, 162]) {
      g.fillStyle = '#9b6b3f'; g.fillRect(0, sy, w, 8);
      for (let x = 10; x < w - 30; x += 26 + rnd() * 12) {
        const bh = 34 + rnd() * 26, bw = 20 + rnd() * 10;
        g.fillStyle = bagCols[Math.floor(rnd() * bagCols.length)];
        g.fillRect(x, sy - bh, bw, bh);
        g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x + 3, sy - bh * 0.6, bw - 6, bh * 0.25);
      }
    }
    for (let k = 0; k < 9; k++) {
      g.fillStyle = ['#d8e04a', '#e8453c', '#4b8fe0', '#f28bb6'][k % 4];
      g.beginPath(); g.arc(30 + k * 52 + rnd() * 10, 228, 11 + rnd() * 5, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#b08968'; g.beginPath(); g.ellipse(390, 236, 70, 22, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8d5b9'; g.beginPath(); g.ellipse(390, 230, 52, 13, 0, 0, Math.PI * 2); g.fill();
    // glass on top
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, 'rgba(210,230,245,0.45)'); grd.addColorStop(0.35, 'rgba(120,150,170,0.15)'); grd.addColorStop(1, 'rgba(60,80,95,0.25)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    centerText(g, 'Food  ·  Toys  ·  Treats', w / 2, 30, w - 60, 30, ROUNDED, 'rgba(255,255,255,0.95)');
    g.fillStyle = 'rgba(255,255,255,0.8)'; drawPaw(g, w - 46, h - 70, 44);
    r.fillStyle = 'rgb(26,26,26)'; r.fillRect(0, 0, w, h);
  });
  atlas.add('secondWindow', 512, 256, (g, r, w, h) => {
    g.fillStyle = '#6a5140'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#4b392c'; g.fillRect(0, 150, w, 10);
    const rnd = mulberry32(23);
    for (let x = 20; x < 220; x += 12 + rnd() * 6) {
      g.fillStyle = ['#8b2f35', '#2f4f7f', '#3f6e4a', '#c9a227', '#6b4a8b'][Math.floor(rnd() * 5)];
      const bh = 40 + rnd() * 20; g.fillRect(x, 150 - bh, 10, bh);
    }
    // lamp, clock, vase, chair
    g.fillStyle = '#e9d8a6'; g.beginPath(); g.moveTo(280, 60); g.lineTo(330, 60); g.lineTo(345, 110); g.lineTo(265, 110); g.fill();
    g.fillStyle = '#c9a227'; g.fillRect(302, 110, 6, 40); g.fillRect(290, 146, 30, 6);
    g.fillStyle = '#f3ecd9'; g.beginPath(); g.arc(420, 80, 32, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#3b2a1e'; g.lineWidth = 3; g.beginPath(); g.moveTo(420, 80); g.lineTo(420, 58); g.moveTo(420, 80); g.lineTo(436, 88); g.stroke();
    g.fillStyle = '#2f6d8f'; g.beginPath(); g.ellipse(390, 205, 18, 34, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#8a5a36'; g.fillRect(90, 190, 90, 12); g.fillRect(90, 170, 12, 70); g.fillRect(168, 200, 10, 40); g.fillRect(96, 200, 8, 40);
    g.fillStyle = '#b86b77'; g.beginPath(); g.arc(470, 220, 20, 0, Math.PI * 2); g.fill();
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, 'rgba(210,230,245,0.4)'); grd.addColorStop(0.4, 'rgba(120,150,170,0.1)'); grd.addColorStop(1, 'rgba(40,50,60,0.25)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    centerText(g, 'Antiques & Curios', w / 2, 28, w - 80, 32, SERIF, '#e8c66a', 'italic bold');
    r.fillStyle = 'rgb(26,26,26)'; r.fillRect(0, 0, w, h);
  });
  atlas.add('gymGlass', 512, 224, (g, r, w, h) => {
    glass(g, r, 0, 0, w, h, -30);
    g.fillStyle = 'rgba(255,236,190,0.35)';
    for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(64 + k * 128, 40, 40, 12, 0, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = 'rgba(214,170,60,0.9)';
    for (let k = 0; k < 6; k++) trophy(g, 50 + k * 82, 180, 36);
    g.fillStyle = '#5b6168';
    for (let x = 0; x <= w; x += 128) g.fillRect(Math.min(x, w - 8), 0, 8, h);
    g.fillRect(0, 0, w, 8); g.fillRect(0, h - 8, w, 8); g.fillRect(0, 110, w, 6);
    r.fillStyle = 'rgb(90,90,90)';
    for (let x = 0; x <= w; x += 128) r.fillRect(Math.min(x, w - 8), 0, 8, h);
  });
  atlas.add('barnDoor', 256, 256, (g, r, w, h) => {
    g.fillStyle = '#a8322b'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 0; x < w; x += 21) g.fillRect(x, 0, 2, h);
    g.strokeStyle = '#f4efe6'; g.lineWidth = 14;
    g.strokeRect(7, 7, w - 14, h - 14);
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
    g.lineWidth = 10;
    for (const x0 of [0, w / 2]) {
      g.beginPath(); g.moveTo(x0 + 10, 10); g.lineTo(x0 + w / 2 - 10, h - 10); g.moveTo(x0 + w / 2 - 10, 10); g.lineTo(x0 + 10, h - 10); g.stroke();
    }
  });
  atlas.add('hayloft', 128, 128, (g, r, w, h) => {
    g.fillStyle = '#a8322b'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f4efe6'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.lineWidth = 7; g.beginPath(); g.moveTo(8, 8); g.lineTo(w - 8, h - 8); g.moveTo(w - 8, 8); g.lineTo(8, h - 8); g.stroke();
  });

  // POI signs
  atlas.add('petSign', 1024, 176, (g, r, w, h) => {
    g.fillStyle = '#fff4dc'; roundRect(g, 0, 0, w, h, 34); g.fill();
    g.fillStyle = '#16847d'; roundRect(g, 10, 10, w - 20, h - 20, 28); g.fill();
    centerText(g, 'Pet Supply', w / 2, h / 2 + 4, w - 320, 118, ROUNDED, '#fff4dc');
    g.fillStyle = '#ffd166'; drawPaw(g, 92, h / 2, 96); drawPaw(g, w - 92, h / 2, 96);
    r.fillStyle = 'rgb(120,120,120)'; r.fillRect(0, 0, w, h);
  });
  atlas.add('secondSign', 1000, 132, (g, r, w, h) => {
    g.fillStyle = '#23483a'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#e0b95b'; g.lineWidth = 5; g.strokeRect(12, 12, w - 24, h - 24);
    centerText(g, 'Secondhand Shop', w / 2, h / 2 + 3, w - 120, 86, SERIF, '#e8c66a', 'italic bold');
  });
  atlas.add('gymSign', 640, 208, (g, r, w, h) => {
    g.fillStyle = '#f4f1e8'; roundRect(g, 0, 0, w, h, 30); g.fill();
    g.fillStyle = '#2a4d9e'; roundRect(g, 10, 10, w - 20, h - 20, 24); g.fill();
    centerText(g, 'GYM', w / 2, h / 2 + 8, 360, 170, ROUNDED, '#ffffff');
    g.fillStyle = '#f2c14e'; trophy(g, 90, h / 2, 110); trophy(g, w - 90, h / 2, 110);
  });
  atlas.add('gymSub', 896, 96, (g, r, w, h) => {
    g.fillStyle = '#1d3570'; roundRect(g, 0, 0, w, h, 18); g.fill();
    centerText(g, 'DOG CONTEST HALL', w / 2, h / 2 + 3, w - 60, 62, ROUNDED, '#f2c14e');
  });
  atlas.add('homeSign', 384, 128, (g, r, w, h) => {
    woodBoard(g, w, h, '#8a5a32', 3);
    g.strokeStyle = '#f3e3c3'; g.lineWidth = 4; roundRect(g, 10, 10, w - 20, h - 20, 16); g.stroke();
    centerText(g, 'Home', w / 2 + 10, h / 2 + 4, w - 150, 82, SERIF, '#fff1d6', 'italic bold');
    g.fillStyle = '#e8505b';
    g.beginPath(); const hx = 52, hy = 60;
    g.moveTo(hx, hy + 22); g.bezierCurveTo(hx - 30, hy, hx - 16, hy - 24, hx, hy - 8); g.bezierCurveTo(hx + 16, hy - 24, hx + 30, hy, hx, hy + 22); g.fill();
    g.fillStyle = '#fff1d6'; drawPaw(g, w - 48, h / 2 + 2, 44);
  });
  atlas.add('kennelSign', 576, 176, (g, r, w, h) => {
    woodBoard(g, w, h, '#d6ad74', 5);
    g.strokeStyle = '#5a3a1e'; g.lineWidth = 6; roundRect(g, 12, 12, w - 24, h - 24, 20); g.stroke();
    centerText(g, 'Kennel', w / 2, h / 2 + 5, w - 200, 110, SERIF, '#4a2e17');
    g.fillStyle = '#4a2e17'; drawPaw(g, 70, h / 2, 64); drawPaw(g, w - 70, h / 2, 64);
  });
  atlas.add('parkSign', 512, 128, (g, r, w, h) => {
    g.fillStyle = '#f0e6c8'; roundRect(g, 0, 0, w, h, 24); g.fill();
    g.fillStyle = '#2f6b3a'; roundRect(g, 8, 8, w - 16, h - 16, 18); g.fill();
    centerText(g, 'Park', w / 2, h / 2 + 4, w - 160, 84, SERIF, '#f6ecd0');
    g.fillStyle = '#9fd36b';
    for (const x of [70, w - 70]) { g.beginPath(); g.ellipse(x, h / 2, 34, 18, -0.6, 0, Math.PI * 2); g.fill(); }
  });
  atlas.add('bladeSign', 192, 192, (g, r, w, h) => {
    g.fillStyle = '#23483a'; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f3e8cf'; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#23483a';
    g.beginPath(); g.ellipse(w / 2, 100, 40, 30, 0, 0, Math.PI * 2); g.fill();
    g.fillRect(w / 2 - 14, 62, 28, 10); g.beginPath(); g.arc(w / 2, 60, 7, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(w / 2 + 36, 96); g.quadraticCurveTo(w / 2 + 62, 80, w / 2 + 66, 70); g.lineTo(w / 2 + 58, 100); g.fill();
    g.lineWidth = 7; g.strokeStyle = '#23483a'; g.beginPath(); g.arc(w / 2 - 42, 100, 14, Math.PI * 0.5, Math.PI * 1.5); g.stroke();
    centerText(g, 'Curios', w / 2, 150, 120, 30, SERIF, '#23483a', 'italic bold');
  });
  atlas.add('chalk', 128, 176, (g, r, w, h) => {
    g.fillStyle = '#8a5a32'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#2d3935'; g.fillRect(9, 9, w - 18, h - 18);
    const chalk = '"Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive';
    centerText(g, 'Treats', w / 2, 44, w - 26, 30, chalk, '#f4f1e8');
    centerText(g, 'today!', w / 2, 78, w - 26, 26, chalk, '#ffd166');
    g.fillStyle = '#f4f1e8'; drawBone(g, w / 2, 118, 56, -0.2);
    g.fillStyle = '#f7b2c4'; drawPaw(g, w / 2 + 28, 148, 22);
  });
  atlas.add('stop', 128, 128, (g, r, w, h) => {
    g.fillStyle = '#c62828'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#fff'; g.lineWidth = 6;
    g.beginPath();
    for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k * Math.PI) / 4; g.lineTo(w / 2 + Math.cos(a) * 56, h / 2 + Math.sin(a) * 56); }
    g.closePath(); g.stroke();
    centerText(g, 'STOP', w / 2, h / 2 + 2, 96, 38, 'Helvetica, Arial, sans-serif', '#fff');
  });
  [['DISC', '#f28c28'], ['AGILITY', '#3a9d5d'], ['OBEY', '#7b5cc4']].forEach(([word, col], k) => {
    atlas.add('banner' + k, 96, 288, (g, r, w, h) => {
      g.fillStyle = col; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      if (k === 0) { g.beginPath(); g.ellipse(w / 2, 80, 34, 14, -0.3, 0, Math.PI * 2); g.fill(); g.fillStyle = col; g.beginPath(); g.ellipse(w / 2, 78, 20, 7, -0.3, 0, Math.PI * 2); g.fill(); }
      if (k === 1) { g.fillRect(16, 60, 8, 50); g.fillRect(w - 24, 60, 8, 50); g.fillRect(16, 78, w - 32, 7); }
      if (k === 2) drawPaw(g, w / 2, 80, 56);
      g.save(); g.translate(w / 2, 200); g.rotate(-Math.PI / 2);
      centerText(g, word, 0, 0, 150, 40, ROUNDED, '#ffffff');
      g.restore();
    });
  });
  atlas.add('flagPaw', 192, 128, (g, r, w, h) => {
    g.fillStyle = '#2a4d9e'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2c14e'; drawPaw(g, w / 2, h / 2, 76);
  });
  atlas.add('flagBone', 192, 128, (g, r, w, h) => {
    g.fillStyle = '#e8505b'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; drawBone(g, w / 2, h / 2, 110, -0.25);
  });
  atlas.add('flagStripe', 192, 128, (g, r, w, h) => {
    const cols = ['#f2c14e', '#ffffff', '#3a9d5d'];
    cols.forEach((c, k) => { g.fillStyle = c; g.fillRect(0, (k * h) / 3, w, h / 3 + 1); });
  });
  STREET_NAMES_X.forEach((n, k) => atlas.add('streetX' + k, 256, 48, (g, r, w, h) => streetPlate(g, w, h, n)));
  STREET_NAMES_Z.forEach((n, k) => atlas.add('streetZ' + k, 256, 48, (g, r, w, h) => streetPlate(g, w, h, n)));
}

function streetPlate(g: CanvasRenderingContext2D, w: number, h: number, name: string) {
  g.fillStyle = '#1f6b45'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#fff'; g.lineWidth = 3; roundRect(g, 4, 4, w - 8, h - 8, 6); g.stroke();
  centerText(g, name, w / 2, h / 2 + 1, w - 24, 32, 'Helvetica, Arial, sans-serif', '#fff');
}

// =============================================================================
// Houses
// =============================================================================

export interface HouseSpec {
  seed: number;
  w: number;
  d: number;
  stories: 1 | 2;
  wall: 'siding' | 'brick' | 'stucco';
  wallColor: THREE.ColorRepresentation;
  trimColor: THREE.ColorRepresentation;
  roofColor: THREE.ColorRepresentation;
  accent: THREE.ColorRepresentation;
  roof: 'gable' | 'frontGable' | 'hip';
  pitch: number;
  porch: boolean;
  chimney: boolean;
  shutters: boolean;
  flowerBoxes: boolean;
  /** attached garage on the -x / +x side, or none */
  garage: -1 | 0 | 1;
  door: string;
  window: number;
  roundWindow?: boolean;
  doorSlot?: number;
}

export interface HouseCtx {
  b: Batch;
  atlas: Atlas;
  flowers: FlowerSink;
  shrubs: THREE.BufferGeometry[];
}

const WALL_KEY = { siding: 'siding', brick: 'brick', stucco: 'concrete' } as const;
const WALL_COLORS = ['#f4f1e8', '#ecdfc4', '#f3dc92', '#bcd5c2', '#a9c8e0', '#ecbfae', '#d9c9e6', '#cddcaa', '#f2cda5', '#a3bccf', '#e8e3d5', '#f6e9ce'];
const ROOF_COLORS = ['#5d6168', '#6d5243', '#94503e', '#48525f', '#56644e', '#7d736b', '#3f4247'];
const ACCENTS = ['#2f4f7f', '#3f6e4a', '#8b2f35', '#2d2d30', '#5f8bb3', '#7a5230', '#4d7f7a'];
export const GREENS = ['#5d8f3a', '#4f8434', '#6b9a3f', '#58903a', '#476f2f'];

export function randomHouseSpec(r: () => number, w: number, d: number, garage: -1 | 0 | 1): HouseSpec {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const wallRoll = r();
  const wall: HouseSpec['wall'] = wallRoll < 0.62 ? 'siding' : wallRoll < 0.84 ? 'brick' : 'stucco';
  const stories: 1 | 2 = r() < 0.62 ? 2 : 1;
  const roofRoll = r();
  const roof: HouseSpec['roof'] = roofRoll < 0.45 ? 'gable' : roofRoll < 0.72 ? 'hip' : 'frontGable';
  return {
    seed: Math.floor(r() * 1e6),
    w, d, stories, wall,
    wallColor: wall === 'brick' ? pick(['#ffffff', '#f3e6e0', '#ffe9d8']) : pick(WALL_COLORS),
    trimColor: r() < 0.82 ? '#f8f7f2' : pick(['#efe6d2', '#e7e2d6']),
    roofColor: pick(ROOF_COLORS),
    accent: pick(ACCENTS),
    roof,
    pitch: roof === 'frontGable' ? 0.75 + r() * 0.25 : 0.5 + r() * 0.25,
    porch: r() < 0.4,
    chimney: r() < 0.45,
    shutters: wall !== 'brick' && r() < 0.55,
    flowerBoxes: r() < 0.35,
    garage,
    door: 'door' + Math.floor(r() * 5),
    window: Math.floor(r() * 4),
  };
}

function addWindow(ctx: HouseCtx, F: THREE.Matrix4, x: number, y: number, ww: number, wh: number, rect: AtlasRect, trim: THREE.ColorRepresentation, o: { shutters?: THREE.ColorRepresentation; box?: THREE.ColorRepresentation; r?: () => number } = {}) {
  const b = ctx.b;
  b.add('trim', boxGeo(ww + 0.24, wh + 0.26, 0.07), mul(F, tm(x, y - 0.1, 0)), trim);
  b.add('facade', atlasQuad(ww, wh, rect), mul(F, tm(x, y + wh / 2, 0.038)), 0xffffff, 'keep');
  b.add('trim', boxGeo(ww + 0.38, 0.07, 0.17), mul(F, tm(x, y - 0.14, 0.06)), trim);
  if (o.shutters) {
    for (const sx of [-1, 1]) b.add('trim', boxGeo(ww * 0.42, wh + 0.04, 0.04), mul(F, tm(x + sx * (ww / 2 + 0.14 + ww * 0.21), y - 0.02, 0.02)), o.shutters);
  }
  if (o.box && o.r) {
    b.add('trim', boxGeo(ww + 0.1, 0.2, 0.24), mul(F, tm(x, y - 0.38, 0.14)), o.box);
    b.add('foliage', hedgeGeo(ww, 0.14, 0.2, Math.floor(o.r() * 99)), mul(F, tm(x - ww / 2, y - 0.2, 0.14)), GREENS[0], 'box');
    ctx.flowers.scatter(mul(F, tm(x, y - 0.16, 0.14)), -ww / 2, -0.09, ww / 2, 0.09, 70, o.r, undefined, 0.02, 0.12);
  }
}

/** A house in its own frame: front wall on z = 0 facing +z, footprint x in [-w/2, w/2], z in [-d, 0]. */
export function buildHouse(ctx: HouseCtx, s: HouseSpec, M: THREE.Matrix4): { doorX: number; stoop: number } {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(s.seed);
  const F = 0.5, SH = 2.75, E = F + s.stories * SH;
  const { w, d } = s;
  const wallKey = WALL_KEY[s.wall];
  const trim = s.trimColor;
  b.add('concrete', boxGeo(w + 0.12, F + 0.02, d + 0.12), mul(M, tm(0, 0, -d / 2)), '#aca79d');

  const wm = new MeshBuilder(), rm = new MeshBuilder(), tr = new MeshBuilder();
  wm.poly([V(-w / 2, F, 0), V(w / 2, F, 0), V(w / 2, E, 0), V(-w / 2, E, 0)]);
  wm.poly([V(w / 2, F, 0), V(w / 2, F, -d), V(w / 2, E, -d), V(w / 2, E, 0)]);
  wm.poly([V(w / 2, F, -d), V(-w / 2, F, -d), V(-w / 2, E, -d), V(w / 2, E, -d)]);
  wm.poly([V(-w / 2, F, -d), V(-w / 2, F, 0), V(-w / 2, E, 0), V(-w / 2, E, -d)]);
  const o = 0.42, lift = 0.1, p = s.pitch, th = 0.16;
  const roofDark = new THREE.Color(s.roofColor).multiplyScalar(0.75);
  let ridgeY: number;
  if (s.roof === 'gable') {
    const R = E + (d / 2) * p;
    wm.poly([V(w / 2, E, 0), V(w / 2, E, -d), V(w / 2, R, -d / 2)]);
    wm.poly([V(-w / 2, E, -d), V(-w / 2, E, 0), V(-w / 2, R, -d / 2)]);
    const e = E - o * p + lift, rr = R + lift, ox = w / 2 + 0.32;
    rm.slab([V(-ox, e, o), V(ox, e, o), V(ox, rr, -d / 2), V(-ox, rr, -d / 2)], th, tr);
    rm.slab([V(ox, e, -d - o), V(-ox, e, -d - o), V(-ox, rr, -d / 2), V(ox, rr, -d / 2)], th, tr);
    b.add('roof', boxGeo(2 * ox + 0.04, 0.12, 0.3), mul(M, tm(0, rr - 0.06, -d / 2)), roofDark);
    for (const z of [0, -d]) b.add('trim', boxGeo(w + 0.1, 0.2, 0.06), mul(M, tm(0, E - 0.2, z + (z ? -0.02 : 0.02))), trim);
    ridgeY = rr;
  } else if (s.roof === 'frontGable') {
    const R = E + (w / 2) * p;
    wm.poly([V(-w / 2, E, 0), V(w / 2, E, 0), V(0, R, 0)]);
    wm.poly([V(w / 2, E, -d), V(-w / 2, E, -d), V(0, R, -d)]);
    const e = E - o * p + lift, rr = R + lift, oz = 0.36;
    rm.slab([V(-w / 2 - o, e, -d - oz), V(-w / 2 - o, e, oz), V(0, rr, oz), V(0, rr, -d - oz)], th, tr);
    rm.slab([V(w / 2 + o, e, oz), V(w / 2 + o, e, -d - oz), V(0, rr, -d - oz), V(0, rr, oz)], th, tr);
    b.add('roof', boxGeo(0.3, 0.12, d + 2 * oz + 0.04), mul(M, tm(0, rr - 0.06, -d / 2)), roofDark);
    for (const x of [-w / 2, w / 2]) b.add('trim', boxGeo(0.06, 0.2, d + 0.1), mul(M, tm(x + Math.sign(x) * 0.02, E - 0.2, -d / 2)), trim);
    ridgeY = rr;
  } else {
    const R = E + (d / 2) * p;
    const e = E - o * p + lift, rr = R + lift;
    const hx = w / 2 + o, hz = d / 2 + o, rx = Math.max(0.02, w / 2 - d / 2), cz = -d / 2;
    rm.slab([V(-hx, e, cz + hz), V(hx, e, cz + hz), V(rx, rr, cz), V(-rx, rr, cz)], th, tr);
    rm.slab([V(hx, e, cz + hz), V(hx, e, cz - hz), V(rx, rr, cz)], th, tr);
    rm.slab([V(hx, e, cz - hz), V(-hx, e, cz - hz), V(-rx, rr, cz), V(rx, rr, cz)], th, tr);
    rm.slab([V(-hx, e, cz - hz), V(-hx, e, cz + hz), V(-rx, rr, cz)], th, tr);
    b.add('roof', boxGeo(2 * rx + 0.3, 0.12, 0.3), mul(M, tm(0, rr - 0.06, cz)), roofDark);
    for (const z of [0, -d]) b.add('trim', boxGeo(w + 0.1, 0.2, 0.06), mul(M, tm(0, E - 0.2, z + (z ? -0.02 : 0.02))), trim);
    for (const x of [-w / 2, w / 2]) b.add('trim', boxGeo(0.06, 0.2, d + 0.1), mul(M, tm(x + Math.sign(x) * 0.02, E - 0.2, -d / 2)), trim);
    ridgeY = rr;
  }
  b.add(wallKey, wm.geometry(), M, s.wallColor, 'keep');
  b.add('roof', rm.geometry(), M, s.roofColor, 'keep');
  b.add('trim', tr.geometry(), M, trim, 'keep');
  if (s.wall === 'siding') {
    for (const [x, z] of [[-w / 2, 0], [w / 2, 0], [-w / 2, -d], [w / 2, -d]]) b.add('trim', boxGeo(0.16, E - F, 0.16), mul(M, tm(x, F, z)), trim);
  }
  if (s.stories === 2 && s.wall !== 'brick') b.add('trim', boxGeo(w + 0.08, 0.1, 0.06), mul(M, tm(0, F + SH - 0.05, 0.01)), trim);

  // front: windows in slots, the door in one of them
  const slots = Math.max(2, Math.min(4, Math.floor((w - 0.4) / 2.2)));
  const slotX = (k: number) => -w / 2 + (w / slots) * (k + 0.5);
  const doorSlot = s.doorSlot ?? Math.min(slots - 1, Math.floor((slots - 1) / 2 + (slots % 2 === 0 && r() < 0.5 ? 1 : 0)));
  const winRect = A['win' + s.window];
  for (let f = 0; f < s.stories; f++) {
    for (let k = 0; k < slots; k++) {
      if (f === 0 && k === doorSlot) continue;
      addWindow(ctx, M, slotX(k), F + f * SH + 0.8, 1.05, 1.42, winRect, trim, {
        shutters: s.shutters ? s.accent : undefined, box: f === 0 && s.flowerBoxes ? s.accent : undefined, r,
      });
    }
  }
  if (s.roof === 'frontGable') {
    if (s.roundWindow) {
      const shape = new THREE.Shape().absarc(0, 0, 0.46, 0, Math.PI * 2, false);
      b.add('facade', atlasShape(shape, A.round, 24), mul(M, tm(0, E + 0.95, 0.04)), 0xffffff, 'keep');
      b.add('trim', new THREE.TorusGeometry(0.48, 0.06, 6, 28), mul(M, tm(0, E + 0.95, 0.04)), trim);
    } else {
      addWindow(ctx, M, 0, E + 0.3, 0.8, 1.0, A['win' + ((s.window + 2) % 4)], trim);
    }
  }
  // sides and back
  const sideN = Math.max(1, Math.floor(d / 2.7));
  for (const side of [-1, 1]) {
    const Fr = mul(M, tm((side * w) / 2, 0, -d / 2, (side * Math.PI) / 2));
    for (let f = 0; f < s.stories; f++) {
      if (f === 0 && s.garage === side) continue;
      for (let k = 0; k < sideN; k++) {
        const x = -d / 2 + (d / sideN) * (k + 0.5);
        addWindow(ctx, Fr, x, F + f * SH + 0.85, 0.95, 1.3, A['win' + ((s.window + k + 1) % 4)], trim);
      }
    }
  }
  const Fb = mul(M, tm(0, 0, -d, Math.PI));
  for (let f = 0; f < s.stories; f++) for (const x of [-w / 4, w / 4]) addWindow(ctx, Fb, x, F + f * SH + 0.85, 0.95, 1.3, A['win' + ((s.window + 1) % 4)], trim);

  // door, stoop or porch
  const dx = slotX(doorSlot);
  b.add('trim', boxGeo(1.3, 2.32, 0.06), mul(M, tm(dx, F - 0.02, 0)), trim);
  b.add('facade', atlasQuad(1.0, 2.12, A[s.door]), mul(M, tm(dx, F + 1.06, 0.034)), 0xffffff, 'keep');
  b.add('trim', boxGeo(1.52, 0.1, 0.18), mul(M, tm(dx, F + 2.3, 0.06)), trim);
  b.add('metal', boxGeo(0.13, 0.24, 0.12), mul(M, tm(dx + 0.85, F + 1.55, 0.07)), '#2a2a2a');
  b.add('trim', boxGeo(0.09, 0.14, 0.09), mul(M, tm(dx + 0.85, F + 1.6, 0.08)), '#fff3cf');
  let stoop: number;
  if (s.porch) {
    const pw = Math.min(w - 0.6, 3.8), pd = 1.9;
    b.add('trim', boxGeo(pw, F, pd), mul(M, tm(dx, 0, pd / 2)), '#b9a58a');
    b.add('concrete', boxGeo(1.7, F * 0.5, 0.42), mul(M, tm(dx, 0, pd + 0.21)), '#b8b2a6');
    const y0 = s.stories === 1 ? F + 2.32 : F + 2.95, y1 = y0 - 0.38;
    const pr = new MeshBuilder(), prt = new MeshBuilder();
    pr.slab([V(dx - pw / 2 - 0.18, y1, pd + 0.22), V(dx + pw / 2 + 0.18, y1, pd + 0.22), V(dx + pw / 2 + 0.18, y0, 0), V(dx - pw / 2 - 0.18, y0, 0)], 0.14, prt);
    b.add('roof', pr.geometry(), M, s.roofColor, 'keep');
    b.add('trim', prt.geometry(), M, trim, 'keep');
    for (const sx of [-1, 1]) {
      const px = dx + sx * (pw / 2 - 0.12);
      b.add('trim', boxGeo(0.15, y1 - F - 0.1, 0.15), mul(M, tm(px, F, pd - 0.12)), trim);
      b.add('trim', boxGeo(0.06, 0.06, pd - 0.3), mul(M, tm(px, F + 0.85, pd / 2 - 0.1)), trim);
      for (let k = 0; k < 6; k++) b.add('trim', boxGeo(0.04, 0.82, 0.04), mul(M, tm(px, F, 0.2 + k * 0.28)), trim);
    }
    stoop = pd + 0.42;
  } else {
    b.add('concrete', boxGeo(1.8, F, 1.0), mul(M, tm(dx, 0, 0.5)), '#bdb7ab');
    b.add('concrete', boxGeo(1.6, F * 0.5, 0.42), mul(M, tm(dx, 0, 1.21)), '#bdb7ab');
    if (s.stories === 2 || s.roof === 'frontGable') {
      const cy = F + 2.62;
      const cm = new MeshBuilder(), ct = new MeshBuilder();
      cm.slab([V(dx - 0.95, cy, 0.95), V(dx + 0.95, cy, 0.95), V(dx + 0.95, cy + 0.3, 0), V(dx - 0.95, cy + 0.3, 0)], 0.12, ct);
      b.add('roof', cm.geometry(), M, s.roofColor, 'keep');
      b.add('trim', ct.geometry(), M, trim, 'keep');
      for (const sx of [-0.8, 0.8]) b.add('trim', boxGeo(0.06, 0.4, 0.5), mul(M, tm(dx + sx, cy - 0.4, 0.3)), trim);
    }
    stoop = 1.42;
  }

  if (s.chimney) {
    const cx = s.roof === 'frontGable' ? w / 2 - 0.9 : w / 2 - 1.3;
    const top = ridgeY + 0.7;
    b.add('brick', boxGeo(0.72, top - (E - 0.8), 0.82), mul(M, tm(cx, E - 0.8, -d / 2 - 0.5)), '#f4ece6');
    b.add('concrete', boxGeo(0.86, 0.12, 0.96), mul(M, tm(cx, top, -d / 2 - 0.5)), '#8d8a84');
  }

  if (s.garage) {
    const gw = 3.5, gd = Math.min(d, 6.2), gh = 2.9;
    const G = mul(M, tm(s.garage * (w / 2 + gw / 2), 0, -0.5));
    b.add(wallKey, boxGeo(gw, gh, gd), mul(G, tm(0, 0.02, -gd / 2)), s.wallColor);
    b.add('trim', boxGeo(2.95, 2.38, 0.04), mul(G, tm(0, 0.02, 0.0)), trim);
    b.add('facade', atlasQuad(2.7, 2.2, A.garage), mul(G, tm(0, 1.12, 0.024)), 0xffffff, 'keep');
    const pg = Math.min(p, 0.6);
    const gm = new MeshBuilder(), gr = new MeshBuilder(), gt = new MeshBuilder();
    const R = gh + (gw / 2) * pg;
    gm.poly([V(-gw / 2, gh, 0), V(gw / 2, gh, 0), V(0, R, 0)]);
    const e = gh - 0.3 * pg + 0.08, rr = R + 0.08;
    gr.slab([V(-gw / 2 - 0.3, e, -gd - 0.05), V(-gw / 2 - 0.3, e, 0.35), V(0, rr, 0.35), V(0, rr, -gd - 0.05)], 0.14, gt);
    gr.slab([V(gw / 2 + 0.3, e, 0.35), V(gw / 2 + 0.3, e, -gd - 0.05), V(0, rr, -gd - 0.05), V(0, rr, 0.35)], 0.14, gt);
    b.add(wallKey, gm.geometry(), G, s.wallColor, 'keep');
    b.add('roof', gr.geometry(), G, s.roofColor, 'keep');
    b.add('trim', gt.geometry(), G, trim, 'keep');
  }
  return { doorX: dx, stoop };
}

// =============================================================================
// Yards, fences, beds
// =============================================================================

export interface LotCtx extends HouseCtx {
  trees: TreeFactory;
  cars: CarPlacement[];
}

type FenceKind = 'picket' | 'hedge' | 'wall' | 'none';
export interface Blocker { x: number; r: number }

export function shrub(ctx: HouseCtx, M: THREE.Matrix4, x: number, z: number, s: number, seed: number, tint?: THREE.ColorRepresentation) {
  const t = ctx.shrubs[seed % ctx.shrubs.length];
  ctx.b.addClone('foliage', t, mul(M, tm(x, 0, z, seed * 1.7, 0, 0, s)), tint ?? GREENS[seed % GREENS.length], 'box');
}

/** Mulch flower bed (rectangle in frame M) with shrubs and flowers. */
export function addBed(ctx: HouseCtx, M: THREE.Matrix4, x0: number, z0: number, x1: number, z1: number, r: () => number) {
  if (x1 - x0 < 0.5 || Math.abs(z1 - z0) < 0.3) return;
  ctx.b.add('concrete', flatRect(x0, z0, x1, z1, 0.02), M, '#4b3727');
  const n = Math.max(1, Math.round((x1 - x0) / 1.2));
  const zc = (z0 + z1) / 2;
  for (let k = 0; k < n; k++) shrub(ctx, M, x0 + ((k + 0.5) * (x1 - x0)) / n, zc + (r() - 0.5) * 0.2, 0.5 + r() * 0.35, Math.floor(r() * 1000));
  ctx.flowers.scatter(M, x0 + 0.1, z0 + 0.05, x1 - 0.1, z1 - 0.05, 12, r);
}

function fenceRun(ctx: HouseCtx, M: THREE.Matrix4, kind: FenceKind, x0: number, x1: number, color: THREE.ColorRepresentation, seed: number) {
  const len = x1 - x0;
  if (len < 0.3) return;
  const F = mul(M, tm(x0, 0, 0));
  if (kind === 'picket') addPicketFence(ctx.b, F, len, color);
  else if (kind === 'hedge') ctx.b.add('foliage', hedgeGeo(len, 0.95, 0.7, seed), F, GREENS[seed % GREENS.length], 'box');
  else if (kind === 'wall') {
    ctx.b.add('brick', boxGeo(len, 0.55, 0.3), mul(F, tm(len / 2, 0, 0)), '#ffffff');
    ctx.b.add('concrete', boxGeo(len + 0.04, 0.07, 0.38), mul(F, tm(len / 2, 0.55, 0)), '#cfc9bd');
    for (const x of [0, len]) {
      ctx.b.add('brick', boxGeo(0.42, 0.78, 0.42), mul(F, tm(x, 0, 0)), '#ffffff');
      ctx.b.add('concrete', boxGeo(0.5, 0.08, 0.5), mul(F, tm(x, 0.78, 0)), '#cfc9bd');
    }
  }
}

/** Runs a fence along +x from a to b in frame M, leaving gaps. */
function fenceWithGaps(ctx: HouseCtx, M: THREE.Matrix4, kind: FenceKind, a: number, b: number, gaps: [number, number][], color: THREE.ColorRepresentation, seed: number) {
  const sorted = gaps.filter(([g0, g1]) => g1 > a && g0 < b).sort((p, q) => p[0] - q[0]);
  let x = a;
  for (const [g0, g1] of sorted) {
    fenceRun(ctx, M, kind, x, Math.max(x, g0), color, seed++);
    x = Math.max(x, g1);
  }
  fenceRun(ctx, M, kind, x, b, color, seed);
}

export function addMailbox(b: Batch, M: THREE.Matrix4, color: THREE.ColorRepresentation) {
  b.add('trim', boxGeo(0.09, 1.02, 0.09), M, '#7a5a3a');
  b.add('trim', boxGeo(0.22, 0.14, 0.46), mul(M, tm(0, 1.02, 0.04)), color);
  b.add('trim', new THREE.CylinderGeometry(0.11, 0.11, 0.46, 12, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2), mul(M, tm(0, 1.16, 0.04)), color);
  b.add('trim', boxGeo(0.02, 0.2, 0.06), mul(M, tm(0.12, 1.08, -0.08)), '#d03a2f');
}

export function addDoghouse(b: Batch, M: THREE.Matrix4, wall: THREE.ColorRepresentation, roof: THREE.ColorRepresentation) {
  const w = 0.95, d = 1.15, h = 0.62;
  b.add('siding', boxGeo(w, h, d), mul(M, tm(0, 0.04, -d / 2)), wall);
  const wm = new MeshBuilder(), rm = new MeshBuilder(), tr = new MeshBuilder();
  const R = h + 0.04 + 0.42;
  wm.poly([V(-w / 2, h + 0.04, 0), V(w / 2, h + 0.04, 0), V(0, R, 0)]);
  wm.poly([V(w / 2, h + 0.04, -d), V(-w / 2, h + 0.04, -d), V(0, R, -d)]);
  rm.slab([V(-w / 2 - 0.12, h - 0.04, -d - 0.1), V(-w / 2 - 0.12, h - 0.04, 0.12), V(0, R + 0.06, 0.12), V(0, R + 0.06, -d - 0.1)], 0.06, tr);
  rm.slab([V(w / 2 + 0.12, h - 0.04, 0.12), V(w / 2 + 0.12, h - 0.04, -d - 0.1), V(0, R + 0.06, -d - 0.1), V(0, R + 0.06, 0.12)], 0.06, tr);
  b.add('siding', wm.geometry(), M, wall, 'keep');
  b.add('trim', rm.geometry(), M, roof, 'keep');
  b.add('trim', tr.geometry(), M, '#f6f3ea', 'keep');
  const door = new THREE.Shape();
  door.moveTo(-0.2, 0); door.lineTo(0.2, 0); door.lineTo(0.2, 0.32); door.absarc(0, 0.32, 0.2, 0, Math.PI, false); door.lineTo(-0.2, 0);
  b.add('trim', new THREE.ShapeGeometry(door, 10), mul(M, tm(0, 0.06, 0.005)), '#1d1612');
  b.add('trim', boxGeo(0.34, 0.1, 0.02), mul(M, tm(0, 0.72, 0.01)), '#8a5a32');
}

export interface LotOptions {
  W: number;
  D: number;
  offset: number;
  seed: number;
  /** which end of the lot (in lot x) is on a side street: -1, +1 or 0 */
  streetSide: -1 | 0 | 1;
  rot: number;
  blockers: Blocker[];
}

/** A house lot in the street frame Ms (street edge on z = 0, lot towards -z): house, yard, fence, path, mailbox. */
export function buildLot(ctx: LotCtx, Ms: THREE.Matrix4, o: LotOptions) {
  const b = ctx.b;
  const M = mul(Ms, tm(o.offset, 0, 0));
  const r = mulberry32(o.seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const xMin = -o.W / 2 + (o.streetSide === -1 ? 1.3 : 0.4);
  const xMax = o.W / 2 - (o.streetSide === 1 ? 1.3 : 0.4);
  const usable = xMax - xMin;
  const gw = 3.5;
  const garage = (usable > 11.5 && r() < 0.62 ? (r() < 0.5 ? -1 : 1) : 0) as -1 | 0 | 1;
  const w = garage ? Math.min(usable - gw - 0.8, 7 + r() * 2.2) : Math.min(usable - 2, 7.4 + r() * 2.2);
  const d = Math.min(o.D - 4.2, 5.3 + r() * 0.9);
  const yard = Math.max(2.6, o.D - 1 - d - 0.5);
  const total = w + (garage ? gw : 0);
  const slack = Math.max(0, usable - total);
  const cx = xMin + total / 2 + slack * (0.2 + r() * 0.6);
  const hx = cx - (garage * gw) / 2;
  const hz = -1 - yard;
  const spec = randomHouseSpec(r, w, d, garage);
  const res = buildHouse(ctx, spec, mul(M, tm(hx, 0, hz)));
  const doorX = hx + res.doorX;
  const gX = hx + garage * (w / 2 + gw / 2);

  // path to the sidewalk
  if (r() < 0.7) b.add('concrete', flatRect(doorX - 0.55, hz + res.stoop - 0.05, doorX + 0.55, 0, 0.015), M, '#d3ccbe');
  else {
    b.add('concrete', flatRect(doorX - 0.55, -1, doorX + 0.55, 0, 0.015), M, '#d3ccbe');
    for (let z = hz + res.stoop + 0.3; z < -1.2; z += 0.62) {
      b.add('concrete', new THREE.CylinderGeometry(0.27, 0.29, 0.05, 12), mul(M, tm(doorX + (r() - 0.5) * 0.15, 0.012, z)), '#bdb5a6');
    }
  }
  o.blockers.push({ x: o.offset + doorX, r: 1.3 });
  if (garage) {
    b.add('concrete', flatRect(gX - 1.5, hz - 0.5, gX + 1.5, 0, 0.012), M, '#c6c1b7');
    o.blockers.push({ x: o.offset + gX, r: 2.1 });
    if (r() < 0.55) {
      const p = V(gX, 0, hz + 1.75).applyMatrix4(M);
      ctx.cars.push({ x: p.x, z: p.z, rot: o.rot + (r() < 0.5 ? 0 : Math.PI), color: pick(CAR_COLORS) });
    }
  }

  // front fence along the property line, and down the side street if there is one
  const fr = r();
  const kind: FenceKind = fr < 0.36 ? 'picket' : fr < 0.62 ? 'hedge' : fr < 0.76 ? 'wall' : 'none';
  const fColor = r() < 0.8 ? '#f6f3ea' : pick(['#dfe9f0', '#f2e5c8', '#e0ecd7']);
  const gaps: [number, number][] = [[doorX - 0.7, doorX + 0.7]];
  if (garage) gaps.push([gX - 1.6, gX + 1.6]);
  const fx0 = -o.W / 2 + (o.streetSide === -1 ? 1.2 : 0), fx1 = o.W / 2 - (o.streetSide === 1 ? 1.2 : 0);
  const FM = mul(M, tm(0, 0, -1.05));
  fenceWithGaps(ctx, FM, kind, fx0, fx1, gaps, fColor, o.seed);
  if (kind === 'picket') {
    for (const sx of [-0.72, 0.72]) {
      b.add('trim', boxGeo(0.12, 1.12, 0.12), mul(FM, tm(doorX + sx, 0, -0.03)), fColor);
      b.add('trim', new THREE.SphereGeometry(0.08, 8, 6), mul(FM, tm(doorX + sx, 1.16, -0.03)), fColor);
    }
    if (r() < 0.75) addPicketFence(b, mul(FM, tm(doorX - 0.66, 0, -0.1, 1.45 + r() * 0.15)), 1.15, fColor, 0.9);
  }
  if (o.streetSide !== 0 && kind !== 'none') {
    const xs = o.streetSide * (o.W / 2 - 1.2);
    const SM = mul(M, tm(xs, 0, -1.05, Math.PI / 2));
    fenceRun(ctx, SM, kind, 0, o.D - 1.2, fColor, o.seed + 7);
  }

  // flower beds along the house front
  const half = spec.porch ? Math.min(w - 0.6, 3.8) / 2 + 0.1 : 1.0;
  addBed(ctx, M, hx - w / 2 + 0.1, hz + 0.1, doorX - half, hz + 0.95, r);
  addBed(ctx, M, doorX + half, hz + 0.1, hx + w / 2 - 0.1, hz + 0.95, r);
  if (kind !== 'hedge' && r() < 0.45) {
    const a = r() < 0.5;
    const x0 = a ? fx0 + 0.3 : doorX + 0.9, x1 = a ? doorX - 0.9 : fx1 - 0.3;
    const gx0 = garage ? gX - 1.7 : 99, gx1 = garage ? gX + 1.7 : 99;
    if (!(x0 < gx1 && x1 > gx0)) addBed(ctx, M, x0, -1.95, x1, -1.25, r);
  }
  if (kind === 'none' && r() < 0.6) {
    for (let k = 0; k < 3; k++) shrub(ctx, M, xMin + 0.8 + r() * (usable - 1.6), -1.8 - r() * (yard - 2.2), 0.6 + r() * 0.5, Math.floor(r() * 999));
  }

  if (r() < 0.85) addMailbox(b, mul(M, tm(doorX + 0.95, 0, -0.55)), pick(['#2d2d30', '#f4f1e8', '#2f4f7f', '#3f6e4a', '#8b2f35']));

  // a small tree in the widest side yard
  const leftSpace = hx - w / 2 - (garage === -1 ? gw : 0) - xMin;
  const rightSpace = xMax - (hx + w / 2 + (garage === 1 ? gw : 0));
  const space = Math.max(leftSpace, rightSpace);
  if (space > 2.4 && r() < 0.7) {
    const tx = leftSpace > rightSpace ? xMin + leftSpace / 2 : xMax - rightSpace / 2;
    const p = V(tx, 0, hz - 0.6).applyMatrix4(M);
    ctx.trees.add(b, space > 3.6 && r() < 0.35 ? 'blossom' : 'small', p.x, p.z, { scale: space > 3.6 ? 0.8 : 0.9 });
  }
}

export const CAR_COLORS = ['#c0392b', '#2e5c9a', '#f4f4f0', '#2b2b2e', '#8fa3ad', '#e0b43a', '#3f7a5a', '#c7c9cc', '#7a2432', '#5a9bd5'];

// =============================================================================
// Points of interest
// =============================================================================

function worldOf(M: THREE.Matrix4, x: number, z: number) {
  const p = V(x, 0, z).applyMatrix4(M);
  return { x: p.x, z: p.z };
}

/** Striped shop awning on a wall (frame M, wall at z = 0), from x0 to x1. */
function addAwning(b: Batch, M: THREE.Matrix4, x0: number, x1: number, yTop: number, depth: number, drop: number, colA: THREE.ColorRepresentation, colB: THREE.ColorRepresentation) {
  const n = Math.max(2, Math.round((x1 - x0) / 0.36));
  const sw = (x1 - x0) / n;
  const mA = new MeshBuilder(), mB = new MeshBuilder();
  const val = 0.26;
  for (let k = 0; k < n; k++) {
    const mb = k % 2 ? mA : mB;
    const xa = x0 + k * sw, xb = xa + sw, yf = yTop - drop;
    const top = [V(xa, yf, depth), V(xb, yf, depth), V(xb, yTop, 0), V(xa, yTop, 0)];
    mb.poly(top);
    mb.poly([...top].reverse());
    const fr = [V(xa, yf - val, depth), V(xb, yf - val, depth), V(xb, yf, depth), V(xa, yf, depth)];
    mb.poly(fr);
    mb.poly([...fr].reverse());
    // scallop
    const pts: V3[] = [];
    for (let s = 0; s <= 6; s++) {
      const a = Math.PI + (s / 6) * Math.PI;
      pts.push(V(xa + sw / 2 + Math.cos(a) * sw / 2, yf - val + Math.sin(a) * sw * 0.35, depth));
    }
    mb.poly(pts.reverse());
    mb.poly([...pts].reverse());
  }
  for (const x of [x0, x1]) {
    const side = [V(x, yTop - drop, depth), V(x, yTop, 0), V(x, yTop - drop - val, depth)];
    mA.poly(side); mA.poly([...side].reverse());
  }
  b.add('trim', mA.geometry(), M, colA, 'keep');
  b.add('trim', mB.geometry(), M, colB, 'keep');
  b.add('metal', boxGeo(x1 - x0 + 0.1, 0.05, 0.05), mul(M, tm((x0 + x1) / 2, yTop - 0.03, 0.03)), '#3a3a3a');
}

/** Two-sided sign board: atlas face front and back, on a thin board. */
export function signBoard(b: Batch, M: THREE.Matrix4, w: number, h: number, rect: AtlasRect, board: THREE.ColorRepresentation = '#5a3a1e', twoSided = true) {
  b.add('trim', boxGeo(w + 0.08, h + 0.08, 0.05), mul(M, tm(0, -h / 2 - 0.04, 0)), board);
  b.add('facade', atlasQuad(w, h, rect), mul(M, tm(0, 0, 0.027)), 0xffffff, 'keep');
  if (twoSided) b.add('facade', atlasQuad(w, h, rect), mul(M, tm(0, 0, -0.027, Math.PI)), 0xffffff, 'keep');
}

function buildHome(ctx: LotCtx, Ms: THREE.Matrix4, blockers: Blocker[], rot: number) {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(4242);
  const w = 8.6, d = 6.6, hz = -5.2, hx = -1.8;
  const spec: HouseSpec = {
    seed: 777, w, d, stories: 1, wall: 'siding', wallColor: '#f8e3a3', trimColor: '#fdfcf7', roofColor: '#c75a43', accent: '#5b9bd5',
    roof: 'frontGable', pitch: 0.95, porch: true, chimney: true, shutters: true, flowerBoxes: true, garage: 0,
    door: 'homeDoor', window: 0, roundWindow: true, doorSlot: 1,
  };
  const res = buildHouse(ctx, spec, mul(Ms, tm(hx, 0, hz)));
  const doorX = hx + res.doorX;
  const white = '#fdfcf7';
  // picket fence with an arbour over the gate
  const FM = mul(Ms, tm(0, 0, -1.05));
  fenceWithGaps(ctx, FM, 'picket', -12, 12, [[doorX - 0.85, doorX + 0.85], [5.2, 8.0]], white, 9);
  const G = mul(Ms, tm(doorX, 0, -1.05));
  for (const sx of [-0.82, 0.82]) for (const sz of [0.05, -0.45]) b.add('trim', boxGeo(0.1, 2.25, 0.1), mul(G, tm(sx, 0, sz)), white);
  for (const sz of [0.05, -0.45]) b.add('trim', new THREE.TorusGeometry(0.82, 0.05, 6, 20, Math.PI), mul(G, tm(0, 2.25, sz)), white);
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI;
    b.add('trim', boxGeo(0.04, 0.04, 0.62), mul(G, tm(Math.cos(a) * 0.82, 2.23 + Math.sin(a) * 0.82, -0.2 + 0.31)), white);
  }
  const signM = mul(G, tm(0, 2.0, 0.12));
  signBoard(b, signM, 1.15, 0.38, A.homeSign, '#6b4526');
  for (const sx of [-0.35, 0.35]) b.add('metal', boxGeo(0.015, 0.2, 0.015), mul(G, tm(sx, 2.0, 0.12)), '#444');
  // climbing roses over the arbour
  const rose = [FlowerSink.COLORS[0], FlowerSink.COLORS[1], FlowerSink.COLORS[9]];
  for (let k = 0; k < 16; k++) {
    const a = (k / 15) * Math.PI;
    const px = Math.cos(a) * 0.86, py = 2.25 + Math.sin(a) * 0.86;
    shrub(ctx, G, px, -0.2, 0.28, k * 7);
    const blob = mul(G, tm(px, py - 0.12, -0.2));
    b.addClone('foliage', ctx.shrubs[k % ctx.shrubs.length], mul(blob, tm(0, 0, 0, k, 0, 0, 0.3)), GREENS[1], 'box');
    ctx.flowers.scatter(mul(G, tm(px, py, -0.2)), -0.15, -0.3, 0.15, 0.3, 90, r, rose, -0.1, 0.12);
  }
  for (const sx of [-0.82, 0.82]) ctx.flowers.scatter(mul(G, tm(sx, 0, -0.2)), -0.12, -0.3, 0.12, 0.3, 30, r, rose, 0.3, 2.0);
  // stepping stones from the gate to the porch
  for (let z = hz + res.stoop + 0.35, k = 0; z < -1.3; z += 0.6, k++) {
    b.add('concrete', new THREE.CylinderGeometry(0.28, 0.3, 0.05, 12), mul(Ms, tm(doorX + Math.sin(k * 1.7) * 0.12, 0.012, z)), '#c5bba9');
  }
  b.add('concrete', flatRect(doorX - 0.6, -1, doorX + 0.6, 0, 0.015), Ms, '#d3ccbe');
  // side garden with a doghouse
  addDoghouse(b, mul(Ms, tm(-7.0, 0, -3.3, 0.35)), '#fdfcf7', '#c75a43');
  b.add('metal', new THREE.CylinderGeometry(0.13, 0.1, 0.07, 16).translate(0, 0.035, 0), mul(Ms, tm(-6.0, 0, -2.5)), '#c0392b');
  b.add('trim', new THREE.CircleGeometry(0.11, 14).rotateX(-Math.PI / 2).translate(0, 0.06, 0), mul(Ms, tm(-6.0, 0, -2.5)), '#4f8fb0');
  b.add('concrete', flatRect(5.3, -9.5, 7.9, 0, 0.012), Ms, '#cfc8b8');
  addBed(ctx, Ms, -4.9, -2.1, doorX - 1.1, -1.35, r);
  addBed(ctx, Ms, doorX + 1.1, -2.1, 4.9, -1.35, r);
  addBed(ctx, Ms, hx - w / 2, hz + 0.1, doorX - 2.0, hz + 1.0, r);
  addBed(ctx, Ms, doorX + 2.0, hz + 0.1, hx + w / 2, hz + 1.0, r);
  addMailbox(b, mul(Ms, tm(doorX + 1.2, 0, -0.55)), '#d0443a');
  const t = worldOf(Ms, -9.4, -5.6);
  ctx.trees.add(b, 'blossom', t.x, t.z, { scale: 1.0, seed: 3 });
  const t2 = worldOf(Ms, 9.8, -9.0);
  ctx.trees.add(b, 'round', t2.x, t2.z, { scale: 0.85, seed: 11 });
  addBench(b, mul(Ms, tm(-7.2, 0, -8.6, 0.2)), '#b07d4f');
  ctx.cars.push({ ...worldOf(Ms, 6.6, -6.8), rot: rot + Math.PI, color: '#5a9bd5' });
  blockers.push({ x: doorX, r: 1.5 }, { x: 6.6, r: 2 });
}

function buildPetShop(ctx: LotCtx, Ms: THREE.Matrix4, blockers: Blocker[]) {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(99);
  const w = 15, d = 9.4, H = 4.9, fz = -3.6;
  const S = mul(Ms, tm(0, 0, fz));
  const teal = '#1e8a82', cream = '#f2e8d4', frame = '#2e3b3a';
  b.add('concrete', boxGeo(w, H, d), mul(S, tm(0, 0, -d / 2)), cream);
  b.add('concrete', boxGeo(w + 0.1, 0.08, d + 0.1), mul(S, tm(0, H, -d / 2)), '#8d8a84');
  b.add('trim', boxGeo(w + 0.12, 1.5, 0.14), mul(S, tm(0, 3.3, 0)), teal);
  b.add('trim', boxGeo(w + 0.36, 0.16, 0.34), mul(S, tm(0, H - 0.06, 0)), '#fbf8f0');
  b.add('metal', boxGeo(1.4, 0.8, 1.1), mul(S, tm(3.5, H + 0.08, -5)), '#b9bcbf');
  b.add('metal', boxGeo(1.1, 0.7, 0.9), mul(S, tm(-4, H + 0.08, -3.5)), '#b9bcbf');
  // storefront
  b.add('trim', boxGeo(2.2, 2.8, 0.1), mul(S, tm(0, 0, 0.02)), frame);
  b.add('facade', atlasQuad(1.9, 2.6, A.glassDoor), mul(S, tm(0, 1.32, 0.075)), 0xffffff, 'keep');
  for (const sx of [-1, 1]) {
    const x = sx * 4.25;
    b.add('trim', boxGeo(5.3, 2.62, 0.1), mul(S, tm(x, 0.42, 0.02)), frame);
    b.add('facade', atlasQuad(5.0, 2.35, A.petWindow), mul(S, tm(x, 0.55 + 1.175, 0.075)), 0xffffff, 'keep');
    b.add('trim', boxGeo(5.3, 0.46, 0.16), mul(S, tm(x, 0, 0.04)), teal);
    b.add('trim', boxGeo(0.4, 3.0, 0.2), mul(S, tm(sx * 7.3, 0, 0.03)), '#fbf8f0');
  }
  addAwning(b, S, -7.1, 7.1, 3.2, 1.45, 0.55, teal, '#fdf8ee');
  b.add('trim', boxGeo(7.6, 1.36, 0.06), mul(S, tm(0, 3.37, 0.08)), '#fdf8ee');
  b.add('facade', atlasQuad(7.4, 1.27, A.petSign), mul(S, tm(0, 4.05, 0.115)), 0xffffff, 'keep');
  // forecourt: paving, planters, bench, chalkboard, water bowl
  b.add('concrete', flatRect(-12, fz, 12, 0, 0.012), Ms, '#dcd6ca');
  for (const sx of [-1.75, 1.75]) {
    b.add('brick', boxGeo(0.9, 0.5, 0.9), mul(S, tm(sx, 0, 0.8)), '#ffffff');
    shrub(ctx, S, sx, 0.8, 0.75, 31, '#4f8a39');
  }
  ctx.flowers.scatter(mul(S, tm(0, 0.5, 0.8)), -2.1, -0.4, -1.4, 0.4, 40, r);
  ctx.flowers.scatter(mul(S, tm(0, 0.5, 0.8)), 1.4, -0.4, 2.1, 0.4, 40, r);
  addBench(b, mul(S, tm(-5, 0, 1.3)), '#9a6a3f');
  const C = mul(S, tm(4.2, 0, 1.4, -0.3));
  for (const sz of [1, -1]) {
    const lean = mul(C, tm(0, 0, sz * 0.18, sz < 0 ? Math.PI : 0, -0.22));
    b.add('facade', atlasQuad(0.62, 0.86, A.chalk), mul(lean, tm(0, 0.47, 0.02)), 0xffffff, 'keep');
    b.add('trim', boxGeo(0.66, 0.92, 0.03), mul(lean, tm(0, 0.02, 0)), '#6b4526');
  }
  b.add('metal', new THREE.CylinderGeometry(0.15, 0.11, 0.08, 18).translate(0, 0.04, 0), mul(S, tm(1.15, 0, 0.45)), '#c9ccd0');
  b.add('trim', new THREE.CircleGeometry(0.12, 16).rotateX(-Math.PI / 2).translate(0, 0.075, 0), mul(S, tm(1.15, 0, 0.45)), '#4f8fb0');
  for (const sx of [-9, 9]) {
    const t = worldOf(Ms, sx, -0.7);
    b.add('metal', boxGeo(1.2, 0.02, 1.2), mul(Ms, tm(sx, 0, -0.7)), '#3a3a3a');
    ctx.trees.add(b, 'oval', t.x, t.z, { scale: 0.9 });
  }
  // hedges along the sides of the lot
  for (const sx of [-11.6, 11.6]) b.add('foliage', hedgeGeo(8, 1.1, 0.8, 5), mul(Ms, tm(sx, 0, -3.8, Math.PI / 2)), GREENS[2], 'box');
  blockers.push({ x: -9, r: 1.2 }, { x: 9, r: 1.2 });
}

function buildGym(ctx: LotCtx, Ms: THREE.Matrix4, blockers: Blocker[], flags: THREE.BufferGeometry[]) {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(55);
  const w = 18, d = 14.5, Hw = 6.2, rise = 2.8, fz = -6;
  const G = mul(Ms, tm(0, 0, fz));
  const panel = '#f3ecdc', blue = '#2a4d9e';
  b.add('brick', boxGeo(w, 1.3, d), mul(G, tm(0, 0, -d / 2)), '#f6ece6');
  b.add('concrete', boxGeo(w, Hw - 1.3, d), mul(G, tm(0, 1.3, -d / 2)), panel);
  b.add('trim', boxGeo(w + 0.06, 0.3, d + 0.06), mul(G, tm(0, Hw - 0.5, -d / 2)), blue);
  // arched gable walls and barrel roof
  const Rr = (w * w / 4 + rise * rise) / (2 * rise);
  const arc: [number, number][] = [];
  const N = 18;
  for (let k = 0; k <= N; k++) {
    const x = -w / 2 - 0.3 + ((w + 0.6) * k) / N;
    arc.push([x, Hw + Math.sqrt(Math.max(0, Rr * Rr - x * x)) - (Rr - rise)]);
  }
  const wm = new MeshBuilder();
  const front = [V(-w / 2, Hw, 0), V(w / 2, Hw, 0)];
  for (let k = N; k >= 0; k--) { const [x, y] = arc[k]; if (Math.abs(x) <= w / 2) front.push(V(x, y - 0.02, 0)); }
  wm.poly(front);
  const back = front.map((p) => V(-p.x, p.y, -d));
  wm.poly(back);
  b.add('concrete', wm.geometry(), G, panel, 'keep');
  const rm = new MeshBuilder(), rt = new MeshBuilder();
  for (let k = 0; k < N; k++) {
    const [xa, ya] = arc[k], [xb, yb] = arc[k + 1];
    rm.slab([V(xa, ya + 0.1, 0.6), V(xb, yb + 0.1, 0.6), V(xb, yb + 0.1, -d - 0.6), V(xa, ya + 0.1, -d - 0.6)].reverse(), 0.18, rt);
  }
  b.add('metal', rm.geometry(), G, '#7f9fc4', 'keep');
  b.add('trim', rt.geometry(), G, '#f4f4f0', 'keep');
  // glass entrance, doors, canopy
  b.add('trim', boxGeo(8.8, 4.5, 0.1), mul(G, tm(0, 0, 0.02)), '#4c535a');
  b.add('facade', atlasQuad(8.4, 4.2, A.gymGlass), mul(G, tm(0, 2.2, 0.075)), 0xffffff, 'keep');
  for (const sx of [-0.85, 0.85]) b.add('facade', atlasQuad(1.6, 2.6, A.glassDoor), mul(G, tm(sx, 1.35, 0.09)), 0xffffff, 'keep');
  const cm = new MeshBuilder(), ct = new MeshBuilder();
  cm.slab([V(-4.8, 3.25, 2.6), V(4.8, 3.25, 2.6), V(4.8, 3.3, 0), V(-4.8, 3.3, 0)], 0.25, ct);
  b.add('trim', cm.geometry(), G, '#f4f4f0', 'keep');
  b.add('trim', ct.geometry(), G, '#f4f4f0', 'keep');
  for (const sx of [-4.4, 4.4]) b.add('metal', cylGeo(0.09, 0.09, 3.05, 12), mul(G, tm(sx, 0, 2.35)), '#d9dcdf');
  b.add('trim', boxGeo(6.6, 0.75, 0.06), mul(G, tm(0, 4.45, 0.06)), '#f4f4f0');
  b.add('facade', atlasQuad(6.4, 0.69, A.gymSub), mul(G, tm(0, 4.82, 0.1)), 0xffffff, 'keep');
  b.add('trim', boxGeo(5.0, 1.7, 0.08), mul(G, tm(0, Hw + 0.02, 0.05)), '#f4f4f0');
  b.add('facade', atlasQuad(4.8, 1.56, A.gymSign), mul(G, tm(0, Hw + 0.87, 0.1)), 0xffffff, 'keep');
  // banners either side of the entrance
  [[-5.7, 0], [-7.6, 1], [5.7, 2], [7.6, 0]].forEach(([x, k]) => {
    b.add('facade', atlasQuad(1.0, 3.0, A['banner' + k]), mul(G, tm(x, 3.4, 0.08)), 0xffffff, 'keep');
    b.add('metal', boxGeo(1.2, 0.05, 0.05), mul(G, tm(x, 4.9, 0.1)), '#3a3a3a');
  });
  // clerestory windows on the sides
  for (const side of [-1, 1]) {
    const Fr = mul(G, tm((side * w) / 2, 0, -d / 2, (side * Math.PI) / 2));
    b.add('trim', boxGeo(10.4, 1.4, 0.08), mul(Fr, tm(0, 4.1, 0)), '#4c535a');
    b.add('facade', atlasQuad(10, 1.2, A.gymGlass), mul(Fr, tm(0, 4.8, 0.05)), 0xffffff, 'keep');
  }
  // plaza with planters, benches and flag poles
  b.add('concrete', flatRect(-12, fz, 12, 0, 0.012), Ms, '#dcd6ca');
  for (const sx of [-6.8, 6.8]) {
    b.add('brick', boxGeo(2.4, 0.5, 1.0), mul(G, tm(sx, 0, 1.6)), '#ffffff');
    for (const dx of [-0.6, 0.6]) shrub(ctx, G, sx + dx, 1.6, 0.7, 13 + Math.round(dx * 10), '#4f8a39');
    ctx.flowers.scatter(mul(G, tm(sx, 0.5, 1.6)), -1.1, -0.4, 1.1, 0.4, 30, r);
  }
  addBench(b, mul(G, tm(-9.5, 0, 2.8, Math.PI / 2)), '#9a6a3f');
  const flagRects = [A.flagPaw, A.flagBone, A.flagStripe];
  [-2.4, 0, 2.4].forEach((dx, k) => {
    const x = 9.3 + dx * 0.55, z = 3.9 - Math.abs(dx) * 0.3;
    const P = mul(G, tm(x, 0, z));
    b.add('metal', cylGeo(0.035, 0.055, 7.2 - Math.abs(dx) * 0.3, 10), P, '#eeeeea');
    b.add('metal', new THREE.SphereGeometry(0.08, 10, 8).translate(0, 7.25 - Math.abs(dx) * 0.3, 0), P, '#e2b13c');
    b.add('concrete', cylGeo(0.3, 0.34, 0.2, 14), P, '#bdb7ab');
    flags.push(flagGeo(1.5, 1.0, mul(P, tm(0.04, 7.1 - Math.abs(dx) * 0.3, 0, -Math.PI / 2 + 0.4)), 0xffffff, flagRects[k], k * 1.7));
  });
  for (const [x, z] of [[-10.5, -12], [10.5, -12], [-10.2, -20], [10.3, -21.5], [0, -22.4]]) {
    const t = worldOf(Ms, x, z);
    ctx.trees.add(b, x === 0 ? 'conifer' : 'round', t.x, t.z);
  }
  for (const sx of [-11.6, 11.6]) b.add('foliage', hedgeGeo(10, 1.1, 0.8, 8), mul(Ms, tm(sx, 0, -3.5, Math.PI / 2)), GREENS[1], 'box');
  blockers.push({ x: -12, r: 0 });
}

function buildKennel(ctx: LotCtx, Ms: THREE.Matrix4, blockers: Blocker[]) {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(31);
  const w = 9.6, d = 8.6, Hw = 3.3, bx = -4.2, fz = -4.4;
  const K = mul(Ms, tm(bx, 0, fz));
  const red = '#b43a2f', white = '#f6f3ea';
  b.add('concrete', boxGeo(w + 0.1, 0.3, d + 0.1), mul(K, tm(0, 0, -d / 2)), '#a9a49a');
  const wm = new MeshBuilder(), rm = new MeshBuilder(), rt = new MeshBuilder();
  const kx = w * 0.3, ky = Hw + 1.9, top = Hw + 2.9;
  wm.poly([V(-w / 2, 0.3, 0), V(w / 2, 0.3, 0), V(w / 2, Hw, 0), V(kx, ky, 0), V(0, top, 0), V(-kx, ky, 0), V(-w / 2, Hw, 0)]);
  wm.poly([V(w / 2, 0.3, -d), V(-w / 2, 0.3, -d), V(-w / 2, Hw, -d), V(-kx, ky, -d), V(0, top, -d), V(kx, ky, -d), V(w / 2, Hw, -d)]);
  wm.poly([V(w / 2, 0.3, 0), V(w / 2, 0.3, -d), V(w / 2, Hw, -d), V(w / 2, Hw, 0)]);
  wm.poly([V(-w / 2, 0.3, -d), V(-w / 2, 0.3, 0), V(-w / 2, Hw, 0), V(-w / 2, Hw, -d)]);
  b.add('siding', wm.geometry(), K, red, 'keep');
  const oz = 0.4, lift = 0.1;
  const L = (x: number, y: number, z: number) => V(x, y + lift, z);
  const e = Hw - 0.25;
  for (const s of [-1, 1]) {
    rm.slab(orient([L(s * (w / 2 + 0.28), e, oz), L(s * (w / 2 + 0.28), e, -d - oz), L(s * kx, ky, -d - oz), L(s * kx, ky, oz)]), 0.15, rt);
    rm.slab(orient([L(s * kx, ky, oz), L(s * kx, ky, -d - oz), L(0, top, -d - oz), L(0, top, oz)]), 0.15, rt);
  }
  b.add('roof', rm.geometry(), K, '#55585f', 'keep');
  b.add('trim', rt.geometry(), K, white, 'keep');
  for (const [x, z] of [[-w / 2, 0], [w / 2, 0], [-w / 2, -d], [w / 2, -d]]) b.add('trim', boxGeo(0.18, Hw - 0.3, 0.18), mul(K, tm(x, 0.3, z)), white);
  b.add('trim', boxGeo(3.1, 3.05, 0.08), mul(K, tm(0, 0.28, 0.02)), white);
  b.add('facade', atlasQuad(2.8, 2.8, A.barnDoor), mul(K, tm(0, 0.3 + 1.4, 0.065)), 0xffffff, 'keep');
  b.add('trim', boxGeo(1.4, 1.4, 0.08), mul(K, tm(0, Hw + 0.35, 0.02)), white);
  b.add('facade', atlasQuad(1.2, 1.2, A.hayloft), mul(K, tm(0, Hw + 0.95, 0.065)), 0xffffff, 'keep');
  b.add('trim', boxGeo(2.9, 0.92, 0.07), mul(K, tm(0, 2.92, 0.05)), '#6b4526');
  b.add('facade', atlasQuad(2.75, 0.84, A.kennelSign), mul(K, tm(0, 3.38, 0.09)), 0xffffff, 'keep');
  for (const side of [-1, 1]) {
    const Fr = mul(K, tm((side * w) / 2, 0, -d / 2, (side * Math.PI) / 2));
    for (const x of [-2.2, 2.2]) addWindow(ctx, Fr, x, 1.1, 1.0, 1.1, A.win2, white);
  }
  // weathervane
  const V0 = mul(K, tm(0, top + lift + 0.05, -0.8));
  b.add('metal', cylGeo(0.02, 0.02, 1.0, 6), V0, '#2b2b2b');
  b.add('metal', boxGeo(0.9, 0.03, 0.03), mul(V0, tm(0, 0.75, 0)), '#2b2b2b');
  b.add('metal', new THREE.ConeGeometry(0.07, 0.2, 6).rotateZ(-Math.PI / 2), mul(V0, tm(0.5, 0.765, 0)), '#2b2b2b');
  b.add('metal', boxGeo(0.35, 0.18, 0.02), mul(V0, tm(-0.28, 0.83, 0)), '#2b2b2b');
  // gravel drive and hay bales
  b.add('concrete', flatRect(bx - 1.7, fz, bx + 1.7, 0, 0.012), Ms, '#bcae95');
  for (const [x, z] of [[bx - 3.3, fz + 0.9], [bx - 3.3, fz + 2.1]]) {
    b.add('concrete', new THREE.CylinderGeometry(0.55, 0.55, 0.9, 16).rotateZ(Math.PI / 2).translate(0, 0.55, 0), mul(Ms, tm(x, 0, z, 0.1)), '#d8bf73');
  }
  // fenced dog run with little houses
  const rx0 = 2.2, rx1 = 11.2, rz0 = -11.2, rz1 = -2.2;
  const run = mul(Ms, tm(0, 0, 0));
  fenceWithGaps(ctx, mul(run, tm(0, 0, rz1)), 'picket', rx0, rx1, [[5.6, 6.8]], white, 3);
  fenceRun(ctx, mul(run, tm(rx0, 0, rz0, -Math.PI / 2 + Math.PI)), 'picket', 0, rz1 - rz0, white, 4);
  fenceRun(ctx, mul(run, tm(rx1, 0, rz1, Math.PI / 2)), 'picket', 0, rz1 - rz0, white, 5);
  fenceRun(ctx, mul(run, tm(rx0, 0, rz0)), 'picket', 0, rx1 - rx0, white, 6);
  addDoghouse(b, mul(Ms, tm(4.0, 0, -9.3, 0.3)), '#f2d98d', '#3f6e4a');
  addDoghouse(b, mul(Ms, tm(8.8, 0, -9.4, -0.25)), '#a9c8e0', '#b43a2f');
  b.add('metal', new THREE.CylinderGeometry(0.14, 0.1, 0.07, 16).translate(0, 0.035, 0), mul(Ms, tm(6.4, 0, -5.5)), '#2f6fb0');
  b.add('trim', new THREE.SphereGeometry(0.035, 10, 8).translate(0, 0.035, 0), mul(Ms, tm(7.2, 0, -4.4)), '#d7e04a');
  // roadside sign on posts
  const SP = mul(Ms, tm(-9.2, 0, -1.6));
  for (const sx of [-0.85, 0.85]) b.add('trim', boxGeo(0.1, 1.55, 0.1), mul(SP, tm(sx, 0, 0)), '#6b4526');
  signBoard(b, mul(SP, tm(0, 1.25, 0)), 1.9, 0.58, A.kennelSign, '#6b4526');
  addBed(ctx, Ms, -11.6, -2.2, -10.4, -1.3, r);
  const t = worldOf(Ms, -10.2, -8.5);
  ctx.trees.add(b, 'oval', t.x, t.z);
  blockers.push({ x: bx, r: 2.0 }, { x: -9.2, r: 1.2 });
}

/** Keeps a roof quad's winding so its normal points up. */
function orient(pts: V3[]): V3[] {
  return polyNormal(pts).y < 0 ? [...pts].reverse() : pts;
}

function buildSecondhand(ctx: LotCtx, Ms: THREE.Matrix4, blockers: Blocker[]) {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(71);
  const w = 12, d = 9, Hw = 7.2, fz = -3.0;
  const S = mul(Ms, tm(0, 0, fz));
  const green = '#2f5d4a', cream = '#efe6d2';
  b.add('brick', boxGeo(w, Hw, d), mul(S, tm(0, 0, -d / 2)), '#ffffff');
  b.add('trim', boxGeo(w + 0.5, 0.38, 0.5), mul(S, tm(0, Hw - 0.12, 0)), cream);
  b.add('trim', boxGeo(w + 0.3, 0.14, 0.3), mul(S, tm(0, Hw - 0.42, 0)), cream);
  for (let x = -w / 2 + 0.3; x <= w / 2 - 0.3; x += 0.5) b.add('trim', boxGeo(0.14, 0.14, 0.2), mul(S, tm(x, Hw - 0.3, 0.1)), cream);
  b.add('concrete', boxGeo(w, 0.06, d), mul(S, tm(0, Hw, -d / 2)), '#77736d');
  // shopfront
  b.add('trim', boxGeo(w - 0.3, 3.75, 0.14), mul(S, tm(0, 0, 0.02)), green);
  b.add('facade', atlasQuad(5.6, 1.85, A.secondWindow), mul(S, tm(-2.3, 0.65 + 0.925, 0.095)), 0xffffff, 'keep');
  b.add('trim', boxGeo(5.9, 0.6, 0.18), mul(S, tm(-2.3, 0, 0.05)), '#234a3a');
  b.add('trim', boxGeo(5.9, 0.08, 0.26), mul(S, tm(-2.3, 0.6, 0.08)), cream);
  b.add('facade', atlasQuad(1.1, 2.34, A.shopDoor), mul(S, tm(3.3, 1.2, 0.095)), 0xffffff, 'keep');
  b.add('concrete', boxGeo(1.5, 0.12, 0.5), mul(S, tm(3.3, 0, 0.3)), '#bdb7ab');
  for (const x of [-w / 2 + 0.25, 1.9, w / 2 - 0.25]) {
    b.add('trim', boxGeo(0.34, 3.85, 0.24), mul(S, tm(x, 0, 0.06)), green);
    b.add('trim', boxGeo(0.46, 0.14, 0.3), mul(S, tm(x, 3.75, 0.06)), cream);
  }
  b.add('facade', atlasQuad(8.0, 1.06, A.secondSign), mul(S, tm(0, 3.05, 0.1)), 0xffffff, 'keep');
  addAwning(b, S, -5.3, 0.7, 2.52, 1.25, 0.5, green, '#f3ead3');
  // arched upper windows
  const arch = new THREE.Shape();
  arch.moveTo(-0.55, 0); arch.lineTo(0.55, 0); arch.lineTo(0.55, 1.45); arch.absarc(0, 1.45, 0.55, 0, Math.PI, false); arch.lineTo(-0.55, 0);
  for (const x of [-3.6, 0, 3.6]) {
    b.add('trim', boxGeo(1.44, 2.25, 0.05), mul(S, tm(x, 4.25, 0)), cream);
    b.add('facade', atlasShape(arch, A.archWin, 12), mul(S, tm(x, 4.35, 0.04)), 0xffffff, 'keep');
    b.add('trim', boxGeo(1.5, 0.08, 0.18), mul(S, tm(x, 4.25, 0.06)), cream);
    b.add('trim', boxGeo(0.22, 0.3, 0.1), mul(S, tm(x, 6.3, 0.04)), cream);
  }
  // hanging blade sign
  const BS = mul(S, tm(w / 2 - 0.9, 0, 0));
  b.add('metal', boxGeo(0.05, 0.05, 1.0), mul(BS, tm(0, 4.1, 0.5)), '#222');
  b.add('metal', boxGeo(0.03, 0.4, 0.03), mul(BS, tm(0, 3.72, 0.02, 0, -0.9)), '#222');
  const disc = new THREE.Shape().absarc(0, 0, 0.4, 0, Math.PI * 2, false);
  for (const s of [1, -1]) b.add('facade', atlasShape(disc, A.bladeSign, 24), mul(BS, tm(s * 0.02, 3.62, 0.72, (s * Math.PI) / 2)), 0xffffff, 'keep');
  b.add('trim', new THREE.CylinderGeometry(0.42, 0.42, 0.035, 24).rotateZ(Math.PI / 2), mul(BS, tm(0, 3.62, 0.72)), '#23483a');
  for (const sx of [-0.2, 0.2]) b.add('metal', boxGeo(0.01, 0.1, 0.01), mul(BS, tm(0, 4.0, 0.72 + sx)), '#222');
  // forecourt props
  b.add('concrete', flatRect(-12, fz, 12, 0, 0.012), Ms, '#cfc6b6');
  const crate = '#a47a4b';
  b.add('trim', boxGeo(0.6, 0.4, 0.45), mul(S, tm(-5.3, 0, 0.6, 0.1)), crate);
  b.add('trim', boxGeo(0.6, 0.4, 0.45), mul(S, tm(-4.65, 0, 0.55, -0.05)), crate);
  b.add('trim', boxGeo(0.55, 0.38, 0.42), mul(S, tm(-5.0, 0.4, 0.58, 0.2)), '#b88c58');
  b.add('trim', cylGeo(0.3, 0.26, 0.55, 16), mul(S, tm(1.25, 0, 0.55)), '#7a5230');
  shrub(ctx, S, 1.25, 0.55, 0.5, 44, '#4f8a39');
  ctx.flowers.scatter(mul(S, tm(1.25, 0.55, 0.55)), -0.25, -0.25, 0.25, 0.25, 90, r, undefined, 0.05, 0.25);
  addBench(b, mul(S, tm(-1.4, 0, 1.2)), '#6d4a2c', '#23483a');
  b.add('trim', boxGeo(0.34, 0.5, 0.34), mul(S, tm(4.5, 0, 0.5)), '#d8cbb0');
  shrub(ctx, S, 4.5, 0.5, 0.5, 45);
  for (const [x, z] of [[-10, -0.7], [10, -0.7]]) {
    const t = worldOf(Ms, x, z);
    b.add('metal', boxGeo(1.2, 0.02, 1.2), mul(Ms, tm(x, 0, z)), '#3a3a3a');
    ctx.trees.add(b, 'round', t.x, t.z, { scale: 0.85 });
  }
  for (const sx of [-11.6, 11.6]) b.add('foliage', hedgeGeo(7, 1.0, 0.8, 9), mul(Ms, tm(sx, 0, -3.8, Math.PI / 2)), GREENS[3], 'box');
  blockers.push({ x: -10, r: 1.2 }, { x: 10, r: 1.2 });
}

function buildParkBlock(ctx: LotCtx, Ms: THREE.Matrix4, water: THREE.BufferGeometry[]) {
  const b = ctx.b, A = ctx.atlas.rects;
  const r = mulberry32(12);
  const x0 = -11, x1 = 11, z0 = -23, z1 = -1, gh = 1.5;
  const iron = '#232826';
  const post = (x: number, z: number) => addFencePost(b, mul(Ms, tm(x, 0, z)), 1.45, iron);
  const run = (xa: number, za: number, xb: number, zb: number) => {
    const len = Math.hypot(xb - xa, zb - za);
    const ang = Math.atan2(-(zb - za), xb - xa);
    const n = Math.max(1, Math.round(len / 2.6));
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const px = xa + (xb - xa) * t0, pz = za + (zb - za) * t0;
      addIronFence(b, mul(Ms, tm(px, 0, pz, ang)), len / n, 1.3, iron);
      post(px, pz);
    }
    post(xb, zb);
  };
  run(x0, z1, -gh - 0.3, z1);
  run(gh + 0.3, z1, x1, z1);
  run(x1, z1, x1, z0);
  run(x1, z0, x0, z0);
  run(x0, z0, x0, z1);
  // gate: brick pillars, iron arch and the park sign
  for (const sx of [-1, 1]) {
    const P = mul(Ms, tm(sx * (gh + 0.3), 0, z1));
    b.add('brick', boxGeo(0.55, 1.9, 0.55), P, '#ffffff');
    b.add('concrete', boxGeo(0.68, 0.1, 0.68), mul(P, tm(0, 1.9, 0)), '#cfc9bd');
    b.add('concrete', new THREE.SphereGeometry(0.16, 12, 8).translate(0, 2.12, 0), P, '#cfc9bd');
    // open gate leaves
    const L = mul(P, tm(-sx * 0.3, 0, -0.05, sx * 1.25 + (sx < 0 ? Math.PI : 0)));
    addIronFence(b, L, 1.3, 1.25, iron);
  }
  b.add('metal', new THREE.TorusGeometry(gh + 0.3, 0.05, 6, 28, Math.PI), mul(Ms, tm(0, 1.95, z1)), iron);
  b.add('metal', new THREE.TorusGeometry(gh + 0.1, 0.03, 6, 28, Math.PI), mul(Ms, tm(0, 1.95, z1)), iron);
  for (const sx of [-0.6, 0.6]) b.add('metal', boxGeo(0.015, 0.4, 0.015), mul(Ms, tm(sx, 2.95, z1)), iron);
  signBoard(b, mul(Ms, tm(0, 2.92, z1)), 1.8, 0.45, A.parkSign, '#1f3f27');
  // hedges inside the fence
  const hedge = (xa: number, za: number, len: number, ang: number, seed: number) => b.add('foliage', hedgeGeo(len, 0.85, 0.7, seed), mul(Ms, tm(xa, 0, za, ang)), GREENS[seed % 5], 'box');
  hedge(x0 + 0.6, z1 - 0.6, 7.5, 0, 1);
  hedge(3.1, z1 - 0.6, 7.5, 0, 2);
  hedge(x0 + 0.6, z0 + 0.6, 20.8, 0, 3);
  hedge(x0 + 0.6, z0 + 1.2, 18, Math.PI / 2 * -1 + Math.PI, 4);
  hedge(x1 - 0.6, z1 - 1.2, 20.6, Math.PI / 2, 5);
  // paths and fountain
  const sand = '#d9c9a5';
  b.add('concrete', flatRect(-1.1, -8.4, 1.1, z1 + 0.02, 0.014), Ms, sand);
  b.add('concrete', new THREE.RingGeometry(3.1, 4.4, 40).rotateX(-Math.PI / 2).translate(0, 0.014, 0), mul(Ms, tm(0, 0, -12)), sand);
  const Fm = mul(Ms, tm(0, 0, -12));
  b.add('concrete', new THREE.CylinderGeometry(2.5, 2.6, 0.5, 36, 1, true).translate(0, 0.25, 0), Fm, '#d2cbbd');
  b.add('concrete', new THREE.CylinderGeometry(2.25, 2.25, 0.5, 36, 1, true).translate(0, 0.25, 0), Fm, '#d2cbbd');
  b.add('concrete', new THREE.RingGeometry(2.25, 2.5, 36).rotateX(-Math.PI / 2).translate(0, 0.5, 0), Fm, '#e1dace');
  b.add('concrete', cylGeo(0.25, 0.35, 1.3, 16), Fm, '#d2cbbd');
  b.add('concrete', new THREE.CylinderGeometry(0.9, 0.3, 0.3, 24).translate(0, 1.4, 0), Fm, '#d2cbbd');
  b.add('concrete', new THREE.SphereGeometry(0.16, 12, 8).translate(0, 1.72, 0), Fm, '#d2cbbd');
  water.push(prepGeometry(new THREE.CircleGeometry(2.25, 36).rotateX(-Math.PI / 2).translate(0, 0.38, 0), Fm, 0xffffff, 'keep'));
  water.push(prepGeometry(new THREE.CircleGeometry(0.85, 24).rotateX(-Math.PI / 2).translate(0, 1.52, 0), Fm, 0xffffff, 'keep'));
  for (const [x, z, a] of [[-5.3, -12, Math.PI / 2], [5.3, -12, -Math.PI / 2], [0, -17.3, 0]] as const) addBench(b, mul(Ms, tm(x, 0, z, a)));
  addStreetLamp(b, mul(Ms, tm(-3.2, 0, -8.2, Math.PI * 0.75)));
  addStreetLamp(b, mul(Ms, tm(3.2, 0, -15.8, -Math.PI * 0.25)));
  addBed(ctx, Ms, -6.4, -4.4, -2.2, -2.8, r);
  addBed(ctx, Ms, 2.2, -4.4, 6.4, -2.8, r);
  for (const [x, z, k] of [[-7.4, -6.5, 'round'], [7.6, -6.2, 'oval'], [-7.2, -18.4, 'oval'], [7.4, -18.8, 'round'], [-8.2, -12.2, 'conifer'], [8.4, -12.5, 'blossom']] as const) {
    const t = worldOf(Ms, x, z);
    ctx.trees.add(b, k, t.x, t.z, { scale: 1.05 });
  }
}

// =============================================================================
// Streets
// =============================================================================

interface StreetGeom {
  P: number;
  h: number; // half street width
  rw: number; // half roadway width
  cw: number; // curb width
  cross: number; // raised intersection + crosswalk half-extent along each leg
  ramp: number;
  dip: number;
}

/** A road surface running along x (axis 'x') or z, lowered in the middle with ramps up to y = 0 at raised ends. */
function roadStrip(b: Batch, g: StreetGeom, axis: 'x' | 'z', c: number, a0: number, a1: number, ramps: [boolean, boolean]) {
  const as = [a0, a0 + (ramps[0] ? g.ramp : 0), a1 - (ramps[1] ? g.ramp : 0), a1];
  const ys = [ramps[0] ? 0 : -g.dip, -g.dip, -g.dip, ramps[1] ? 0 : -g.dip];
  const P = (a: number, y: number, cc: number) => (axis === 'x' ? V(a, y, cc) : V(cc, y, a));
  const mb = new MeshBuilder();
  for (let k = 0; k < 3; k++) {
    if (as[k + 1] - as[k] < 0.01) continue;
    mb.polyUp([P(as[k], ys[k], c - g.rw), P(as[k + 1], ys[k + 1], c - g.rw), P(as[k + 1], ys[k + 1], c + g.rw), P(as[k], ys[k], c + g.rw)]);
  }
  b.add('asphalt', mb.geometry(), null, 0xffffff, 'box');
}

/** Sidewalk band from the curb (road side, across = cRoad) to the block edge (cOuter), with its curb. */
function sidewalk(b: Batch, g: StreetGeom, axis: 'x' | 'z', a0: number, a1: number, cRoad: number, cOuter: number, curb = true) {
  const sgn = Math.sign(cOuter - cRoad);
  const cIn = curb ? cRoad + sgn * g.cw : cRoad;
  const slab = Math.abs(cOuter - cIn);
  const P = (a: number, cc: number) => (axis === 'x' ? V(a, 0, cc) : V(cc, 0, a));
  const mb = new MeshBuilder();
  mb.polyUp([P(a0, cIn), P(a1, cIn), P(a1, cOuter), P(a0, cOuter)], (p) => {
    const a = axis === 'x' ? p.x : p.z, cc = axis === 'x' ? p.z : p.x;
    return [(a - a0) / slab, Math.abs(cc - cIn) / slab];
  });
  b.add('sidewalk', mb.geometry(), null, 0xffffff, 'keep');
  if (curb) {
    const len = a1 - a0, mid = (a0 + a1) / 2, cc = cRoad + (sgn * g.cw) / 2;
    const geo = axis === 'x' ? boxGeo(len, 0.18, g.cw) : boxGeo(g.cw, 0.18, len);
    b.add('concrete', geo, axis === 'x' ? tm(mid, -0.18, cc) : tm(cc, -0.18, mid), '#dcd8d0');
  }
}

function flatQuad(b: Batch, key: string, x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.ColorRepresentation) {
  b.add(key, flatRect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), y), null, color, 'box');
}

// =============================================================================
// The town
// =============================================================================

type Side = 'n' | 'e' | 's' | 'w';
const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

export function buildTown(layout: TownLayout, renderer: THREE.WebGLRenderer): TownWorld {
  const group = new THREE.Group();
  group.name = 'town';
  const P = pitch(layout);
  const h = layout.street / 2;
  const g: StreetGeom = { P, h, rw: h - layout.sidewalk, cw: 0.2, cross: h - layout.sidewalk + 2.8, ramp: 1.2, dip: 0.12 };
  const X1 = layout.cols * P, Z1 = layout.rows * P;
  // one ring of extra blocks and an outer ring road around the playable grid
  const iMin = -1, iMax = layout.cols + 1, jMin = -1, jMax = layout.rows + 1;
  const outer: Bounds = { minX: iMin * P - h, maxX: iMax * P + h, minZ: jMin * P - h, maxZ: jMax * P + h };

  const kit = createKit();
  const atlas = new Atlas(2048, 2048);
  buildTownAtlas(atlas);
  atlas.material(kit, 'facade');
  kit.mat('water', new THREE.MeshStandardMaterial({ color: '#2f6f86', roughness: 0.04, metalness: 0.1 }));
  // 3 x 3 spatial chunks: frustum culling keeps the main pass and the shadow pass cheap
  const b = new Batch([(outer.maxX - outer.minX) / 3 + 0.01, (outer.maxZ - outer.minZ) / 3 + 0.01], { x: outer.minX, z: outer.minZ });
  b.aliases = { metal: 'trim', paint: 'trim', dirt: 'concrete' };
  b.noCast = new Set(['facade', 'grass', 'sidewalk', 'asphalt']);
  // walls, roofs and ground are cheap: one mesh each; only the heavy materials are chunked
  b.chunked = new Set(['trim', 'foliage', 'leafCard', 'bark']);
  // everything beyond the ring road goes into one unchunked batch
  const far = new Batch(0);
  far.aliases = b.aliases;
  const trees = new TreeFactory(4);
  const flowers = new FlowerSink();
  const shrubs = Array.from({ length: 6 }, (_, k) => shrubGeo(k * 13 + 1, 1, 0.8));
  const cars: CarPlacement[] = [];
  const flagGeos: THREE.BufferGeometry[] = [];
  const waterGeos: THREE.BufferGeometry[] = [];
  const ctx: LotCtx = { b, atlas, flowers, shrubs, trees, cars };

  // ---------------------------------------------------------------- blocks
  const extended = new Set([`w:${1}`, `e:${layout.rows - 1}`, `n:${1}`, `s:${layout.cols - 1}`]);
  for (let c = iMin; c < iMax; c++) {
    for (let r = jMin; r < jMax; r++) {
      const rect = blockRect(c, r, layout);
      const cx = (rect.minX + rect.maxX) / 2, cz = (rect.minZ + rect.maxZ) / 2;
      b.anchor = { x: cx, z: cz };
      b.add('grass', flatRect(rect.minX, rect.minZ, rect.maxX, rect.maxZ, 0), null, 0xffffff, 'box');
      const frames: Record<Side, { M: THREE.Matrix4; rot: number }> = {
        n: { M: tm(cx, 0, rect.minZ, Math.PI), rot: Math.PI },
        e: { M: tm(rect.maxX, 0, cz, Math.PI / 2), rot: Math.PI / 2 },
        s: { M: tm(cx, 0, rect.maxZ, 0), rot: 0 },
        w: { M: tm(rect.minX, 0, cz, -Math.PI / 2), rot: -Math.PI / 2 },
      };
      const blockers: Record<Side, Blocker[]> = { n: [], e: [], s: [], w: [] };
      const seed = Math.floor(hash2(c + 10, r + 10, 77) * 1e6);
      const poi = layout.pois.find((p) => p.col === c && p.row === r);
      const noVergeTrees = new Set<Side>();
      if (!poi) {
        (['n', 'e', 's', 'w'] as Side[]).forEach((side, k) => {
          buildLot(ctx, frames[side].M, { W: 14, D: 10, offset: 5, seed: seed + k * 101, streetSide: 1, rot: frames[side].rot, blockers: blockers[side] });
        });
        const rr = mulberry32(seed);
        for (let k = 0; k < 2; k++) trees.add(b, rr() < 0.6 ? 'round' : rr() < 0.5 ? 'oval' : 'conifer', cx + (rr() - 0.5) * 5, cz + (rr() - 0.5) * 5, { scale: 1.1 + rr() * 0.2 });
      } else {
        const side = poi.side as Side;
        const F = frames[side];
        switch (poi.kind) {
          case 'park': buildParkBlock(ctx, F.M, waterGeos); blockers[side].push({ x: 0, r: 3.2 }); break;
          case 'gym': buildGym(ctx, F.M, blockers[side], flagGeos); noVergeTrees.add(side); break;
          case 'home': buildHome(ctx, F.M, blockers[side], F.rot); break;
          case 'shop': buildPetShop(ctx, F.M, blockers[side]); noVergeTrees.add(side); break;
          case 'kennel': buildKennel(ctx, F.M, blockers[side]); break;
          case 'secondhand': buildSecondhand(ctx, F.M, blockers[side]); noVergeTrees.add(side); break;
        }
        if (poi.kind !== 'park' && poi.kind !== 'gym') {
          const opp = OPPOSITE[side];
          const O = frames[opp];
          for (const [offset, ss] of [[6, 1], [-6, -1]] as const) {
            buildLot(ctx, O.M, { W: 12, D: 12, offset, seed: seed + offset * 13, streetSide: ss, rot: O.rot, blockers: blockers[opp] });
          }
        }
      }
      // verges: street trees, lamps, hydrant
      const rr = mulberry32(seed + 5);
      (['n', 'e', 's', 'w'] as Side[]).forEach((side, k) => {
        const M = frames[side].M;
        const lampX = ((c + r + k) % 2 ? 1 : -1) * (5 + rr() * 2);
        const free = (x: number, pad: number) => !blockers[side].some((bl) => Math.abs(bl.x - x) < bl.r + pad);
        if (free(lampX, 0.3) && !(poi?.kind === 'park' && side !== poi.side)) addStreetLamp(b, mul(M, tm(lampX, 0, -0.35)));
        if (noVergeTrees.has(side)) return;
        for (const base of [-8, 0, 8]) {
          const x = base + (rr() - 0.5) * 2.4;
          if (!free(x, 0.8) || Math.abs(x - lampX) < 2.2) continue;
          const p = worldOf(M, x, -0.5);
          trees.add(b, rr() < 0.65 ? 'round' : 'oval', p.x, p.z, { scale: 0.95 + rr() * 0.15 });
        }
      });
      if (!poi && rr() < 0.5) addHydrant(b, tm(rect.maxX - 0.55, 0, rect.minZ + 0.55));
    }
  }

  // ---------------------------------------------------------------- streets
  const hasLeg = (i: number, j: number, dir: Side) => {
    if (dir === 'w') return i > iMin || extended.has(`w:${j}`);
    if (dir === 'e') return i < iMax || extended.has(`e:${j}`);
    if (dir === 'n') return j > jMin || extended.has(`n:${i}`);
    return j < jMax || extended.has(`s:${i}`);
  };
  const white = '#f1f0ea';
  // no parked cars in front of the shops and the park gate
  const clearZones = layout.pois.map((poi) => {
    const r = blockRect(poi.col, poi.row, layout);
    const m = layout.street + 3;
    switch (poi.side) {
      case 'n': return { minX: r.minX, maxX: r.maxX, minZ: r.minZ - m, maxZ: r.minZ };
      case 's': return { minX: r.minX, maxX: r.maxX, minZ: r.maxZ, maxZ: r.maxZ + m };
      case 'w': return { minX: r.minX - m, maxX: r.minX, minZ: r.minZ, maxZ: r.maxZ };
      default: return { minX: r.maxX, maxX: r.maxX + m, minZ: r.minZ, maxZ: r.maxZ };
    }
  });
  const keepClear = (x: number, z: number) => clearZones.some((q) => x > q.minX - 3 && x < q.maxX + 3 && z > q.minZ - 3 && z < q.maxZ + 3);
  for (let j = jMin; j <= jMax; j++) {
    const z = j * P;
    for (let i = iMin; i < iMax; i++) {
      b.anchor = { x: (i + 0.5) * P, z };
      const a0 = i * P + g.cross, a1 = (i + 1) * P - g.cross;
      roadStrip(b, g, 'x', z, a0, a1, [true, true]);
      if (j > jMin) sidewalk(b, g, 'x', i * P + h, (i + 1) * P - h, z - g.rw, z - h);
      if (j < jMax) sidewalk(b, g, 'x', i * P + h, (i + 1) * P - h, z + g.rw, z + h);
      if (j === jMin) sidewalk(b, g, 'x', i * P + h, (i + 1) * P - h, z - g.rw, z - h);
      if (j === jMax) sidewalk(b, g, 'x', i * P + h, (i + 1) * P - h, z + g.rw, z + h);
      streetDetails(b, g, 'x', z, a0, a1, i * 7 + j * 13, cars, keepClear);
    }
  }
  for (let i = iMin; i <= iMax; i++) {
    const x = i * P;
    for (let j = jMin; j < jMax; j++) {
      b.anchor = { x, z: (j + 0.5) * P };
      const a0 = j * P + g.cross, a1 = (j + 1) * P - g.cross;
      roadStrip(b, g, 'z', x, a0, a1, [true, true]);
      sidewalk(b, g, 'z', j * P + h, (j + 1) * P - h, x - g.rw, x - h);
      sidewalk(b, g, 'z', j * P + h, (j + 1) * P - h, x + g.rw, x + h);
      streetDetails(b, g, 'z', x, a0, a1, i * 11 + j * 5 + 3, cars, keepClear);
    }
  }
  // intersections: raised plus shape, corner squares, crosswalks, missing legs become sidewalk
  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const x = i * P, z = j * P;
      b.anchor = { x, z };
      flatQuad(b, 'asphalt', x - g.rw, z - g.rw, x + g.rw, z + g.rw, 0, 0xffffff);
      for (const s of [-1, 1]) for (const t of [-1, 1]) {
        const mb = new MeshBuilder();
        const xa = x + s * g.rw, xb = x + s * h, za = z + t * g.rw, zb = z + t * h;
        mb.polyUp([V(xa, 0, za), V(xb, 0, za), V(xb, 0, zb), V(xa, 0, zb)], (p) => [Math.abs(p.x - xa) / (h - g.rw), Math.abs(p.z - za) / (h - g.rw)]);
        b.add('sidewalk', mb.geometry(), null, 0xffffff, 'keep');
      }
      for (const dir of ['n', 'e', 's', 'w'] as Side[]) {
        const sx = dir === 'e' ? 1 : dir === 'w' ? -1 : 0, sz = dir === 's' ? 1 : dir === 'n' ? -1 : 0;
        if (hasLeg(i, j, dir)) {
          if (sx) flatQuad(b, 'asphalt', x + sx * g.rw, z - g.rw, x + sx * g.cross, z + g.rw, 0, 0xffffff);
          else flatQuad(b, 'asphalt', x - g.rw, z + sz * g.rw, x + g.rw, z + sz * g.cross, 0, 0xffffff);
          // zebra crossing aligned with the sidewalk it connects
          const c0 = g.rw + 0.25, c1 = h - 0.05;
          for (let k = -3; k <= 3; k++) {
            const o = k * 0.9;
            if (sx) flatQuad(b, 'paint', x + sx * c0, z + o - 0.22, x + sx * c1, z + o + 0.22, 0.012, white);
            else flatQuad(b, 'paint', x + o - 0.22, z + sz * c0, x + o + 0.22, z + sz * c1, 0.012, white);
          }
          if (sx && (i + sx < iMin || i + sx > iMax)) countryRoad(b, g, 'x', z, x + sx * g.cross, x + sx * 420);
          if (sz && (j + sz < jMin || j + sz > jMax)) countryRoad(b, g, 'z', x, z + sz * g.cross, z + sz * 420);
        } else if (sx) {
          sidewalk(b, g, 'z', z - g.rw, z + g.rw, x + sx * g.rw, x + sx * h);
        } else {
          sidewalk(b, g, 'x', x - g.rw, x + g.rw, z + sz * g.rw, z + sz * h);
        }
      }
      if (i >= 0 && i <= layout.cols && j >= 0 && j <= layout.rows) addSignPost(b, atlas, tm(x + h + 0.45, 0, z + h + 0.45), i, j);
    }
  }

  // ---------------------------------------------------------------- surroundings
  b.anchor = null;
  const corridors: [number, number, number, number][] = [];
  for (const key of extended) {
    const [dir, n] = key.split(':');
    const k = Number(n);
    if (dir === 'w') corridors.push([outer.minX, k * P, outer.minX - 500, k * P]);
    if (dir === 'e') corridors.push([outer.maxX, k * P, outer.maxX + 500, k * P]);
    if (dir === 'n') corridors.push([k * P, outer.minZ, k * P, outer.minZ - 500]);
    if (dir === 's') corridors.push([k * P, outer.maxZ, k * P, outer.maxZ + 500]);
  }
  const land = terrain({ flat: outer, hole: outer, extent: 330, cell: 6, corridors, hillStart: 45, hillEnd: 300, hillHeight: 46, seed: 9 });
  const ground = new THREE.Mesh(land.geometry, kit.materials.grass);
  ground.receiveShadow = true;
  ground.name = 'terrain';
  group.add(ground);
  kit.geometries.push(land.geometry);
  // tree belt, denser near town, thinning out over the hills
  const tr = mulberry32(2024);
  for (let x = outer.minX - 320; x < outer.maxX + 320; x += 8) {
    for (let z = outer.minZ - 320; z < outer.maxZ + 320; z += 8) {
      const px = x + (tr() - 0.5) * 7, pz = z + (tr() - 0.5) * 7;
      const d = distToRect(px, pz, outer);
      if (d < 2.5 || d > 300) continue;
      let cd = Infinity;
      for (const cor of corridors) cd = Math.min(cd, distToSegment(px, pz, cor));
      if (cd < 9) continue;
      const cluster = fbm2(px / 70, pz / 70, 3, 4);
      const p = d < 14 ? 0.4 : d < 60 ? 0.18 * (cluster > 0.45 ? 1.5 : 0.45) : 0.055 * (cluster > 0.5 ? 2 : 0.3);
      if (tr() > p) continue;
      const kind: TreeKind = d > 80 && tr() < 0.55 ? 'conifer' : tr() < 0.18 ? 'conifer' : tr() < 0.6 ? 'round' : 'oval';
      const lod = d < 22 ? 0 : 1;
      trees.add(far, kind, px, pz, { lod, shadow: false, y: land.height(px, pz) - 0.1, scale: 0.9 + tr() * 0.4 });
    }
  }

  // ---------------------------------------------------------------- build meshes
  const meshes = [...b.build(kit.materials, group), ...far.build(kit.materials, group)];
  const flowerMesh = flowers.build();
  if (flowerMesh) group.add(flowerMesh);
  const carSet = createCars(cars);
  group.add(carSet.group);
  const flags = flagGeos.length ? createFlags(flagGeos, kit.materials.facade instanceof THREE.MeshStandardMaterial ? kit.materials.facade.map : null) : null;
  if (flags) group.add(flags.mesh);
  if (waterGeos.length) {
    const wg = mergeGeometries(waterGeos, false)!;
    waterGeos.forEach((x) => x.dispose());
    const wm = new THREE.Mesh(wg, kit.materials.water);
    wm.receiveShadow = true;
    group.add(wm);
    kit.geometries.push(wg);
  }
  shrubs.forEach((s) => s.dispose());
  trees.dispose();

  const lights = createOutdoorLights(renderer, { fogNear: 45, fogFar: 330, shadowSize: 24, sunIntensity: 2.8, hemi: 0.4 });
  group.add(lights.group);

  const home = layout.pois.find((p) => p.kind === 'home') ?? layout.pois[0];
  const hr = blockRect(home.col, home.row, layout);
  const ex = home.side === 'e' ? hr.maxX + layout.sidewalk / 2 : home.side === 'w' ? hr.minX - layout.sidewalk / 2 : (hr.minX + hr.maxX) / 2;
  const ez = home.side === 's' ? hr.maxZ + layout.sidewalk / 2 : home.side === 'n' ? hr.minZ - layout.sidewalk / 2 : (hr.minZ + hr.maxZ) / 2;

  return {
    group,
    environment: lights.environment,
    background: lights.background,
    fog: lights.fog,
    sun: lights.sun,
    bounds: { minX: -h, maxX: X1 + h, minZ: -h, maxZ: Z1 + h },
    obstacles: [],
    camera: { position: V(ex, 1.7, ez + 4.5), target: V(ex, 0.7, ez - 3), fov: 55 },
    update(_dt, time, focus) {
      lights.update(time, focus);
      flags?.update(time);
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      if (flowerMesh) { flowerMesh.geometry.dispose(); (flowerMesh.material as THREE.Material).dispose(); flowerMesh.dispose(); }
      carSet.dispose();
      flags?.dispose();
      lights.dispose();
      kit.dispose();
    },
  };
}

function streetDetails(b: Batch, g: StreetGeom, axis: 'x' | 'z', c: number, a0: number, a1: number, seed: number, cars: CarPlacement[], keepClear: (x: number, z: number) => boolean) {
  const yellow = '#e3b32e';
  const y = -g.dip + 0.012;
  const q = (a: number, cc: number, la: number, lc: number, col: THREE.ColorRepresentation, yy = y) => {
    if (axis === 'x') flatQuad(b, 'paint', a - la / 2, cc - lc / 2, a + la / 2, cc + lc / 2, yy, col);
    else flatQuad(b, 'paint', cc - lc / 2, a - la / 2, cc + lc / 2, a + la / 2, yy, col);
  };
  const s0 = a0 + g.ramp + 1.0, s1 = a1 - g.ramp - 1.0;
  for (let a = s0; a + 3 <= s1; a += 6) q(a + 1.5, c, 3, 0.12, yellow);
  const r = mulberry32(seed * 31 + 7);
  if (r() < 0.6) {
    const a = s0 + 3 + r() * (s1 - s0 - 6);
    const mh = new THREE.CircleGeometry(0.34, 18).rotateX(-Math.PI / 2);
    b.add('paint', mh, axis === 'x' ? tm(a, y - 0.004, c + 1.6) : tm(c + 1.6, y - 0.004, a), '#4d4d4f');
  }
  for (const s of [-1, 1]) q(s0 + 1, c + s * (g.rw - 0.25), 0.9, 0.35, '#2b2b2c', y - 0.006);
  if (r() < 0.32) {
    const side = r() < 0.5 ? -1 : 1;
    const a = s0 + 3 + r() * Math.max(0, s1 - s0 - 6);
    const cc = c + side * (g.rw - 1.05);
    // drive on the right: +x traffic keeps to +z, +z traffic keeps to -x
    const rot = axis === 'x' ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : side < 0 ? 0 : Math.PI;
    if (!keepClear(axis === 'x' ? a : cc, axis === 'x' ? cc : a)) cars.push({ x: axis === 'x' ? a : cc, y: -g.dip, z: axis === 'x' ? cc : a, rot, color: CAR_COLORS[Math.floor(r() * CAR_COLORS.length)] });
  }
}

function countryRoad(b: Batch, g: StreetGeom, axis: 'x' | 'z', c: number, a0: number, a1: number) {
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const P = (a: number, y: number, cc: number) => (axis === 'x' ? V(a, y, cc) : V(cc, y, a));
  const mb = new MeshBuilder();
  mb.polyUp([P(lo, 0.02, c - g.rw), P(hi, 0.02, c - g.rw), P(hi, 0.02, c + g.rw), P(lo, 0.02, c + g.rw)]);
  b.add('asphalt', mb.geometry(), null, 0xffffff, 'box');
  const sk = new MeshBuilder();
  for (const s of [-1, 1]) {
    const e = c + s * g.rw;
    const quad = [P(lo, 0.02, e), P(hi, 0.02, e), P(hi, -0.5, e + s * 1.6), P(lo, -0.5, e + s * 1.6)];
    sk.poly(polyNormal(quad).y < 0 ? [...quad].reverse() : quad);
  }
  b.add('concrete', sk.geometry(), null, '#8f8a7f', 'box');
  for (let a = lo + 4; a + 3 < hi; a += 7) {
    if (axis === 'x') flatQuad(b, 'paint', a, c - 0.06, a + 3, c + 0.06, 0.032, '#e3b32e');
    else flatQuad(b, 'paint', c - 0.06, a, c + 0.06, a + 3, 0.032, '#e3b32e');
  }
}

export function addHydrant(b: Batch, M: THREE.Matrix4) {
  const red = '#c8322b';
  b.add('trim', cylGeo(0.13, 0.14, 0.08, 12), M, red);
  b.add('trim', cylGeo(0.1, 0.11, 0.5, 12), M, red);
  b.add('trim', new THREE.SphereGeometry(0.11, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.5, 0), M, red);
  b.add('trim', cylGeo(0.03, 0.03, 0.08, 8), mul(M, tm(0, 0.6, 0)), '#e6e6e0');
  for (const s of [-1, 1]) b.add('trim', new THREE.CylinderGeometry(0.05, 0.05, 0.12, 8).rotateZ(Math.PI / 2).translate(s * 0.14, 0.34, 0), M, '#e6e6e0');
}

function addSignPost(b: Batch, atlas: Atlas, M: THREE.Matrix4, i: number, j: number) {
  const A = atlas.rects;
  b.add('metal', cylGeo(0.035, 0.035, 3.0, 8), M, '#8d9196');
  const plate = (rect: AtlasRect, y: number, ry: number) => {
    const Pm = mul(M, tm(0, y, 0, ry));
    b.add('trim', boxGeo(1.0, 0.2, 0.02), mul(Pm, tm(0.45, -0.1, 0)), '#1f6b45');
    b.add('facade', atlasQuad(0.96, 0.18, rect), mul(Pm, tm(0.45, 0, 0.011)), 0xffffff, 'keep');
    b.add('facade', atlasQuad(0.96, 0.18, rect), mul(Pm, tm(0.45, 0, -0.011, Math.PI)), 0xffffff, 'keep');
  };
  plate(A['streetX' + ((j + 1) % STREET_NAMES_X.length)], 2.85, Math.PI);
  plate(A['streetZ' + ((i + 1) % STREET_NAMES_Z.length)], 2.62, Math.PI / 2);
  const oct = new THREE.Shape();
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    if (k === 0) oct.moveTo(Math.cos(a) * 0.36, Math.sin(a) * 0.36); else oct.lineTo(Math.cos(a) * 0.36, Math.sin(a) * 0.36);
  }
  b.add('facade', atlasShape(oct, A.stop, 1), mul(M, tm(0, 2.1, -0.05, Math.PI)), 0xffffff, 'keep');
  b.add('trim', new THREE.CylinderGeometry(0.37, 0.37, 0.02, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 8), mul(M, tm(0, 2.1, -0.03)), '#dddddd');
}
