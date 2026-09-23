// Coat colouring. Each pattern paints a vertex from its bind position, normal
// and the soft region tags produced by the sculpt.

import * as THREE from 'three';
import type { CoatDef } from './breeds';
import type { DogDesign } from './design';

export interface PaintCtx {
  p: [number, number, number];
  n: [number, number, number];
  tags: Record<string, number>;
  design: DogDesign;
  /** head space coordinates (divided by head scale) */
  hx: number;
  hy: number;
  hz: number;
  /** 0 at hips, 1 at shoulders */
  u: number;
  /** distance to nearest eye centre divided by eye radius */
  eyeD: number;
  /** position relative to the tail base, 0 at base and 1 at tip */
  tailF: number;
}

export interface Paint {
  color: THREE.Color;
  /** fur length multiplier (0 = bare skin) */
  fur: number;
  gloss: number;
}

// cheap value noise for organic mask borders
function hash3(x: number, y: number, z: number) {
  let h = x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
function fbm(x: number, y: number, z: number) {
  return vnoise(x, y, z) * 0.6 + vnoise(x * 2.1 + 7, y * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3 + 3, z * 4.3) * 0.1;
}

/** cellular noise: distance to the nearest jittered feature point plus a per-cell random value */
function worley(x: number, y: number, z: number): [number, number] {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9, id = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const px = cx + 0.15 + 0.7 * hash3(cx, cy, cz);
    const py = cy + 0.15 + 0.7 * hash3(cx + 17, cy + 31, cz + 7);
    const pz = cz + 0.15 + 0.7 * hash3(cx + 5, cy + 11, cz + 23);
    const dd = Math.hypot(x - px, y - py, z - pz);
    if (dd < best) { best = dd; id = hash3(cx + 3, cy + 7, cz + 13); }
  }
  return [best, id];
}

const ss = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const colorCache = new Map<string, THREE.Color>();
function col(hex: string) {
  let c = colorCache.get(hex);
  if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
  return c;
}

function sum(t: Record<string, number>, ...keys: string[]) {
  let s = 0;
  for (const k of keys) s += t[k] || 0;
  return s;
}

/** Common anatomical masks used by several patterns. */
function masks(c: PaintCtx, coat: CoatDef) {
  const { p, n, tags, design } = c;
  const o = coat.opts || {};
  const d = design.dims;
  const nz = (p[0] * 31 + p[1] * 17 + p[2] * 23);
  const noise = fbm(p[0] * 60, p[1] * 60, p[2] * 60 + nz * 0) - 0.5;
  const head = sum(tags, 'skull', 'brow', 'cheek', 'muzzle', 'lip', 'nose', 'jaw', 'chin');
  const muzzle = sum(tags, 'muzzle', 'lip', 'chin', 'jaw', 'nose');
  const legs = sum(tags, 'legF', 'legH', 'paw');
  const under = clamp01(-n[1]);
  // inner side of legs faces the body midline
  const inner = legs * clamp01(-Math.sign(p[0]) * n[0] * 1.5);
  const lowLeg = ss(d.H * 0.42, d.H * 0.18, p[1]) * (1 - head) * (1 - sum(tags, 'tail'));
  const belly = sum(tags, 'belly') * ss(-0.2, -0.7, n[1]) + sum(tags, 'ribs', 'chest') * ss(-0.55, -0.9, n[1]);
  const chestFront = sum(tags, 'chest', 'throat') * ss(0.0, 0.6, n[2] - n[1] * 0.3);
  const throat = sum(tags, 'throat', 'neck') * ss(-0.1, -0.7, n[1]) * ss(-0.3, 0.3, n[2]);
  const backTop = sum(tags, 'back', 'ribs', 'rump', 'neck', 'shoulder') * ss(0.2, 0.8, n[1]);
  const underTail = sum(tags, 'tail') * ss(0.0, -0.6, n[1]);
  const muzzleLower = muzzle * ss(0.55, -0.1, n[1]);
  const cheekLower = sum(tags, 'cheek') * ss(0.3, -0.4, n[1]);
  // spots above the eyes ("pips"); opts.pip scales their size, opts.pipY their height above the eye
  // the centre is pushed out along the gaze so it sits on the skin however deep the eye is set
  let pip = 0;
  const pipR = d.eyeR * 0.72 * (o.pip ?? 1);
  const pipY = d.eyeR * (o.pipY ?? 1.75);
  for (let i = 0; i < design.eyes.pos.length; i++) {
    const e = design.eyes.pos[i], g = design.eyes.dir[i];
    const cx = e[0] * (o.pipX ?? 0.95) + g[0] * d.eyeR, cy = e[1] + pipY, cz = e[2] - d.eyeR * 0.4 + g[2] * d.eyeR;
    const dist = Math.hypot(p[0] - cx, (p[1] - cy) * 1.2, p[2] - cz) / pipR;
    pip = Math.max(pip, ss(1.1, 0.75, dist + noise * 0.3));
  }
  const vent = sum(tags, 'rump') * ss(-0.4, -0.85, n[2]) * ss(d.H * 0.8, d.H * 0.62, p[1]);
  return { noise, head, muzzle, legs, under, inner, lowLeg, belly, chestFront, throat, backTop, underTail, muzzleLower, cheekLower, pip, vent };
}

