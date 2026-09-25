// Handheld and small props: toys, bowls, shop items, dig-up collectibles, poop
// and fitted accessories. Everything is built procedurally at real-world scale
// (metres, +Y up, front = +Z) with PBR materials and small canvas textures.
//
// Conventions
// - Toys have their origin at their centre; `rest` is the height of that origin
//   above the floor when the toy lies still (balls: rest === radius).
// - Items, collectibles and poop stand on y = 0 with their front facing +Z.
// - Textures are cached per module and shared; `dispose()` / `disposeObject()`
//   free geometries and materials but keep the shared textures alive.

import * as THREE from 'three';
import { physicalMaterial } from './materials';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type {
  Accessory, AccessoryFit, AccessoryKind, Bowl, CollectibleKind, FoodKind, ItemKind, Toy, ToyKind,
} from './types';

// =============================================================================
// Noise, random, textures
// =============================================================================

function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ Math.imul(seed + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Value noise in [0, 1]. Periodic in x / y when px / py > 0. */
function vnoise(x: number, y: number, z = 0, seed = 0, px = 0, py = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const x0 = px ? mod(ix, px) : ix, x1 = px ? mod(ix + 1, px) : ix + 1;
  const y0 = py ? mod(iy, py) : iy, y1 = py ? mod(iy + 1, py) : iy + 1;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (zz: number) => l(
    l(hash3(x0, y0, zz, seed), hash3(x1, y0, zz, seed), fx),
    l(hash3(x0, y1, zz, seed), hash3(x1, y1, zz, seed), fx), fy);
  return l(c(iz), c(iz + 1), fz);
}

/** Fractal value noise in roughly [0, 1]. */
function fbm(x: number, y: number, z = 0, oct = 4, seed = 0, px = 0, py = 0): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, z * f, seed + i * 17, px * f, py * f);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

const texCache = new Map<string, THREE.Texture>();

function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = texCache.get(key) as T | undefined;
  if (!t) { t = make(); texCache.set(key, t); }
  return t;
}

function newCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, wrap: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Canvas painted with the 2D API (labels, prints). */
function drawTex(key: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true, wrap = false) {
  return cached(key, () => {
    const { c, ctx } = newCanvas(w, h);
    paint(ctx, w, h);
    return toTexture(c, srgb, wrap);
  });
}

/** Per-pixel painter output; colours are sRGB 0..1, h is a height for bump maps, m an extra channel (roughness etc). */
interface Px { r: number; g: number; b: number; a: number; h: number; m: number }
interface Maps { map: THREE.Texture; bump: THREE.Texture; aux: THREE.Texture }

/**
 * Paints colour, height and an auxiliary channel in one pass. u, v are UV
 * coordinates (v = 1 at the top row, like three's flipped canvas textures).
 */
function pixelMaps(key: string, w: number, h: number, fn: (u: number, v: number, p: Px) => void, wrap = true): Maps {
  const k = key + '#map';
  if (!texCache.has(k)) {
    const col = newCanvas(w, h), hei = newCanvas(w, h), aux = newCanvas(w, h);
    const ci = col.ctx.createImageData(w, h), hi = hei.ctx.createImageData(w, h), ai = aux.ctx.createImageData(w, h);
    const p: Px = { r: 0, g: 0, b: 0, a: 1, h: 0.5, m: 1 };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        p.r = p.g = p.b = 0; p.a = 1; p.h = 0.5; p.m = 1;
        fn((x + 0.5) / w, 1 - (y + 0.5) / h, p);
        const o = (y * w + x) * 4;
        ci.data[o] = p.r * 255; ci.data[o + 1] = p.g * 255; ci.data[o + 2] = p.b * 255; ci.data[o + 3] = p.a * 255;
        const hv = Math.max(0, Math.min(255, p.h * 255));
        hi.data[o] = hi.data[o + 1] = hi.data[o + 2] = hv; hi.data[o + 3] = 255;
        const av = Math.max(0, Math.min(255, p.m * 255));
        ai.data[o] = ai.data[o + 1] = ai.data[o + 2] = av; ai.data[o + 3] = 255;
      }
    }
    col.ctx.putImageData(ci, 0, 0); hei.ctx.putImageData(hi, 0, 0); aux.ctx.putImageData(ai, 0, 0);
    texCache.set(k, toTexture(col.c, true, wrap));
    texCache.set(key + '#bump', toTexture(hei.c, false, wrap));
    texCache.set(key + '#aux', toTexture(aux.c, false, wrap));
  }
  return { map: texCache.get(k)!, bump: texCache.get(key + '#bump')!, aux: texCache.get(key + '#aux')! };
}

/** sRGB 0..1 triple for pixel painting. */
const hex = (s: string): [number, number, number] => {
  const c = new THREE.Color(s).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
const setRGB = (p: Px, c: [number, number, number], k = 1) => { p.r = c[0] * k; p.g = c[1] * k; p.b = c[2] * k; };
const mixRGB = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Rounded rectangle path helper for canvas painting. */
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A cartoon paw print centred at (x, y) with overall size s. */
function pawPath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.ellipse(x, y + s * 0.18, s * 0.3, s * 0.25, 0, 0, Math.PI * 2);
  for (const [dx, dy, r] of [[-0.34, -0.14, 0.12], [-0.13, -0.34, 0.12], [0.13, -0.34, 0.12], [0.34, -0.14, 0.12]]) {
    ctx.moveTo(x + dx * s + r * s, y + dy * s);
    ctx.ellipse(x + dx * s, y + dy * s, r * s, r * s * 1.2, 0, 0, Math.PI * 2);
  }
}

/** Soft noise used as fine grain / bump everywhere (tileable). */
function grainMaps(): Maps {
  return pixelMaps('grain', 256, 256, (u, v, p) => {
    const n = fbm(u * 32, v * 32, 0, 3, 3, 32, 32);
    const f = vnoise(u * 128, v * 128, 0, 9, 128, 128);
    p.r = p.g = p.b = 0.8 + n * 0.2;
    p.h = n * 0.6 + f * 0.4;
    p.m = f;
  });
}

// =============================================================================
// Geometry helpers
// =============================================================================

const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/** Matrix from translation, XYZ euler rotation and scale. */
function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

/** Rotates a Y-aligned geometry centred at the origin so it spans a -> b. */
function spanning(a: THREE.Vector3, b: THREE.Vector3) {
  const d = b.clone().sub(a);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize());
  return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function lathe(profile: [number, number][], segs: number, phiStart = 0, phiLen = Math.PI * 2) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segs, phiStart, phiLen);
}

/** Displace vertices along their normals. */
function displace(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number, recompute = true) {
  const p = geo.attributes.position as THREE.BufferAttribute, n = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = fn(x, y, z);
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  if (recompute) geo.computeVertexNormals();
  return geo;
}

/** Welds a (non-indexed) geometry so displacement and normals stay smooth. */
function welded(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  const w = mergeVertices(geo, 1e-5);
  geo.dispose();
  w.computeVertexNormals();
  return w;
}

/** Arbitrary per-vertex position edit. */
function warp(geo: THREE.BufferGeometry, fn: (v: THREE.Vector3) => void, recompute = true) {
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  if (recompute) geo.computeVertexNormals();
  return geo;
}

/** Remap UVs with a function of the current UV. */
function remapUV(geo: THREE.BufferGeometry, fn: (u: number, v: number, i: number) => [number, number]) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const [a, b] = fn(uv.getX(i), uv.getY(i), i);
    uv.setXY(i, a, b);
  }
  return geo;
}

/** Planar UVs from two position axes. */
function planarUV(geo: THREE.BufferGeometry, axisU: 'x' | 'y' | 'z', axisV: 'x' | 'y' | 'z', scale: number, ou = 0.5, ov = 0.5) {
  const p = geo.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  const get = (i: number, a: 'x' | 'y' | 'z') => (a === 'x' ? p.getX(i) : a === 'y' ? p.getY(i) : p.getZ(i));
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = get(i, axisU) * scale + ou;
    uv[i * 2 + 1] = get(i, axisV) * scale + ov;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Makes a geometry mergeable: indexed, position/normal/uv (+color). */
function prep(geo: THREE.BufferGeometry, color: THREE.Color | null) {
  const n = geo.attributes.position.count;
  if (!geo.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) geo.deleteAttribute(k);
  geo.morphAttributes = {};
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (color) {
    if (!geo.attributes.color) {
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
  } else if (geo.attributes.color) geo.deleteAttribute('color');
  return geo;
}

/** Collects parts per material and merges them into one mesh per material. */
class Parts {
  private groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(geo: THREE.BufferGeometry, mat: THREE.Material, color?: THREE.ColorRepresentation | null, m?: THREE.Matrix4): this {
    if (m) geo.applyMatrix4(m);
    const vc = (mat as THREE.MeshStandardMaterial).vertexColors;
    prep(geo, vc ? new THREE.Color(color ?? 0xffffff) : null);
    let list = this.groups.get(mat);
    if (!list) this.groups.set(mat, (list = []));
    list.push(geo);
    return this;
  }
  build(group = new THREE.Group(), shadows = true): THREE.Group {
    for (const [mat, list] of this.groups) {
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false)!;
      if (list.length > 1) for (const g of list) g.dispose();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.groups.clear();
    return group;
  }
}

/** Paints a vertex colour gradient/function onto a geometry (sRGB hex strings in, linear stored). */
function paintVerts(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number, c: THREE.Color) => void) {
  const p = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.set(0xffffff);
    fn(p.getX(i), p.getY(i), p.getZ(i), c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Frees geometries and materials under an object (shared textures stay cached). */
export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
}

function shadowed(obj: THREE.Object3D, cast = true) {
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = cast; o.receiveShadow = true; } });
  return obj;
}

// =============================================================================
// Materials
// =============================================================================

type MatOpts = THREE.MeshPhysicalMaterialParameters;
const phys = (o: MatOpts) => physicalMaterial(o);
const stdm = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);

function plastic(color: THREE.ColorRepresentation, rough = 0.35, extra: MatOpts = {}) {
  return phys({ color, roughness: rough, clearcoat: 0.35, clearcoatRoughness: 0.25, ...extra });
}
function metal(color: THREE.ColorRepresentation, rough = 0.25, extra: MatOpts = {}) {
  return phys({ color, metalness: 1, roughness: rough, ...extra });
}
const CHROME = '#e9ecef', GOLD = '#f2c35c', SILVER = '#d9dde2', BRASS = '#d9b163';

// =============================================================================
// Toys
// =============================================================================

export type PropToy = Toy & {
  /** height of the origin above the floor when the toy lies at rest */
  rest: number;
};

function toyResult(kind: ToyKind, object: THREE.Object3D, o: Partial<PropToy> & { radius: number; rest: number; grip: THREE.Vector3 }): PropToy {
  object.name = kind;
  return {
    kind, object, bounce: 0.3, glide: false,
    dispose: () => disposeObject(object),
    ...o,
  };
}

/** Squash & stretch spring used by the squeezable toys. */
function squashSpring(pivot: THREE.Object3D, amount: number) {
  let x = 0, v = 0;
  return (dt: number, squeeze: number) => {
    const w = 38, z = 0.28;
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      v += (-(w * w) * (x - squeeze) - 2 * z * w * v) * h;
      x += v * h;
    }
    const sq = x * amount;
    pivot.scale.set(1 + sq * 0.55, 1 - sq, 1 + sq * 0.55);
  };
}

// ---- balls ------------------------------------------------------------------

function tennisMaps(): Maps {
  // Classic tennis ball seam: a curve on the unit sphere.
  const a = 0.69, b = 0.31, c = 2 * Math.sqrt(a * b);
  const pts: number[] = [];
  const N = 360;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    pts.push(a * Math.cos(t) + b * Math.cos(3 * t), c * Math.sin(2 * t), a * Math.sin(t) - b * Math.sin(3 * t));
  }
  const felt = hex('#cde021'), feltDark = hex('#a3bb12'), seam = hex('#f3f2e6');
  return pixelMaps('tennis', 512, 256, (u, v, p) => {
    const phi = u * Math.PI * 2, th = (1 - v) * Math.PI;
    const x = -Math.cos(phi) * Math.sin(th), y = Math.cos(th), z = Math.sin(phi) * Math.sin(th);
    let best = -1;
    for (let i = 0; i < pts.length; i += 3) {
      const d = x * pts[i] + y * pts[i + 1] + z * pts[i + 2];
      if (d > best) best = d;
    }
    const ang = Math.acos(Math.min(1, best));
    // fuzz: fine fibres (3D noise so there is no pole pinching)
    const f1 = vnoise(x * 60 + 10, y * 60, z * 60, 4);
    const f2 = vnoise(x * 190, y * 190 + 3, z * 190, 7);
    const blot = fbm(x * 6 + 5, y * 6, z * 6, 3, 11);
    const k = 0.9 + f1 * 0.12 + f2 * 0.1;
    const col = mixRGB(felt, feltDark, clamp01((blot - 0.45) * 1.6) * 0.5);
    const sw = 0.032; // seam half width (rad)
    const s = 1 - smoothstep(sw * 0.75, sw, ang);
    setRGB(p, mixRGB(col, seam, s), mixRGB([k, k, k], [1, 1, 1], s)[0]);
    const groove = 1 - smoothstep(sw * 0.9, sw * 1.6, ang);
    p.h = (0.55 + f1 * 0.25 + f2 * 0.2) * (1 - groove) + groove * (0.25 + s * 0.12);
    p.m = 1;
  }, true);
}

function makeTennisBall(): PropToy {
  const r = 0.033;
  const maps = tennisMaps();
  const mat = phys({
    map: maps.map, bumpMap: maps.bump, bumpScale: 1.6, roughness: 0.92,
    sheen: 0.8, sheenRoughness: 0.5, sheenColor: new THREE.Color('#c4d830'),
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 30, 16), mat);
  const obj = shadowed(new THREE.Group().add(mesh));
  return toyResult('tennisBall', obj, { radius: r, rest: r, bounce: 0.72, grip: v3(0, 0, r * 0.85) });
}

function makeRubberBall(): PropToy {
  const r = 0.035;
  const maps = pixelMaps('rubber', 256, 128, (u, v, p) => {
    const th = (1 - v) * Math.PI, phi = u * Math.PI * 2;
    const x = Math.cos(phi) * Math.sin(th), y = Math.cos(th), z = Math.sin(phi) * Math.sin(th);
    const n = vnoise(x * 70, y * 70, z * 70, 5);
    const seam = 1 - smoothstep(0.004, 0.012, Math.abs(y));
    setRGB(p, hex('#cf2a22'), 1 + seam * 0.12);
    p.h = 0.5 + n * 0.12 + seam * 0.25;
    p.m = 0.8 + n * 0.2;
  });
  const mat = phys({
    map: maps.map, bumpMap: maps.bump, bumpScale: 0.6, roughnessMap: maps.aux, roughness: 0.4,
    clearcoat: 0.55, clearcoatRoughness: 0.28, sheen: 0.25, sheenColor: new THREE.Color('#ff8f80'), sheenRoughness: 0.4,
  });
  const obj = shadowed(new THREE.Group().add(new THREE.Mesh(new THREE.SphereGeometry(r, 30, 16), mat)));
  return toyResult('rubberBall', obj, { radius: r, rest: r, bounce: 0.82, grip: v3(0, 0, r * 0.85) });
}

// ---- discs ------------------------------------------------------------------

const DISC_R = 0.11;

/** Lathe profile for a flying disc: domed top, rolled rim, thin underside. Returns the geometry and the index where the underside starts. */
function discGeometry(): THREE.BufferGeometry {
  const R = DISC_R;
  const top: [number, number][] = [
    [0, 0.0222], [0.02, 0.0221], [0.04, 0.0218], [0.055, 0.0213], [0.068, 0.0206],
    [0.0735, 0.0205], [0.075, 0.0208], [0.0765, 0.0204], // flight ring
    [0.084, 0.0195], [0.0855, 0.0198], [0.087, 0.0192],
    [0.095, 0.0176], [0.1015, 0.0154], [0.106, 0.0128], [0.109, 0.0096], [0.1102, 0.0062],
    [0.1098, 0.0028], [0.1082, 0.0006],
  ];
  const under: [number, number][] = [
    [0.1062, 0.0003], [0.1049, 0.0022], [0.1046, 0.0065], [0.1042, 0.011], [0.1026, 0.0148],
    [0.0995, 0.0168], [0.092, 0.0182], [0.07, 0.019], [0.04, 0.0195], [0, 0.0197],
  ];
  const prof = [...under.slice().reverse(), ...top.slice().reverse()];
  const geo = lathe(prof, 44);
  // planar UVs for the printed top, a flat corner for the underside
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const nUnder = under.length;
  const rows = prof.length;
  for (let i = 0; i < pos.count; i++) {
    const row = i % rows;
    if (row >= nUnder + 3) uv.setXY(i, 0.5 + pos.getX(i) / (2 * R) * 0.98, 0.5 - pos.getZ(i) / (2 * R) * 0.98);
    else uv.setXY(i, 0.02, 0.02);
  }
  return geo;
}

function frisbeeMaps(gold: boolean): Maps {
  const base = gold ? hex('#f6cf6a') : hex('#f2561d');
  const print = gold ? hex('#fff3c6') : hex('#fff7ef');
  return pixelMaps(gold ? 'goldDisc' : 'frisbee', 512, 512, (u, v, p) => {
    const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
    const r = Math.hypot(x, y);
    const a = Math.atan2(y, x);
    let ink = 0;
    let emboss = 0;
    // rings
    ink = Math.max(ink, 1 - smoothstep(0.006, 0.012, Math.abs(r - 0.62)));
    ink = Math.max(ink, 1 - smoothstep(0.003, 0.008, Math.abs(r - 0.57)));
    if (gold) {
      // five-pointed star
      const k = Math.cos(Math.PI / 5) / Math.cos(mod(a + Math.PI / 2, (2 * Math.PI) / 5) - Math.PI / 5);
      const star = r < 0.36 * Math.pow(k, 6) ? 1 : 0;
      emboss = Math.max(star * 0.9, 1 - smoothstep(0.0, 0.015, Math.abs(r - 0.44)));
      // laurel dots around
      const dots = (1 - smoothstep(0.02, 0.03, Math.hypot(r - 0.5, (mod(a, 0.2) - 0.1) * 0.5))) * (Math.abs(a + Math.PI / 2) > 0.5 ? 1 : 0);
      emboss = Math.max(emboss, dots);
    } else {
      // paw print logo
      const px = x / 0.34, py = -y / 0.34 - 0.05;
      let paw = Math.hypot(px / 1.2, (py - 0.2) / 1) < 0.55 ? 1 : 0;
      for (const [dx, dy] of [[-0.62, -0.35], [-0.24, -0.7], [0.24, -0.7], [0.62, -0.35]]) if (Math.hypot(px - dx, (py - dy) / 1.2) < 0.22) paw = 1;
      ink = Math.max(ink, paw);
    }
    const n = vnoise(u * 300, v * 300, 0, 3);
    setRGB(p, mixRGB(base, print, gold ? emboss * 0.25 : ink), 0.97 + n * 0.03);
    p.h = 0.5 + emboss * 0.4 + ink * 0.06 + n * 0.02;
    p.m = gold ? 0.24 + emboss * 0.2 + n * 0.05 : 0.3 - ink * 0.12;
  }, false);
}