type PatternFn = (c: PaintCtx, coat: CoatDef, m: ReturnType<typeof masks>, out: THREE.Color) => void;

function shadeSolid(c: PaintCtx, coat: CoatDef, m: ReturnType<typeof masks>, out: THREE.Color, baseKey = 'base') {
  const base = col(coat.colors[baseKey]);
  const light = col(coat.colors.light || coat.colors[baseKey]);
  const dark = col(coat.colors.dark || coat.colors[baseKey]);
  out.copy(base);
  const lightAmt = clamp01(m.belly * 0.7 + m.inner * 0.6 + m.throat * 0.4 + m.chestFront * 0.25 + m.underTail * 0.5 + m.noise * 0.25);
  out.lerp(light, lightAmt);
  const darkAmt = clamp01((c.tags.ear || 0) * 0.45 + m.backTop * 0.25 + m.muzzle * 0.12 * (1 - m.muzzleLower) - m.noise * 0.2);
  out.lerp(dark, darkAmt);
  // optional distinct ear colour (e.g. the redder ears of a golden puppy)
  if (coat.colors.ear) out.lerp(col(coat.colors.ear), ss(0.3, 0.8, c.tags.ear || 0));
}

/** Shade an arbitrary colour the same way shadeSolid does (paler underneath, deeper on top). */
function shadeColor(c: PaintCtx, m: ReturnType<typeof masks>, base: string, light: string | undefined, dark: string | undefined, out: THREE.Color) {
  out.copy(col(base));
  const lightAmt = clamp01(m.belly * 0.6 + m.inner * 0.5 + m.throat * 0.3 + m.underTail * 0.4 + m.noise * 0.25);
  if (light) out.lerp(col(light), lightAmt);
  const darkAmt = clamp01((c.tags.ear || 0) * 0.35 + m.backTop * 0.3 - m.noise * 0.2);
  if (dark) out.lerp(col(dark), darkAmt);
  return out;
}

const tmpC = new THREE.Color();

/**
 * Coloured head patches on a white dog (Cavalier Blenheim, Jack Russell, Shih Tzu...).
 * Colours: base/light/dark = white shades, patch (+patchLight/patchDark), optional tan points and mask.
 * opts: blaze (forehead blaze half-width, head units; 0 = none), blazeWide (half-width at the stop),
 * lozenge (Blenheim spot 0..1), body (amount of body patching 0..1), saddle (bias of patches to the
 * top line), tailBase (patch over the root of the tail), cheek (how far colour runs down the cheeks),
 * muzzle (0..1 coloured muzzle), scale (body patch noise scale).
 */
function partiMask(c: PaintCtx, coat: CoatDef, m: ReturnType<typeof masks>) {
  const o = coat.opts || {};
  const d = c.design.dims;
  const t = c.tags;
  const ear = ss(0.3, 0.7, t.ear || 0);
  // head: colour over skull, brows and upper cheeks, split by a white blaze
  const hz = c.hz, ax = Math.abs(c.hx);
  const bw = (o.blaze ?? 0.008) + ((o.blazeWide ?? 0.016) - (o.blaze ?? 0.008)) * ss(0.04, d.stopZ, hz);
  const blaze = (o.blaze ?? 0.008) > 0 ? ss(bw + 0.003, bw - 0.002, ax + m.noise * 0.008) * ss(-0.1, 0.35, c.n[1] + c.n[2]) : 0;
  const cheekCut = ss(0.35 - (o.cheek ?? 0.5), 0.05 - (o.cheek ?? 0.5), c.n[1] + m.noise * 0.3);
  let head = sum(t, 'skull', 'brow') + sum(t, 'cheek') * (1 - cheekCut);
  head *= 1 - blaze;
  // the muzzle stays white unless asked otherwise
  head = Math.max(head * (1 - ss(0.3, 0.6, m.muzzle)), ss(0.3, 0.6, m.muzzle) * (o.muzzle ?? 0) * (1 - m.muzzleLower * 0.5));
  // Blenheim spot on the crown
  if (o.lozenge) {
    const dz = hz - 0.045, dy = c.hy - 0.075;
    head = Math.max(head, (o.lozenge ?? 0) * ss(1, 0.6, Math.hypot(c.hx / 0.009, dy / 0.02, dz / 0.012) + m.noise * 0.4) * sum(t, 'skull', 'brow'));
  }
  // colour runs from the ears down the back of the neck
  const neck = sum(t, 'neck') * ss(0.0, 0.6, c.n[1] + m.noise * 0.5) * ss(-0.2, 0.4, -c.n[2]) * (o.neck ?? 0.6);
  // body patches: blobby noise biased to the top line
  const sc = (o.scale ?? 14) / Math.max(0.5, d.g);
  const blob = fbm(c.p[0] * sc + 3.1, c.p[1] * sc, c.p[2] * sc + 1.7);
  const bodyT = sum(t, 'back', 'ribs', 'rump', 'shoulder', 'thigh', 'belly', 'chest', 'legFup', 'legHup');
  const top = ss(-0.3, 0.7, c.n[1]) * ss(d.H * 0.5, d.H * 0.85, c.p[1]);
  const bodyAmt = o.body ?? 0.5;
  const th = 0.78 - 0.38 * bodyAmt;
  let body = bodyT * ss(th - 0.02, th + 0.02, blob + top * (o.saddle ?? 0.25));
  body *= 1 - clamp01(m.belly * 1.5 + m.chestFront + m.throat + m.lowLeg);
  // patch over the root of the tail
  const tb = c.design.dims.tailBase;
  const rootD = Math.hypot(c.p[0], c.p[1] - tb[1], c.p[2] - tb[2]) / (0.05 * d.g);
  const root = (o.tailBase ?? 0) * ss(1.1, 0.8, rootD + m.noise * 0.5) * (1 - m.vent) * (1 - m.underTail);
  const tail = sum(t, 'tail') * ss(0.45, 0.35, c.tailF) * (o.tailBase ?? 0);
  return clamp01(Math.max(ear, head, neck, body, root, tail) + m.noise * 0.3 * Math.max(head, body));
}