function makeDisc(gold: boolean): PropToy {
  const maps = frisbeeMaps(gold);
  const mat = gold
    ? phys({ map: maps.map, bumpMap: maps.bump, bumpScale: 2.5, roughnessMap: maps.aux, roughness: 1, metalness: 1, clearcoat: 0.8, clearcoatRoughness: 0.12, side: THREE.DoubleSide })
    : phys({ map: maps.map, bumpMap: maps.bump, bumpScale: 0.8, roughnessMap: maps.aux, roughness: 1, clearcoat: 0.4, clearcoatRoughness: 0.2, sheen: 0.3, sheenColor: new THREE.Color('#ffb18f'), side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(discGeometry(), mat);
  mesh.position.y = -0.011;
  const obj = shadowed(new THREE.Group().add(mesh));
  return toyResult(gold ? 'goldDisc' : 'frisbee', obj, {
    radius: DISC_R, rest: 0.011, glide: true, bounce: 0.25, grip: v3(0, -0.004, -DISC_R + 0.003),
  });
}

// ---- rope ---------------------------------------------------------------------

const ROPE_COLORS = ['#b8241c', '#efe4cc', '#1f4485'];

function ropeMaps(): Maps {
  const cols = ROPE_COLORS.map(hex);
  return pixelMaps('rope', 256, 128, (u, v, p) => {
    // three plies twisting around the rope (one full turn per texture tile)
    const t = mod(v * 3 + u * 3, 3);
    const ply = Math.floor(t);
    const f = t - ply; // 0..1 across the ply
    const round = Math.sin(f * Math.PI);
    // fibres twist the other way inside each ply
    const fib = 0.5 + 0.5 * Math.sin((u * 3 - v * 3) * 40 + vnoise(u * 64, v * 64, 0, 2, 64, 64) * 3);
    const fuzz = vnoise(u * 180, v * 180, 0, 4, 180, 180);
    const c = cols[ply];
    const shade = 0.55 + 0.45 * Math.pow(round, 0.6);
    setRGB(p, c, shade * (0.88 + fib * 0.1 + fuzz * 0.06));
    p.h = Math.pow(round, 0.7) * 0.8 + fib * 0.14 + fuzz * 0.06;
    p.m = 1;
  });
}

/** UV spot inside a ply of the given colour (for tassel strands). */
function ropePlyUV(ply: number): [number, number] {
  // choose u = 0.1, then v so that (v*3 + u*3) mod 3 = ply + 0.5
  const u = 0.1;
  return [u, mod((ply + 0.5 - u * 3) / 3, 1)];
}

const ROPE_LEN = 0.24;  // distance between knot centres along the rope
const ROPE_R = 0.0105;  // rope radius
const KNOT_R = 0.022;   // knot radius

interface RopeTemplate { pos: Float32Array; nrm: Float32Array; count: number }

/** Knot + frayed tassel, built along +Y with the knot centred at the origin. */
function ropeEndTemplate(seed: number): { geo: THREE.BufferGeometry; tpl: RopeTemplate } {
  const parts: THREE.BufferGeometry[] = [];
  const knot = new THREE.SphereGeometry(KNOT_R, 16, 12);
  // lumpy wraps of rope around the knot
  displace(knot, (x, y, z) => {
    const a = Math.atan2(z, x);
    const b = Math.asin(Math.max(-1, Math.min(1, y / KNOT_R)));
    const w = Math.sin(a * 2 + b * 3 + seed);
    return KNOT_R * (0.16 * Math.sign(w) * Math.pow(Math.abs(w), 0.6) + 0.06 * Math.sin(a * 5 - b * 4 + seed * 2));
  }, true);
  knot.scale(1, 1.18, 1);
  remapUV(knot, (u, v) => [v * 2.4, u * 2]);
  parts.push(knot);
  // frayed tassel: soft, slightly curly strands fanning out along +Y
  const rnd = rng(seed * 31 + 7);
  for (let i = 0; i < 26; i++) {
    const ang = (i / 26) * Math.PI * 2 + rnd() * 0.4;
    const rr = KNOT_R * (0.1 + rnd() * 0.45);
    const len = 0.012 + rnd() * 0.012;
    const spread = 0.3 + rnd() * 0.6;
    const dir = v3(Math.cos(ang) * Math.sin(spread), Math.cos(spread), Math.sin(ang) * Math.sin(spread));
    const side = v3(-Math.sin(ang), 0, Math.cos(ang)).multiplyScalar((rnd() - 0.5) * 0.014);
    const a = v3(Math.cos(ang) * rr, KNOT_R * 0.75, Math.sin(ang) * rr);
    const b = a.clone().addScaledVector(dir, len * 0.5).add(side);
    const c = a.clone().addScaledVector(dir, len).addScaledVector(side, -0.6).add(v3(0, -len * 0.08, 0));
    const strand = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, b, c]), 3, 0.00085 + rnd() * 0.0004, 3, false);
    const [su, sv] = ropePlyUV(i % 3);
    remapUV(strand, (u, v) => [su + u * 0.02, sv + v * 0.01]);
    parts.push(strand);
  }
  const geo = mergeGeometries(parts.map((g) => prep(g, null)), false)!;
  parts.forEach((g) => g.dispose());
  const pos = (geo.attributes.position.array as Float32Array).slice();
  const nrm = (geo.attributes.normal.array as Float32Array).slice();
  return { geo, tpl: { pos, nrm, count: geo.attributes.position.count } };
}

/** Parabola sag depth so the arc length between ends distance d equals len. */
function solveSag(d: number, len: number): number {
  if (d >= len * 0.999) return 0;
  const arc = (k: number) => (d / 2) * (Math.sqrt(1 + k * k) + Math.asinh(k) / k);
  let lo = 1e-4, hi = 1e4;
  for (let i = 0; i < 48; i++) {
    const mid = Math.sqrt(lo * hi);
    if (arc(mid) < len) lo = mid; else hi = mid;
  }
  return (Math.sqrt(lo * hi) * d) / 4;
}

function makeRope(): PropToy {
  const SEG = 48, RAD = 12;
  const maps = ropeMaps();
  const mat = phys({
    map: maps.map, bumpMap: maps.bump, bumpScale: 2.2, roughness: 0.95,
    sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color('#b8a898'),
  });

  // tube topology (positions filled in by reshape)
  const tubeCount = (SEG + 1) * (RAD + 1);
  const endA = ropeEndTemplate(1), endB = ropeEndTemplate(2);
  const total = tubeCount + endA.tpl.count + endB.tpl.count;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const index: number[] = [];
  const pitch = 0.034; // metres of rope per texture repeat
  for (let i = 0; i <= SEG; i++) {
    for (let j = 0; j <= RAD; j++) {
      const k = i * (RAD + 1) + j;
      uv[k * 2] = ((i / SEG) * ROPE_LEN) / pitch;
      uv[k * 2 + 1] = j / RAD;
      if (i < SEG && j < RAD) {
        const a = k, b = k + RAD + 1, c = b + 1, d = a + 1;
        index.push(a, b, d, b, c, d);
      }
    }
  }
  let off = tubeCount;
  for (const end of [endA, endB]) {
    uv.set(end.geo.attributes.uv.array as Float32Array, off * 2);
    const ei = end.geo.index!.array;
    for (let i = 0; i < ei.length; i++) index.push(ei[i] + off);
    off += end.tpl.count;
    end.geo.dispose();
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const nrmAttr = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', nrmAttr);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const obj = new THREE.Group().add(mesh);

  const grip = new THREE.Vector3();
  const curve: THREE.Vector3[] = Array.from({ length: SEG + 1 }, () => new THREE.Vector3());
  const tmp = Array.from({ length: 65 }, () => new THREE.Vector3());
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), prevT = new THREE.Vector3();
  const rot = new THREE.Matrix4(), q = new THREE.Quaternion();

  /** Lay the rope between local points a and b, sagging towards `down` (local). */
  const reshape = (a: THREE.Vector3, b: THREE.Vector3, down: THREE.Vector3) => {
    const chord = b.clone().sub(a);
    let d = chord.length();
    if (d < 1e-3) { chord.set(1e-3, 0, 0); d = 1e-3; }
    const c = chord.clone().divideScalar(d);
    const perp = down.clone().addScaledVector(c, -down.dot(c));
    if (perp.lengthSq() < 0.04) perp.add(Math.abs(c.x) < 0.9 ? v3(1, 0, 0) : v3(0, 0, 1)).addScaledVector(c, -perp.dot(c));
    perp.normalize();
    const sag = solveSag(d, ROPE_LEN);
    // sample the parabola, then resample at even arc length
    const cum = [0];
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      tmp[i].copy(a).addScaledVector(chord, t).addScaledVector(perp, 4 * sag * t * (1 - t));
      if (i) cum.push(cum[i - 1] + tmp[i].distanceTo(tmp[i - 1]));
    }
    const L = cum[64];
    let j = 0;
    for (let i = 0; i <= SEG; i++) {
      const s = (i / SEG) * L;
      while (j < 63 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      curve[i].copy(tmp[j]).lerp(tmp[j + 1], Math.min(1, f));
    }
    grip.copy(curve[SEG >> 1]);
    // tube with parallel-transported frames
    for (let i = 0; i <= SEG; i++) {
      T.copy(curve[Math.min(SEG, i + 1)]).sub(curve[Math.max(0, i - 1)]).normalize();
      if (i === 0) {
        N.copy(perp).addScaledVector(T, -perp.dot(T)).normalize();
      } else {
        q.setFromUnitVectors(prevT, T);
        N.applyQuaternion(q).addScaledVector(T, -N.dot(T)).normalize();
      }
      prevT.copy(T);
      B.crossVectors(T, N);
      // the three plies bulge out so the twist reads in silhouette (matches the texture)
      for (let k = 0; k <= RAD; k++) {
        const vi = i * (RAD + 1) + k;
        const ang = (k / RAD) * Math.PI * 2;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const ph = mod(uv[vi * 2 + 1] * 3 + uv[vi * 2] * 3, 1);
        const r = ROPE_R * (0.86 + 0.2 * Math.sin(ph * Math.PI));
        const dr = ROPE_R * 0.2 * Math.cos(ph * Math.PI) * Math.PI * 3 / (Math.PI * 2);
        const rx = N.x * cs + B.x * sn, ry = N.y * cs + B.y * sn, rz = N.z * cs + B.z * sn;
        const tx = -N.x * sn + B.x * cs, ty = -N.y * sn + B.y * cs, tz = -N.z * sn + B.z * cs;
        let nx = rx - tx * dr / r, ny = ry - ty * dr / r, nz = rz - tz * dr / r;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl; ny /= nl; nz /= nl;
        const idx = vi * 3;
        pos[idx] = curve[i].x + rx * r; pos[idx + 1] = curve[i].y + ry * r; pos[idx + 2] = curve[i].z + rz * r;
        nrm[idx] = nx; nrm[idx + 1] = ny; nrm[idx + 2] = nz;
      }
    }
    // knots, oriented outward along the rope ends
    let o = tubeCount;
    for (const [end, p, dir] of [
      [endA, curve[0], curve[0].clone().sub(curve[1]).normalize()],
      [endB, curve[SEG], curve[SEG].clone().sub(curve[SEG - 1]).normalize()],
    ] as const) {
      q.setFromUnitVectors(UP, dir);
      rot.makeRotationFromQuaternion(q).setPosition(p);
      const tp = end.tpl.pos, tn = end.tpl.nrm;
      const e = rot.elements;
      for (let i = 0; i < end.tpl.count; i++) {
        const x = tp[i * 3], y = tp[i * 3 + 1], z = tp[i * 3 + 2];
        const nx = tn[i * 3], ny = tn[i * 3 + 1], nz = tn[i * 3 + 2];
        const k = (o + i) * 3;
        pos[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        pos[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        pos[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        nrm[k] = e[0] * nx + e[4] * ny + e[8] * nz;
        nrm[k + 1] = e[1] * nx + e[5] * ny + e[9] * nz;
        nrm[k + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
      }
      o += end.tpl.count;
    }
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
    geo.computeBoundingSphere();
  };

  // resting shape: lying on the floor with a lazy bend
  const rest = KNOT_R * 1.05;
  reshape(v3(-0.105, 0, -0.02), v3(0.105, 0, 0.02), v3(0.3, -0.45, 1));

  const inv = new THREE.Matrix4(), la = new THREE.Vector3(), lb = new THREE.Vector3(), down = new THREE.Vector3();
  const toy = toyResult('rope', obj, { radius: 0.06, rest, bounce: 0.12, grip });
  toy.setEnds = (a, b) => {
    obj.updateMatrix();
    inv.copy(obj.matrix).invert();
    la.copy(a).applyMatrix4(inv);
    lb.copy(b).applyMatrix4(inv);
    down.set(0, -1, 0).transformDirection(inv);
    reshape(la, lb, down);
  };
  return toy;
}

// ---- squeaky duck -------------------------------------------------------------

function makeSqueaky(): PropToy {
  const mat = phys({ vertexColors: true, roughness: 0.36, clearcoat: 0.5, clearcoatRoughness: 0.32 });
  const yellow = '#ffbc00', orange = '#ff5e00', black = '#120d0c';
  const P = new Parts();
  // body: egg with a flat bottom and an upturned tail
  const body = new THREE.SphereGeometry(0.036, 26, 16);
  warp(body, (v) => {
    v.x *= 0.98; v.y *= 0.8; v.z *= 1.22;
    if (v.z < -0.01) v.y += Math.pow((-v.z - 0.01) / 0.034, 2.2) * 0.026 * smoothstep(-0.02, 0.02, v.y);
    if (v.z < -0.02) v.x *= 1 - ((-v.z - 0.02) / 0.03) * 0.4;
    v.y += 0.03;
    if (v.y < 0.004) v.y = 0.004 - (0.004 - v.y) * 0.15;
  });
  P.add(body, mat, yellow);
  // wings
  for (const s of [1, -1]) {
    const wing = new THREE.SphereGeometry(0.017, 12, 8);
    warp(wing, (v) => { v.x *= 0.28; v.y *= 0.58; v.z *= 1.1; if (v.z < 0) v.y += (-v.z / 0.019) * 0.005; });
    P.add(wing, mat, yellow, M(0.0315 * s, 0.032, -0.01, 0.2, 0.1 * s, -0.1 * s));
  }
  // head
  const head = new THREE.SphereGeometry(0.0245, 22, 14);
  warp(head, (v) => { v.z *= 1.02; v.y *= 0.98; });
  P.add(head, mat, yellow, M(0, 0.072, 0.02));
  // beak: two flattened lobes with a smile
  const upper = new THREE.SphereGeometry(0.0125, 14, 8);
  warp(upper, (v) => { v.x *= 1.05; v.y *= 0.42; v.z *= 1.15; v.y += Math.abs(v.x) * 0.25; });
  P.add(upper, mat, orange, M(0, 0.067, 0.043, 0.1, 0, 0));
  const lower = new THREE.SphereGeometry(0.011, 12, 6);
  warp(lower, (v) => { v.x *= 0.95; v.y *= 0.32; v.z *= 1.0; });
  P.add(lower, mat, orange, M(0, 0.0625, 0.04, 0.05, 0, 0));
  // eyes
  for (const s of [1, -1]) {
    P.add(new THREE.SphereGeometry(0.0042, 10, 6), mat, black, M(0.0125 * s, 0.079, 0.0395, 0, 0, 0, 1, 1.25, 0.8));
  }
  const pivot = P.build();
  pivot.position.y = -0.037;
  const obj = new THREE.Group().add(pivot);
  const toy = toyResult('squeaky', obj, { radius: 0.045, rest: 0.037, bounce: 0.45, grip: v3(0, 0.005, 0) });
  toy.update = squashSpring(pivot, 0.34);
  return toy;
}

// ---- plush teddy ----------------------------------------------------------------

function plushMaps(): Maps {
  return pixelMaps('plush', 256, 256, (u, v, p) => {
    const n = fbm(u * 16, v * 16, 0, 3, 21, 16, 16);
    const f = vnoise(u * 200, v * 200, 0, 22, 200, 200) * 0.6 + vnoise(u * 90, v * 90, 0, 23, 90, 90) * 0.4;
    const k = 0.86 + n * 0.1 + f * 0.1;
    p.r = p.g = p.b = k;
    p.h = n * 0.2 + f * 0.8;
    p.m = 1;
  });
}

function makePlushie(): PropToy {
  const maps = plushMaps();
  const fur = phys({
    vertexColors: true, map: maps.map, bumpMap: maps.bump, bumpScale: 0.9, roughness: 1,
    sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color('#f5d6b0'),
  });
  const gloss = phys({ vertexColors: true, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
  const brown = '#a8703d', tan = '#e3c091', dark = '#1a120e', red = '#c2262e';
  const P = new Parts();
  const ell = (rx: number, ry: number, rz: number, ws = 14, hs = 10) => new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz);
  // body and belly patch
  P.add(ell(0.039, 0.046, 0.034, 16, 10), fur, brown, M(0, 0.05, 0));
  P.add(ell(0.026, 0.032, 0.012, 12, 8), fur, tan, M(0, 0.047, 0.026, -0.12));
  // head, muzzle, ears
  P.add(ell(0.036, 0.033, 0.032, 18, 12), fur, brown, M(0, 0.11, 0.004));
  P.add(ell(0.017, 0.0125, 0.013, 14, 8), fur, tan, M(0, 0.1, 0.031));
  for (const s of [1, -1]) {
    P.add(ell(0.0135, 0.0135, 0.0065, 12, 8), fur, brown, M(0.027 * s, 0.137, -0.002, 0, 0, -0.35 * s));
    P.add(ell(0.0085, 0.0085, 0.003, 10, 6), fur, tan, M(0.0272 * s, 0.1365, 0.0035, 0, 0, -0.35 * s));
    // arms reaching forward-down
    const arm = new THREE.CapsuleGeometry(0.0115, 0.03, 3, 8);
    P.add(arm, fur, brown, spanning(v3(0.032 * s, 0.07, 0.006), v3(0.04 * s, 0.037, 0.028)));
    P.add(ell(0.009, 0.0095, 0.004, 10, 6), fur, tan, M(0.042 * s, 0.027, 0.034, -0.7, 0.2 * s, 0));
    // legs sticking out forward (sitting)
    const leg = new THREE.CapsuleGeometry(0.0145, 0.03, 3, 8);
    P.add(leg, fur, brown, spanning(v3(0.021 * s, 0.018, 0.0), v3(0.028 * s, 0.015, 0.044)));
    P.add(ell(0.0115, 0.0125, 0.004, 10, 6), fur, tan, M(0.029 * s, 0.0155, 0.0615, 0, 0.12 * s, 0));
    // eyes
    P.add(new THREE.SphereGeometry(0.0042, 10, 6), gloss, dark, M(0.0135 * s, 0.117, 0.03));
  }
  P.add(ell(0.0062, 0.0044, 0.004, 12, 8), gloss, dark, M(0, 0.106, 0.0435, 0.3));
  // satin neck ribbon with a small bow
  const band = new THREE.CylinderGeometry(0.0285, 0.0305, 0.007, 28, 1, true);
  band.scale(1, 1, 0.9);
  P.add(band, gloss, red, M(0, 0.083, 0.003, 0.12));
  for (const s of [1, -1]) {
    const loop = ell(0.011, 0.0065, 0.0035, 12, 8);
    P.add(loop, gloss, red, M(0.01 * s, 0.083, 0.034, 0, 0.3 * s, 0.25 * s));
  }
  P.add(ell(0.004, 0.004, 0.003, 10, 6), gloss, red, M(0, 0.083, 0.036));
  const pivot = P.build();
  pivot.position.y = -0.06;
  const obj = new THREE.Group().add(pivot);
  const toy = toyResult('plushie', obj, { radius: 0.075, rest: 0.06, bounce: 0.12, grip: v3(0, 0.02, 0.01) });
  toy.update = squashSpring(pivot, 0.22);
  return toy;
}

// ---- rawhide bone -------------------------------------------------------------------

function rawhideMaps(): Maps {
  const light = hex('#e6c893'), mid = hex('#cda46c'), dark = hex('#9e723f');
  return pixelMaps('rawhide', 256, 256, (u, v, p) => {
    const streak = fbm(u * 3, v * 40, 0, 4, 41, 3, 40);
    const blot = fbm(u * 6, v * 6, 0, 4, 42, 6, 6);
    const fine = vnoise(u * 120, v * 30, 0, 43, 120, 30);
    let c = mixRGB(light, mid, clamp01(streak * 1.4 - 0.25));
    c = mixRGB(c, dark, clamp01((blot - 0.58) * 3) * 0.6);
    setRGB(p, c, 0.95 + fine * 0.07);
    p.h = streak * 0.6 + fine * 0.4;
    p.m = 0.5 + blot * 0.25;
  });
}

function makeBone(): PropToy {
  const maps = rawhideMaps();
  const mat = phys({
    map: maps.map, bumpMap: maps.bump, bumpScale: 2, roughnessMap: maps.aux, roughness: 1,
    clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.5, sheenColor: new THREE.Color('#fff0d0'), sheenRoughness: 0.5,
  });
  const P = new Parts();
  // twisted, rolled shaft along X
  const shaft = new THREE.CylinderGeometry(0.0115, 0.0115, 0.1, 14, 18, true);
  warp(shaft, (v) => {
    const a = Math.atan2(v.z, v.x);
    const pinch = 1 - 0.14 * Math.cos((v.y / 0.05) * Math.PI * 0.5) ** 2;
    const k = (1 + 0.1 * Math.sin(a * 2 + v.y * 150)) * (2 - pinch);
    v.x *= k * 0.85; v.z *= k * 0.85;
  });
  remapUV(shaft, (u, v) => [u, v * 2]);
  P.add(shaft, mat, null, M(0, 0, 0, 0, 0, Math.PI / 2));
  // knotted ends: two lobes each plus a wrap band
  for (const s of [1, -1]) {
    for (const t of [1, -1]) {
      const lobe = new THREE.SphereGeometry(0.0172, 16, 12);
      displace(lobe, (x, y, z) => 0.0009 * Math.sin(Math.atan2(y, x) * 2 + z * 200 + t), true);
      P.add(lobe, mat, null, M(0.054 * s, 0, 0.0105 * t, 0, 0.5 * s * t, 0, 1.15, 0.8, 1));
    }
  }
  const obj = P.build();
  return toyResult('bone', obj, { radius: 0.07, rest: 0.0135, bounce: 0.2, grip: v3(0, 0.004, 0.006) });
}

/** Builds a toy. */
export function makeToy(kind: ToyKind): PropToy {
  switch (kind) {
    case 'tennisBall': return makeTennisBall();
    case 'rubberBall': return makeRubberBall();
    case 'frisbee': return makeDisc(false);
    case 'goldDisc': return makeDisc(true);
    case 'rope': return makeRope();
    case 'squeaky': return makeSqueaky();
    case 'plushie': return makePlushie();
    case 'bone': return makeBone();
  }
}

// =============================================================================
// Bowls
// =============================================================================

const BOWL_R = 0.09;
const BOWL_RIM = 0.0528;
const BOWL_FLOOR = 0.0062;
/** inner wall (y, r) from the floor to the rim */
const BOWL_INNER: [number, number][] = [
  [0.0062, 0.036], [0.0075, 0.0425], [0.011, 0.0472], [0.02, 0.0522], [0.034, 0.0562], [0.046, 0.059], [0.0512, 0.0612],
];

function bowlInnerR(y: number): number {
  const t = BOWL_INNER;
  if (y <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (y <= t[i][0]) {
      const f = (y - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * f;
    }
  }
  return t[t.length - 1][1];
}

function steelMaps(): Maps {
  return pixelMaps('steel', 64, 512, (u, v, p) => {
    const line = vnoise(0.5, v * 400, 0, 51) * 0.6 + vnoise(0.5, v * 1500, 0, 52) * 0.4;
    const smudge = fbm(u * 4, v * 8, 0, 3, 53, 4, 8);
    const k = 0.93 + line * 0.07;
    p.r = p.g = p.b = k;
    p.h = line;
    p.m = 0.16 + line * 0.14 + smudge * 0.1;
  });
}

function makeSteelBowl(): THREE.Group {
  const maps = steelMaps();
  const steel = phys({
    color: '#d4d8dc', metalness: 1, roughness: 1, roughnessMap: maps.aux, map: maps.map,
  });
  const inner = BOWL_INNER.slice().reverse().map(([y, r]) => [r, y] as [number, number]);
  const prof: [number, number][] = [
    [0, 0.003], [0.06, 0.003], [0.08, 0.0026], [0.0865, 0.0036], [0.0895, 0.0062], [0.0888, 0.0094],
    [0.0835, 0.019], [0.0765, 0.032], [0.0705, 0.0435], [0.0674, 0.0495], [0.0655, 0.0522], [0.0632, BOWL_RIM],
    ...inner, [0.02, BOWL_FLOOR], [0, BOWL_FLOOR],
  ];
  const geo = lathe(prof, 40);
  const bowl = new THREE.Mesh(geo, steel);
  const rubber = new THREE.Mesh(
    new THREE.TorusGeometry(0.0848, 0.0028, 4, 40).rotateX(Math.PI / 2).translate(0, 0.0026, 0),
    stdm({ color: '#1d1c1b', roughness: 0.85 }),
  );
  return shadowed(new THREE.Group().add(bowl, rubber)) as THREE.Group;
}

/** A liquid disc inside the bowl with animated ripples. */
function makeLiquid(mat: THREE.Material, amp: number) {
  const RINGS = 7, SEGS = 40;
  const geo = new THREE.BufferGeometry();
  const count = 1 + RINGS * SEGS;
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const polar: number[] = [0, 0];
  for (let r = 1; r <= RINGS; r++) for (let s = 0; s < SEGS; s++) polar.push(r / RINGS, (s / SEGS) * Math.PI * 2);
  const idx: number[] = [];
  for (let s = 0; s < SEGS; s++) idx.push(0, 1 + ((s + 1) % SEGS), 1 + s);
  for (let r = 1; r < RINGS; r++) {
    for (let s = 0; s < SEGS; s++) {
      const a = 1 + (r - 1) * SEGS + s, b = 1 + (r - 1) * SEGS + ((s + 1) % SEGS);
      const c = a + SEGS, d = b + SEGS;
      idx.push(a, b, d, a, d, c);
    }
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  let level = 0, radius = 0.05;
  const update = (time: number) => {
    for (let i = 0; i < count; i++) {
      const pr = polar[i * 2] * radius, pa = polar[i * 2 + 1];
      const x = Math.cos(pa) * pr, z = Math.sin(pa) * pr;
      // concentric ripple + a slow cross wave, faded at the wall
      const edge = 1 - Math.pow(polar[i * 2], 6) * 0.7;
      const k1 = 380, w1 = 5.5, k2 = 230;
      const ph1 = k1 * pr - w1 * time, ph2 = k2 * (x * 0.8 + z * 0.6) - 3.1 * time;
      const rho = polar[i * 2];
      const men = 0.0012 * Math.pow(rho, 12);
      const h = amp * edge * (Math.sin(ph1) * 0.6 + Math.sin(ph2) * 0.4) + men;
      const dr = amp * edge * 0.6 * k1 * Math.cos(ph1) + (rho > 0 ? (0.0012 * 12 * Math.pow(rho, 11)) / radius : 0);
      const dc = amp * edge * 0.4 * k2 * Math.cos(ph2);
      const gx = dr * Math.cos(pa) + dc * 0.8, gz = dr * Math.sin(pa) + dc * 0.6;
      pos[i * 3] = x; pos[i * 3 + 1] = level + h; pos[i * 3 + 2] = z;
      const inv = 1 / Math.hypot(gx, 1, gz);
      nrm[i * 3] = -gx * inv; nrm[i * 3 + 1] = inv; nrm[i * 3 + 2] = -gz * inv;
      uv[i * 2] = 0.5 + x * 6; uv[i * 2 + 1] = 0.5 + z * 6;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
  };
  return {
    mesh,
    setLevel(y: number) { level = y; radius = bowlInnerR(y) - 0.0004; geo.boundingSphere = new THREE.Sphere(v3(0, y, 0), radius * 1.05); },
    update,
  };
}

// ---- food mounds ------------------------------------------------------------------

interface FoodLook {
  mound?: { map: Maps; tint: string; rough: number; clearcoat: number; bump: number; lump: number; dome: number };
  pieces?: { geo: () => THREE.BufferGeometry; colors: string[]; count: number; size: [number, number]; rough: number; clearcoat: number; map?: Maps; embed: number }[];
  liquid?: { color: string; rough: number };
}

/** Painted heap of round kibble (colour, height, roughness), tileable. */
function kibbleMaps(): Maps {
  const key = 'kibble';
  if (!texCache.has(key + '#map')) {
    const S = 512;
    const col = newCanvas(S, S), hei = newCanvas(S, S), aux = newCanvas(S, S);
    col.ctx.fillStyle = '#2a170b'; col.ctx.fillRect(0, 0, S, S);
    hei.ctx.fillStyle = '#000'; hei.ctx.fillRect(0, 0, S, S);
    aux.ctx.fillStyle = '#e0e0e0'; aux.ctx.fillRect(0, 0, S, S);
    const rnd = rng(7);
    const tones = ['#a8652f', '#b8773c', '#94552a', '#c58b4f', '#8a4a22', '#9e5e2e'];
    const one = (x: number, y: number, r: number, sq: number, rot: number, tone: string, dimple: boolean) => {
      for (const [ctx, kind] of [[col.ctx, 0], [hei.ctx, 1], [aux.ctx, 2]] as const) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.scale(1, sq);
        if (kind === 0) {
          // contact shadow, then the lit piece
          const sh = ctx.createRadialGradient(r * 0.25, r * 0.3, r * 0.5, r * 0.25, r * 0.3, r * 1.35);
          sh.addColorStop(0, 'rgba(20,10,4,0.7)'); sh.addColorStop(1, 'rgba(20,10,4,0)');
          ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(r * 0.25, r * 0.3, r * 1.35, 0, Math.PI * 2); ctx.fill();
          const c = new THREE.Color(tone);
          const hi = '#' + c.clone().lerp(new THREE.Color('#f0c890'), 0.35).getHexString();
          const lo = '#' + c.clone().multiplyScalar(0.55).getHexString();
          const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r);
          g.addColorStop(0, hi); g.addColorStop(0.55, tone); g.addColorStop(1, lo);
          ctx.fillStyle = g;
        } else if (kind === 1) {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          g.addColorStop(0, '#fff'); g.addColorStop(0.6, '#c8c8c8'); g.addColorStop(1, '#303030');
          ctx.fillStyle = g;
        } else ctx.fillStyle = '#a8a8a8';
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
        if (dimple) {
          ctx.fillStyle = kind === 0 ? 'rgba(40,20,8,0.55)' : kind === 1 ? '#707070' : '#c0c0c0';
          ctx.beginPath(); ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    };
    for (let i = 0; i < 380; i++) {
      const x = rnd() * S, y = rnd() * S, r = S * (0.033 + rnd() * 0.01);
      const sq = 0.7 + rnd() * 0.3, rot = rnd() * Math.PI, tone = tones[Math.floor(rnd() * tones.length)];
      const dimple = rnd() < 0.3;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const X = x + ox, Y = y + oy;
        if (X + r * 1.5 < 0 || X - r * 1.5 > S || Y + r * 1.5 < 0 || Y - r * 1.5 > S) continue;
        one(X, Y, r, sq, rot, tone, dimple);
      }
    }
    texCache.set(key + '#map', toTexture(col.c, true, true));
    texCache.set(key + '#bump', toTexture(hei.c, false, true));
    texCache.set(key + '#aux', toTexture(aux.c, false, true));
  }
  return { map: texCache.get(key + '#map')!, bump: texCache.get(key + '#bump')!, aux: texCache.get(key + '#aux')! };
}

function meatMaps(key: string, base: string, chunk: string, gravy: string): Maps {
  const b = hex(base), c = hex(chunk), g = hex(gravy);
  return pixelMaps(key, 256, 256, (u, v, p) => {
    const n = fbm(u * 10, v * 10, 0, 4, 71, 10, 10);
    const cells = fbm(u * 5, v * 5, 1, 3, 72, 5, 5);
    const chunkM = smoothstep(0.52, 0.6, cells);
    const gloss = smoothstep(0.55, 0.7, fbm(u * 7, v * 7, 3, 3, 73, 7, 7));
    let col = mixRGB(b, c, chunkM * 0.8);
    col = mixRGB(col, g, gloss * 0.5);
    setRGB(p, col, 0.8 + n * 0.35);
    p.h = n * 0.6 + chunkM * 0.4;
    p.m = 0.55 - gloss * 0.4;
  });
}

function kibbleGeo() {
  return new THREE.SphereGeometry(1, 8, 5).scale(1, 0.6, 1);
}
function chunkGeo() {
  const g = welded(new THREE.IcosahedronGeometry(1, 1));
  return displace(g, (x, y, z) => 0.3 * (vnoise(x * 1.7 + 5, y * 1.7, z * 1.7, 81) - 0.5), true).scale(1.2, 0.75, 1);
}
function cubeGeo() {
  const g = welded(new THREE.BoxGeometry(1.4, 1.4, 1.4, 2, 2, 2));
  return displace(g, (x, y, z) => 0.12 * (vnoise(x * 3, y * 3 + 2, z * 3, 82) - 0.5), true);
}
function jerkyGeo() {
  const g = new THREE.BoxGeometry(1, 0.05, 0.22, 10, 1, 3);
  warp(g, (v) => {
    const t = v.x;
    // ragged width, tapered torn ends, a gentle twist and wave
    const w = 1 + 0.35 * (vnoise(t * 7 + (v.z > 0 ? 0 : 9), 0, 0, 83) - 0.5) - 0.5 * smoothstep(0.38, 0.5, Math.abs(t));
    const tw = Math.sin(t * 2.2) * 0.45;
    const y = v.y * (1 + 0.4 * vnoise(t * 5, v.z * 10, 0, 84)), z = v.z * w;
    v.y = y * Math.cos(tw) - z * Math.sin(tw) + Math.sin(t * 3.1) * 0.04;
    v.z = y * Math.sin(tw) + z * Math.cos(tw);
  });
  return g;
}

function jerkyMaps(): Maps {
  return pixelMaps('jerky', 128, 128, (u, v, p) => {
    const fib = fbm(u * 3, v * 14, 0, 3, 85, 3, 14);
    const spot = fbm(u * 6, v * 6, 1, 3, 86, 6, 6);
    const k = 0.82 + fib * 0.2 + smoothstep(0.5, 0.75, spot) * 0.2;
    p.r = p.g = p.b = Math.min(1, k);
    p.h = fib * 0.6 + spot * 0.4;
    p.m = 0.7 - smoothstep(0.5, 0.7, spot) * 0.45;
  });
}

function foodLook(kind: FoodKind): FoodLook {
  switch (kind) {
    case 'dry':
      return {
        mound: { map: kibbleMaps(), tint: '#ffffff', rough: 0.75, clearcoat: 0, bump: 4, lump: 0.0035, dome: 0.018 },
        pieces: [{ geo: kibbleGeo, colors: ['#9a5a2a', '#b3743c', '#86491f', '#c48a4f'], count: 30, size: [0.0055, 0.0068], rough: 0.7, clearcoat: 0, embed: 0.35 }],
      };
    case 'canned':
      return {
        mound: { map: meatMaps('canned', '#6a3420', '#8d4a2e', '#3f1c0e'), tint: '#ffffff', rough: 0.5, clearcoat: 0.7, bump: 3, lump: 0.004, dome: 0.016 },
        pieces: [{ geo: chunkGeo, colors: ['#7a3c22', '#8c4a2e', '#5f2d19'], count: 16, size: [0.006, 0.009], rough: 0.4, clearcoat: 0.8, embed: 0.45 }],
      };
    case 'premium':
      return {
        mound: { map: meatMaps('premium', '#b07852', '#d09a70', '#7a4a2c'), tint: '#ffffff', rough: 0.55, clearcoat: 0.55, bump: 2.5, lump: 0.004, dome: 0.017 },
        pieces: [
          { geo: chunkGeo, colors: ['#9c5634', '#b86f47', '#7d4125'], count: 12, size: [0.006, 0.009], rough: 0.45, clearcoat: 0.6, embed: 0.4 },
          { geo: cubeGeo, colors: ['#f07a1e', '#ea8a2a'], count: 9, size: [0.0032, 0.0038], rough: 0.4, clearcoat: 0.6, embed: 0.35 },
          { geo: () => new THREE.SphereGeometry(1, 8, 6), colors: ['#6aa82c', '#79b53a'], count: 10, size: [0.0034, 0.004], rough: 0.35, clearcoat: 0.8, embed: 0.3 },
        ],
      };
    case 'jerky':
      return {
        pieces: [{ geo: jerkyGeo, colors: ['#4a170b', '#5c2010', '#3d1309'], count: 9, size: [0.055, 0.066], rough: 0.8, clearcoat: 0.45, embed: 0, map: jerkyMaps() }],
      };
    case 'milk':
      return { liquid: { color: '#f6f3ea', rough: 0.22 } };
  }
}

interface FoodView {
  group: THREE.Group;
  setFill(f: number): void;
  update?(time: number): void;
  dispose(): void;
}

function makeFoodView(kind: FoodKind): FoodView {
  const look = foodLook(kind);
  const group = new THREE.Group();
  const updaters: ((f: number) => void)[] = [];
  let liquidUpdate: ((t: number) => void) | undefined;

  // mound surface shape at a given fill
  let edgeY = 0, edgeR = 0, dome = 0;
  const shapeFor = (f: number, domeMax: number) => {
    edgeY = BOWL_FLOOR + 0.0015 + f * (BOWL_RIM - 0.006 - BOWL_FLOOR);
    edgeR = bowlInnerR(edgeY) - 0.0006;
    dome = domeMax * Math.min(1, f * 1.6);
  };
  const surfY = (rho: number) => edgeY + dome * (1 - rho * rho);

  if (look.mound) {
    const m = look.mound;
    const RINGS = 7, SEGS = 32;
    const count = 1 + RINGS * SEGS;
    const polar: number[] = [0, 0];
    for (let r = 1; r <= RINGS; r++) for (let s = 0; s < SEGS; s++) polar.push(r / RINGS, (s / SEGS) * Math.PI * 2);
    const idx: number[] = [];
    for (let s = 0; s < SEGS; s++) idx.push(0, 1 + ((s + 1) % SEGS), 1 + s);
    for (let r = 1; r < RINGS; r++) for (let s = 0; s < SEGS; s++) {
      const a = 1 + (r - 1) * SEGS + s, b = 1 + (r - 1) * SEGS + ((s + 1) % SEGS);
      idx.push(a, b, b + SEGS, a, b + SEGS, a + SEGS);
    }
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const lumps = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const rho = polar[i * 2], a = polar[i * 2 + 1];
      lumps[i] = (fbm(Math.cos(a) * rho * 4 + 3, Math.sin(a) * rho * 4, 0, 3, 91) - 0.5) * (1 - Math.pow(rho, 4));
    }
    const mat = phys({
      color: m.tint, map: m.map.map, bumpMap: m.map.bump, bumpScale: m.bump, roughnessMap: m.map.aux, roughness: m.rough / 0.6,
      clearcoat: m.clearcoat, clearcoatRoughness: 0.25,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);
    updaters.push((f) => {
      mesh.visible = f > 0.001;
      shapeFor(f, m.dome);
      for (let i = 0; i < count; i++) {
        const rho = polar[i * 2], a = polar[i * 2 + 1];
        const r = rho * edgeR;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        pos[i * 3] = x; pos[i * 3 + 1] = surfY(rho) + lumps[i] * m.lump * 2 * Math.min(1, f * 3); pos[i * 3 + 2] = z;
        uv[i * 2] = x * 7 + 0.5; uv[i * 2 + 1] = z * 7 + 0.5;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.uv.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    });
  } else if (!look.liquid) {
    // pieces only (jerky): sit on the bowl floor
    updaters.push((f) => { shapeFor(f * 0.35, 0.004); });
  }

  for (const [pi, pc] of (look.pieces || []).entries()) {
    const geo = pc.geo();
    const mat = pc.map
      ? phys({ map: pc.map.map, bumpMap: pc.map.bump, bumpScale: 2, roughnessMap: pc.map.aux, roughness: pc.rough, clearcoat: pc.clearcoat, clearcoatRoughness: 0.35 })
      : phys({ roughness: pc.rough, clearcoat: pc.clearcoat, clearcoatRoughness: 0.3, bumpMap: grainMaps().bump, bumpScale: 1 });
    const inst = new THREE.InstancedMesh(geo, mat, pc.count);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const rnd = rng(1000 + pi * 77 + kind.length * 13);
    const items = Array.from({ length: pc.count }, (_, i) => ({
      rho: Math.sqrt(rnd()) * 0.92, a: rnd() * Math.PI * 2, rot: new THREE.Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3),
      s: pc.size[0] + rnd() * (pc.size[1] - pc.size[0]), order: i / pc.count, lift: rnd(),
    }));
    // jerky strips lie flat-ish
    if (kind === 'jerky') items.forEach((it, i) => { it.rot.set((rnd() - 0.5) * 0.4, rnd() * 6.3, (rnd() - 0.5) * 0.3); it.rho = rnd() * 0.35; it.lift = i; });
    const c = new THREE.Color();
    items.forEach((_, i) => inst.setColorAt(i, c.set(pc.colors[i % pc.colors.length])));
    const mtx = new THREE.Matrix4(), pp = new THREE.Vector3(), qq = new THREE.Quaternion(), ss = new THREE.Vector3();
    updaters.push((f) => {
      let n = 0;
      const visible = kind === 'jerky' ? Math.ceil(pc.count * f - 0.01) : Math.round(pc.count * Math.sqrt(f));
      for (const it of items) {
        if (n >= visible) break;
        const r = it.rho * edgeR * (kind === 'jerky' ? 1 : 0.95);
        let y: number;
        if (kind === 'jerky') y = BOWL_FLOOR + 0.004 + it.lift * 0.0045 * (0.4 + f * 0.6);
        else y = surfY(it.rho) + it.s * (1 - pc.embed) * 0.7;
        pp.set(Math.cos(it.a) * r, y, Math.sin(it.a) * r);
        qq.setFromEuler(it.rot);
        ss.setScalar(it.s);
        mtx.compose(pp, qq, ss);
        inst.setMatrixAt(n++, mtx);
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
    });
    group.add(inst);
  }

  if (look.liquid) {
    const mat = phys({ color: look.liquid.color, roughness: look.liquid.rough, clearcoat: 0.8, clearcoatRoughness: 0.04 });
    const liq = makeLiquid(mat, 0.0003);
    group.add(liq.mesh);
    updaters.push((f) => {
      liq.mesh.visible = f > 0.001;
      liq.setLevel(BOWL_FLOOR + 0.001 + f * (BOWL_RIM - 0.008 - BOWL_FLOOR));
      liq.update(0);
    });
    liquidUpdate = (t) => liq.update(t);
  }

  return {
    group,
    setFill(f) { for (const u of updaters) u(f); },
    update: liquidUpdate,
    dispose: () => disposeObject(group),
  };
}

/** Stainless steel food bowl; `setFood` switches between kibble, canned, premium, jerky and milk. */
export function makeFoodBowl(): Bowl {
  const object = makeSteelBowl();
  object.name = 'foodBowl';
  const views = new Map<FoodKind, FoodView>();
  let kind: FoodKind = 'dry';
  let fill = 1;
  const view = (k: FoodKind) => {
    let v = views.get(k);
    if (!v) { v = makeFoodView(k); views.set(k, v); object.add(v.group); }
    return v;
  };
  const show = () => {
    for (const [k, v] of views) v.group.visible = k === kind;
    view(kind).setFill(fill);
  };
  show();
  return {
    object,
    rimHeight: BOWL_RIM,
    radius: BOWL_R,
    setFill(f) { fill = clamp01(f); show(); },
    setFood(k) { kind = k; show(); },
    update(_dt, time) { views.get(kind)?.update?.(time); },
    dispose() { for (const v of views.values()) v.dispose(); disposeObject(object); },
  };
}

/** Stainless steel water bowl with a rippling water surface that lowers as it empties. */
export function makeWaterBowl(): Bowl {
  const object = makeSteelBowl();
  object.name = 'waterBowl';
  const water = phys({
    color: '#a9d6e6', roughness: 0.03, metalness: 0, transparent: true, opacity: 0.5, ior: 1.33,
    specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false, envMapIntensity: 1.6,
  });
  const liq = makeLiquid(water, 0.00022);
  liq.mesh.renderOrder = 2;
  object.add(liq.mesh);
  // faint tinted body so deep water reads bluer than shallow water
  const tint = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), stdm({ color: '#4d9dbb', transparent: true, opacity: 0.25, depthWrite: false, roughness: 0.2 }));
  tint.renderOrder = 1;
  object.add(tint);
  let fill = 1;
  const apply = () => {
    const y = BOWL_FLOOR + 0.0008 + fill * (BOWL_RIM - 0.007 - BOWL_FLOOR);
    liq.setLevel(y);
    liq.mesh.visible = tint.visible = fill > 0.001;
    const r = bowlInnerR(BOWL_FLOOR + 0.002) * 0.98;
    tint.position.y = BOWL_FLOOR + 0.0006;
    tint.scale.setScalar(r);
    (tint.material as THREE.MeshStandardMaterial).opacity = 0.12 + fill * 0.3;
    liq.update(0);
  };
  apply();
  return {
    object,
    rimHeight: BOWL_RIM,
    radius: BOWL_R,
    setFill(f) { fill = clamp01(f); apply(); },
    update(_dt, time) { if (fill > 0.001) liq.update(time); },
    dispose() { disposeObject(object); },
  };
}

// =============================================================================
// Shop items
// =============================================================================

const FONT = '"Avenir Next", "Trebuchet MS", "Helvetica Neue", Arial, sans-serif';

/** Bold outlined text for package prints. */
function title(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string, stroke?: string, weight = 800, maxW = 0) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (maxW) {
    const w = ctx.measureText(text).width;
    if (w > maxW) { ctx.translate(x, y); ctx.scale(maxW / w, 1); ctx.translate(-x, -y); }
  }
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Subtle print grain + gloss variation so flat prints don't look like stickers. */
function printNoise(ctx: CanvasRenderingContext2D, w: number, h: number, amt = 0.05, seed = 1) {
  const img = ctx.getImageData(0, 0, w, h);
  const rnd = rng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 255 * amt;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** A flat panel mapped to a sub-rectangle [u0, v0, u1, v1] of an atlas texture. */
function panel(w: number, h: number, rect: [number, number, number, number], m: THREE.Matrix4, sx = 1, sy = 1) {
  const g = new THREE.PlaneGeometry(w, h, sx, sy);
  remapUV(g, (u, v) => [rect[0] + (rect[2] - rect[0]) * u, rect[1] + (rect[3] - rect[1]) * v]);
  return g.applyMatrix4(m);
}

/**
 * Flexible package (bag / pouch): a box whose depth pillows out in the middle
 * and pinches flat into a heat seal at the top. Planar front UVs (u: x, v: y).
 */
function pillowBag(W: number, H: number, D: number, sealFrom = 0.86, bottomFlat = 0.1) {
  const g = new THREE.BoxGeometry(W, H, D, 16, 24, 6);
  g.translate(0, H / 2, 0);
  warp(g, (v) => {
    const u = v.x / (W / 2), t = v.y / H;
    const side = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), 5)), 0.45);
    const top = 1 - smoothstep(sealFrom - 0.22, sealFrom, t);
    const bottom = smoothstep(-0.02, bottomFlat, t) * 0.25 + 0.75;
    const f = Math.max(0.03, side * top * bottom);
    v.z *= f * (1 + 0.08 * Math.sin(t * Math.PI));
    v.x *= 1 - 0.035 * smoothstep(0.5, 1, t) - 0.03 * (1 - side) * top;
    // gentle crinkles
    v.z += D * 0.02 * (vnoise(v.x * 60, v.y * 60, 0, 5) - 0.5) * top;
  });
  planarUV(g, 'x', 'y', 1, 0.5, 0);
  remapUV(g, (u, v) => [0.5 + (u - 0.5) / W, v / H]);
  return g;
}

function bagPrint(): THREE.Texture {
  return drawTex('bagPrint', 512, 768, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#e2462c'); g.addColorStop(1, '#b8281a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // crimped seal
    ctx.fillStyle = '#9c2014'; ctx.fillRect(0, 0, w, h * 0.09);
    for (let x = 0; x < w; x += 7) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x, 0, 3, h * 0.085); }
    ctx.fillStyle = '#f7c948'; ctx.fillRect(0, h * 0.09, w, 10);
    // brand
    title(ctx, 'CRUNCHY', w / 2, h * 0.2, 86, '#fff', '#7a1208');
    title(ctx, 'PUP', w / 2, h * 0.31, 110, '#f7c948', '#7a1208');
    title(ctx, 'Complete puppy food', w / 2, h * 0.395, 30, '#ffe9d6', undefined, 600);
    // bowl of kibble illustration
    ctx.save();
    ctx.translate(w / 2, h * 0.62);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 88, 170, 22, 0, 0, Math.PI * 2); ctx.fill();
    const rnd = rng(3);
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI, r = rnd() * 130;
      const x = Math.cos(a) * r, y = -Math.sin(a) * r * 0.5 + 10;
      ctx.fillStyle = ['#8a4a22', '#a8652f', '#c58b4f'][i % 3];
      ctx.beginPath(); ctx.ellipse(x, y, 17, 13, rnd(), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,230,190,0.35)';
      ctx.beginPath(); ctx.ellipse(x - 4, y - 4, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    }
    const bg = ctx.createLinearGradient(-160, 0, 160, 0);
    bg.addColorStop(0, '#8d97a3'); bg.addColorStop(0.35, '#f2f4f6'); bg.addColorStop(1, '#6e7884');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.moveTo(-165, 10); ctx.quadraticCurveTo(-150, 95, 0, 95); ctx.quadraticCurveTo(150, 95, 165, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
    // badge + weight
    ctx.fillStyle = '#f7c948';
    ctx.beginPath(); ctx.arc(w * 0.83, h * 0.47, 52, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#b8281a'; pawPath(ctx, w * 0.83, h * 0.47, 58); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillRect(0, h * 0.86, w, h * 0.14);
    title(ctx, 'CHICKEN & RICE', w / 2, h * 0.905, 34, '#b8281a');
    title(ctx, '2 kg', w / 2, h * 0.955, 26, '#444', undefined, 700);
    printNoise(ctx, w, h, 0.04, 11);
  });
}

function makeDryFood(): THREE.Object3D {
  const W = 0.17, H = 0.25, D = 0.075;
  const mat = phys({ map: bagPrint(), roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.28, bumpMap: grainMaps().bump, bumpScale: 0.3 });
  return new Parts().add(pillowBag(W, H, D, 0.93, 0.08), mat).build();
}

function canLabel(): THREE.Texture {
  return drawTex('canLabel', 1024, 320, (ctx, w, h) => {
    ctx.fillStyle = '#1f5fa8'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f4ead2'; ctx.fillRect(0, h * 0.14, w, h * 0.72);
    ctx.fillStyle = '#e8a33a'; ctx.fillRect(0, h * 0.14, w, 8); ctx.fillRect(0, h * 0.86 - 8, w, 8);
    // repeating paws on the blue bands
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let x = 20; x < w; x += 60) { pawPath(ctx, x, h * 0.07, 26); ctx.fill(); pawPath(ctx, x + 30, h * 0.93, 26); ctx.fill(); }
    // front (u = 0.5): stew picture + name
    const cx = w / 2;
    ctx.fillStyle = '#7a3c22';
    ctx.beginPath(); ctx.ellipse(cx - 130, h * 0.52, 95, 70, 0, 0, Math.PI * 2); ctx.fill();
    const rnd = rng(5);
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = ['#a0583a', '#5f2d19', '#c46d3f', '#6aa82c'][i % 4];
      ctx.beginPath(); ctx.ellipse(cx - 130 + (rnd() - 0.5) * 140, h * 0.52 + (rnd() - 0.5) * 90, 14 + rnd() * 8, 10 + rnd() * 6, rnd() * 3, 0, Math.PI * 2); ctx.fill();
    }
    title(ctx, 'MEATY', cx + 90, h * 0.4, 70, '#1f5fa8', '#fff');
    title(ctx, 'CHUNKS', cx + 90, h * 0.62, 58, '#c0392b', '#fff');
    title(ctx, 'in gravy', cx + 90, h * 0.77, 28, '#5a3a20', undefined, 600);
    title(ctx, 'NET WT 400g', cx + 330, h * 0.77, 22, '#555', undefined, 600);
    printNoise(ctx, w, h, 0.03, 12);
  });
}