const PATTERNS: Record<string, PatternFn> = {
  solid(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
  },
  tan(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const tan = col(coat.colors.tan);
    let t = 0;
    t = Math.max(t, m.pip);
    t = Math.max(t, m.muzzleLower * ss(0.3, 0.6, m.muzzle));
    t = Math.max(t, m.cheekLower * 0.8);
    t = Math.max(t, m.lowLeg * ss(0.1, 0.45, m.legs + (c.tags.paw || 0)) * (0.55 + 0.45 * ss(-0.2, 0.3, c.n[2])));
    t = Math.max(t, m.inner * 0.9);
    t = Math.max(t, m.underTail);
    t = Math.max(t, m.vent);
    // two chest spots
    const d = c.design.dims;
    for (const side of [1, -1]) {
      const dx = c.p[0] - side * d.CD * 0.18, dy = c.p[1] - (d.H - d.CD * 0.6), dz = c.p[2] - (d.shZ + 0.035 * d.g);
      t = Math.max(t, ss(1.0, 0.6, Math.hypot(dx, dy, dz) / (0.035 * d.g) + m.noise * 0.4));
    }
    t = clamp01(t + m.noise * 0.3 * t);
    out.lerp(tan, ss(0.35, 0.65, t));
  },
  urajiro(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const cream = col(coat.colors.cream);
    let t = 0;
    t = Math.max(t, m.muzzleLower * 1.0);
    t = Math.max(t, m.cheekLower * 1.0 + (c.tags.cheek || 0) * ss(0.7, 0.2, c.n[1]) * 0.6);
    t = Math.max(t, m.throat, m.chestFront * 0.9, m.belly);
    t = Math.max(t, m.inner, m.underTail, m.vent);
    t = Math.max(t, m.pip * 0.9);
    t = Math.max(t, m.lowLeg * ss(0.2, 0.7, c.n[2]) * 0.8);
    // inner ear
    if (c.design.dims.earSide === 'erect') t = Math.max(t, (c.tags.ear || 0) * ss(0.2, 0.6, c.n[2]));
    t = clamp01(t + m.noise * 0.35 * t);
    out.lerp(cream, ss(0.35, 0.7, t));
  },
  'urajiro-tan'(c, coat, m, out) {
    PATTERNS.urajiro(c, coat, m, out);
    const tan = col(coat.colors.tan);
    const edge = clamp01(m.lowLeg * 0.8 + m.cheekLower * 0.4 + m.pip * 0.3) * (1 - ss(0.5, 0.9, m.belly + m.inner));
    out.lerp(tan, ss(0.3, 0.7, edge) * 0.8);
  },
  tricolor(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const white = col(coat.colors.white);
    const black = col(coat.colors.black);
    const d = c.design.dims;
    // black saddle over the back
    const saddle = sum(c.tags, 'back', 'ribs', 'rump', 'belly') * ss(-0.35, 0.25, c.n[1] + m.noise * 0.6) * ss(d.H * 0.55, d.H * 0.75, c.p[1]);
    const saddleFront = ss(d.shZ + 0.01, d.shZ - 0.07 * d.g, c.p[2]);
    const saddleBack = ss(d.hipZ - 0.06 * d.g, d.hipZ + 0.02 * d.g, c.p[2]);
    out.lerp(black, ss(0.3, 0.6, saddle * saddleFront * saddleBack));
    // white blaze, muzzle, chest, legs, tail tip
    const blaze = sum(c.tags, 'skull', 'brow', 'muzzle') * ss(0.013, 0.004, Math.abs(c.hx) - m.noise * 0.01) * ss(0.02, 0.07, c.hz) * ss(-0.2, 0.4, c.n[1]);
    let w = Math.max(m.muzzle * ss(0.3, 0.6, m.muzzle) * (1 - (c.tags.nose || 0)), blaze);
    w = Math.max(w, m.throat, m.chestFront, m.belly, m.inner * 0.9);
    w = Math.max(w, m.lowLeg * 1.0, (c.tags.paw || 0));
    w = Math.max(w, sum(c.tags, 'tail') * ss(0.6, 0.72, c.tailF));
    w = Math.max(w, m.vent, m.underTail * 0.6);
    w = clamp01(w + m.noise * 0.4 * w);
    out.lerp(white, ss(0.35, 0.65, w));
  },
  husky(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const white = col(coat.colors.white);
    const d = c.design.dims;
    let w = 0;
    w = Math.max(w, m.muzzleLower, m.muzzle * ss(0.3, -0.2, c.n[1] - 0.2) * 0.8);
    w = Math.max(w, (c.tags.cheek || 0) * ss(0.98, 0.7, c.n[1] + m.noise * 0.3));
    w = Math.max(w, m.pip * 1.0);
    // mask around the eyes except a dark line from the outer corner
    if (m.head > 0.3 && c.eyeD < 2.6) {
      const below = ss(0.0, -0.3, c.n[1]);
      w = Math.max(w, below * ss(2.6, 1.8, c.eyeD));
    }
    w = Math.max(w, m.throat, m.chestFront, m.belly, m.inner, m.lowLeg, m.underTail, m.vent);
    w = Math.max(w, sum(c.tags, 'neck') * ss(-0.2, -0.6, c.n[1]));
    if (d.earSide === 'erect') w = Math.max(w, (c.tags.ear || 0) * ss(0.25, 0.6, c.n[2]));
    // lower flanks are pale, with one clean line along the body
    const trunk = (1 - m.head) * (1 - sum(c.tags, 'tail', 'ear'));
    w = Math.max(w, trunk * ss(d.H - d.CD * 0.62, d.H - d.CD * 0.9, c.p[1] + m.noise * 0.035 * d.g));
    w = clamp01(w + m.noise * 0.4 * w);
    out.lerp(white, ss(0.35, 0.65, w));
    // widow's peak / skull cap stays dark
  },
  corgi(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const white = col(coat.colors.white);
    const blaze = sum(c.tags, 'skull', 'brow', 'muzzle') * ss(0.012, 0.004, Math.abs(c.hx) - m.noise * 0.012) * ss(0.03, 0.08, c.hz) * ss(-0.2, 0.4, c.n[1]);
    let w = Math.max(m.muzzleLower, m.muzzle * ss(0.25, -0.1, c.n[1] - 0.25), blaze);
    w = Math.max(w, m.throat, m.chestFront, m.belly, m.inner, m.lowLeg * 0.95, (c.tags.paw || 0));
    w = Math.max(w, sum(c.tags, 'neck') * ss(0.3, -0.4, c.n[1]) * 0.9, m.vent * 0.7);
    if (c.design.dims.earSide === 'erect') w = Math.max(w, (c.tags.ear || 0) * ss(0.25, 0.6, c.n[2]) * 0.7);
    w = clamp01(w + m.noise * 0.45 * w);
    out.lerp(white, ss(0.35, 0.65, w));
  },
  'corgi-tri'(c, coat, m, out) {
    PATTERNS.corgi(c, coat, m, out);
    const black = col(coat.colors.black);
    const d = c.design.dims;
    const saddle = sum(c.tags, 'back', 'ribs', 'rump', 'neck', 'shoulder') * ss(-0.1, 0.45, c.n[1] + m.noise * 0.6) * ss(d.H * 0.6, d.H * 0.85, c.p[1]);
    out.lerp(black, ss(0.35, 0.65, saddle) * (1 - m.belly));
  },
  /** fawn pug: black muzzle mask, eye patches, ears and a faint trace along the spine */
  pug(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const mask = col(coat.colors.mask);
    const d = c.design.dims;
    let k = ss(0.2, 0.55, sum(c.tags, 'muzzle', 'lip', 'nose')) + sum(c.tags, 'jaw', 'chin') * (coat.opts?.chin ?? 0.45);
    // mask covers the front of the face up to the eyes
    const face = m.head * ss(d.stopZ - 0.032, d.stopZ - 0.014, c.hz + m.noise * 0.012) * ss(0.05, 0.036, c.hy + m.noise * 0.012);
    k = Math.max(k, face);
    k = Math.max(k, m.head * ss(2.5, 1.7, c.eyeD + m.noise * 0.8));
    k = Math.max(k, ss(0.3, 0.7, c.tags.ear || 0));
    // forehead creases: soft dark arcs above the stop
    if (m.head > 0.3 && c.n[2] > 0.1) {
      const w = c.hy - 0.045 + c.hx * c.hx * 6;
      const crease = Math.max(ss(0.0035, 0.0008, Math.abs(w)), ss(0.003, 0.0008, Math.abs(w - 0.012)) * 0.7) * ss(0.03, 0.012, Math.abs(c.hx));
      k = Math.max(k, crease * 0.55 * sum(c.tags, 'skull', 'brow'));
    }
    // trace
    k = Math.max(k, m.backTop * ss(0.012 * d.g, 0.003 * d.g, Math.abs(c.p[0]) + m.noise * 0.004) * 0.45 * (coat.opts?.trace ?? 1));
    out.lerp(mask, clamp01(k));
  },
  /** Dalmatian: crisp round spots on white, smaller on the head and legs, heavier on the ears */
  spots(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const spot = col(coat.colors.spot);
    const d = c.design.dims;
    const o = coat.opts || {};
    const g = Math.max(0.5, d.g);
    const fine = clamp01(m.head * 0.5 + m.legs * 0.6 + (c.tags.tail || 0) * 0.5);
    const sc = (o.scale ?? 1) * (1 + fine * 0.8) / (0.03 * g);
    const [dist, id] = worley(c.p[0] * sc, c.p[1] * sc, c.p[2] * sc);
    const present = id < (o.density ?? 0.72) * (1 - 0.35 * m.head) ? 1 : 0;
    const r = 0.26 + 0.14 * ((id * 7.3) % 1);
    let k = present * ss(r + 0.05, r - 0.03, dist + m.noise * 0.08);
    // ears are mostly coloured, with a little white showing
    k = Math.max(k, ss(0.3, 0.8, c.tags.ear || 0) * ss(0.44, 0.5, fbm(c.p[0] * 70, c.p[1] * 70, c.p[2] * 70) * 0.6 + (o.ear ?? 0.3)));
    // keep the very tip of the muzzle and the chest a little clearer
    k *= 1 - 0.5 * ss(0.3, 0.6, m.muzzle) * ss(0.45, 0.2, (id * 3.7) % 1);
    out.lerp(spot, clamp01(k));
  },
  /** German Shepherd style black & tan: black saddle, crown, muzzle mask and ears on a tan dog */
  saddle(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const black = col(coat.colors.black);
    const d = c.design.dims;
    const o = coat.opts || {};
    const t = c.tags;
    const trunk = sum(t, 'back', 'ribs', 'rump', 'neck', 'shoulder', 'thigh', 'belly', 'chest', 'legFup', 'legHup');
    const line = d.H - d.CD * (o.depth ?? 0.72);
    const bodyK = trunk * ss(line - 0.02 * d.g, line + 0.015 * d.g, c.p[1] + m.noise * 0.04 * d.g) * (1 - clamp01(m.chestFront * 1.3 + m.throat * 1.2 + m.belly));
    // crown: head and neck tag weights are complementary, so add them to avoid a seam where they meet
    const crown = sum(t, 'skull', 'brow', 'cheek') * ss(0.0, 0.55, c.n[1] + m.noise * 0.4) * (1 - m.pip) * (o.crown ?? 0.9);
    let k = clamp01(bodyK + crown);
    const mask = ss(0.25, 0.55, m.muzzle) * (1 - m.muzzleLower * (o.chin ?? 0.4));
    const eyes = m.head * ss(2.4, 1.5, c.eyeD) * (1 - m.pip);
    const ears = ss(0.3, 0.7, t.ear || 0) * (1 - (d.earSide === 'erect' ? ss(0.3, 0.7, c.n[2]) * 0.6 : 0));
    const tail = sum(t, 'tail') * Math.max(ss(-0.3, 0.3, c.n[1] + m.noise * 0.4), ss(0.7, 0.9, c.tailF));
    k = Math.max(k, mask, eyes, ears, tail * (1 - m.underTail));
    k = clamp01(k + m.noise * 0.3 * k);
    out.lerp(black, ss(0.35, 0.65, k));
  },
  /** sable: black-tipped hair over the top line, darker ears and muzzle */
  sable(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const black = col(coat.colors.black);
    const o = coat.opts || {};
    const t = c.tags;
    const top = clamp01(m.backTop * 1.1 + sum(t, 'neck', 'shoulder', 'thigh', 'ribs', 'back', 'rump') * ss(-0.5, 0.5, c.n[1]) * 0.75
      + sum(t, 'tail') * ss(-0.3, 0.4, c.n[1]) * 0.9 + sum(t, 'skull', 'brow') * ss(0.3, 0.8, c.n[1]) * 0.6);
    const grain = fbm(c.p[0] * 160, c.p[1] * 160, c.p[2] * 160);
    let k = top * (0.45 + 0.7 * grain) * (o.sable ?? 0.8);
    k = Math.max(k, ss(0.3, 0.7, t.ear || 0) * (o.ears ?? 0.7));
    k = Math.max(k, ss(0.25, 0.55, m.muzzle) * (1 - m.muzzleLower * 0.5) * (o.mask ?? 0.8));
    k *= 1 - clamp01(m.belly + m.inner + m.throat * 0.7 + m.chestFront * 0.6 + m.underTail);
    out.lerp(black, clamp01(k));
  },
  /** white dog with coloured head and body patches (see partiMask) */
  parti(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const k = partiMask(c, coat, m);
    shadeColor(c, m, coat.colors.patch, coat.colors.patchLight, coat.colors.patchDark, tmpC);
    // tan points inside the patches (tricolour)
    if (coat.colors.tan) {
      let tp = Math.max(m.pip * 1.1, m.cheekLower * 0.9 * (1 - ss(0.3, 0.6, m.muzzle)), m.underTail, m.vent * 0.8);
      const earTan = coat.opts?.earTan ?? 0;
      if (earTan > 0.5) tp = Math.max(tp, ss(0.3, 0.7, c.tags.ear || 0));
      else if (c.design.dims.earSide === 'floppy') tp = Math.max(tp, (c.tags.ear || 0) * ss(0.2, 0.7, -c.n[0] * Math.sign(c.p[0])) * 0.8);
      tmpC.lerp(col(coat.colors.tan), ss(0.35, 0.65, tp));
    }
    out.lerp(tmpC, ss(0.35, 0.65, k));
  },
  /** Yorkshire terrier puppy: black saddle with a tan head, legs and underside */
  yorkie(c, coat, m, out) {
    const t = c.tags;
    const d = c.design.dims;
    shadeColor(c, m, coat.colors.tan, coat.colors.tanLight, coat.colors.tanDark, out);
    shadeColor(c, m, coat.colors.base, coat.colors.light, coat.colors.dark, tmpC);
    const trunk = sum(t, 'back', 'ribs', 'rump', 'neck', 'shoulder', 'thigh', 'belly', 'chest', 'legFup', 'legHup');
    const line = d.H - d.CD * 0.8;
    let k = trunk * ss(line - 0.015 * d.g, line + 0.015 * d.g, c.p[1] + m.noise * 0.03 * d.g);
    k *= 1 - clamp01(m.chestFront * 1.2 + m.throat * 1.3 + m.belly + m.inner);
    // puppies keep a black crown behind the brows; added (not max) so it joins the neck without a seam
    k = clamp01(k + sum(t, 'skull', 'cheek') * ss(0.055, 0.03, c.hz + m.noise * 0.02) * ss(0.1, 0.6, c.n[1]) * (coat.opts?.crown ?? 0.9));
    k = Math.max(k, (t.ear || 0) * ss(0.075, 0.1, c.hy) * 0.6);
    k = Math.max(k, sum(t, 'tail') * ss(0.05, 0.3, c.tailF + m.noise * 0.1));
    k = clamp01(k + m.noise * 0.3 * k);
    out.lerp(tmpC, ss(0.35, 0.65, k));
  },
  /** Schnauzer salt & pepper: peppered grey coat with pale furnishings (beard, brows, legs, belly) */
  grizzle(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const t = c.tags;
    const dark = col(coat.colors.pepper || coat.colors.dark);
    const pale = col(coat.colors.silver || coat.colors.light);
    const pep = clamp01(m.backTop * 0.8 + sum(t, 'skull') * 0.5 + (t.ear || 0) * 0.7 + sum(t, 'tail') * 0.6 + 0.25);
    const grain = vnoise(c.p[0] * 700, c.p[1] * 700, c.p[2] * 700);
    out.lerp(dark, clamp01(pep * (0.25 + 0.75 * grain) * (coat.opts?.pepper ?? 0.85)));
    const furn = furnishings(c, m);
    out.lerp(pale, ss(0.3, 0.7, furn) * 0.85);
  },
  /** solid dark coat with silver furnishings (black & silver schnauzer) */
  furnish(c, coat, m, out) {
    shadeSolid(c, coat, m, out);
    const pale = col(coat.colors.silver);
    out.lerp(pale, ss(0.35, 0.7, furnishings(c, m)));
  },
};