function makeCannedFood(): THREE.Object3D {
  const R = 0.0375, H = 0.105;
  const tin = metal('#d8dde2', 0.28);
  const label = phys({ map: canLabel(), roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4 });
  const P = new Parts();
  // body with rolled rims and a sunken lid
  const prof: [number, number][] = [
    [0, 0.0025], [R - 0.004, 0.0025], [R - 0.0025, 0.0008], [R - 0.0005, 0.0012], [R + 0.0006, 0.004], [R, 0.008],
    [R, H - 0.008], [R + 0.0006, H - 0.004], [R + 0.0002, H - 0.0006], [R - 0.0012, H], [R - 0.0024, H - 0.0022],
    [R - 0.0028, H - 0.0036], [R - 0.006, H - 0.0036], [R - 0.0068, H - 0.0024], [R - 0.0078, H - 0.0036], [0, H - 0.0036],
  ];
  P.add(lathe(prof, 40), tin);
  const band = new THREE.CylinderGeometry(R + 0.0004, R + 0.0004, H - 0.02, 40, 1, true, Math.PI, Math.PI * 2);
  P.add(band, label, null, M(0, H / 2, 0));
  // pull ring
  const ring = new THREE.TorusGeometry(0.0085, 0.0017, 6, 20);
  ring.scale(1, 1.25, 0.6);
  P.add(ring, tin, null, M(0, H - 0.0022, 0.014, -Math.PI / 2 + 0.05));
  P.add(new THREE.CylinderGeometry(0.004, 0.004, 0.0012, 12), tin, null, M(0, H - 0.0028, 0.004));
  return P.build();
}

function pouchPrint(): { map: THREE.Texture; metal: THREE.Texture } {
  const paint = (ctx: CanvasRenderingContext2D, w: number, h: number, metalPass: boolean) => {
    ctx.fillStyle = metalPass ? '#000' : '#2a1838'; ctx.fillRect(0, 0, w, h);
    if (!metalPass) {
      const g = ctx.createRadialGradient(w / 2, h * 0.55, 20, w / 2, h * 0.55, w * 0.8);
      g.addColorStop(0, '#4d2d66'); g.addColorStop(1, '#1d1028');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    const gold = metalPass ? '#fff' : '#d9ae55';
    // seals and gold trims
    ctx.fillStyle = gold;
    ctx.fillRect(0, h * 0.075, w, 6); ctx.fillRect(0, h * 0.9, w, 6);
    ctx.strokeStyle = gold; ctx.lineWidth = 4;
    rrect(ctx, 26, h * 0.12, w - 52, h * 0.74, 22); ctx.stroke();
    title(ctx, 'GOURMET', w / 2, h * 0.2, 64, gold, undefined, 700);
    title(ctx, 'SELECTION', w / 2, h * 0.27, 34, gold, undefined, 600);
    if (!metalPass) {
      // salmon fillet on a plate
      ctx.fillStyle = '#f5f0e8';
      ctx.beginPath(); ctx.ellipse(w / 2, h * 0.52, 150, 70, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f08a5d';
      ctx.beginPath(); ctx.ellipse(w / 2 - 20, h * 0.5, 90, 38, -0.15, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fbd2bd'; ctx.lineWidth = 5;
      for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(w / 2 - 20 + i * 22 - 10, h * 0.5 - 30); ctx.quadraticCurveTo(w / 2 - 20 + i * 22 + 8, h * 0.5, w / 2 - 20 + i * 22 - 6, h * 0.5 + 30); ctx.stroke(); }
      ctx.fillStyle = '#5c9e31';
      for (const [dx, dy] of [[70, 20], [85, -5], [60, 35]]) { ctx.beginPath(); ctx.arc(w / 2 + dx, h * 0.52 + dy, 10, 0, Math.PI * 2); ctx.fill(); }
      title(ctx, 'Salmon & Garden Veg', w / 2, h * 0.68, 30, '#f3e6c8', undefined, 600);
    }
    title(ctx, '★ ★ ★', w / 2, h * 0.76, 36, gold, undefined, 700);
    title(ctx, '85 g', w / 2, h * 0.83, 26, metalPass ? '#000' : '#cbb7de', undefined, 600);
    // tear notch marker
    ctx.fillStyle = gold; ctx.beginPath(); ctx.moveTo(0, h * 0.055); ctx.lineTo(18, h * 0.065); ctx.lineTo(0, h * 0.075); ctx.fill();
  };
  return {
    map: drawTex('pouchPrint', 512, 768, (ctx, w, h) => { paint(ctx, w, h, false); printNoise(ctx, w, h, 0.03, 13); }),
    metal: drawTex('pouchMetal', 512, 768, (ctx, w, h) => paint(ctx, w, h, true), false),
  };
}

function makePremiumFood(): THREE.Object3D {
  const t = pouchPrint();
  const mat = phys({ map: t.map, metalnessMap: t.metal, metalness: 1, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  return new Parts().add(pillowBag(0.1, 0.145, 0.034, 0.9, 0.16), mat).build();
}

function jerkyPrint(): { map: THREE.Texture; rough: THREE.Texture } {
  const paint = (ctx: CanvasRenderingContext2D, w: number, h: number, pass: 0 | 1) => {
    if (pass === 0) {
      ctx.fillStyle = '#b98b58'; ctx.fillRect(0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const n = fbm(x / 40, y / 40, 0, 3, 91) * 30 + (hash3(x, y, 0, 92) - 0.5) * 18;
        const o = (y * w + x) * 4;
        img.data[o] += n; img.data[o + 1] += n * 0.85; img.data[o + 2] += n * 0.6;
      }
      ctx.putImageData(img, 0, 0);
    } else { ctx.fillStyle = '#e6e6e6'; ctx.fillRect(0, 0, w, h); }
    // window showing the jerky inside
    const wx = w * 0.18, wy = h * 0.46, ww = w * 0.64, wh = h * 0.3;
    if (pass === 0) {
      ctx.save(); rrect(ctx, wx, wy, ww, wh, 30); ctx.clip();
      ctx.fillStyle = '#3a1a10'; ctx.fillRect(wx, wy, ww, wh);
      const rnd = rng(9);
      for (let i = 0; i < 9; i++) {
        ctx.save();
        ctx.translate(wx + rnd() * ww, wy + rnd() * wh); ctx.rotate(-0.6 + rnd() * 1.2);
        ctx.fillStyle = ['#6b2c18', '#5a2414', '#7d3a20'][i % 3];
        rrect(ctx, -110, -16, 220, 32 + rnd() * 10, 10); ctx.fill();
        ctx.fillStyle = 'rgba(255,200,160,0.18)'; ctx.fillRect(-100, -10, 200, 5);
        ctx.restore();
      }
      const gl = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
      gl.addColorStop(0, 'rgba(255,255,255,0.25)'); gl.addColorStop(0.3, 'rgba(255,255,255,0)'); gl.addColorStop(1, 'rgba(255,255,255,0.1)');
      ctx.fillStyle = gl; ctx.fillRect(wx, wy, ww, wh);
      ctx.restore();
      ctx.strokeStyle = '#7a1c14'; ctx.lineWidth = 5; rrect(ctx, wx, wy, ww, wh, 30); ctx.stroke();
    } else {
      ctx.fillStyle = '#303030'; rrect(ctx, wx, wy, ww, wh, 30); ctx.fill();
    }
    if (pass === 0) {
      // label band
      ctx.fillStyle = '#b3261c'; ctx.fillRect(0, h * 0.2, w, h * 0.2);
      ctx.fillStyle = '#f2d27a'; ctx.fillRect(0, h * 0.2, w, 5); ctx.fillRect(0, h * 0.4 - 5, w, 5);
      title(ctx, 'BEEF', w / 2, h * 0.26, 74, '#fff', '#5a0f0a');
      title(ctx, 'JERKY', w / 2, h * 0.345, 66, '#f2d27a', '#5a0f0a');
      title(ctx, 'Natural dog treats', w / 2, h * 0.83, 30, '#4a2a14', undefined, 700);
      title(ctx, '100% real beef', w / 2, h * 0.88, 24, '#6b4424', undefined, 600);
      // zip line + seal
      ctx.fillStyle = 'rgba(60,35,15,0.35)'; ctx.fillRect(0, h * 0.13, w, 4);
      for (let x = 0; x < w; x += 6) { ctx.fillStyle = 'rgba(60,35,15,0.25)'; ctx.fillRect(x, 0, 3, h * 0.07); }
    }
  };
  return {
    map: drawTex('jerkyPrint', 512, 768, (ctx, w, h) => paint(ctx, w, h, 0)),
    rough: drawTex('jerkyRough', 256, 384, (ctx, w, h) => { ctx.scale(0.5, 0.5); paint(ctx, w * 2, h * 2, 1); }, false),
  };
}

function makeJerky(): THREE.Object3D {
  const t = jerkyPrint();
  const mat = phys({ map: t.map, roughnessMap: t.rough, roughness: 1, clearcoat: 0.25, clearcoatRoughness: 0.5, bumpMap: grainMaps().bump, bumpScale: 0.8 });
  return new Parts().add(pillowBag(0.12, 0.17, 0.04, 0.92, 0.14), mat).build();
}

function milkAtlas(): THREE.Texture {
  // atlas: [0,.5]x[0,1] front/back panel, [.5,.75] side, [.75,1] roof; fin strip along the top of the side area
  return drawTex('milkAtlas', 1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#fbfbf8'; ctx.fillRect(0, 0, w, h);
    const pw = w * 0.5;
    // cow spots
    const rnd = rng(21);
    ctx.fillStyle = '#1d1d22';
    for (let i = 0; i < 12; i++) {
      const x = rnd() * w * 0.75, y = h * 0.64 + rnd() * h * 0.32, r = 14 + rnd() * 24;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.ellipse(x + (rnd() - 0.5) * r, y + (rnd() - 0.5) * r * 0.6, r * (0.4 + rnd() * 0.4), r * (0.3 + rnd() * 0.3), rnd() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // blue top band on panels
    ctx.fillStyle = '#2b6cc4'; ctx.fillRect(0, 0, w * 0.75, h * 0.2);
    ctx.fillStyle = '#e53935'; ctx.fillRect(0, h * 0.2, w * 0.75, 8);
    title(ctx, 'MILK', pw / 2, h * 0.36, 120, '#2b6cc4', '#fff');
    title(ctx, 'for puppies', pw / 2, h * 0.5, 36, '#e53935', undefined, 700);
    title(ctx, 'Lactose free', pw / 2, h * 0.1, 34, '#fff', undefined, 700);
    ctx.fillStyle = '#fff'; pawPath(ctx, pw * 0.86, h * 0.44, 40); ctx.fill();
    ctx.fillStyle = '#2b6cc4'; pawPath(ctx, pw * 0.86, h * 0.44, 34); ctx.fill();
    title(ctx, '500 ml', w * 0.625, h * 0.42, 30, '#2b6cc4', undefined, 700);
    // roof: blue with a drop icon
    ctx.fillStyle = '#2b6cc4'; ctx.fillRect(w * 0.75, 0, w * 0.25, h);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(w * 0.875, h * 0.3); ctx.quadraticCurveTo(w * 0.93, h * 0.55, w * 0.875, h * 0.62); ctx.quadraticCurveTo(w * 0.82, h * 0.55, w * 0.875, h * 0.3); ctx.fill();
    printNoise(ctx, w, h, 0.03, 14);
  });
}

function makeMilk(): THREE.Object3D {
  const S = 0.068, H = 0.13, G = 0.03, F = 0.012;
  const mat = phys({ map: milkAtlas(), roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.35 });
  const P = new Parts();
  const front: [number, number, number, number] = [0, 0, 0.5, 1], side: [number, number, number, number] = [0.5, 0, 0.75, 1];
  const roof: [number, number, number, number] = [0.75, 0, 1, 1];
  P.add(panel(S, H, front, M(0, H / 2, S / 2)), mat);
  P.add(panel(S, H, front, M(0, H / 2, -S / 2, 0, Math.PI)), mat);
  P.add(panel(S, H, side, M(S / 2, H / 2, 0, 0, Math.PI / 2)), mat);
  P.add(panel(S, H, side, M(-S / 2, H / 2, 0, 0, -Math.PI / 2)), mat);
  P.add(panel(S, S, [0.6, 0.9, 0.62, 0.92], M(0, 0.0005, 0, Math.PI / 2)), mat);
  // gable roof panels
  const slope = Math.hypot(S / 2, G);
  const ang = Math.atan2(S / 2, G);
  for (const s of [1, -1]) {
    const m = M(0, H + G / 2, (s * S) / 4, -s * ang, s > 0 ? 0 : Math.PI, 0);
    P.add(panel(S, slope, roof, m), mat);
  }
  // side gables folded inwards into a V
  for (const s of [1, -1]) {
    const tri = new THREE.BufferGeometry();
    const x = s * (S / 2 - 0.0005), xi = s * (S / 2 - 0.02);
    tri.setAttribute('position', new THREE.Float32BufferAttribute([x, H, -S / 2, x, H, S / 2, x, H + G, 0, xi, H + G * 0.45, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0.52, 0.66, 0.73, 0.66, 0.62, 0.72, 0.62, 0.7], 2));
    tri.setIndex(s > 0 ? [0, 3, 2, 3, 1, 2, 0, 1, 3] : [0, 2, 3, 3, 2, 1, 0, 3, 1]);
    tri.computeVertexNormals();
    P.add(tri, mat);
  }
  // top fin (samples the plain blue roof colour)
  const fin = new THREE.BoxGeometry(S, F, 0.003);
  remapUV(fin, (u, v) => [0.76 + u * 0.03, 0.05 + v * 0.1]);
  P.add(fin, mat, null, M(0, H + G + F / 2 - 0.001, 0));
  return P.build();
}

function waterLabel(): THREE.Texture {
  return drawTex('waterLabel', 1024, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#e9f6fd'); g.addColorStop(1, '#bfe2f5');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // mountains
    ctx.fillStyle = '#5aa0d8';
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 32) ctx.lineTo(x, h * 0.7 - Math.abs(Math.sin(x * 0.011)) * h * 0.35 - Math.sin(x * 0.037) * 10);
    ctx.lineTo(w, h); ctx.fill();
    ctx.fillStyle = '#2f78c0';
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 24) ctx.lineTo(x, h * 0.85 - Math.abs(Math.sin(x * 0.02 + 1)) * h * 0.2);
    ctx.lineTo(w, h); ctx.fill();
    title(ctx, 'SPRING', w / 2, h * 0.3, 70, '#1c5ea8', '#fff');
    title(ctx, 'natural water', w / 2, h * 0.55, 30, '#1c5ea8', undefined, 700);
    title(ctx, '500 ml', w * 0.82, h * 0.3, 30, '#1c5ea8', undefined, 700);
  });
}

function makeWaterBottle(): THREE.Object3D {
  const R = 0.032;
  const prof: [number, number][] = [
    [0, 0.001], [R * 0.6, 0.0005], [R * 0.92, 0.003], [R, 0.012], [R, 0.05], [R * 0.93, 0.056], [R, 0.062],
    [R, 0.135], [R * 0.93, 0.141], [R, 0.147], [R * 0.98, 0.158], [R * 0.85, 0.178], [R * 0.62, 0.192],
    [0.0135, 0.2], [0.0135, 0.206], [0.0165, 0.207], [0.0165, 0.209], [0.0135, 0.21], [0.0135, 0.213],
  ];
  const plastic = phys({
    color: '#dff1fa', roughness: 0.05, transparent: true, opacity: 0.14, clearcoat: 1, clearcoatRoughness: 0.03,
    ior: 1.5, specularIntensity: 1, depthWrite: false, envMapIntensity: 1.4,
  });
  const water = phys({ color: '#6fb8e0', roughness: 0.05, transparent: true, opacity: 0.22, depthWrite: false });
  const label = phys({ map: waterLabel(), roughness: 0.35, clearcoat: 0.5 });
  const cap = plastic.clone();
  cap.setValues({ color: '#1f6fd0', transparent: false, opacity: 1, roughness: 0.35, side: THREE.FrontSide, depthWrite: true, clearcoat: 0.3 });
  const group = new THREE.Group();
  const waterProf = prof.filter(([, y]) => y < 0.172).map(([r, y]) => [Math.max(0, r - 0.0012), y + 0.0012] as [number, number]);
  waterProf.push([0, 0.172]);
  const wmesh = new THREE.Mesh(lathe(waterProf, 32), water);
  wmesh.renderOrder = 1;
  const bottle = new THREE.Mesh(lathe(prof, 36), plastic);
  bottle.renderOrder = 2;
  const lab = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.0004, R + 0.0004, 0.068, 36, 1, true, Math.PI, Math.PI * 2), label);
  lab.position.y = 0.1;
  const capProf: [number, number][] = [[0, 0.232], [0.0148, 0.232], [0.0156, 0.2305], [0.0156, 0.2115], [0.0172, 0.2105], [0.0172, 0.209], [0.0142, 0.209]];
  const capGeo = lathe(capProf, 40);
  // knurled ridges
  warp(capGeo, (v) => {
    const r = Math.hypot(v.x, v.z);
    if (r > 0.0153 && v.y > 0.212 && v.y < 0.2302) {
      const a = Math.atan2(v.z, v.x);
      const k = 1 + 0.03 * Math.sign(Math.sin(a * 20));
      v.x *= k; v.z *= k;
    }
  });
  group.add(wmesh, bottle, lab, new THREE.Mesh(capGeo, cap));
  return shadowed(group);
}

function woodMaps(): Maps {
  const a = hex('#c58a52'), b = hex('#8f5a2e');
  return pixelMaps('wood', 256, 256, (u, v, p) => {
    const warpN = fbm(u * 3, v * 1.5, 0, 3, 101, 3, 2) * 4;
    const ring = 0.5 + 0.5 * Math.sin((u * 18 + warpN) * Math.PI * 2 * 0.5);
    const fine = vnoise(u * 180, v * 8, 0, 102, 180, 8);
    const c = mixRGB(a, b, Math.pow(ring, 3) * 0.7 + fine * 0.15);
    setRGB(p, c);
    p.h = ring * 0.4 + fine * 0.6;
    p.m = 0.55 + fine * 0.2;
  });
}

function makeBrush(): THREE.Object3D {
  const wood = woodMaps();
  const woodMat = phys({ map: wood.map, bumpMap: wood.bump, bumpScale: 0.6, roughness: 0.45, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  const rubber = phys({ color: '#2a2c33', roughness: 0.7, bumpMap: grainMaps().bump, bumpScale: 0.3 });
  const pinMat = metal(SILVER, 0.3);
  const tipMat = plastic('#1d1d1f', 0.3);
  // paddle outline in XZ: oval head (+Z) and a tapered handle (-Z)
  const shape = new THREE.Shape();
  const hw = 0.034, hl = 0.046, hz = 0.035;
  shape.moveTo(0.011, -0.012);
  shape.absellipse(0, hz, hw, hl, -Math.PI / 2 + 0.33, Math.PI * 1.5 - 0.33, false, 0);
  shape.lineTo(-0.011, -0.012);
  shape.bezierCurveTo(-0.012, -0.05, -0.015, -0.09, -0.012, -0.12);
  shape.quadraticCurveTo(0, -0.128, 0.012, -0.12);
  shape.bezierCurveTo(0.015, -0.09, 0.012, -0.05, 0.011, -0.012);
  const body = new THREE.ExtrudeGeometry(shape, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 12 });
  body.rotateX(Math.PI / 2);
  body.translate(0, 0.011, 0);
  planarUV(body, 'z', 'x', 3, 0.5, 0.5);
  const P = new Parts();
  P.add(body, woodMat);
  // rubber cushion and pins
  const cushion = new THREE.SphereGeometry(1, 20, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  P.add(cushion, rubber, null, M(0, 0.0105, hz, 0, 0, 0, hw * 0.84, 0.004, hl * 0.86));
  const pin = new THREE.CylinderGeometry(0.0005, 0.0005, 0.011, 3, 1, true);
  const tip = new THREE.SphereGeometry(0.0011, 4, 3);
  const pins: THREE.BufferGeometry[] = [], tips: THREE.BufferGeometry[] = [];
  for (let iz = -6; iz <= 6; iz++) {
    for (let ix = -5; ix <= 5; ix++) {
      const x = (ix + (iz % 2 ? 0.5 : 0)) * 0.0052, z = iz * 0.0063;
      if ((x / (hw * 0.76)) ** 2 + (z / (hl * 0.78)) ** 2 > 1) continue;
      pins.push(pin.clone().translate(x, 0.019, hz + z));
      tips.push(tip.clone().translate(x, 0.0248, hz + z));
    }
  }
  P.add(mergeGeometries(pins.map((g) => prep(g, null)))!, pinMat);
  P.add(mergeGeometries(tips.map((g) => prep(g, null)))!, tipMat);
  pin.dispose(); tip.dispose();
  // hanging hole in the handle
  P.add(new THREE.TorusGeometry(0.004, 0.0012, 6, 16), metal(BRASS, 0.3), null, M(0, 0.0115, -0.105, Math.PI / 2));
  return P.build();
}

function shampooLabel(): THREE.Texture {
  return drawTex('shampooLabel', 1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    // only the front half carries the print
    ctx.save();
    ctx.beginPath(); rrect(ctx, w * 0.3, h * 0.08, w * 0.4, h * 0.84, 40); ctx.clip();
    const g = ctx.createLinearGradient(0, h * 0.08, 0, h * 0.92);
    g.addColorStop(0, '#fff7fb'); g.addColorStop(1, '#ffe0ee');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const rnd = rng(31);
    for (let i = 0; i < 22; i++) {
      const x = w * 0.3 + rnd() * w * 0.4, y = h * 0.08 + rnd() * h * 0.35, r = 8 + rnd() * 26;
      ctx.strokeStyle = 'rgba(120,170,230,0.6)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.18, 0, Math.PI * 2); ctx.fill();
    }
    title(ctx, 'Puppy', w / 2, h * 0.46, 76, '#e05297', '#fff');
    title(ctx, 'SHAMPOO', w / 2, h * 0.6, 60, '#3a78c9', '#fff');
    title(ctx, 'gentle · tear free', w / 2, h * 0.72, 28, '#7a5a6a', undefined, 600);
    ctx.fillStyle = '#e05297'; pawPath(ctx, w / 2, h * 0.83, 46); ctx.fill();
    ctx.restore();
  });
}

function makeShampoo(): THREE.Object3D {
  const bottle = phys({ color: '#f58fbf', roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.1, sheen: 0.3, sheenColor: new THREE.Color('#ffd0e6') });
  const label = phys({ map: shampooLabel(), roughness: 0.3, clearcoat: 0.6, transparent: false });
  const capMat = plastic('#f7f4f0', 0.3);
  const prof: [number, number][] = [
    [0, 0.001], [0.018, 0.0008], [0.024, 0.004], [0.026, 0.012], [0.026, 0.11], [0.0245, 0.125], [0.019, 0.138],
    [0.012, 0.146], [0.0105, 0.15],
  ];
  const P = new Parts();
  const body = lathe(prof, 40, Math.PI);
  body.scale(1.35, 1, 0.82);
  P.add(body, bottle);
  const lab = new THREE.CylinderGeometry(0.0262, 0.0262, 0.085, 40, 1, true, Math.PI, Math.PI * 2);
  lab.scale(1.35, 1, 0.82);
  P.add(lab, label, null, M(0, 0.062, 0));
  // flip-top cap
  const capProf: [number, number][] = [[0.0103, 0.148], [0.0148, 0.1482], [0.0152, 0.15], [0.0152, 0.166], [0.0146, 0.1695], [0.009, 0.171], [0, 0.171]];
  const cap = lathe(capProf, 32);
  cap.scale(1.25, 1, 1);
  P.add(cap, capMat);
  P.add(new THREE.BoxGeometry(0.006, 0.0022, 0.004), capMat, null, M(0, 0.1705, 0.016));
  return P.build();
}

function towelMaps(): Maps {
  const blue = hex('#72b3de'), white = hex('#f3f6f7');
  return pixelMaps('towel', 256, 256, (u, v, p) => {
    const N = 110;
    const x = u * N, y = v * N;
    const j = hash3(mod(Math.floor(x), N), mod(Math.floor(y), N), 0, 111), j2 = hash3(mod(Math.floor(x), N), mod(Math.floor(y), N), 1, 111);
    const fx = x - Math.floor(x) - 0.5 + (j - 0.5) * 0.45, fy = y - Math.floor(y) - 0.5 + (j2 - 0.5) * 0.45;
    const loop = 1 - smoothstep(0.12, 0.55, Math.hypot(fx, fy));
    const n = fbm(u * 10, v * 10, 0, 3, 112, 10, 10);
    // woven border band across the towel (flat weave, no loops)
    const band = smoothstep(0.18, 0.19, u) * (1 - smoothstep(0.255, 0.265, u));
    const weave = 0.5 + 0.5 * Math.sin(v * 900);
    const c = band > 0.5 ? white : blue;
    const k = band > 0.5 ? 0.9 + weave * 0.08 : 0.82 + loop * 0.14 + n * 0.08;
    setRGB(p, c, k);
    p.h = band > 0.5 ? 0.35 + weave * 0.1 : loop * 0.8 + n * 0.2;
    p.m = 1;
  });
}

function makeTowel(): THREE.Object3D {
  const tm = towelMaps();
  const mat = phys({
    map: tm.map, bumpMap: tm.bump, bumpScale: 1.2, roughness: 1,
    sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color('#e4f4ff'),
  });
  const W = 0.2, D = 0.13, T = 0.016;
  const P = new Parts();
  const uvOf = (g: THREE.BufferGeometry) => {
    const pp = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    for (let k = 0; k < pp.count; k++) uv.setXY(k, pp.getX(k) * 4 + 0.5, pp.getZ(k) * 4 + pp.getY(k) * 4);
  };
  // three soft layers of a Z-folded towel; the folds bulge out on alternate sides
  for (let i = 0; i < 3; i++) {
    const g = new RoundedBoxGeometry(W - i * 0.003, T, D - i * 0.002, 4, T * 0.48);
    warp(g, (v) => {
      const ex = Math.abs(v.x) / (W / 2), ez = Math.abs(v.z) / (D / 2);
      v.y *= 1 + 0.18 * (1 - Math.pow(ex, 4)) * (1 - Math.pow(ez, 4));
    });
    g.translate(i * 0.0015, T * 0.55 + i * T * 0.96, (i - 1) * 0.001);
    uvOf(g);
    P.add(g, mat);
  }
  for (const [side, y] of [[-1, T * 1.03], [1, T * 1.99]] as const) {
    const fold = new THREE.CylinderGeometry(T * 0.98, T * 0.98, D - 0.004, 16, 1, true, side > 0 ? 0 : Math.PI, Math.PI);
    fold.rotateX(Math.PI / 2);
    fold.translate(side * (W / 2 - T * 0.95), y, 0);
    uvOf(fold);
    P.add(fold, mat);
  }
  return P.build();
}

function makeShowerHead(): THREE.Object3D {
  const chrome = metal(CHROME, 0.12, { clearcoat: 0.5 });
  const hose = metal('#cfd3d7', 0.25);
  const P = new Parts();
  // hose stub: ribbed metal tube standing up from the floor
  const hoseGeo = new THREE.CylinderGeometry(0.0075, 0.0075, 0.06, 10, 30, false);
  warp(hoseGeo, (v) => { const k = 1 + 0.08 * Math.abs(Math.sin(v.y * 520)); v.x *= k; v.z *= k; });
  P.add(hoseGeo, hose, null, M(0, 0.03, 0));
  P.add(new THREE.CylinderGeometry(0.0095, 0.0095, 0.012, 16), chrome, null, M(0, 0.064, 0));
  // handle: a slightly curved, tapering tube
  const pts = [v3(0, 0.068, 0), v3(0, 0.12, 0.004), v3(0, 0.17, 0.014), v3(0, 0.2, 0.026)];
  const curve = new THREE.CatmullRomCurve3(pts);
  const handle = new THREE.TubeGeometry(curve, 16, 0.0105, 14, false);
  warp(handle, (v) => {
    const t = clamp01((v.y - 0.068) / 0.132);
    const c = curve.getPoint(t);
    const k = 0.8 + 0.2 * t;
    v.x = c.x + (v.x - c.x) * k; v.z = c.z + (v.z - c.z) * k;
  });
  P.add(handle, chrome);
  // head: a shallow dish facing forward and slightly down
  const R = 0.04;
  const headProf: [number, number][] = [[0, -0.014], [0.012, -0.0138], [0.03, -0.0105], [0.038, -0.006], [R, 0], [R - 0.0005, 0.003], [R - 0.003, 0.004]];
  const head = lathe(headProf, 40);
  const headM = M(0, 0.226, 0.04, Math.PI / 2 - 0.35, 0, 0);
  P.add(head, chrome, null, headM);
  // face plate with rings of soft rubber nozzles (painted + bumped)
  const fm = pixelMaps('showerFace', 256, 256, (u, v, p) => {
    const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
    const a = Math.atan2(y, x);
    let d = 1;
    for (let ring = 1; ring <= 4; ring++) {
      const n = ring * 8, rr = ring * 0.21;
      const k = Math.round(((a - ring) / (Math.PI * 2)) * n);
      const aa = (k / n) * Math.PI * 2 + ring;
      d = Math.min(d, Math.hypot(x - Math.cos(aa) * rr, y - Math.sin(aa) * rr));
    }
    const nub = 1 - smoothstep(0.03, 0.05, d);
    const hole = 1 - smoothstep(0.008, 0.016, d);
    setRGB(p, mixRGB(hex('#e8eaec'), hex('#b9bec4'), nub * 0.8), 1 - hole * 0.7);
    p.h = 0.4 + nub * 0.5 - hole * 0.4;
    p.m = 0.2 + nub * 0.4;
  }, false);
  const faceMat = phys({ map: fm.map, bumpMap: fm.bump, bumpScale: 3, roughnessMap: fm.aux, roughness: 1, metalness: 0.6 });
  const face = new THREE.CircleGeometry(R - 0.003, 40);
  face.rotateX(-Math.PI / 2);
  planarUV(face, 'x', 'z', 1 / (2 * (R - 0.003)), 0.5, 0.5);
  P.add(face, faceMat, null, headM.clone().multiply(M(0, 0.0038, 0)));
  // neck joining handle and head
  P.add(new THREE.SphereGeometry(0.012, 16, 10), chrome, null, M(0, 0.205, 0.028));
  return P.build();
}

function makePoopBag(): THREE.Object3D {
  const R = 0.018, L = 0.058;
  const film = phys({ color: '#3fae4a', roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.25, sheen: 0.4, sheenColor: new THREE.Color('#bff5c4') });
  const endTex = drawTex('rollEnd', 256, 256, (ctx, w) => {
    ctx.fillStyle = '#2f8a39'; ctx.fillRect(0, 0, w, w);
    for (let r = w * 0.5; r > w * 0.18; r -= 3.2) {
      ctx.strokeStyle = r % 2 < 1 ? 'rgba(160,240,170,0.45)' : 'rgba(10,60,20,0.35)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(w / 2, w / 2, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = '#b89568'; ctx.beginPath(); ctx.arc(w / 2, w / 2, w * 0.18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a2a1a'; ctx.beginPath(); ctx.arc(w / 2, w / 2, w * 0.14, 0, Math.PI * 2); ctx.fill();
  });
  const pawTex = drawTex('rollPaws', 256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    for (let i = 0; i < 6; i++) { ctx.fillStyle = '#d8f6dc'; pawPath(ctx, 20 + i * 44, i % 2 ? 40 : 90, 26); ctx.fill(); }
  }, true, true);
  const rollMat = film.clone(); rollMat.map = pawTex;
  const endMat = phys({ map: endTex, roughness: 0.5, clearcoat: 0.3 });
  const P = new Parts();
  const body = new THREE.CylinderGeometry(R, R, L, 32, 1, true);
  remapUV(body, (u, v) => [u * 2, v]);
  P.add(body, rollMat, null, M(0, R, 0, 0, 0, Math.PI / 2));
  for (const s of [1, -1]) {
    const cap = new THREE.CircleGeometry(R, 32);
    P.add(cap, endMat, null, M((s * L) / 2, R, 0, 0, (s * Math.PI) / 2, 0));
  }
  // loose end of the film peeling off the roll and draping onto the floor
  const flap = new THREE.PlaneGeometry(L * 0.96, 0.05, 1, 12);
  warp(flap, (v) => {
    const t = (v.y + 0.025) / 0.05; // 0 at the roll, 1 at the free end
    const rr = R + 0.0006;
    if (t < 0.45) { const a = -0.2 + t * 2.4; v.y = R + Math.sin(-a) * rr; v.z = Math.cos(a) * rr; }
    else { const k = (t - 0.45) / 0.55; v.y = Math.max(0.0008, R - Math.sin(0.88) * rr - k * 0.016); v.z = Math.cos(0.88) * rr * 0.4 + 0.012 + k * 0.026; }
  });
  const flapMat = film.clone(); flapMat.side = THREE.DoubleSide; flapMat.map = pawTex;
  P.add(flap, flapMat);
  return P.build();
}

function giftPaper(): THREE.Texture {
  return drawTex('giftPaper', 512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#d6332f'; ctx.fillRect(0, 0, w, h);
    const rnd = rng(41);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const cx = (x + (y % 2) * 0.5) * (w / 8), cy = y * (h / 8) + 32;
      ctx.fillStyle = '#fbf3e6';
      ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
      if (rnd() < 0.5) { ctx.fillStyle = '#f5c542'; title(ctx, '★', cx + w / 16, cy + h / 16, 22, '#f5c542'); }
    }
    printNoise(ctx, w, h, 0.03, 15);
  }, true, true);
}

/** Flat ribbon strip following a polyline; `side` gives the width direction per point. */
function ribbonStrip(pts: THREE.Vector3[], width: number | ((t: number) => number), side: (i: number, t: number) => THREE.Vector3): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = typeof width === 'number' ? width : width(t);
    const s = side(i, t).clone().normalize().multiplyScalar(w / 2);
    const p = pts[i];
    pos.push(p.x - s.x, p.y - s.y, p.z - s.z, p.x + s.x, p.y + s.y, p.z + s.z);
    uv.push(0, t, 1, t);
    if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A two-loop ribbon bow centred at the origin and facing +Z: the loops fan out
 * along ±X (running out along the front and back along the rear), the tails
 * hang down in front. `size` is the half span of the loops.
 */
function bowGeometry(size: number, width: number, tails = true): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = Math.sin(a / 2); // 0 at the knot, 1 at the loop tip
      pts.push(v3(s * size * r * (0.62 + 0.38 * r), size * (0.16 * r - 0.08 * r * r), size * 0.3 * Math.sin(a) * (0.3 + 0.7 * r)));
    }
    out.push(ribbonStrip(pts, (t) => width * (0.75 + 0.65 * Math.sin(t * Math.PI)), (_i, t) => v3(-s * 0.18 * Math.sin(t * Math.PI), 1, 0)));
    if (tails) {
      const tp: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        tp.push(v3(s * (0.08 + t * 0.42) * size, -t * size * 1.0, size * (0.14 + 0.06 * Math.sin(t * 3))));
      }
      out.push(ribbonStrip(tp, width * 0.9, () => v3(1, s * 0.42, 0)));
    }
  }
  const knot = new RoundedBoxGeometry(width * 0.85, width * 1.05, width * 0.75, 2, width * 0.3);
  knot.translate(0, 0, size * 0.04);
  out.push(knot);
  return out;
}

function makePresent(): THREE.Object3D {
  const S = 0.11, H = 0.095;
  const paper = phys({ map: giftPaper(), roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.4 });
  const satin = phys({ color: '#e9ad24', roughness: 0.28, metalness: 0.35, sheen: 1, sheenColor: new THREE.Color('#ffe9a0'), sheenRoughness: 0.25, clearcoat: 0.5, clearcoatRoughness: 0.2, side: THREE.DoubleSide });
  const P = new Parts();
  // map each face with its own planar projection
  const boxUV = (g: THREE.BufferGeometry, oy: number) => {
    const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
      const a = ax > 0.5 ? p.getZ(i) : p.getX(i), b = ay > 0.5 ? p.getZ(i) : p.getY(i) + oy;
      uv.setXY(i, a * 4, b * 4);
    }
    return g;
  };
  P.add(boxUV(new THREE.BoxGeometry(S, H, S), H / 2), paper, null, M(0, H / 2, 0));
  // lid overlap lip
  P.add(boxUV(new THREE.BoxGeometry(S + 0.003, 0.02, S + 0.003), H - 0.0095), paper, null, M(0, H - 0.0095, 0));
  // ribbon bands over the lid
  const band = 0.016;
  P.add(new THREE.BoxGeometry(band, H + 0.0015, S + 0.0045), satin, null, M(0, H / 2 + 0.0004, 0));
  P.add(new THREE.BoxGeometry(S + 0.0045, H + 0.0015, band), satin, null, M(0, H / 2 + 0.0004, 0));
  // bow on top, tilted back
  // a full four-loop bow: a front-facing pair and a smaller crossways pair
  const bowM = M(0, H + 0.012, 0.004, -0.25, 0.25, 0);
  for (const g of bowGeometry(0.038, band * 1.25, true)) P.add(g, satin, null, bowM);
  for (const g of bowGeometry(0.032, band * 1.15, false)) P.add(g, satin, null, bowM.clone().multiply(M(0, 0.003, -0.004, 0, Math.PI / 2, 0)));
  return P.build();
}