/** beard, eyebrows, legs, chest and belly: the long "furnishing" coat of a schnauzer */
function furnishings(c: PaintCtx, m: ReturnType<typeof masks>) {
  const t = c.tags;
  let f = Math.max(m.muzzleLower, ss(0.3, 0.6, m.muzzle) * ss(0.6, 0.1, c.n[1]) * 0.9, m.pip * 1.2);
  f = Math.max(f, (t.brow || 0) * ss(0.2, 0.6, c.n[2]) * 0.9);
  f = Math.max(f, m.cheekLower * 0.7, m.throat, m.chestFront * 0.9, m.belly, m.inner, m.underTail, m.vent);
  f = Math.max(f, m.lowLeg * 0.9, (t.paw || 0) * 0.9);
  return clamp01(f + m.noise * 0.3 * f);
}

export function paintVertex(c: PaintCtx, coat: CoatDef, furRegions: Record<string, number>): Paint {
  const m = masks(c, coat);
  const fn = PATTERNS[coat.pattern] || PATTERNS.solid;
  const out = new THREE.Color();
  fn(c, coat, m, out);

  // fur length from region multipliers
  let fur = 0, tw = 0;
  for (const [k, v] of Object.entries(c.tags)) {
    const r = furRegions[k] ?? 1;
    fur += r * v;
    tw += v;
  }
  fur = tw > 0 ? fur / tw : 1;
  if ((c.tags.legF || 0) > 0.3 && furRegions.legFback !== undefined) fur = fur * (1 - ss(-0.1, -0.6, c.n[2])) + furRegions.legFback * ss(-0.1, -0.6, c.n[2]) * (c.tags.legF || 0);
  let gloss = 0;

  // nose leather
  const nose = c.tags.nose || 0;
  if (nose > 0.25) {
    out.lerp(col(coat.nose), ss(0.25, 0.6, nose));
    fur *= 1 - ss(0.25, 0.5, nose);
    gloss = Math.max(gloss, ss(0.3, 0.7, nose));
  }
  // lips: dark rim along the underside of the flews
  const lip = c.tags.lip || 0;
  if (lip > 0.3 && c.n[1] < -0.2) {
    const k = ss(0.3, 0.7, lip) * ss(-0.2, -0.6, c.n[1]);
    out.lerp(col('#2a1d1b'), k * 0.9);
    fur *= 1 - k;
    gloss = Math.max(gloss, k * 0.35);
  }
  // mouth interior (palate on the head, gums/tongue bed on the jaw)
  const d = c.design.dims;
  const mouthZone = (c.tags.jaw || 0) + (c.tags.chin || 0);
  if (mouthZone > 0.4 && c.n[1] > 0.2) {
    const k = ss(0.2, 0.55, c.n[1]);
    const inner = ss(d.muzzleW * 0.3, d.muzzleW * 0.18, Math.abs(c.hx)) * ss(d.stopZ + d.muzzleL * 0.78, d.stopZ + d.muzzleL * 0.55, c.hz);
    out.lerp(col('#261a19'), k);
    out.lerp(col('#b4505d'), k * inner);
    fur *= 1 - k;
    gloss = Math.max(gloss, 0.5 * k);
  }
  const upperMouth = sum(c.tags, 'muzzle', 'lip');
  if (upperMouth > 0.5 && c.n[1] < -0.55 && Math.abs(c.hx) < 0.02 && c.hy < 0.0) {
    const k = ss(-0.55, -0.85, c.n[1]);
    out.lerp(col('#6e2d35'), k);
    fur *= 1 - k;
  }
  // paw pads
  const paw = c.tags.paw || 0;
  if (paw > 0.3 && c.n[1] < -0.45 && c.p[1] < d.pawR * 0.45) {
    const k = ss(-0.45, -0.75, c.n[1]);
    out.lerp(col(coat.pad || '#2a2020'), k);
    fur *= 1 - k;
    gloss = Math.max(gloss, 0.15 * k);
  }
  // eye rims and short fur around the eyes
  if (c.eyeD < 2.6) {
    const bare = ss(1.2, 2.5, c.eyeD);
    fur *= bare;
    // bare skin round the eye would otherwise read lighter than the root-shaded fur around it
    if (fur < 1) out.multiplyScalar(0.8 + 0.2 * bare);
    const rim = ss(1.45, 1.12, c.eyeD);
    out.lerp(col('#1e1614'), rim * 0.9);
    gloss = Math.max(gloss, rim * 0.3);
  }
  return { color: out, fur, gloss };
}