/** Builds a shop / inventory item, standing on y = 0 and facing +Z. */
export function makeItem(kind: ItemKind): THREE.Object3D {
  const make: Record<ItemKind, () => THREE.Object3D> = {
    dryFood: makeDryFood, cannedFood: makeCannedFood, premiumFood: makePremiumFood, jerky: makeJerky,
    milk: makeMilk, waterBottle: makeWaterBottle, brush: makeBrush, shampoo: makeShampoo, towel: makeTowel,
    showerHead: makeShowerHead, poopBag: makePoopBag, present: makePresent,
  };
  const o = make[kind]();
  o.name = kind;
  return o;
}

// =============================================================================
// Collectibles (dug up on walks)
// =============================================================================

function leatherMaps(): Maps {
  const base = hex('#7a4a2a'), worn = hex('#b0784a'), dark = hex('#3e2414');
  return pixelMaps('leather', 256, 256, (u, v, p) => {
    const grain = vnoise(u * 90, v * 90, 0, 121, 90, 90);
    const crease = Math.pow(Math.abs(Math.sin((v * 7 + fbm(u * 4, v * 4, 0, 3, 122, 4, 4) * 2) * Math.PI)), 12);
    const wear = smoothstep(0.55, 0.75, fbm(u * 5, v * 5, 1, 4, 123, 5, 5));
    const dirt = smoothstep(0.5, 0.8, fbm(u * 3, v * 3, 2, 4, 124, 3, 3));
    let c = mixRGB(base, worn, wear * 0.7);
    c = mixRGB(c, dark, dirt * 0.5 + crease * 0.35);
    setRGB(p, c, 0.9 + grain * 0.15);
    p.h = grain * 0.4 + (1 - crease) * 0.5;
    p.m = 0.55 + wear * 0.25 + dirt * 0.15;
  });
}

function makeOldBoot(): THREE.Object3D {
  const lm = leatherMaps();
  const leather = phys({ map: lm.map, bumpMap: lm.bump, bumpScale: 1.5, roughnessMap: lm.aux, roughness: 1, clearcoat: 0.15, clearcoatRoughness: 0.6, side: THREE.DoubleSide });
  const sole = phys({ color: '#2e2926', roughness: 0.85, bumpMap: grainMaps().bump, bumpScale: 1 });
  const laceMat = phys({ color: '#8f7550', roughness: 0.9, sheen: 0.5, sheenColor: new THREE.Color('#c8b890') });
  const brass = metal(BRASS, 0.45);
  const inside = stdm({ color: '#1c1410', roughness: 1 });
  const P = new Parts();
  // sole: footprint outline extruded down from y = 0.014
  const fp = new THREE.Shape();
  fp.moveTo(0, -0.125);
  fp.bezierCurveTo(0.038, -0.125, 0.036, -0.06, 0.04, -0.02);
  fp.bezierCurveTo(0.048, 0.04, 0.05, 0.1, 0.03, 0.125);
  fp.bezierCurveTo(0.015, 0.14, -0.02, 0.14, -0.035, 0.12);
  fp.bezierCurveTo(-0.048, 0.08, -0.044, 0.0, -0.038, -0.03);
  fp.bezierCurveTo(-0.036, -0.08, -0.036, -0.125, 0, -0.125);
  const soleGeo = new THREE.ExtrudeGeometry(fp, { depth: 0.011, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1, curveSegments: 10 });
  soleGeo.rotateX(Math.PI / 2);
  soleGeo.translate(0, 0.013, 0);
  P.add(soleGeo, sole);
  // foot of the upper
  const foot = new THREE.SphereGeometry(1, 22, 14);
  warp(foot, (v) => {
    v.x *= 0.044; v.y *= 0.056; v.z *= 0.118;
    v.z += 0.012;
    // lower toe box, flat underside, instep rising into the shaft
    const toe = smoothstep(-0.03, 0.1, v.z);
    v.y = v.y > 0 ? v.y * (1 - 0.5 * toe) : v.y * 0.3;
    v.y += 0.03;
    if (v.y < 0.015) v.y = 0.015;
    v.x *= 1 + 0.1 * smoothstep(0, 0.08, v.z);
  });
  P.add(foot, leather);
  // shaft: slumped cylinder with creases, open at the top
  const shaft = new THREE.CylinderGeometry(0.041, 0.049, 0.12, 24, 8, true);
  warp(shaft, (v) => {
    const t = (v.y + 0.06) / 0.12;
    v.z += -0.01 * t + 0.018 * t * t;
    v.x *= 1 + 0.04 * Math.sin(t * 9);
    v.z *= 1 + 0.05 * Math.sin(t * 7 + 1);
    v.y += 0.075 + 0.06;
    v.z -= 0.058;
  });
  P.add(shaft, leather);
  // padded collar and dark opening
  P.add(new THREE.TorusGeometry(0.043, 0.0055, 6, 24), leather, null, M(0, 0.194, -0.049, Math.PI / 2 - 0.12, 0, 0, 1, 1, 1));
  P.add(new THREE.CircleGeometry(0.041, 24), inside, null, M(0, 0.185, -0.05, -Math.PI / 2 - 0.12, 0, 0));
  // tongue
  const tongue = new THREE.CylinderGeometry(0.02, 0.02, 0.04, 10, 4, true, -0.8, 1.6);
  warp(tongue, (v) => { v.z += Math.pow((v.y + 0.02) / 0.04, 2) * 0.01; });
  P.add(tongue, leather, null, M(0, 0.195, -0.034, -0.25, 0, 0));
  // laces and eyelets across the instep
  for (let i = 0; i < 5; i++) {
    const y = 0.07 + i * 0.024, z = 0.035 - i * 0.017;
    const w = 0.02 - i * 0.001;
    for (const s of [1, -1]) P.add(new THREE.TorusGeometry(0.0028, 0.0009, 4, 8), brass, null, M(s * w, y, z, -0.9 + i * 0.12, s * 0.5, 0));
    const lace = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(v3(-w, y, z), v3(0, y + 0.004, z + 0.012), v3(w, y + 0.012, z - 0.006)), 8, 0.0019, 5);
    P.add(lace, laceMat);
  }
  // loose lace ends flopping over the side
  const loose = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([v3(0.02, 0.18, -0.03), v3(0.045, 0.17, -0.01), v3(0.055, 0.12, 0.01), v3(0.06, 0.06, 0.02)]), 12, 0.0014, 4);
  P.add(loose, laceMat);
  // heel pull tab
  P.add(new THREE.TorusGeometry(0.008, 0.0025, 5, 12, Math.PI), leather, null, M(0, 0.2, -0.097, 0, Math.PI / 2, 0, 1, 1.2, 1));
  const g = P.build();
  g.rotation.y = 0.35;
  return new THREE.Group().add(g);
}

function makeSeashell(): THREE.Object3D {
  const R = 0.034, NT = 30, NR = 14, TH = 1.3;
  const mat = phys({ vertexColors: true, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.4, bumpMap: grainMaps().bump, bumpScale: 0.4 });
  const pink = new THREE.Color('#a3261d'), cream = new THREE.Color('#f0b489'), peach = new THREE.Color('#dc5128');
  const valve = (top: boolean) => {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const c = new THREE.Color();
    for (let j = 0; j <= NR; j++) {
      const rho = j / NR;
      for (let i = 0; i <= NT; i++) {
        const th = (i / NT - 0.5) * 2 * TH;
        const rim = R * (0.93 + 0.07 * Math.cos(th));
        const ribs = Math.pow(Math.abs(Math.cos(th * 8.5)), 0.6);
        const r = rho * rim * (1 + 0.025 * ribs * rho);
        const dome = Math.pow(Math.sin(Math.PI * Math.min(1, rho * 1.02) * 0.92 + 0.08), 0.7) * (1 - 0.35 * (th / TH) ** 2);
        const h = (top ? 0.0135 : -0.0035) * dome * Math.min(1, rho * 4) + (top ? 1 : -0.4) * 0.0034 * ribs * Math.sqrt(rho);
        pos.push(r * Math.sin(th), h + 0.004, r * Math.cos(th) - R * 0.45);
        const band = 0.5 + 0.5 * Math.sin(rho * 46);
        c.copy(pink).lerp(peach, Math.min(1, rho * 1.6)).lerp(cream, Math.pow(rho, 2.5) * 0.35 + ribs * 0.25);
        c.multiplyScalar(top ? 0.75 + band * 0.25 : 1.0);
        col.push(c.r, c.g, c.b);
        if (i < NT && j < NR) {
          const a = j * (NT + 1) + i, b = a + 1, d = a + NT + 1, e = d + 1;
          if (top) idx.push(a, d, b, b, d, e); else idx.push(a, b, d, b, e, d);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  const P = new Parts();
  P.add(valve(true), mat);
  P.add(valve(false), mat);
  // hinge "ears"
  for (const s of [1, -1]) {
    const ear = new THREE.SphereGeometry(1, 10, 6);
    ear.scale(0.009, 0.0022, 0.006);
    paintVerts(ear, (_x, _y, _z, c) => c.copy(pink).lerp(cream, 0.2));
    P.add(ear, mat, null, M(s * 0.007, 0.0055, -R * 0.4, 0, s * 0.35, 0));
  }
  return P.build();
}

function makeGoldNugget(): THREE.Object3D {
  const g = welded(new THREE.IcosahedronGeometry(1, 6));
  displace(g, (x, y, z) => {
    const big = fbm(x * 1.3 + 3, y * 1.3, z * 1.3, 3, 131) - 0.5;
    const ridge = 0.5 - Math.abs(vnoise(x * 3.2, y * 3.2 + 7, z * 3.2, 133) - 0.5) * 2;
    return 0.55 * big + 0.12 * ridge + 0.06 * (vnoise(x * 9, y * 9, z * 9, 132) - 0.5);
  }, true);
  g.scale(0.016, 0.011, 0.013);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y, 0);
  const gm = grainMaps();
  const mat = metal('#eab94a', 0.55, { bumpMap: gm.bump, bumpScale: 3, roughnessMap: gm.aux });
  return new Parts().add(g, mat).build();
}

function makeTrophy(): THREE.Object3D {
  const gold = metal(GOLD, 0.18, { clearcoat: 0.6, clearcoatRoughness: 0.1 });
  const base = phys({ color: '#1c1a1d', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 });
  const P = new Parts();
  P.add(new RoundedBoxGeometry(0.058, 0.02, 0.058, 2, 0.003), base, null, M(0, 0.01, 0));
  P.add(new RoundedBoxGeometry(0.044, 0.014, 0.044, 2, 0.0025), base, null, M(0, 0.027, 0));
  P.add(new RoundedBoxGeometry(0.03, 0.011, 0.002, 1, 0.0008), gold, null, M(0, 0.01, 0.0292));
  const prof: [number, number][] = [
    [0, 0.034], [0.015, 0.034], [0.0155, 0.036], [0.012, 0.038], [0.005, 0.043], [0.0035, 0.05], [0.0035, 0.056],
    [0.0065, 0.059], [0.0035, 0.062], [0.004, 0.068], [0.009, 0.074], [0.0175, 0.083], [0.0225, 0.097], [0.0245, 0.112],
    [0.0255, 0.121], [0.0258, 0.123], [0.0245, 0.1232], [0.0232, 0.121], [0.022, 0.11], [0.0195, 0.097], [0.013, 0.086],
    [0.005, 0.08], [0, 0.079],
  ];
  P.add(lathe(prof, 32), gold);
  for (const s of [1, -1]) {
    const h = new THREE.TorusGeometry(0.0115, 0.0021, 6, 14, Math.PI * 1.15);
    P.add(h, gold, null, M(s * 0.0235, 0.1, 0, 0, 0, s > 0 ? -Math.PI / 2 - 0.3 : Math.PI / 2 + 0.3 - Math.PI * 0.15));
  }
  // a star on the cup
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2, r = i % 2 ? 0.0028 : 0.0068;
    if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r); else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const sg = new THREE.ExtrudeGeometry(star, { depth: 0.0008, bevelEnabled: true, bevelThickness: 0.0003, bevelSize: 0.0003, bevelSegments: 1 });
  const Rc = 0.0226;
  warp(sg, (v) => { v.z = Math.sqrt(Rc * Rc - v.x * v.x) + v.z - 0.0003; });
  P.add(sg, gold, null, M(0, 0.103, 0, -0.18, 0, 0));
  return P.build();
}

function makeMarble(): THREE.Object3D {
  const r = 0.0085;
  const glass = phys({
    color: '#d8f0ec', roughness: 0.0, transparent: true, opacity: 0.3, clearcoat: 1, clearcoatRoughness: 0,
    ior: 1.5, specularIntensity: 1, envMapIntensity: 2, depthWrite: false,
  });
  const vaneMat = phys({ vertexColors: true, roughness: 0.3, clearcoat: 0.5, side: THREE.DoubleSide });
  const cols = [new THREE.Color('#1e62d0'), new THREE.Color('#f28c1c'), new THREE.Color('#e8e8f0')];
  const P = new Parts();
  // cat's-eye: three twisted, lens-shaped vanes through the centre
  for (let k = 0; k < 3; k++) {
    const vane = new THREE.PlaneGeometry(r * 1.5, r * 1.6, 2, 14);
    warp(vane, (v) => {
      const t = v.y / (r * 0.8);
      const wdt = Math.sqrt(Math.max(0, 1 - t * t));
      const a = k * (Math.PI / 3) + t * 1.3;
      const x = v.x * wdt;
      v.set(Math.cos(a) * x, v.y, Math.sin(a) * x);
    });
    paintVerts(vane, (_x, _y, _z, c) => c.copy(cols[k]));
    P.add(vane, vaneMat, null, M(0, r, 0));
  }
  const g = P.build();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), glass);
  ball.position.y = r;
  ball.renderOrder = 1;
  g.add(ball);
  return shadowed(g);
}

function canPrint(): THREE.Texture {
  return drawTex('sodaCan', 512, 512, (ctx, w, h) => {
    // v: 0 = bottom of the can, 1 = top (texture rows flipped)
    ctx.fillStyle = '#c9ced4'; ctx.fillRect(0, 0, w, h);
    const y0 = h * (1 - 0.86), y1 = h * (1 - 0.1);
    ctx.fillStyle = '#d42a2a'; ctx.fillRect(0, y0, w, y1 - y0);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(0, h * 0.55);
    for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * 0.55 + Math.sin((x / w) * Math.PI * 4) * 22);
    for (let x = w; x >= 0; x -= 8) ctx.lineTo(x, h * 0.6 + Math.sin((x / w) * Math.PI * 4 + 0.6) * 22);
    ctx.fill();
    const rnd = rng(51);
    for (let i = 0; i < 30; i++) {
      ctx.strokeStyle = 'rgba(255,220,120,0.7)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rnd() * w, y0 + rnd() * (y1 - y0) * 0.35, 3 + rnd() * 8, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.save();
    ctx.translate(w * 0.5, h * 0.4); ctx.rotate(Math.PI / 2);
    title(ctx, 'FIZZ', 0, 0, 96, '#fff', '#8a1010');
    ctx.restore();
  });
}

function makeEmptyCan(): THREE.Object3D {
  const R = 0.033, H = 0.122;
  const body = phys({ map: canPrint(), metalness: 0.85, roughness: 0.28, clearcoat: 0.6, clearcoatRoughness: 0.15 });
  const alu = metal('#d6dadf', 0.25);
  const hole = stdm({ color: '#141414', roughness: 0.8 });
  const prof: [number, number][] = [
    [0.02, 0.006], [0.024, 0.0015], [0.027, 0.0002], [0.0295, 0.0015], [R, 0.011], [R, 0.104], [0.031, 0.112],
    [0.0272, 0.1185], [0.0272, 0.1205], [0.0262, H], [0.0252, 0.1205], [0.0252, 0.1175],
  ];
  const g = lathe(prof, 40, Math.PI);
  planarUV(g, 'x', 'y', 1, 0, 0);
  {
    const p = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 + Math.atan2(p.getX(i), p.getZ(i)) / (Math.PI * 2), p.getY(i) / H);
  }
  // dents and a crushed middle
  warp(g, (v) => {
    const a = Math.atan2(v.x, v.z);
    const d1 = Math.exp(-(((a - 1.9) / 0.45) ** 2) - (((v.y - 0.05) / 0.018) ** 2));
    const d2 = Math.exp(-(((a + 0.4) / 0.35) ** 2) - (((v.y - 0.08) / 0.012) ** 2));
    const k = 1 - 0.2 * d1 - 0.12 * d2 - 0.035 * Math.sin(a * 5) * Math.exp(-(((v.y - 0.06) / 0.03) ** 2));
    v.x *= k; v.z *= k;
  });
  const P = new Parts();
  P.add(g, body);
  P.add(new THREE.CircleGeometry(0.0253, 32), alu, null, M(0, 0.1175, 0, -Math.PI / 2));
  P.add(new THREE.CircleGeometry(0.02, 32), alu, null, M(0, 0.0058, 0, Math.PI / 2));
  // opening and pull tab
  const open = new THREE.CircleGeometry(1, 16);
  P.add(open, hole, null, M(0, 0.1178, 0.012, -Math.PI / 2, 0, 0, 0.0075, 0.0055, 1));
  const tab = new THREE.TorusGeometry(0.0055, 0.0017, 4, 14);
  tab.scale(1, 1.4, 0.5);
  P.add(tab, alu, null, M(0, 0.1185, -0.004, -Math.PI / 2 + 0.25, 0, 0));
  const can = P.build();
  // lying on its side
  can.rotation.set(0, 0.4, Math.PI / 2);
  can.position.set(H / 2, R * 0.97, 0);
  const holder = new THREE.Group();
  const inner = new THREE.Group().add(can);
  inner.position.x = -H / 2;
  holder.add(inner);
  return holder;
}

function makeToyCar(): THREE.Object3D {
  const paint = phys({ color: '#d61f1f', roughness: 0.22, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04 });
  const glass = phys({ color: '#1d2a38', roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
  const rubber = phys({ color: '#1b1b1c', roughness: 0.7 });
  const chrome = metal(CHROME, 0.12);
  const lamp = phys({ color: '#fff6d0', emissive: '#fff0b0', emissiveIntensity: 0.4, roughness: 0.1, clearcoat: 1 });
  const tail = phys({ color: '#b01818', emissive: '#600000', emissiveIntensity: 0.3, roughness: 0.2, clearcoat: 1 });
  const P = new Parts();
  const WB = 0.023, WR = 0.0075;
  // lower body side profile (x along the car, y up) with wheel arches
  const s = new THREE.Shape();
  s.moveTo(-0.037, 0.008);
  s.lineTo(-WB - WR - 0.0015, 0.006);
  s.absarc(-WB, 0.0075, WR + 0.0012, Math.PI, 0, true);
  s.lineTo(WB - WR - 0.0012, 0.006);
  s.absarc(WB, 0.0075, WR + 0.0012, Math.PI, 0, true);
  s.lineTo(0.037, 0.007);
  s.quadraticCurveTo(0.0395, 0.012, 0.038, 0.017);
  s.quadraticCurveTo(0.03, 0.021, 0.012, 0.0215);
  s.lineTo(-0.024, 0.022);
  s.quadraticCurveTo(-0.036, 0.022, -0.0375, 0.017);
  s.closePath();
  const W = 0.03;
  const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: W - 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0018, bevelSegments: 2, curveSegments: 8 });
  bodyGeo.translate(0, 0, -(W - 0.004) / 2);
  P.add(bodyGeo, paint);
  // greenhouse (glass) and roof
  const gh = new THREE.Shape();
  gh.moveTo(-0.022, 0.021); gh.lineTo(0.011, 0.021); gh.quadraticCurveTo(0.004, 0.03, 0.0, 0.0325); gh.lineTo(-0.016, 0.0325); gh.quadraticCurveTo(-0.021, 0.028, -0.022, 0.021);
  const ghGeo = new THREE.ExtrudeGeometry(gh, { depth: W - 0.008, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.001, bevelSegments: 2, curveSegments: 8 });
  ghGeo.translate(0, 0, -(W - 0.008) / 2);
  P.add(ghGeo, glass);
  P.add(new RoundedBoxGeometry(0.018, 0.0025, W - 0.0055, 2, 0.001), paint, null, M(-0.008, 0.0335, 0));
  P.add(new THREE.BoxGeometry(0.0022, 0.012, W - 0.0052), paint, null, M(-0.0055, 0.027, 0, 0, 0, -0.08));
  // wheels with hubcaps
  for (const x of [-WB, WB]) for (const z of [1, -1]) {
    const tire = new THREE.CylinderGeometry(WR, WR, 0.0055, 16);
    P.add(tire, rubber, null, M(x, WR, z * (W / 2 - 0.0012), Math.PI / 2));
    P.add(new THREE.CylinderGeometry(WR * 0.55, WR * 0.6, 0.0012, 14), chrome, null, M(x, WR, z * (W / 2 + 0.0016), Math.PI / 2));
  }
  // bumpers, lights
  for (const sx of [1, -1]) P.add(new RoundedBoxGeometry(0.003, 0.0035, W + 0.001, 2, 0.001), chrome, null, M(sx * 0.0385, 0.0085, 0));
  for (const z of [1, -1]) {
    P.add(new THREE.SphereGeometry(0.0026, 10, 8), lamp, null, M(0.0375, 0.0145, z * 0.0095, 0, 0, 0, 0.6, 1, 1));
    P.add(new RoundedBoxGeometry(0.0015, 0.004, 0.006, 1, 0.0005), tail, null, M(-0.0385, 0.0145, z * 0.0095));
  }
  const g = P.build();
  g.rotation.y = -0.5;
  return new THREE.Group().add(g);
}

function watchDial(): THREE.Texture {
  return drawTex('watchDial', 512, 512, (ctx, w) => {
    const c = w / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, '#fffdf6'); g.addColorStop(0.9, '#f3ecdc'); g.addColorStop(1, '#d8c690');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
    ctx.strokeStyle = '#2a2622'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(c, c, c * 0.9, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const r0 = i % 5 ? c * 0.86 : c * 0.82;
      ctx.lineWidth = i % 5 ? 2 : 4;
      ctx.beginPath(); ctx.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0); ctx.lineTo(c + Math.sin(a) * c * 0.9, c - Math.cos(a) * c * 0.9); ctx.stroke();
    }
    const nums = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    ctx.fillStyle = '#1e1b18';
    ctx.font = `600 38px "Times New Roman", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    nums.forEach((n, i) => {
      if (i === 6) return;
      const a = (i / 12) * Math.PI * 2;
      ctx.save(); ctx.translate(c + Math.sin(a) * c * 0.68, c - Math.cos(a) * c * 0.68); ctx.rotate(a); ctx.fillText(n, 0, 0); ctx.restore();
    });
    // small seconds
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c, c + c * 0.42, c * 0.17, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c, c + c * 0.42); ctx.lineTo(c + c * 0.1, c + c * 0.32); ctx.stroke();
    // blued hands
    ctx.strokeStyle = '#1f3a78'; ctx.lineCap = 'round';
    ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(-0.9) * c * 0.45, c - Math.cos(-0.9) * c * 0.45); ctx.stroke();
    ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(2.2) * c * 0.7, c - Math.cos(2.2) * c * 0.7); ctx.stroke();
    ctx.fillStyle = '#1f3a78'; ctx.beginPath(); ctx.arc(c, c, 10, 0, Math.PI * 2); ctx.fill();
    ctx.font = `italic 22px "Times New Roman", Georgia, serif`; ctx.fillStyle = '#5a4a3a';
    ctx.fillText('Railway', c, c - c * 0.33);
  });
}

function makePocketWatch(): THREE.Object3D {
  const gold = metal('#e9bd5c', 0.2, { clearcoat: 0.5, clearcoatRoughness: 0.1 });
  const dial = phys({ map: watchDial(), roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03 });
  const P = new Parts();
  const R = 0.022;
  const prof: [number, number][] = [
    [0, 0.0006], [0.012, 0.0012], [0.018, 0.0028], [0.0212, 0.0055], [R, 0.0078], [0.0218, 0.0102], [0.0205, 0.0118],
    [0.0192, 0.0121], [0.0186, 0.0112], [0.0185, 0.0104],
  ];
  P.add(lathe(prof, 40), gold);
  P.add(new THREE.CircleGeometry(0.0186, 40), dial, null, M(0, 0.0104, 0, -Math.PI / 2));
  // pendant, crown and bow at 12 o'clock (-Z)
  P.add(new THREE.CylinderGeometry(0.0024, 0.003, 0.004, 12), gold, null, M(0, 0.0068, -0.0235, Math.PI / 2));
  const crown = new THREE.CylinderGeometry(0.0036, 0.0036, 0.0036, 16);
  warp(crown, (v) => { const a = Math.atan2(v.z, v.x); const k = 1 + 0.08 * Math.max(0, Math.sin(a * 12)); if (Math.hypot(v.x, v.z) > 0.003) { v.x *= k; v.z *= k; } });
  P.add(crown, gold, null, M(0, 0.0068, -0.0272, Math.PI / 2));
  P.add(new THREE.TorusGeometry(0.0058, 0.0011, 8, 24), gold, null, M(0, 0.0045, -0.034, Math.PI / 2 + 0.3));
  // chain links trailing along the floor
  const link = new THREE.TorusGeometry(0.0026, 0.00065, 4, 10);
  link.scale(1.35, 1, 1);
  let prev = v3(0, 0.0022, -0.0395);
  let dir = v3(-0.4, 0, -1).normalize();
  for (let i = 0; i < 14; i++) {
    dir.applyAxisAngle(UP, 0.16);
    const p = prev.clone().addScaledVector(dir, 0.0052);
    p.y = i % 2 ? 0.0027 : 0.0008;
    const yaw = Math.atan2(dir.x, dir.z);
    const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(i % 2 ? 0 : Math.PI / 2, yaw + Math.PI / 2, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
    P.add(link.clone(), gold, null, m);
    prev = p;
  }
  link.dispose();
  return P.build();
}

function petalGeo(len: number, width: number, cup: number, notch = 0): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 4, 8);
  warp(g, (v) => {
    const t = v.y + 0.5;
    const across = v.x * 2;
    const w = Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(t, 0.75))), 0.7) * width * 0.5;
    let y = t * len;
    if (notch) y -= notch * len * Math.max(0, 1 - Math.abs(across) * 3) * smoothstep(0.85, 1, t);
    v.set(across * w, y, cup * (across * across) * width + 0.15 * cup * len * t * t);
  });
  return g;
}

function makeFlower(): THREE.Object3D {
  const mat = phys({ vertexColors: true, roughness: 0.55, sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffd8ea'), side: THREE.DoubleSide });
  const P = new Parts();
  const top = v3(0.006, 0.135, 0.012);
  const stem = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([v3(0, 0, 0), v3(0.004, 0.05, -0.002), v3(0.004, 0.1, 0.004), top]), 16, 0.0021, 6);
  P.add(stem, mat, '#4f8a2a');
  for (const [y, a, l] of [[0.035, 0.6, 0.05], [0.07, -2.4, 0.043]]) {
    const leaf = petalGeo(l, 0.017, 0.25);
    paintVerts(leaf, (_x, yy, _z, c) => c.set('#3f7f25').lerp(new THREE.Color('#78b04a'), yy / l * 0.6));
    P.add(leaf, mat, null, M(0.003, y, 0, 0, a, -0.9));
  }
  // flower head facing forward and up
  const head = M(top.x, top.y, top.z, 0.75, 0, 0);
  const N = 9;
  for (let i = 0; i < N; i++) {
    const pet = petalGeo(0.028, 0.013, 0.12, 0.08);
    paintVerts(pet, (_x, y, _z, c) => c.set('#fce3ee').lerp(new THREE.Color('#e9528f'), smoothstep(0.004, 0.024, y)));
    const m = head.clone().multiply(M(0, 0, 0, 0, (i / N) * Math.PI * 2, 0)).multiply(M(0, 0.001, 0.003, Math.PI / 2 - 0.25, 0, 0));
    P.add(pet, mat, null, m);
  }
  const center = new THREE.SphereGeometry(1, 16, 10);
  displace(center, (x, y, z) => 0.08 * vnoise(x * 6, y * 6, z * 6, 141), true);
  paintVerts(center, (_x, y, _z, c) => c.set('#e39b12').lerp(new THREE.Color('#f7d046'), clamp01(y)));
  P.add(center, mat, null, head.clone().multiply(M(0, 0.003, 0, 0, 0, 0, 0.0065, 0.004, 0.0065)));
  const sep = new THREE.SphereGeometry(0.0045, 10, 6);
  P.add(sep, mat, '#4a8428', head.clone().multiply(M(0, -0.001, 0, 0, 0, 0, 1, 0.6, 1)));
  return P.build();
}

function makeGlasses(): THREE.Object3D {
  const frame = metal('#d9b56a', 0.2);
  const lens = phys({ color: '#e8f0f6', roughness: 0.02, transparent: true, opacity: 0.2, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 1.8, depthWrite: false, side: THREE.DoubleSide });
  const pad = phys({ color: '#f2f2ee', roughness: 0.2, transparent: true, opacity: 0.7 });
  const P = new Parts();
  const LR = 0.0205, CX = 0.0265, CY = 0.024;
  for (const s of [1, -1]) {
    P.add(new THREE.TorusGeometry(LR, 0.0011, 6, 36), frame, null, M(s * CX, CY, 0));
    const l = new THREE.CircleGeometry(LR, 28);
    warp(l, (v) => { v.z = 0.004 * (1 - (v.x * v.x + v.y * v.y) / (LR * LR)); }, false);
    P.add(l, lens, null, M(s * CX, CY, 0));
    // hinge block and temple arm with an ear hook
    const hx = s * (CX + LR + 0.001);
    P.add(new THREE.BoxGeometry(0.004, 0.0035, 0.003), frame, null, M(hx, CY + 0.004, -0.001));
    const arm = new THREE.CatmullRomCurve3([v3(hx, CY + 0.004, -0.002), v3(hx + s * 0.003, CY + 0.004, -0.05), v3(hx + s * 0.004, CY + 0.002, -0.1), v3(hx + s * 0.004, CY - 0.008, -0.118), v3(hx + s * 0.003, 0.001, -0.128)]);
    P.add(new THREE.TubeGeometry(arm, 24, 0.001, 5), frame);
    P.add(new THREE.SphereGeometry(0.0022, 8, 6), pad, null, M(s * 0.0105, CY - 0.009, 0.004, 0, 0, 0, 0.6, 1, 0.4));
  }
  const bridge = new THREE.QuadraticBezierCurve3(v3(-CX + LR * 0.72, CY + 0.012, 0), v3(0, CY + 0.019, 0.003), v3(CX - LR * 0.72, CY + 0.012, 0));
  P.add(new THREE.TubeGeometry(bridge, 12, 0.0011, 5), frame);
  const g = P.build();
  g.rotation.y = 0.3;
  return new THREE.Group().add(g);
}

function makeGem(): THREE.Object3D {
  const rg = 0.01, rt = 0.0056, ht = 0.0042, hp = 0.0088, band = 0.0007;
  const T: THREE.Vector3[] = [], G: THREE.Vector3[] = [], G2: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; T.push(v3(Math.cos(a) * rt, ht, Math.sin(a) * rt)); }
  for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; G.push(v3(Math.cos(a) * rg, 0, Math.sin(a) * rg)); G2.push(v3(Math.cos(a) * rg, -band, Math.sin(a) * rg)); }
  const tris: THREE.Vector3[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => tris.push(a, b, c);
  const top = v3(0, ht, 0), culet = v3(0, -hp, 0);
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    tri(top, T[j], T[i]);
    tri(T[i], T[j], G[2 * i + 1]);
    tri(T[i], G[2 * i + 1], G[2 * i]);
    tri(T[j], G[(2 * i + 2) % 16], G[2 * i + 1]);
  }
  for (let k = 0; k < 16; k++) {
    const l = (k + 1) % 16;
    tri(G[k], G[l], G2[k]); tri(G[l], G2[l], G2[k]);
    // pavilion: main facets split at a mid ring for more sparkle
    const mid = G2[k].clone().lerp(G2[l], 0.5).multiplyScalar(0.45).setY(-hp * 0.55);
    tri(G2[k], G2[l], mid);
    tri(G2[k], mid, culet);
    tri(mid, G2[l], culet);
  }
  const g = new THREE.BufferGeometry().setFromPoints(tris);
  g.computeVertexNormals();
  const mat = phys({
    color: '#0f3fc4', roughness: 0.03, metalness: 0.1, ior: 2.4, specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0,
    envMapIntensity: 3, emissive: '#0a2890', emissiveIntensity: 0.45, iridescence: 0.4, iridescenceIOR: 1.6,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.rotation.set(-1.0, 0.3, 0);
  mesh.updateMatrix();
  g.applyMatrix4(mesh.matrix);
  mesh.rotation.set(0, 0, 0);
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox!.min.y, 0);
  return shadowed(new THREE.Group().add(mesh));
}

function featherMaps(): Maps {
  const blue = hex('#1f5fcf'), light = hex('#5aa2ea'), black = hex('#15161c'), white = hex('#f4f6fa'), down = hex('#b9c6d8');
  return pixelMaps('feather', 512, 128, (u, v, p) => {
    // u: base -> tip, v: 0..1 across (0.5 = rachis)
    const side = v - 0.5, a = Math.abs(side) * 2; // 0 at rachis, 1 at the edge
    // barbs sweep towards the tip
    const barb = u * 90 - a * 7;
    const line = 0.5 + 0.5 * Math.sin(barb * Math.PI * 2);
    const splitN = Math.sin((u * 90 - a * 7) * Math.PI * 2 / 11 + (side > 0 ? 0 : 2));
    const split = splitN > 0.985 && a > 0.4 && vnoise(u * 9, side > 0 ? 1 : 5, 0, 151) > 0.6 ? 1 : 0;
    const edge = 1 - smoothstep(0.86, 1.0, a + (vnoise(u * 120, v * 4, 0, 152) - 0.5) * 0.18);
    const downy = 1 - smoothstep(0.1, 0.24, u);
    let c = mixRGB(blue, light, clamp01(a * 0.8 - 0.2) * 0.6);
    const bar = Math.sin((u * 13 - a * 0.9) * Math.PI);
    if (bar > 0.82 && u > 0.25) c = black;
    if (u > 0.86) c = mixRGB(c, white, smoothstep(0.86, 0.9, u) * (a > 0.25 ? 1 : 0.3));
    c = mixRGB(c, down, downy);
    setRGB(p, c, 0.82 + line * 0.25);
    p.a = edge * (1 - split * 0.9) * (downy ? 1 - downy * 0.4 * line : 1) > 0.5 ? 1 : 0;
    p.h = line;
    p.m = 0.5;
  }, false);
}

function makeFeather(): THREE.Object3D {
  const L = 0.15;
  const fm = featherMaps();
  const vaneMat = phys({ map: fm.map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, sheen: 0.6, sheenRoughness: 0.4, sheenColor: new THREE.Color('#3f86e8'), bumpMap: fm.bump, bumpScale: 0.4 });
  const quill = phys({ color: '#efe9dc', roughness: 0.35, clearcoat: 0.5 });
  const P = new Parts();
  const rach = (t: number) => v3(-L / 2 + t * L, 0.003 + 0.006 * Math.sin(Math.PI * t) + 0.018 * Math.pow(t, 3), 0.008 * Math.sin(t * 2.5));
  // vane surface: u along, v across; asymmetric widths
  const NU = 30, NV = 6;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= NU; i++) {
    const t = 0.13 + (i / NU) * 0.87;
    const c = rach(t);
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.1) / 0.92)), 0.55);
    for (let j = 0; j <= NV * 2; j++) {
      const f = j / (NV * 2) - 0.5; // -0.5..0.5
      const w = (f < 0 ? 0.03 : 0.019) * prof * Math.abs(f) * 2;
      const droop = -0.0025 * Math.pow(Math.abs(f) * 2, 2);
      pos.push(c.x + w * 0.35, c.y + droop, c.z + Math.sign(f) * w);
      uv.push((t - 0.13) / 0.87, 0.5 + f);
      if (i < NU && j < NV * 2) { const a = i * (NV * 2 + 1) + j; idx.push(a, a + 1, a + NV * 2 + 1, a + 1, a + NV * 2 + 2, a + NV * 2 + 1); }
    }
  }
  const vane = new THREE.BufferGeometry();
  vane.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  vane.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  vane.setIndex(idx);
  vane.computeVertexNormals();
  P.add(vane, vaneMat);
  const pts = Array.from({ length: 9 }, (_, i) => rach(i / 8));
  const q = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0012, 5);
  {
    const p = q.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const i = Math.floor(k / 6), t = i / 24;
      const c = rach(t);
      const f = 1 - t * 0.75;
      p.setXYZ(k, c.x + (p.getX(k) - c.x) * f, c.y + (p.getY(k) - c.y) * f, c.z + (p.getZ(k) - c.z) * f);
    }
    q.computeVertexNormals();
  }
  P.add(q, quill);
  const g = P.build();
  g.rotation.set(0.12, 0.55, 0);
  return new THREE.Group().add(g);
}

/** Builds a collectible the puppy digs up on walks (rests on y = 0, faces +Z). */
export function makeCollectible(kind: CollectibleKind): THREE.Object3D {
  const make: Record<CollectibleKind, () => THREE.Object3D> = {
    oldBoot: makeOldBoot, seashell: makeSeashell, goldNugget: makeGoldNugget, trophy: makeTrophy, marble: makeMarble,
    emptyCan: makeEmptyCan, toyCar: makeToyCar, pocketWatch: makePocketWatch, flower: makeFlower, glasses: makeGlasses,
    gem: makeGem, feather: makeFeather,
  };
  const o = make[kind]();
  o.name = kind;
  return o;
}

/** A small, tidy soft-serve swirl for walks. */
export function makePoop(): THREE.Object3D {
  const SEG = 64, RAD = 8, TURNS = 2.4;
  const path = new THREE.CatmullRomCurve3(Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    const a = t * TURNS * Math.PI * 2;
    const r = 0.0135 * Math.pow(1 - t, 0.85) + 0.001;
    return v3(Math.cos(a) * r, 0.0058 + t * 0.017 + 0.004 * Math.pow(t, 3), Math.sin(a) * r);
  }));
  const g = new THREE.TubeGeometry(path, SEG, 1, RAD, false);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let k = 0; k < p.count; k++) {
    const i = Math.floor(k / (RAD + 1)), t = i / SEG;
    const c = path.getPointAt(t);
    const rt = 0.0076 * (1 - 0.7 * Math.pow(t, 1.2)) + 0.0006;
    let x = c.x + (p.getX(k) - c.x) * rt, y = c.y + (p.getY(k) - c.y) * rt * 0.85, z = c.z + (p.getZ(k) - c.z) * rt;
    if (y < 0.0006) y = 0.0006;
    p.setXYZ(k, x, y, z);
  }
  g.computeVertexNormals();
  const mat = phys({ color: '#6a4424', roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, bumpMap: grainMaps().bump, bumpScale: 1.2 });
  const P = new Parts();
  P.add(g, mat);
  const start = path.getPointAt(0);
  P.add(new THREE.SphereGeometry(0.0078, 12, 8), mat, null, M(start.x, start.y * 0.85, start.z, 0, 0, 0, 1, 0.8, 1));
  const end = path.getPointAt(1);
  P.add(new THREE.SphereGeometry(0.0029, 10, 6), mat, null, M(end.x, end.y + 0.0006, end.z, 0, 0, 0, 1, 1.3, 1));
  const obj = P.build();
  obj.name = 'poop';
  return obj;
}

// =============================================================================
// Accessories fitted to a dog
// =============================================================================

/**
 * Collar frame in bone space: origin at the collar ring centre, Y along the
 * neck, Z towards the throat (front-down), X to the dog's left.
 */
function collarFrame(fit: AccessoryFit) {
  const y = fit.neckAxis.clone().normalize();
  const z = v3(0, -1, 1);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(fit.collarCenter);
  return { m, x, y, z };
}

/** The neck is fuller at the throat than at the nape; collars follow that oval (1 at the nape/sides, 1 + THROAT at the throat). */
const THROAT = 0.14;
const neckOval = (theta: number) => 1 + THROAT * Math.pow(Math.max(0, Math.cos(theta)), 1.5);

/** A band around the neck (lathe of a rounded rectangle), in the canonical collar frame. */
function bandGeometry(R: number, width: number, thick: number, segs = 48, repeat = 10): THREE.BufferGeometry {
  const hw = width / 2, ht = thick / 2, c = Math.min(ht, hw) * 0.8;
  const prof: [number, number][] = [];
  const corners: [number, number, number][] = [[R + ht - c, -hw + c, -Math.PI / 2], [R + ht - c, hw - c, 0], [R - ht + c, hw - c, Math.PI / 2], [R - ht + c, -hw + c, Math.PI]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= 3; i++) { const a = a0 + (i / 3) * (Math.PI / 2); prof.push([cx + Math.cos(a) * c, cy + Math.sin(a) * c]); }
  prof.push(prof[0]);
  const g = lathe(prof, segs);
  const p = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const th = Math.atan2(p.getX(i), p.getZ(i));
    uv.setXY(i, (th / (Math.PI * 2) + 0.5) * repeat, p.getY(i) / width + 0.5);
    const k = neckOval(th);
    p.setXYZ(i, p.getX(i) * k, p.getY(i), p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

function leatherStrapMaps(color: string): Maps {
  const base = hex(color);
  return pixelMaps('strap' + color, 256, 64, (u, v, p) => {
    const grain = vnoise(u * 160, v * 40, 0, 161, 160, 40);
    const stitchRow = Math.min(Math.abs(v - 0.17), Math.abs(v - 0.83));
    const dash = mod(u * 24, 1) < 0.62 ? 1 : 0;
    const stitch = (1 - smoothstep(0.018, 0.035, stitchRow)) * dash;
    const groove = 1 - smoothstep(0.03, 0.06, stitchRow);
    const edge = smoothstep(0.0, 0.06, v) * (1 - smoothstep(0.94, 1, v));
    let c = mixRGB(base, [base[0] * 0.6, base[1] * 0.6, base[2] * 0.6], (1 - edge) * 0.5 + groove * 0.25);
    c = mixRGB(c, hex('#f1e6cf'), stitch * 0.85);
    setRGB(p, c, 0.94 + grain * 0.1);
    p.h = 0.6 - groove * 0.3 + stitch * 0.35 + grain * 0.1;
    p.m = 0.5 + grain * 0.15 - stitch * 0.1;
  });
}

function tagMaps(): Maps {
  return pixelMaps('tagPaw', 128, 128, (u, v, p) => {
    const x = (u - 0.5) * 2, y = (v - 0.5) * 2;
    let paw = Math.hypot(x / 0.36, (y + 0.12) / 0.3) < 1 ? 1 : 0;
    for (const [dx, dy] of [[-0.38, 0.2], [-0.14, 0.42], [0.14, 0.42], [0.38, 0.2]]) if (Math.hypot(x - dx, y - dy) < 0.13) paw = 1;
    const ring = 1 - smoothstep(0.02, 0.04, Math.abs(Math.hypot(x, y) - 0.84));
    p.r = p.g = p.b = 1;
    p.h = 0.6 - paw * 0.35 - ring * 0.25;
    p.m = 0.25 + paw * 0.25;
  }, false);
}

function makeCollar(kind: 'collarRed' | 'collarBlue', fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const red = kind === 'collarRed';
  const lm = leatherStrapMaps(red ? '#b3261e' : '#1f55b8');
  const leather = phys({ map: lm.map, bumpMap: lm.bump, bumpScale: 1.5, roughnessMap: lm.aux, roughness: 1, clearcoat: 0.35, clearcoatRoughness: 0.35 });
  const hw = metal(red ? GOLD : SILVER, 0.22, { clearcoat: 0.5 });
  const tm = tagMaps();
  const tagMat = metal(red ? GOLD : SILVER, 1, { bumpMap: tm.bump, bumpScale: 2, roughnessMap: tm.aux });
  const W = 0.017 * hs, T = 0.0034 * hs, R = fit.neckRadius * 1.04 + T * 0.5;
  const { m: frame, z: throat } = collarFrame(fit);
  const P = new Parts();
  P.add(bandGeometry(R, W, T), leather, null, frame);
  // buckle on the dog's left side, towards the nape
  const tb = 2.1;
  const radial = v3(Math.sin(tb), 0, Math.cos(tb)), tangent = v3(Math.cos(tb), 0, -Math.sin(tb));
  const bm = new THREE.Matrix4().makeBasis(tangent, UP, radial).setPosition(radial.clone().multiplyScalar((R + T * 0.7) * neckOval(tb)));
  const bw = W * 0.62, bh = W * 1.32;
  const loop = new THREE.CatmullRomCurve3([v3(-bw, -bh / 2, 0), v3(bw, -bh / 2, 0), v3(bw * 1.1, 0, 0.0006), v3(bw, bh / 2, 0), v3(-bw, bh / 2, 0), v3(-bw * 1.1, 0, 0.0006)], true, 'catmullrom', 0.3);
  P.add(new THREE.TubeGeometry(loop, 24, 0.0011 * hs, 6, true), hw, null, frame.clone().multiply(bm));
  P.add(new THREE.CylinderGeometry(0.0007 * hs, 0.0007 * hs, bw * 2, 6), hw, null, frame.clone().multiply(bm).multiply(M(0, 0, 0.0008, 0, 0, Math.PI / 2)));
  // strap tail tucked through a keeper next to the buckle
  const keeperM = frame.clone().multiply(new THREE.Matrix4().makeRotationY(tb + 0.32)).multiply(M(0, 0, (R + T * 0.9) * neckOval(tb + 0.32)));
  P.add(new RoundedBoxGeometry(0.004 * hs, W * 1.08, T * 0.8, 1, T * 0.3), leather, null, keeperM);
  // D-ring at the throat and a hanging tag (tag hangs with gravity, i.e. bone -Y)
  const throatPt = v3(0, -W * 0.25, (R + T * 0.5) * neckOval(0)).applyMatrix4(frame);
  const ringR = 0.0052 * hs;
  const ringC = throatPt.clone().add(v3(0, -ringR * 0.9, ringR * 0.25));
  const facing = throat.clone().setY(throat.y * 0.35).normalize();
  const ringQ = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), facing);
  P.add(new THREE.TorusGeometry(ringR, 0.0011 * hs, 6, 18), hw, null, new THREE.Matrix4().compose(ringC, ringQ, v3(1, 1, 1)));
  const tagR = 0.0095 * hs;
  const tagC = ringC.clone().add(v3(0, -ringR - tagR * 0.95, tagR * 0.18));
  const tag = new THREE.CylinderGeometry(tagR, tagR, 0.0012 * hs, 24);
  remapUV(tag, (u, v) => [u, v]);
  planarUV(tag, 'x', 'z', 1 / (2 * tagR), 0.5, 0.5);
  tag.rotateX(Math.PI / 2);
  P.add(tag, tagMat, null, new THREE.Matrix4().compose(tagC, ringQ, v3(1, 1, 1)));
  return P.build();
}

function bandanaTexture(): THREE.Texture {
  return drawTex('bandana', 512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#c42a2a'; ctx.fillRect(0, 0, w, h);
    const rnd = rng(71);
    // paisley motifs
    for (let i = 0; i < 26; i++) {
      const x = rnd() * w, y = rnd() * h, s = 18 + rnd() * 16, a = rnd() * Math.PI * 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.strokeStyle = '#fff3e6'; ctx.fillStyle = '#1b1414'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.9, -s * 0.6, s * 0.8, s * 0.7, 0, s * 0.6);
      ctx.bezierCurveTo(-s * 0.7, s * 0.5, -s * 0.5, -s * 0.2, 0, -s * 0.1);
      ctx.bezierCurveTo(s * 0.3, -s * 0.3, s * 0.1, -s * 0.8, 0, -s);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff3e6';
      for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(s * 0.15, s * (0.35 - k * 0.2), 2.4, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    for (let i = 0; i < 160; i++) { ctx.fillStyle = '#fff3e6'; ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, 2 + rnd() * 1.5, 0, Math.PI * 2); ctx.fill(); }
    printNoise(ctx, w, h, 0.05, 72);
  }, true, true);
}

function makeBandana(fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const tex = bandanaTexture();
  const cloth = phys({ map: tex, roughness: 0.85, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffb0a0'), side: THREE.DoubleSide, bumpMap: grainMaps().bump, bumpScale: 0.6 });
  const { m: frame } = collarFrame(fit);
  const R = fit.neckRadius * 1.04 + 0.003 * hs;
  const P = new Parts();
  // rolled band around the neck
  const band = bandGeometry(R, 0.011 * hs, 0.0055 * hs, 40, 6);
  P.add(band, cloth, null, frame);
  // triangle draping over the throat and chest (built in bone space)
  const NS = 14, NT = 10, TH = 1.75, L = 0.085 * hs;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const inv = new THREE.Matrix4().copy(frame);
  const q = new THREE.Vector3();
  for (let j = 0; j <= NT; j++) {
    const t = j / NT;
    for (let i = 0; i <= NS; i++) {
      const s = i / NS * 2 - 1;
      const th = s * TH * (1 - t * 0.98);
      const r = (R + 0.003 * hs) * neckOval(th) + t * 0.012 * hs;
      q.set(Math.sin(th) * r, -0.004 * hs, Math.cos(th) * r).applyMatrix4(inv);
      // hang down (bone -Y) and forward over the chest, with soft folds
      q.y -= t * L;
      q.z += t * L * 0.42 + Math.sin(t * Math.PI) * 0.008 * hs;
      q.addScaledVector(v3(Math.sin(th), 0, 0), t * 0.004 * hs);
      q.z += 0.0025 * hs * Math.sin(s * 6) * t;
      pos.push(q.x, q.y, q.z);
      uv.push(s * 0.5 + 0.5, 1 - t);
      if (i < NS && j < NT) { const a = j * (NS + 1) + i; idx.push(a, a + 1, a + NS + 1, a + 1, a + NS + 2, a + NS + 1); }
    }
  }
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tri.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  tri.setIndex(idx);
  tri.computeVertexNormals();
  P.add(tri, cloth);
  // knot and short tails at the nape
  const nape = v3(0, 0, -(R + 0.004 * hs)).applyMatrix4(frame);
  P.add(new THREE.SphereGeometry(0.0065 * hs, 12, 8), cloth, null, M(nape.x, nape.y, nape.z, 0, 0, 0, 1.2, 0.9, 0.9));
  for (const s of [1, -1]) {
    const tail = petalGeo(0.022 * hs, 0.012 * hs, 0.1);
    P.add(tail, cloth, null, M(nape.x + s * 0.003 * hs, nape.y - 0.002 * hs, nape.z - 0.002 * hs, 0.4, 0, Math.PI + s * 0.5));
  }
  return P.build();
}

function makeRibbon(fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const satin = phys({ color: '#ef5a92', roughness: 0.3, sheen: 1, sheenRoughness: 0.25, sheenColor: new THREE.Color('#ffc4dc'), clearcoat: 0.4, clearcoatRoughness: 0.25, side: THREE.DoubleSide });
  const P = new Parts();
  const m = M(fit.headTop.x, fit.headTop.y + 0.006 * hs, fit.headTop.z + 0.004 * hs, -0.25, 0, 0, hs, hs, hs);
  for (const g of bowGeometry(0.027, 0.014, true)) P.add(g, satin, null, m);
  const obj = P.build();
  obj.userData.iconDir = [0.35, 0.25, 1];
  return obj;
}

function capMaps(): Maps {
  const blue = hex('#2d68c8'), white = hex('#f5f5f2');
  return pixelMaps('cap', 256, 128, (u, v, p) => {
    // u around the crown (0.5 = front), v up the crown
    const seam = 1 - smoothstep(0.004, 0.01, Math.abs(mod(u * 6 + 0.5, 1) - 0.5) / 6);
    const front = Math.abs(u - 0.5) < 1 / 6 ? 1 : 0;
    // paw logo on the front panel
    const x = (u - 0.5) * 7, y = (v - 0.42) * 3.2;
    let paw = Math.hypot(x / 0.36, (y + 0.1) / 0.3) < 1 ? 1 : 0;
    for (const [dx, dy] of [[-0.38, 0.22], [-0.13, 0.44], [0.13, 0.44], [0.38, 0.22]]) if (Math.hypot(x - dx, y - dy) < 0.13) paw = 1;
    const twill = 0.5 + 0.5 * Math.sin((u * 900 + v * 400));
    let c = front ? white : blue;
    if (paw && front) c = hex('#e04040');
    setRGB(p, c, (0.92 + twill * 0.06) * (1 - seam * 0.3));
    p.h = 0.5 + twill * 0.2 - seam * 0.4 + (paw && front ? 0.2 : 0);
    p.m = 0.9;
  });
}

function makeCap(fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const cm = capMaps();
  const cloth = phys({ map: cm.map, bumpMap: cm.bump, bumpScale: 1, roughness: 0.9, sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color('#c8d8ff') });
  const bill = phys({ color: '#2d68c8', roughness: 0.8, sheen: 0.4, sheenColor: new THREE.Color('#c8d8ff'), side: THREE.DoubleSide });
  const P = new Parts();
  const r = 0.036;
  const crown = new THREE.SphereGeometry(r, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  remapUV(crown, (u, v) => [mod(u + 0.25, 1), 1 - v]);
  crown.scale(1, 0.72, 1.06);
  P.add(crown, cloth);
  P.add(new THREE.SphereGeometry(0.0038, 10, 6), cloth, null, M(0, r * 0.72, 0, 0, 0, 0, 1, 0.5, 1));
  // curved bill
  const bs = new THREE.Shape();
  bs.moveTo(-r * 0.95, 0);
  bs.bezierCurveTo(-r * 0.9, r * 1.1, r * 0.9, r * 1.1, r * 0.95, 0);
  bs.quadraticCurveTo(0, r * 0.3, -r * 0.95, 0);
  const bg = new THREE.ExtrudeGeometry(bs, { depth: 0.0018, bevelEnabled: true, bevelThickness: 0.0006, bevelSize: 0.0006, bevelSegments: 1, curveSegments: 16 });
  bg.rotateX(Math.PI / 2);
  warp(bg, (v) => { v.y -= (v.x * v.x) * 5 + v.z * 0.12; });
  P.add(bg, bill, null, M(0, 0.003, r * 0.72));
  const g = P.build();
  const holder = new THREE.Group().add(g);
  g.scale.setScalar(hs);
  g.rotation.x = -0.12;
  holder.position.copy(fit.headTop).add(v3(0, -0.017 * hs, -0.004 * hs));
  return holder;
}

function makeSunglasses(fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const frameMat = phys({ color: '#141416', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.06 });
  const lensMat = phys({ color: '#0c0f16', roughness: 0.04, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0, iridescence: 1, iridescenceIOR: 1.7, iridescenceThicknessRange: [250, 700], envMapIntensity: 1.8 });
  const sp = fit.eyeSpacing;
  const lw = Math.max(0.018 * hs, sp * 0.62), lh = lw * 0.74;
  const P = new Parts();
  const rr = (s: THREE.Shape | THREE.Path, w: number, h: number, r: number) => {
    s.moveTo(-w / 2 + r, -h / 2);
    s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r * 1.6, h / 2);
    s.lineTo(-w / 2 + r * 1.6, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  };
  const b = 0.0019 * hs;
  for (const s of [1, -1]) {
    const outer = new THREE.Shape(); rr(outer, lw + b * 2, lh + b * 2, lh * 0.48);
    const hole = new THREE.Path(); rr(hole, lw, lh, lh * 0.42);
    outer.holes.push(hole);
    const fr = new THREE.ExtrudeGeometry(outer, { depth: 0.0022 * hs, bevelEnabled: true, bevelThickness: 0.0006 * hs, bevelSize: 0.0005 * hs, bevelSegments: 2, curveSegments: 6 });
    const lens = new THREE.ShapeGeometry((() => { const l = new THREE.Shape(); rr(l, lw + 0.0004, lh + 0.0004, lh * 0.42); return l; })(), 6);
    warp(lens, (v) => { v.z = 0.0012 * hs - (v.x * v.x + v.y * v.y) * 3; }, false);
    const m = M(fit.eyeCenter.x + s * sp * 0.5, fit.eyeCenter.y + 0.001 * hs, fit.eyeCenter.z + 0.004 * hs, 0, s * 0.28, 0);
    P.add(fr, frameMat, null, m.clone().multiply(M(0, 0, -0.0011 * hs)));
    P.add(lens, lensMat, null, m);
    // temple arm running back along the side of the head
    const hx = s * (sp * 0.5 + (lw / 2 + b) * Math.cos(0.28));
    const armLen = 0.05 * hs;
    P.add(new THREE.BoxGeometry(0.0022 * hs, 0.0034 * hs, armLen), frameMat, null, M(fit.eyeCenter.x + hx + s * 0.004 * hs, fit.eyeCenter.y + lh * 0.25, fit.eyeCenter.z - armLen / 2 - 0.002 * hs, 0.05, -s * 0.2, 0));
  }
  // bridge
  const gap = sp - (lw + b * 2) * Math.cos(0.28);
  const bridge = new THREE.QuadraticBezierCurve3(v3(-gap / 2 - 0.001, 0, 0), v3(0, 0.003 * hs, 0.002 * hs), v3(gap / 2 + 0.001, 0, 0));
  P.add(new THREE.TubeGeometry(bridge, 8, 0.0014 * hs, 6), frameMat, null, M(fit.eyeCenter.x, fit.eyeCenter.y + lh * 0.28, fit.eyeCenter.z + 0.0055 * hs));
  const obj = P.build();
  obj.userData.iconDir = [0.45, 0.25, 1];
  return obj;
}

function bowtieTexture(): THREE.Texture {
  return drawTex('bowtie', 256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#b3161f'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff4ec';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      ctx.beginPath(); ctx.arc((x + (y % 2) * 0.5) * (w / 8), (y + 0.5) * (h / 8), 5.5, 0, Math.PI * 2); ctx.fill();
    }
  }, true, true);
}

function makeBowtie(fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const satin = phys({ map: bowtieTexture(), roughness: 0.35, sheen: 1, sheenRoughness: 0.3, sheenColor: new THREE.Color('#ffb0b8'), clearcoat: 0.3, clearcoatRoughness: 0.3 });
  const { m: frame } = collarFrame(fit);
  const R = fit.neckRadius * 1.04 + 0.002 * hs;
  const P = new Parts();
  const bandMat = satin.clone();
  P.add(bandGeometry(R, 0.007 * hs, 0.0022 * hs, 40, 8), bandMat, null, frame);
  // the bow sits on the throat, facing outwards
  const bm = frame.clone().multiply(M(0, 0.001 * hs, R * neckOval(0) + 0.009 * hs, 0.3, 0, 0));
  const LW = 0.056 * hs, HC = 0.009 * hs, HW = 0.03 * hs, TH = 0.011 * hs;
  for (const s of [1, -1]) {
    const wing = new THREE.SphereGeometry(1, 18, 12);
    warp(wing, (v) => {
      const u = (v.x + 1) / 2; // 0 at the knot, 1 at the tip
      const h = HC + (HW - HC) * Math.pow(smoothstep(0, 1, u), 0.6);
      const t = TH * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, u * 1.15)));
      // pleats towards the knot
      const pleat = 1 + 0.12 * Math.sin(v.y * 9) * (1 - u);
      v.set(s * u * LW * 0.5, v.y * h * 0.5 * pleat, v.z * t * 0.5);
    });
    planarUV(wing, 'x', 'y', 1 / (0.04 * hs), 0.5, 0.5);
    P.add(wing, satin, null, bm);
  }
  const knot = new RoundedBoxGeometry(0.012 * hs, 0.013 * hs, 0.011 * hs, 2, 0.0035 * hs);
  planarUV(knot, 'x', 'y', 1 / (0.04 * hs), 0.3, 0.3);
  P.add(knot, satin, null, bm.clone().multiply(M(0, 0, 0.001 * hs)));
  const obj = P.build();
  obj.traverse((o) => { if ((o as THREE.Mesh).material === bandMat) o.userData.iconHidden = true; });
  const face = v3(0, 0, 1).transformDirection(bm);
  obj.userData.iconDir = [face.x + 0.35, face.y + 0.3, face.z];
  return obj;
}

function makeFlowerCrown(fit: AccessoryFit): THREE.Group {
  const hs = fit.headScale;
  const mat = phys({ vertexColors: true, roughness: 0.6, sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color('#ffffff'), side: THREE.DoubleSide });
  const P = new Parts();
  const RR = 0.041, N = 10;
  const ring = new THREE.TorusGeometry(RR, 0.0014, 5, 40);
  ring.rotateX(Math.PI / 2);
  P.add(ring, mat, '#4f8a2a');
  const palette = ['#f48fb1', '#ffffff', '#ffd54f', '#ce93d8', '#ffab91', '#f8bbd0'];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const base = new THREE.Matrix4().makeRotationY(a).multiply(M(0, 0.001, RR));
    const col = new THREE.Color(palette[i % palette.length]);
    const size = 0.0125 * (0.85 + ((i * 37) % 10) / 30);
    for (let k = 0; k < 5; k++) {
      const pet = new THREE.PlaneGeometry(1, 1, 2, 4);
      warp(pet, (v) => { const t = v.y + 0.5; const w = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.6) * 0.5; v.set(v.x * 2 * w * size * 1.1, t * size, v.x * v.x * size * 0.5 + t * t * size * 0.22); });
      paintVerts(pet, (_x, y, _z, c) => c.copy(col).lerp(new THREE.Color('#ffffff'), 0.35 * (1 - y / size)));
      P.add(pet, mat, null, base.clone().multiply(M(0, 0.002, 0, -0.35, 0, 0)).multiply(M(0, 0, 0, 0, 0, (k / 5) * Math.PI * 2)).multiply(M(0, 0, 0, -Math.PI / 2 + 0.25, 0, 0)));
    }
    const ctr = new THREE.SphereGeometry(size * 0.28, 6, 4);
    P.add(ctr, mat, '#f2a516', base.clone().multiply(M(0, 0.0028, 0.001, 0, 0, 0, 1, 0.7, 1)));
    // a leaf between flowers
    const leaf = petalGeo(0.011, 0.0055, 0.2);
    const la = a + Math.PI / N;
    P.add(leaf, mat, '#5d9c34', new THREE.Matrix4().makeRotationY(la).multiply(M(0, 0.001, RR, -1.2, 0, Math.PI / 2 + 0.3)));
  }
  const g = P.build();
  g.scale.setScalar(hs);
  g.rotation.x = 0.06;
  const holder = new THREE.Group().add(g);
  holder.position.copy(fit.headTop).add(v3(0, -0.0145 * hs, 0.001 * hs));
  holder.userData.iconDir = [0.3, 0.9, 1];
  return holder;
}

/** A reasonable fit for building accessories without a dog (shop icons): a labrador puppy. */
export function defaultAccessoryFit(): AccessoryFit {
  return {
    neckRadius: 0.076, collarCenter: v3(0, 0.024, 0.02), neckAxis: v3(0, 0.77, 0.638).normalize(),
    headScale: 1.1, headTop: v3(0, 0.082, 0.033), eyeCenter: v3(0, 0.035, 0.091), eyeSpacing: 0.05,
  };
}

/**
 * Builds a wearable fitted to a dog; add `object` to `dogModel.bones[accessory.bone]`.
 * `object.userData.iconDir` / mesh `userData.iconHidden` are hints for renderIcon.
 */
export function makeAccessory(kind: AccessoryKind, fit: AccessoryFit): Accessory {
  let object: THREE.Object3D;
  let bone: 'neck' | 'head' = 'neck';
  switch (kind) {
    case 'collarRed': case 'collarBlue': object = makeCollar(kind, fit); break;
    case 'bandana': object = makeBandana(fit); break;
    case 'bowtie': object = makeBowtie(fit); break;
    case 'ribbon': object = makeRibbon(fit); bone = 'head'; break;
    case 'cap': object = makeCap(fit); bone = 'head'; break;
    case 'sunglasses': object = makeSunglasses(fit); bone = 'head'; break;
    case 'flowerCrown': object = makeFlowerCrown(fit); bone = 'head'; break;
  }
  object.name = kind;
  return { kind, bone, object, dispose: () => disposeObject(object) };
}
