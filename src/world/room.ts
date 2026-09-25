// The puppy's home (three themes) plus a small "interior kit" of procedural
// textures, geometry batching and props shared with the bathroom, kennel and
// obedience ring builders.

import * as THREE from 'three';
import { physicalMaterial } from './materials';
import { texSize } from '../game/quality';
import { shadowMapSize } from '../game/shadows';
import { freeGeometryAfterUpload, manageCanvasTexture } from './texmem';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Circle, Room, RoomTheme } from './types';

// ============================================================================
// Interior kit: randomness, canvases, textures
// ============================================================================

export type Rand = () => number;

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): Rand {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  return { c, g };
}

/** Wrap a canvas as a repeating, mipmapped texture. `color` = sRGB data (albedo), otherwise linear. */
export function canvasTex(c: HTMLCanvasElement, color = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  // fit to the device, free the canvas once uploaded (see texmem.ts)
  return manageCanvasTexture(t);
}

/** Tileable fractal value noise in [0, 1]. `cells` is the lattice size of the first octave. */
export function tileNoise(w: number, h: number, cells: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const out = new Float32Array(w * h);
  const r = rng(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = Math.max(1, Math.round(cells * 2 ** o));
    const cy = Math.max(1, Math.round((cells * 2 ** o * h) / w));
    const lat = new Float32Array(cx * cy);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * cy;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % cy) * cx;
      const r1 = ((y0 + 1) % cy) * cx;
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * cx;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = x0 % cx;
        const b = (x0 + 1) % cx;
        const top = lat[r0 + a] + (lat[r0 + b] - lat[r0 + a]) * sx;
        const bot = lat[r1 + a] + (lat[r1 + b] - lat[r1 + a]) * sx;
        out[y * w + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Read one channel of a canvas as a height field (0..1). */
export function heightFromCanvas(c: HTMLCanvasElement): Float32Array {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const h = new Float32Array(c.width * c.height);
  for (let i = 0; i < h.length; i++) h[i] = d[i * 4] / 255;
  return h;
}

/** Tangent-space normal map (tiling) from a height field. Strength ~ height units per pixel. */
export function normalFromHeight(h: Float32Array, w: number, hh: number, strength: number): THREE.CanvasTexture {
  const { c, g } = makeCanvas(w, hh);
  const img = g.createImageData(w, hh);
  const d = img.data;
  for (let y = 0; y < hh; y++) {
    const yu = ((y - 1 + hh) % hh) * w;
    const yd = ((y + 1) % hh) * w;
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w;
      const xr = (x + 1) % w;
      const nx = -(h[y * w + xr] - h[y * w + xl]) * strength;
      const ny = (h[yd + x] - h[yu + x]) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * w + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTex(c, false);
}

/** Add fine per-pixel luminance noise to a canvas (breaks up flat CG colour). */
export function grainCanvas(c: HTMLCanvasElement, amount: number, seed: number) {
  const g = c.getContext('2d')!;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

function hexJitter(hex: string, r: Rand, dl: number, ds = 0, dh = 0): string {
  const c = new THREE.Color(hex);
  c.offsetHSL((r() - 0.5) * dh, (r() - 0.5) * ds, (r() - 0.5) * dl);
  return '#' + c.getHexString();
}

// ---- wood --------------------------------------------------------------------

/** Paint wood grain lines into the current clip region (a board running along +x). */
function paintGrain(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, r: Rand, density: number, dark: string) {
  // soft lengthwise tone variation
  const lg = g.createLinearGradient(x0, 0, x0 + w, 0);
  for (let i = 0; i <= 4; i++) {
    const a = (r() - 0.5) * 0.16;
    lg.addColorStop(i / 4, a > 0 ? `rgba(255,240,215,${a})` : `rgba(40,20,5,${-a})`);
  }
  g.fillStyle = lg;
  g.fillRect(x0, y0, w, h);
  // across-board shading (slightly darker at the edges)
  const cg = g.createLinearGradient(0, y0, 0, y0 + h);
  cg.addColorStop(0, 'rgba(40,20,5,0.10)');
  cg.addColorStop(0.2, 'rgba(40,20,5,0)');
  cg.addColorStop(0.8, 'rgba(40,20,5,0)');
  cg.addColorStop(1, 'rgba(40,20,5,0.12)');
  g.fillStyle = cg;
  g.fillRect(x0, y0, w, h);
  // cathedral figure: soft nested flame arches (subtle)
  if (r() < 0.4) {
    const cx = x0 + w * (0.25 + r() * 0.5);
    const cy = y0 + h * (0.35 + r() * 0.3);
    const n = 6 + Math.floor(r() * 6);
    const len = w * (0.18 + r() * 0.2);
    g.lineWidth = Math.max(1, h * 0.012);
    for (let i = 0; i < n; i++) {
      const s = (i + 1) / n;
      g.strokeStyle = `rgba(${dark},${0.03 + r() * 0.05})`;
      g.beginPath();
      g.moveTo(cx - len * 2.5, cy - h * 0.45 * s);
      g.bezierCurveTo(cx - len * 0.5, cy - h * 0.42 * s, cx + len * s, cy - h * 0.25 * s, cx + len * s * 1.1, cy);
      g.bezierCurveTo(cx + len * s, cy + h * 0.25 * s, cx - len * 0.5, cy + h * 0.42 * s, cx - len * 2.5, cy + h * 0.45 * s);
      g.stroke();
    }
  }
  // straight-ish grain lines
  const lines = Math.round(h * density);
  for (let i = 0; i < lines; i++) {
    const yy = y0 + r() * h;
    const amp = h * (0.01 + r() * 0.05);
    const freq = 0.5 + r() * 2.5;
    const ph = r() * 6.28;
    g.strokeStyle = r() < 0.8 ? `rgba(${dark},${0.04 + r() * 0.12})` : `rgba(255,236,200,${0.05 + r() * 0.08})`;
    g.lineWidth = 0.5 + r() * 1.6;
    g.beginPath();
    const seg = 24;
    for (let s = 0; s <= seg; s++) {
      const x = x0 + (s / seg) * w;
      const y = yy + amp * Math.sin(ph + (s / seg) * freq * 6.283);
      if (s === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // pores / flecks
  const flecks = Math.round(w * h * 0.004);
  for (let i = 0; i < flecks; i++) {
    g.fillStyle = `rgba(${dark},${0.08 + r() * 0.15})`;
    g.fillRect(x0 + r() * w, y0 + r() * h, 1 + r() * 4, 0.8 + r() * 0.6);
  }
}

export interface PlankSpec {
  px: number; // colour map size
  rows: number; // planks across the tile
  minLen: number; // plank length as fraction of the tile
  maxLen: number;
  colors: string[];
  seed: number;
  dark?: string; // grain colour "r,g,b"
  grain?: number; // grain lines per pixel of board width
  seam?: number; // seam darkness 0..1
  knots?: number;
}

/** Plank floor textures (boards run along u). Returns colour, normal and roughness maps for one tile. */
export function plankTextures(s: PlankSpec) {
  const r = rng(s.seed);
  const W = s.px;
  const { c, g } = makeCanvas(W);
  const hp = W / 2;
  const { c: hc, g: hg } = makeCanvas(hp);
  const rp = W / 4;
  const { c: rc, g: rg } = makeCanvas(rp);
  hg.fillStyle = '#c8c8c8';
  hg.fillRect(0, 0, hp, hp);
  rg.fillStyle = '#707070';
  rg.fillRect(0, 0, rp, rp);
  const rowH = W / s.rows;
  const dark = s.dark ?? '60,34,14';
  const boards: [number, number, number, number][] = [];
  for (let row = 0; row < s.rows; row++) {
    const y0 = row * rowH;
    let x = r() * W;
    const end = x + W;
    while (x < end - 1) {
      let len = (s.minLen + r() * (s.maxLen - s.minLen)) * W;
      if (end - (x + len) < s.minLen * W * 0.6) len = end - x;
      boards.push([x, y0, Math.min(len, end - x), rowH]);
      x += len;
    }
  }
  for (const [bx, by, bw, bh] of boards) {
    const base = hexJitter(s.colors[Math.floor(r() * s.colors.length)], r, 0.09, 0.08, 0.015);
    const seedB = r() * 1e9;
    const rough = 0.34 + r() * 0.2;
    for (const off of [0, -W]) {
      const x0 = bx + off;
      if (x0 + bw < 0 || x0 > W) continue;
      const br = rng(seedB);
      g.save();
      g.beginPath();
      g.rect(x0, by, bw, bh);
      g.clip();
      g.fillStyle = base;
      g.fillRect(x0, by, bw, bh);
      paintGrain(g, x0, by, bw, bh, br, s.grain ?? 0.35, dark);
      if (s.knots && br() < s.knots) {
        const kx = x0 + bw * (0.15 + br() * 0.7);
        const ky = by + bh * (0.3 + br() * 0.4);
        for (let k = 5; k > 0; k--) {
          g.fillStyle = `rgba(${dark},${0.12})`;
          g.beginPath();
          g.ellipse(kx, ky, k * bh * 0.05, k * bh * 0.025, 0, 0, 6.283);
          g.fill();
        }
      }
      g.restore();
      // seams on colour map
      g.strokeStyle = `rgba(35,18,6,${s.seam ?? 0.55})`;
      g.lineWidth = 1.5;
      g.strokeRect(x0 + 0.5, by + 0.5, bw - 1, bh - 1);
      // height: bevelled board edges
      const k = hp / W;
      hg.fillStyle = `rgb(${190 + br() * 20},${190},${190})`;
      hg.fillRect((x0 + 1) * k, (by + 1) * k, (bw - 2) * k, (bh - 2) * k);
      hg.strokeStyle = '#8a8a8a';
      hg.lineWidth = 2;
      hg.strokeRect((x0 + 1) * k, (by + 1) * k, (bw - 2) * k, (bh - 2) * k);
      hg.strokeStyle = '#303030';
      hg.lineWidth = 1;
      hg.strokeRect(x0 * k + 0.5, by * k + 0.5, bw * k - 1, bh * k - 1);
      // roughness per board
      const q = rp / W;
      const rv = Math.round(rough * 255);
      rg.fillStyle = `rgb(${rv},${rv},${rv})`;
      rg.fillRect(x0 * q, by * q, bw * q, bh * q);
      rg.strokeStyle = '#d0d0d0';
      rg.lineWidth = 1;
      rg.strokeRect(x0 * q + 0.5, by * q + 0.5, bw * q - 1, bh * q - 1);
    }
  }
  grainCanvas(c, 10, s.seed + 1);
  // fine grain streaks in the height map, derived from the colour map
  const col = g.getImageData(0, 0, W, W).data;
  const hImg = hg.getImageData(0, 0, hp, hp);
  const hd = hImg.data;
  for (let y = 0; y < hp; y++)
    for (let x = 0; x < hp; x++) {
      const ci = (y * 2 * W + x * 2) * 4;
      const lum = (col[ci] + col[ci + 1] + col[ci + 2]) / 765;
      const i = (y * hp + x) * 4;
      hd[i] = Math.max(0, Math.min(255, hd[i] + (lum - 0.5) * 30));
    }
  hg.putImageData(hImg, 0, 0);
  // streaky wear in roughness
  const rn = tileNoise(rp, rp, 4, 4, s.seed + 7);
  const rImg = rg.getImageData(0, 0, rp, rp);
  for (let i = 0; i < rn.length; i++) {
    const v = rImg.data[i * 4] + (rn[i] - 0.5) * 60;
    rImg.data[i * 4] = rImg.data[i * 4 + 1] = rImg.data[i * 4 + 2] = Math.max(0, Math.min(255, v));
  }
  rg.putImageData(rImg, 0, 0);
  return {
    map: canvasTex(c),
    normalMap: normalFromHeight(heightFromCanvas(hc), hp, hp, 2.2),
    roughnessMap: canvasTex(rc, false),
  };
}

export interface TileSpec {
  px: number;
  cols: number;
  rows: number;
  /** grout width in px */
  grout: number;
  colors: string[];
  groutColor: string;
  seed: number;
  /** half-tile offset on odd rows (subway / brick bond) */
  stagger?: boolean;
  /** alternate colours in a checkerboard instead of random picks */
  checker?: boolean;
  /** soft stone-like veining */
  marble?: number;
  /** tile surface roughness 0..1 */
  rough?: number;
}

/** Ceramic / vinyl tiles with grout: colour, normal (bevelled edges) and roughness maps. */
export function tileTextures(s: TileSpec) {
  const r = rng(s.seed);
  const W = s.px;
  const tw = W / s.cols;
  const th = W / s.rows;
  const { c, g } = makeCanvas(W);
  const hp = W / 2;
  const { g: hg } = makeCanvas(hp);
  const { c: rc, g: rg } = makeCanvas(W / 4);
  g.fillStyle = s.groutColor;
  g.fillRect(0, 0, W, W);
  hg.fillStyle = '#000';
  hg.fillRect(0, 0, hp, hp);
  rg.fillStyle = '#e0e0e0';
  rg.fillRect(0, 0, W / 4, W / 4);
  const gr = s.grout;
  for (let row = 0; row < s.rows; row++) {
    const off = s.stagger && row % 2 ? tw / 2 : 0;
    for (let col = -1; col < s.cols; col++) {
      const x = col * tw + off;
      if (x + tw <= 0 || x >= W) continue;
      const base = s.checker ? s.colors[(row + col + 2) % s.colors.length] : s.colors[Math.floor(r() * s.colors.length)];
      const colr = hexJitter(base, r, 0.03, 0.02);
      const rough = Math.round(((s.rough ?? 0.18) + r() * 0.06) * 255);
      for (const wrap of [0, -W, W]) {
        const x0 = x + wrap + gr / 2;
        if (x0 + tw < 0 || x0 > W) continue;
        const y0 = row * th + gr / 2;
        const w = tw - gr;
        const h = th - gr;
        g.fillStyle = colr;
        g.fillRect(x0, y0, w, h);
        const lg = g.createLinearGradient(x0, y0, x0 + w, y0 + h);
        lg.addColorStop(0, 'rgba(255,255,255,0.08)');
        lg.addColorStop(1, 'rgba(0,0,0,0.05)');
        g.fillStyle = lg;
        g.fillRect(x0, y0, w, h);
        if (s.marble) {
          g.save();
          g.beginPath();
          g.rect(x0, y0, w, h);
          g.clip();
          for (let k = 0; k < 3; k++) {
            g.strokeStyle = `rgba(120,120,130,${0.08 * s.marble + r() * 0.1 * s.marble})`;
            g.lineWidth = 0.6 + r() * 1.5;
            g.beginPath();
            let px = x0 + r() * w;
            let py = y0;
            g.moveTo(px, py);
            while (py < y0 + h) {
              px += (r() - 0.5) * w * 0.25;
              py += h * 0.08;
              g.lineTo(px, py);
            }
            g.stroke();
          }
          g.restore();
        }
        const k = hp / W;
        const bev = Math.max(1, gr * 0.9 * k);
        hg.fillStyle = '#707070';
        hg.fillRect(x0 * k, y0 * k, w * k, h * k);
        hg.fillStyle = '#c8c8c8';
        hg.fillRect(x0 * k + bev, y0 * k + bev, w * k - 2 * bev, h * k - 2 * bev);
        rg.fillStyle = `rgb(${rough},${rough},${rough})`;
        rg.fillRect(x0 / 4, y0 / 4, w / 4, h / 4);
      }
    }
  }
  grainCanvas(c, 6, s.seed);
  const hImg = hg.getImageData(0, 0, hp, hp);
  const h = new Float32Array(hp * hp);
  // soften the bevel a little
  for (let i = 0; i < h.length; i++) h[i] = hImg.data[i * 4] / 255;
  const hs = new Float32Array(h.length);
  for (let y = 0; y < hp; y++)
    for (let x = 0; x < hp; x++) {
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += h[((y + dy + hp) % hp) * hp + ((x + dx + hp) % hp)];
      hs[y * hp + x] = acc / 9;
    }
  return { map: canvasTex(c), normalMap: normalFromHeight(hs, hp, hp, 2.5), roughnessMap: canvasTex(rc, false) };
}

/** Generic furniture wood (light, neutral; tint it with vertex colours). */
export function woodTexture(seed: number, px = 512) {
  const r = rng(seed);
  const { c, g } = makeCanvas(px);
  g.fillStyle = '#d8b48a';
  g.fillRect(0, 0, px, px);
  const rows = 3;
  for (let i = 0; i < rows; i++) {
    const y0 = (i * px) / rows;
    g.save();
    g.beginPath();
    g.rect(0, y0, px, px / rows);
    g.clip();
    g.fillStyle = hexJitter('#d8b48a', r, 0.06);
    g.fillRect(0, y0, px, px / rows);
    paintGrain(g, -px * 0.1, y0 - 4, px * 1.2, px / rows + 8, r, 0.45, '70,40,15');
    g.restore();
  }
  grainCanvas(c, 8, seed);
  const h = heightFromCanvas(c);
  return { map: canvasTex(c), normalMap: normalFromHeight(h, px, px, 0.6) };
}

// ---- paint, fabric, weaves -----------------------------------------------

/** Near-white plaster/paint with roller stipple, to be tinted by material or vertex colour. */
export function paintTextures(seed: number, px = 512, rough = 1) {
  const n = tileNoise(px, px, 8, 5, seed, 0.55);
  const f = tileNoise(px, px, 64, 2, seed + 3, 0.5);
  const { c, g } = makeCanvas(px);
  const img = g.createImageData(px, px);
  const h = new Float32Array(px * px);
  for (let i = 0; i < n.length; i++) {
    const v = 238 + (n[i] - 0.5) * 16 * rough + (f[i] - 0.5) * 8 * rough;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
    h[i] = f[i] * 0.6 + n[i] * 0.4;
  }
  g.putImageData(img, 0, 0);
  return { map: canvasTex(c), normalMap: normalFromHeight(h, px, px, 1.2 * rough) };
}

/** Plain-weave fabric (linen / canvas). Near-white for tinting. */
export function weaveTextures(seed: number, threads = 48, px = 512, slub = 0.5, contrast = 1) {
  const r = rng(seed);
  const tw = px / threads;
  const warpTone = Array.from({ length: threads }, () => 1 - r() * 0.14 * slub);
  const weftTone = Array.from({ length: threads }, () => 1 - r() * 0.14 * slub);
  const nz = tileNoise(px, px, 16, 3, seed + 2);
  const { c, g } = makeCanvas(px);
  const img = g.createImageData(px, px);
  const h = new Float32Array(px * px);
  for (let y = 0; y < px; y++) {
    const iy = Math.floor(y / tw);
    const fy = (y % tw) / tw;
    for (let x = 0; x < px; x++) {
      const ix = Math.floor(x / tw);
      const fx = (x % tw) / tw;
      const over = (ix + iy) % 2 === 0;
      const warp = Math.sin(Math.PI * fx) * (over ? 1 : 0.55);
      const weft = Math.sin(Math.PI * fy) * (over ? 0.55 : 1);
      const top = warp > weft;
      const hv = Math.max(warp, weft);
      const tone = (top ? warpTone[ix] : weftTone[iy]) * (0.72 + 0.28 * hv * contrast + (1 - contrast) * 0.28) * (0.94 + nz[y * px + x] * 0.12);
      const v = Math.min(255, 250 * tone);
      const i = (y * px + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v * 0.99;
      img.data[i + 3] = 255;
      h[y * px + x] = hv;
    }
  }
  g.putImageData(img, 0, 0);
  return { map: canvasTex(c), normalMap: normalFromHeight(h, px, px, 1.4) };
}

/** Woven wicker (horizontal weavers over vertical stakes), full colour. */
export function wickerTextures(seed: number, px = 512, base = '#d2a86c') {
  const r = rng(seed);
  const rows = 16;
  const cols = 12;
  const rh = px / rows;
  const cw = px / cols;
  const { c, g } = makeCanvas(px);
  const h = new Float32Array(px * px);
  const img = g.createImageData(px, px);
  const bc = { r: 0, g: 0, b: 0 };
  new THREE.Color(base).getRGB(bc, THREE.SRGBColorSpace);
  const tones = Array.from({ length: rows }, () => 0.85 + r() * 0.25);
  const nz = tileNoise(px, px, 32, 2, seed);
  for (let y = 0; y < px; y++) {
    const iy = Math.floor(y / rh);
    const fy = (y % rh) / rh;
    for (let x = 0; x < px; x++) {
      const fx = ((x + (iy % 2) * cw * 0.5) % cw) / cw;
      // weaver bulges between stakes, dips where it passes behind them
      const bulge = Math.sin(Math.PI * fy) * (0.55 + 0.45 * Math.sin(Math.PI * fx));
      const gap = Math.pow(Math.sin(Math.PI * fy), 0.35);
      const hv = bulge;
      const t = tones[iy] * (0.45 + 0.55 * gap) * (0.9 + 0.2 * nz[y * px + x]) * (0.8 + 0.2 * Math.sin(Math.PI * fx));
      const i = (y * px + x) * 4;
      img.data[i] = Math.min(255, bc.r * 255 * t * 1.1);
      img.data[i + 1] = Math.min(255, bc.g * 255 * t * 1.1);
      img.data[i + 2] = Math.min(255, bc.b * 255 * t * 1.1);
      img.data[i + 3] = 255;
      h[y * px + x] = hv;
    }
  }
  g.putImageData(img, 0, 0);
  return { map: canvasTex(c), normalMap: normalFromHeight(h, px, px, 3) };
}

/** Soft plush / fleece: low contrast noise with a fuzzy normal map. */
export function plushTextures(seed: number, px = 256) {
  const n = tileNoise(px, px, 32, 3, seed, 0.6);
  const f = tileNoise(px, px, 128, 1, seed + 1);
  const { c, g } = makeCanvas(px);
  const img = g.createImageData(px, px);
  const h = new Float32Array(px * px);
  for (let i = 0; i < n.length; i++) {
    const v = 225 + (n[i] - 0.5) * 30 + (f[i] - 0.5) * 30;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
    h[i] = f[i] * 0.7 + n[i] * 0.3;
  }
  g.putImageData(img, 0, 0);
  return { map: canvasTex(c), normalMap: normalFromHeight(h, px, px, 2.5) };
}

/** Soft contact-shadow atlas: left half a blurred rounded square, right half a radial blob. */
export function contactShadowTexture(): THREE.CanvasTexture {
  const { c, g } = makeCanvas(256, 128);
  g.clearRect(0, 0, 256, 128);
  // 9-slice friendly square: solid core from 0.25 to 0.75 of the cell
  const grad = (x0: number, len: number, t: number) => {
    const d = Math.max(0, Math.abs(t - x0) - len);
    return d;
  };
  const img = g.createImageData(256, 128);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 256; x++) {
      let a = 0;
      if (x < 128) {
        const u = (x + 0.5) / 128;
        const v = (y + 0.5) / 128;
        const dx = grad(0.5, 0.25, u) / 0.25;
        const dy = grad(0.5, 0.25, v) / 0.25;
        const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
        a = Math.pow(1 - d, 2.2);
      } else {
        const u = (x - 128 + 0.5) / 128 - 0.5;
        const v = (y + 0.5) / 128 - 0.5;
        const d = Math.min(1, Math.sqrt(u * u + v * v) * 2);
        a = Math.pow(1 - d, 2);
      }
      const i = (y * 256 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
      img.data[i + 3] = a * 255;
    }
  g.putImageData(img, 0, 0);
  const t = canvasTex(c, true, false);
  t.anisotropy = 4;
  return t;
}

// ============================================================================
// Interior kit: geometry helpers and batching
// ============================================================================

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Transform a geometry in place: scale, then rotate (Euler YXZ: roll, pitch, then yaw), then translate. */
export function tf<T extends THREE.BufferGeometry>(g: T, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1): T {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  return g;
}

/** Box-projected UVs from the current positions/normals, `tile` metres per texture repeat. */
export function boxUV<T extends THREE.BufferGeometry>(g: T, tile = 1, tileV = tile): T {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = p.getX(i);
      v = p.getZ(i);
    } else if (ax >= az) {
      u = p.getZ(i);
      v = p.getY(i);
    } else {
      u = p.getX(i);
      v = p.getY(i);
    }
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tileV;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Remap existing 0..1 UVs into a sub-rectangle (texture atlases). */
export function atlasUV<T extends THREE.BufferGeometry>(g: T, u0: number, v0: number, u1: number, v1: number): T {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  uv.needsUpdate = true;
  return g;
}

/** Scale existing UVs. */
export function scaleUV<T extends THREE.BufferGeometry>(g: T, su: number, sv = su): T {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

/** Reverse triangle winding and normals (inside faces of open shells). */
export function flip<T extends THREE.BufferGeometry>(g: T): T {
  if (g.index) {
    const a = g.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
  } else {
    for (const key of Object.keys(g.attributes)) {
      const at = g.attributes[key];
      for (let i = 0; i < at.count; i += 3)
        for (let k = 0; k < at.itemSize; k++) {
          const t = at.getComponent(i + 1, k);
          at.setComponent(i + 1, k, at.getComponent(i + 2, k));
          at.setComponent(i + 2, k, t);
        }
    }
  }
  const n = g.attributes.normal;
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

export const box = (w: number, h: number, d: number, sx = 1, sy = 1, sz = 1) => new THREE.BoxGeometry(w, h, d, sx, sy, sz);
export const rbox = (w: number, h: number, d: number, r: number, seg = 3) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
export const cyl = (rt: number, rb: number, h: number, seg = 24, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

/** Upright tube along a polyline with constant radius. */
export function tube(points: THREE.Vector3[], radius: number, seg = 32, radial = 8) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), seg, radius, radial, false);
}

/** Lathe from (r, y) pairs. */
export function lathe(profile: [number, number][], seg = 32) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}

/** Cushion / pillow: a box whose faces bulge and whose edges pinch. */
export function pillow(w: number, h: number, d: number, pinch = 0.8, seg = 10) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (w / 2);
    const y = p.getY(i) / (h / 2);
    const z = p.getZ(i);
    const f = (1 - Math.pow(Math.abs(x), 3)) * (1 - Math.pow(Math.abs(y), 3));
    p.setZ(i, z * (1 - pinch + pinch * f));
    // round the silhouette corners a little
    const k = 1 - 0.06 * Math.pow(Math.abs(x * y), 2);
    p.setX(i, p.getX(i) * k);
    p.setY(i, p.getY(i) * k);
  }
  const ng = g.toNonIndexed();
  g.dispose();
  // smooth normals across the pinched shape
  ng.deleteAttribute('normal');
  const merged = mergeVerticesForNormals(ng);
  return merged;
}

/** Recompute smooth normals by welding positions (keeps uvs of the first welded vertex). */
function mergeVerticesForNormals(g: THREE.BufferGeometry) {
  const p = g.attributes.position;
  const key = (i: number) => `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
  const acc = new Map<string, THREE.Vector3>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    const n = b.sub(a).cross(c.sub(a));
    for (let k = 0; k < 3; k++) {
      const kk = key(i + k);
      const v = acc.get(kk);
      if (v) v.add(n);
      else acc.set(kk, n.clone());
    }
  }
  const nArr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const v = acc.get(key(i))!.clone().normalize();
    nArr[i * 3] = v.x;
    nArr[i * 3 + 1] = v.y;
    nArr[i * 3 + 2] = v.z;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nArr, 3));
  return g;
}

/** Leaf blade geometry lying along +z (base at origin), width profile, midrib fold and droop. */
export function leafGeometry(len: number, width: number, fold = 0.25, droop = 0.25, tipPow = 0.8, segL = 7, segW = 4, skew = 1) {
  const g = new THREE.PlaneGeometry(1, 1, segW, segL);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i); // -0.5..0.5
    const v = p.getY(i) + 0.5; // 0..1 along the leaf
    const vs = Math.pow(v, skew);
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, vs * 1.02)), tipPow) * (v < 0.1 ? 0.4 + 6 * v : 1);
    const x = u * width * prof;
    const z = v * len;
    const y = -Math.abs(u) * width * prof * fold - droop * len * v * v;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

export interface BatchOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/**
 * Collects geometry per material and merges it into one mesh per material, so a
 * whole room renders in a couple of dozen draw calls. Shadow flags are read from
 * `material.userData.cast` / `.receive` (default true).
 */
export class Batch {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(mat: THREE.Material, g: THREE.BufferGeometry, color?: THREE.ColorRepresentation): THREE.BufferGeometry {
    if (color !== undefined) setColor(g, color);
    const list = this.parts.get(mat);
    if (list) list.push(g);
    else this.parts.set(mat, [g]);
    return g;
  }

  build(parent: THREE.Object3D, name = 'batch'): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [mat, list] of this.parts) {
      const useColor = (mat as THREE.MeshStandardMaterial).vertexColors;
      const prepared = list.map((g) => {
        let q = g;
        if (!q.index) {
          const n = q.attributes.position.count;
          const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
          for (let i = 0; i < n; i++) idx[i] = i;
          q.setIndex(new THREE.BufferAttribute(idx, 1));
        }
        for (const k of Object.keys(q.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) q.deleteAttribute(k);
        if (!q.attributes.normal) q.computeVertexNormals();
        if (!q.attributes.uv) q.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(q.attributes.position.count * 2), 2));
        if (useColor && !q.attributes.color) setColor(q, 0xffffff);
        if (!useColor && q.attributes.color) q.deleteAttribute('color');
        q.morphAttributes = {};
        q.clearGroups();
        return q;
      });
      const merged = mergeGeometries(prepared, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      freeGeometryAfterUpload(merged);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${mat.name || mat.type}`;
      mesh.castShadow = mat.userData.cast ?? true;
      mesh.receiveShadow = mat.userData.receive ?? true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (mat.userData.order !== undefined) mesh.renderOrder = mat.userData.order;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.parts.clear();
    return meshes;
  }
}

export function setColor(g: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

type MatOpts = THREE.MeshStandardMaterialParameters & { cast?: boolean; receive?: boolean; order?: number };

/** MeshStandardMaterial with batching hints. */
export function stdMat(name: string, o: MatOpts): THREE.MeshStandardMaterial {
  const { cast, receive, order, ...params } = o;
  const m = new THREE.MeshStandardMaterial(params);
  m.name = name;
  if (cast !== undefined) m.userData.cast = cast;
  if (receive !== undefined) m.userData.receive = receive;
  if (order !== undefined) m.userData.order = order;
  return m;
}

export function physMat(name: string, o: THREE.MeshPhysicalMaterialParameters & { cast?: boolean; receive?: boolean }): THREE.MeshPhysicalMaterial {
  const { cast, receive, ...params } = o;
  const m = physicalMaterial(params);
  m.name = name;
  if (cast !== undefined) m.userData.cast = cast;
  if (receive !== undefined) m.userData.receive = receive;
  return m;
}

/** Soft contact shadows / ambient occlusion decals (one draw call for all). */
export class ContactShadows {
  readonly material: THREE.MeshBasicMaterial;
  private geos: THREE.BufferGeometry[] = [];
  constructor(opacity = 0.55) {
    this.material = new THREE.MeshBasicMaterial({
      map: contactShadowTexture(),
      color: 0x000000,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.material.name = 'contactShadows';
    this.material.userData.cast = false;
    this.material.userData.receive = false;
  }

  /**
   * Nine-slice soft rectangle (inner w x d fully dark, fading over `m` metres), lying on the
   * plane given by position/rotation (default: floor). `strength` scales darkness.
   */
  rect(x: number, z: number, w: number, d: number, m: number, ry = 0, strength = 1, y = 0.003, rx = -Math.PI / 2) {
    const xs = [-w / 2 - m, -w / 2, w / 2, w / 2 + m];
    const zs = [-d / 2 - m, -d / 2, d / 2, d / 2 + m];
    const us = [0, 0.125, 0.375, 0.5];
    const vs = [0, 0.25, 0.75, 1];
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        pos.push(xs[i], zs[j], 0);
        uv.push(us[i], vs[j]);
        col.push(strength, strength, strength);
      }
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const a = j * 4 + i;
        idx.push(a, a + 1, a + 5, a, a + 5, a + 4);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(16 * 3).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    // plane is authored in XY with +Z normal; orient it
    tf(g, x, y, z, ry, rx);
    this.geos.push(g);
  }

  /** Round blob of radius r. */
  blob(x: number, z: number, r: number, strength = 1, y = 0.003) {
    const g = new THREE.PlaneGeometry(r * 2, r * 2);
    atlasUV(g, 0.5, 0, 1, 1);
    setColor(g, new THREE.Color(strength, strength, strength));
    tf(g, x, y, z, 0, -Math.PI / 2);
    this.geos.push(g);
  }

  /** Vertical soft strip on a wall (e.g. behind furniture, or wall/floor corner AO). */
  wall(x: number, y: number, z: number, w: number, h: number, m: number, ry: number, strength = 1) {
    this.rect(x, z, w, h, m, ry, strength, y, 0);
  }

  build(parent: THREE.Object3D) {
    if (!this.geos.length) return;
    // per-decal strength is stored in the vertex colour and multiplied into alpha
    const g = mergeGeometries(this.geos, false)!;
    for (const q of this.geos) q.dispose();
    this.material.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 color;\nvarying float vStrength;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvStrength = color.r;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vStrength;')
        .replace('#include <opaque_fragment>', 'diffuseColor.a *= vStrength;\n#include <opaque_fragment>');
    };
    const mesh = new THREE.Mesh(freeGeometryAfterUpload(g), this.material);
    mesh.name = 'contactShadows';
    mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;
    parent.add(mesh);
  }
}

// ============================================================================
// Interior kit: lighting helpers
// ============================================================================

/** Fit an orthographic shadow camera around a world-space box, seen from the light. */
export function fitShadow(light: THREE.DirectionalLight, box: THREE.Box3, margin = 0.1) {
  const cam = new THREE.OrthographicCamera();
  cam.position.copy(light.position);
  cam.lookAt(light.target.position);
  cam.updateMatrixWorld(true);
  const inv = cam.matrixWorldInverse;
  const b = new THREE.Box3();
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    b.expandByPoint(p.applyMatrix4(inv));
  }
  const sc = light.shadow.camera;
  sc.left = b.min.x - margin;
  sc.right = b.max.x + margin;
  sc.bottom = b.min.y - margin;
  sc.top = b.max.y + margin;
  sc.near = Math.max(0.05, -b.max.z - margin);
  sc.far = -b.min.z + margin;
  sc.updateProjectionMatrix();
}

/** Warm directional "sun" with soft shadows. `dir` is the direction the light travels. */
export function makeSun(color: THREE.ColorRepresentation, intensity: number, dir: THREE.Vector3, target: THREE.Vector3, mapSize = 2048) {
  const sun = new THREE.DirectionalLight(color, intensity);
  sun.name = 'sun';
  sun.position.copy(target).addScaledVector(dir.clone().normalize(), -15);
  sun.target.position.copy(target);
  sun.castShadow = true;
  const size = shadowMapSize(mapSize);
  sun.shadow.mapSize.set(size, size);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  // keep the penumbra the same width in the room at a smaller map
  sun.shadow.radius = 3 * (size / mapSize);
  return sun;
}

/**
 * Capture the location itself into a PMREM environment map (with its lights), so
 * reflections and image-based fill match the room. `scale` dims the capture.
 */
export function captureEnvironment(renderer: THREE.WebGLRenderer, group: THREE.Object3D, position: THREE.Vector3, background: THREE.Color, scale = 1): THREE.Texture {
  const scene = new THREE.Scene();
  scene.background = background;
  const parent = group.parent;
  scene.add(group);
  const lights: [THREE.Light, number][] = [];
  group.traverse((o) => {
    if ((o as THREE.Light).isLight) lights.push([o as THREE.Light, (o as THREE.Light).intensity]);
  });
  for (const [l, i] of lights) l.intensity = i * scale;
  scene.updateMatrixWorld(true);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02, 0.05, 60, { size: 256, position });
  pmrem.dispose();
  for (const [l, i] of lights) l.intensity = i;
  scene.remove(group);
  if (parent) parent.add(group);
  // disposing the texture should free the whole render target (framebuffer included)
  const tex = rt.texture;
  tex.dispose = () => rt.dispose();
  return tex;
}

/** Dispose every geometry, material and texture under an object. */
export function disposeTree(root: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x));
  });
  for (const m of mats) {
    for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
    m.dispose();
  }
}

// ============================================================================
// Painted canvases: leaves, pictures, gardens, rugs
// ============================================================================

/** Light, near-neutral leaf with midrib and veins (tint with vertex colour). u across, v along. */
export function leafTexture(seed: number, variegated = false) {
  const r = rng(seed);
  const W = 128;
  const H = 256;
  const { c, g } = makeCanvas(W, H);
  const grd = g.createLinearGradient(0, H, 0, 0);
  grd.addColorStop(0, '#c8d8b0');
  grd.addColorStop(1, '#e4ecd4');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  if (variegated) {
    for (let y = 0; y < H; y += 6 + r() * 8) {
      g.fillStyle = `rgba(40,60,20,${0.25 + r() * 0.3})`;
      g.fillRect(0, y, W, 2 + r() * 5);
    }
    g.fillStyle = 'rgba(255,240,150,0.9)';
    g.fillRect(0, 0, 10, H);
    g.fillRect(W - 10, 0, 10, H);
  } else {
    // darker margins
    const eg = g.createLinearGradient(0, 0, W, 0);
    eg.addColorStop(0, 'rgba(30,50,10,0.35)');
    eg.addColorStop(0.2, 'rgba(30,50,10,0)');
    eg.addColorStop(0.8, 'rgba(30,50,10,0)');
    eg.addColorStop(1, 'rgba(30,50,10,0.35)');
    g.fillStyle = eg;
    g.fillRect(0, 0, W, H);
    // lateral veins
    g.strokeStyle = 'rgba(255,255,235,0.55)';
    g.lineWidth = 1.5;
    for (let y = H * 0.95; y > H * 0.05; y -= 14 + r() * 6) {
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(W / 2, y);
        g.quadraticCurveTo(W / 2 + side * W * 0.25, y - 10, W / 2 + side * W * 0.48, y - 34);
        g.stroke();
      }
    }
  }
  // midrib
  g.strokeStyle = 'rgba(255,255,230,0.9)';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(W / 2, H);
  g.lineTo(W / 2, 0);
  g.stroke();
  grainCanvas(c, 10, seed);
  return canvasTex(c, true, false);
}

type Painter = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: Rand) => void;

/** Build a 2x2 picture atlas from four painters. Cell i covers atlasCell(i). */
export function pictureAtlas(painters: Painter[], seed: number, px = 1024) {
  const { c, g } = makeCanvas(px);
  const r = rng(seed);
  const s = px / 2;
  painters.slice(0, 4).forEach((p, i) => {
    const x = (i % 2) * s;
    const y = Math.floor(i / 2) * s;
    g.save();
    g.beginPath();
    g.rect(x, y, s, s);
    g.clip();
    p(g, x, y, s, s, r);
    g.restore();
  });
  grainCanvas(c, 8, seed);
  const t = canvasTex(c, true, false);
  return t;
}
/** UV rect [u0, v0, u1, v1] of atlas cell i (0..3), optionally cropped to aspect w/h. */
export function atlasCell(i: number, aspect = 1): [number, number, number, number] {
  const u0 = (i % 2) * 0.5;
  const v1 = 1 - Math.floor(i / 2) * 0.5;
  let cw = 0.5;
  let ch = 0.5;
  if (aspect > 1) ch = 0.5 / aspect;
  else cw = 0.5 * aspect;
  const cu = u0 + 0.25;
  const cv = v1 - 0.25;
  return [cu - cw / 2 + 0.004, cv - ch / 2 + 0.004, cu + cw / 2 - 0.004, cv + ch / 2 - 0.004];
}

const blobs = (g: CanvasRenderingContext2D, r: Rand, cx: number, cy: number, rad: number, n: number, colors: string[], spread = 1) => {
  for (let i = 0; i < n; i++) {
    const a = r() * 6.283;
    const d = Math.sqrt(r()) * rad * spread;
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    g.beginPath();
    g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, rad * (0.25 + r() * 0.35), 0, 6.283);
    g.fill();
  }
};

export const paintLandscape: Painter = (g, x, y, w, h, r) => {
  const sky = g.createLinearGradient(0, y, 0, y + h * 0.6);
  sky.addColorStop(0, '#7fb2d8');
  sky.addColorStop(1, '#f4e3c3');
  g.fillStyle = sky;
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 5; i++) blobs(g, r, x + r() * w, y + h * (0.1 + r() * 0.2), w * 0.06, 6, ['rgba(255,255,255,0.5)']);
  const hills = ['#8fae6a', '#6f9150', '#557a3c'];
  hills.forEach((col, k) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x, y + h);
    const base = y + h * (0.5 + k * 0.12);
    for (let i = 0; i <= 20; i++) g.lineTo(x + (i / 20) * w, base + Math.sin(i * 0.6 + k * 2 + r()) * h * 0.04);
    g.lineTo(x + w, y + h);
    g.fill();
  });
  blobs(g, r, x + w * 0.7, y + h * 0.55, w * 0.08, 14, ['#3f6a2e', '#4d7a36', '#5e8c40']);
  g.fillStyle = '#5a3d22';
  g.fillRect(x + w * 0.695, y + h * 0.6, w * 0.012, h * 0.1);
  g.fillStyle = '#e8b04a';
  g.beginPath();
  g.arc(x + w * 0.22, y + h * 0.2, w * 0.05, 0, 6.283);
  g.fill();
};

export const paintDogPortrait: Painter = (g, x, y, w, h) => {
  g.fillStyle = '#e9d7bb';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#d98f6a';
  g.beginPath();
  g.arc(x + w / 2, y + h * 0.55, w * 0.36, 0, 6.283);
  g.fill();
  const cx = x + w / 2;
  const cy = y + h * 0.52;
  g.fillStyle = '#7a4d2c';
  // ears
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + s * w * 0.17, cy - h * 0.02, w * 0.07, h * 0.15, s * 0.35, 0, 6.283);
    g.fill();
  }
  g.fillStyle = '#c99a62';
  g.beginPath();
  g.ellipse(cx, cy - h * 0.04, w * 0.15, h * 0.16, 0, 0, 6.283);
  g.fill();
  g.beginPath();
  g.ellipse(cx, cy + h * 0.1, w * 0.1, h * 0.08, 0, 0, 6.283);
  g.fill();
  g.fillStyle = '#e8cfa6';
  g.beginPath();
  g.ellipse(cx, cy + h * 0.12, w * 0.07, h * 0.055, 0, 0, 6.283);
  g.fill();
  g.fillStyle = '#2a1a12';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(cx + s * w * 0.06, cy - h * 0.06, w * 0.018, 0, 6.283);
    g.fill();
  }
  g.beginPath();
  g.ellipse(cx, cy + h * 0.075, w * 0.03, h * 0.02, 0, 0, 6.283);
  g.fill();
  // body
  g.fillStyle = '#c99a62';
  g.beginPath();
  g.ellipse(cx, cy + h * 0.36, w * 0.2, h * 0.16, 0, 0, 6.283);
  g.fill();
};

export const paintAbstract: Painter = (g, x, y, w, h) => {
  g.fillStyle = '#f1e7d6';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#d27a4f';
  g.beginPath();
  g.arc(x + w * 0.35, y + h * 0.62, w * 0.24, Math.PI, 0);
  g.fill();
  g.fillStyle = '#e6b64c';
  g.beginPath();
  g.arc(x + w * 0.68, y + h * 0.33, w * 0.13, 0, 6.283);
  g.fill();
  g.fillStyle = '#4f8a8b';
  g.fillRect(x + w * 0.55, y + h * 0.55, w * 0.28, h * 0.32);
  g.fillStyle = '#2f4858';
  g.fillRect(x + w * 0.12, y + h * 0.62, w * 0.46, h * 0.03);
};

export const paintBotanical: Painter = (g, x, y, w, h, r) => {
  g.fillStyle = '#f3ecdc';
  g.fillRect(x, y, w, h);
  g.strokeStyle = '#4c6a3a';
  g.fillStyle = '#6f9a55';
  g.lineWidth = w * 0.008;
  const cx = x + w / 2;
  g.beginPath();
  g.moveTo(cx, y + h * 0.9);
  g.quadraticCurveTo(cx - w * 0.05, y + h * 0.5, cx + w * 0.02, y + h * 0.12);
  g.stroke();
  for (let i = 0; i < 9; i++) {
    const t = 0.2 + i * 0.075;
    const px = cx - w * 0.02 * Math.sin(t * 3);
    const py = y + h * (0.9 - t * 0.85);
    const s = i % 2 ? 1 : -1;
    g.save();
    g.translate(px, py);
    g.rotate(s * (0.9 + r() * 0.3));
    g.beginPath();
    g.ellipse(0, -w * 0.08, w * 0.035, w * 0.08, 0, 0, 6.283);
    g.fill();
    g.restore();
  }
};

export interface GardenStyle {
  sky: [string, string];
  far: string[];
  trees: string[];
  lawn: string;
  fence?: string;
  bamboo?: boolean;
  flowers?: string[];
  maple?: boolean;
}

/** Draw into a scratch layer, then composite it once with a blur (canvas filters are slow per call). */
export function blurredLayer(g: CanvasRenderingContext2D, blur: number, draw: (lg: CanvasRenderingContext2D) => void) {
  const { c, g: lg } = makeCanvas(g.canvas.width, g.canvas.height);
  draw(lg);
  g.filter = blur > 0 ? `blur(${blur}px)` : 'none';
  g.drawImage(c, 0, 0);
  g.filter = 'none';
}

/** Painterly tree: trunk plus a canopy of shaded leaf clumps, lit from the upper left. */
function paintTree(g: CanvasRenderingContext2D, r: Rand, x: number, baseY: number, h: number, colors: string[], haze = 0, detail = 1) {
  const w = h * (0.5 + r() * 0.25);
  const shade = (col: string, k: number) => {
    const c = new THREE.Color(col);
    c.lerp(new THREE.Color('#b9cfdc'), haze);
    c.multiplyScalar(k);
    return c.getStyle();
  };
  // trunk and a couple of limbs
  g.strokeStyle = shade('#5b4632', 1);
  g.lineCap = 'round';
  g.lineWidth = h * 0.05;
  g.beginPath();
  g.moveTo(x, baseY);
  g.quadraticCurveTo(x + h * 0.02, baseY - h * 0.3, x - h * 0.01, baseY - h * 0.6);
  g.stroke();
  g.lineWidth = h * 0.02;
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.moveTo(x, baseY - h * 0.4);
    g.quadraticCurveTo(x + sx * w * 0.2, baseY - h * 0.5, x + sx * w * 0.3, baseY - h * 0.7);
    g.stroke();
  }
  const cy = baseY - h * 0.66;
  const clumps = Math.round((12 + r() * 8) * Math.min(1, detail + 0.3));
  const pts: [number, number, number][] = [];
  for (let i = 0; i < clumps; i++) {
    const a = r() * 6.283;
    const d = Math.sqrt(r());
    pts.push([x + Math.cos(a) * d * w * 0.46, cy + Math.sin(a) * d * h * 0.3, h * (0.1 + r() * 0.07)]);
  }
  pts.sort((p, q) => p[1] - q[1]);
  for (const [px, py, pr] of pts) {
    g.fillStyle = shade(colors[2 % colors.length], 0.5);
    g.beginPath();
    g.ellipse(px, py, pr, pr * 0.85, 0, 0, 6.283);
    g.fill();
  }
  const dots = Math.round(40 * detail);
  for (const [px, py, pr] of pts) {
    const col = colors[Math.floor(r() * colors.length)];
    for (let j = 0; j < dots; j++) {
      const a = r() * 6.283;
      const d = Math.sqrt(r()) * pr;
      const lx = px + Math.cos(a) * d;
      const ly = py + Math.sin(a) * d * 0.85;
      const lit = Math.max(0, (-(lx - px) * 0.6 - (ly - py)) / pr);
      g.fillStyle = shade(col, 0.62 + lit * 0.55 + r() * 0.12);
      const sz = pr * (0.06 + r() * 0.08) * (1.4 - detail * 0.4);
      g.beginPath();
      g.ellipse(lx, ly, sz * 1.3, sz, r() * 3, 0, 6.283);
      g.fill();
    }
  }
}

/** A clipped hedge band along the bottom of the garden. */
function paintHedge(g: CanvasRenderingContext2D, r: Rand, W: number, baseY: number, h: number, colors: string[]) {
  const dark = new THREE.Color(colors[2 % colors.length]).multiplyScalar(0.45).getStyle();
  g.fillStyle = dark;
  g.beginPath();
  g.moveTo(0, baseY);
  for (let x = 0; x <= W; x += 16) g.lineTo(x, baseY - h + Math.sin(x * 0.03) * h * 0.08 + r() * h * 0.08);
  g.lineTo(W, baseY);
  g.fill();
  for (let i = 0; i < W * 1.4; i++) {
    const x = r() * W;
    const y = baseY - r() * h * 0.95;
    const top = 1 - (baseY - y) / h;
    const c = new THREE.Color(colors[Math.floor(r() * colors.length)]).multiplyScalar(0.55 + (1 - top) * 0.5 + r() * 0.1);
    g.fillStyle = c.getStyle();
    g.beginPath();
    g.ellipse(x, y, 2 + r() * 3, 1.5 + r() * 2, r() * 3, 0, 6.283);
    g.fill();
  }
}

/**
 * Outdoor backdrop (2048x1024). The bottom 1/8 is a plain lawn swatch used by the
 * ground plane (v 0..0.12). World mapping: rows 0..896 cover yTop..yGround.
 */
export function gardenTexture(seed: number, s: GardenStyle) {
  const r = rng(seed);
  const W = 2048;
  const H = 1024;
  const { c, g } = makeCanvas(W, H);
  const HG = 896; // ground row
  const sky = g.createLinearGradient(0, 0, 0, HG);
  sky.addColorStop(0, s.sky[0]);
  sky.addColorStop(0.85, s.sky[1]);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // clouds
  blurredLayer(g, 12, (lg) => {
    for (let i = 0; i < 8; i++) blobs(lg, r, r() * W, 60 + r() * 220, 50 + r() * 50, 10, ['rgba(255,255,255,0.5)', 'rgba(255,252,245,0.4)'], 1.6);
  });
  // distant hazy treeline
  blurredLayer(g, 3, (lg) => {
    for (let x = -60; x < W + 60; x += 60 + r() * 50) paintTree(lg, r, x, HG - 120, 170 + r() * 130, s.far, 0.35, 0.5);
    lg.fillStyle = s.far[0];
    lg.fillRect(0, HG - 160, W, 100);
  });
  // garden trees
  blurredLayer(g, 1, (lg) => {
    const nTrees = 6;
    for (let i = 0; i < nTrees; i++) {
      const tx = (i + 0.15 + r() * 0.7) * (W / nTrees);
      const th = 260 + r() * 180;
      const col = s.maple && i % 3 === 1 ? ['#c24d2c', '#d86a3a', '#a63e24', '#e59350'] : s.trees;
      paintTree(lg, r, tx, HG - 40, th, col, 0.08, 1);
    }
  });
  if (s.bamboo) {
    for (let i = 0; i < 90; i++) {
      const bx = r() * W;
      const w = 5 + r() * 7;
      const top = HG - 520 - r() * 300;
      g.fillStyle = r() < 0.5 ? '#86a653' : '#9dbd68';
      g.fillRect(bx, top, w, HG - top);
      g.fillStyle = 'rgba(40,60,20,0.35)';
      for (let y = top; y < HG; y += 50 + r() * 25) g.fillRect(bx - 1, y, w + 2, 3);
      for (let k = 0; k < 14; k++) {
        g.fillStyle = r() < 0.5 ? '#6f9a45' : '#8cba5c';
        g.save();
        g.translate(bx + w / 2, top + r() * (HG - top) * 0.6);
        g.rotate((r() - 0.5) * 2.4);
        g.beginPath();
        g.ellipse(18, 0, 20, 4, 0, 0, 6.283);
        g.fill();
        g.restore();
      }
    }
  }
  // shrubs and hedge
  g.filter = 'none';
  paintHedge(g, r, W, HG - 4, 70, s.trees);
  if (s.fence) {
    g.fillStyle = s.fence;
    for (let x = 4; x < W; x += 24) {
      g.fillStyle = s.fence;
      g.beginPath();
      g.moveTo(x, HG - 12);
      g.lineTo(x, HG - 70);
      g.lineTo(x + 8, HG - 78);
      g.lineTo(x + 16, HG - 70);
      g.lineTo(x + 16, HG - 12);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.fillRect(x + 11, HG - 70, 5, 58);
    }
    g.fillStyle = s.fence;
    g.fillRect(0, HG - 62, W, 6);
    g.fillRect(0, HG - 32, W, 6);
  }
  if (s.flowers) {
    for (let i = 0; i < 700; i++) {
      g.fillStyle = s.flowers[Math.floor(r() * s.flowers.length)];
      g.beginPath();
      g.arc(r() * W, HG - 8 - r() * 22, 1.5 + r() * 2.5, 0, 6.283);
      g.fill();
    }
  }
  // lawn
  const lawn = g.createLinearGradient(0, HG - 10, 0, H);
  lawn.addColorStop(0, s.lawn);
  lawn.addColorStop(1, hexJitter(s.lawn, r, 0.08));
  g.fillStyle = lawn;
  g.fillRect(0, HG - 6, W, H - HG + 6);
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = `rgba(${r() < 0.5 ? '40,70,20' : '190,220,140'},0.25)`;
    g.fillRect(r() * W, HG - 6 + r() * (H - HG), 1, 2 + r() * 3);
  }
  grainCanvas(c, 6, seed);
  const t = canvasTex(c, true, false);
  return t;
}

export interface RugStyle {
  field: string;
  border: string;
  accent: string;
  accent2: string;
  pattern: 'kilim' | 'plain' | 'round';
}

/**
 * Textile atlas: rug (top 3/4), doormat (bottom-left) and bowl mat (bottom-right).
 */
export function textileAtlas(seed: number, rug: RugStyle, doormat = true) {
  const r = rng(seed);
  const S = 1024;
  const { c, g } = makeCanvas(S);
  // ---- rug: rows 0..768
  const RH = 768;
  g.fillStyle = rug.field;
  g.fillRect(0, 0, S, RH);
  // mottled wool
  blurredLayer(g, 3, (lg) => {
    for (let i = 0; i < 400; i++) {
      lg.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + r() * 0.03})`;
      lg.fillRect(r() * S, r() * RH, 20 + r() * 80, 4 + r() * 10);
    }
  });
  if (rug.pattern === 'kilim') {
    const m = 36;
    const band = (inset: number, width: number, col: string) => {
      g.strokeStyle = col;
      g.lineWidth = width;
      g.strokeRect(inset + width / 2, inset + width / 2, S - 2 * inset - width, RH - 2 * inset - width);
    };
    band(m, 58, rug.border);
    band(m + 58, 8, rug.field);
    band(m + 66, 6, rug.accent2);
    band(m + 78, 5, rug.border);
    // zigzag running inside the outer band
    g.strokeStyle = rug.accent;
    g.lineWidth = 6;
    const zig = (x0: number, y0: number, x1: number, horiz: boolean) => {
      g.beginPath();
      for (let t = 0, k = 0; t <= Math.abs(x1 - x0); t += 21, k++) {
        const a = x0 + Math.sign(x1 - x0) * t;
        const b = y0 + (k % 2 ? 11 : -11);
        if (horiz) k ? g.lineTo(a, b) : g.moveTo(a, b);
        else k ? g.lineTo(b, a) : g.moveTo(b, a);
      }
      g.stroke();
    };
    zig(m + 12, m + 29, S - m - 12, true);
    zig(m + 12, RH - m - 29, S - m - 12, true);
    zig(m + 12, m + 29, RH - m - 12, false);
    zig(m + 12, S - m - 29, RH - m - 12, false);
    const diamond = (x: number, y: number, w: number, h: number, col: string, steps = 0) => {
      g.fillStyle = col;
      g.beginPath();
      if (!steps) {
        g.moveTo(x, y - h);
        g.lineTo(x + w, y);
        g.lineTo(x, y + h);
        g.lineTo(x - w, y);
      } else {
        // stepped (woven) outline
        for (let i = 0; i <= steps; i++) g.lineTo(x + (w * i) / steps, y - h + (h * i) / steps), g.lineTo(x + (w * (i + 1)) / steps, y - h + (h * i) / steps);
        for (let i = 0; i <= steps; i++) g.lineTo(x + w - (w * i) / steps, y + (h * i) / steps), g.lineTo(x + w - (w * i) / steps, y + (h * (i + 1)) / steps);
        for (let i = 0; i <= steps; i++) g.lineTo(x - (w * i) / steps, y + h - (h * i) / steps), g.lineTo(x - (w * (i + 1)) / steps, y + h - (h * i) / steps);
        for (let i = 0; i <= steps; i++) g.lineTo(x - w + (w * i) / steps, y - (h * i) / steps), g.lineTo(x - w + (w * i) / steps, y - (h * (i + 1)) / steps);
      }
      g.fill();
    };
    // small motif lattice across the field
    for (let yy = 190; yy < RH - 170; yy += 64)
      for (let xx = 190 + ((yy / 64) % 2) * 45; xx < S - 170; xx += 90) {
        if (Math.abs(xx - S / 2) < 260 && Math.abs(yy - RH / 2) < 190) continue;
        diamond(xx, yy, 9, 9, (xx + yy) % 3 ? rug.accent : rug.border);
      }
    const cx = S / 2;
    const cy = RH / 2;
    diamond(cx, cy, 230, 175, rug.border, 7);
    diamond(cx, cy, 196, 148, rug.field, 6);
    diamond(cx, cy, 150, 112, rug.accent, 5);
    diamond(cx, cy, 116, 86, rug.accent2, 4);
    diamond(cx, cy, 70, 52, rug.border, 3);
    diamond(cx, cy, 30, 22, rug.field, 2);
    for (const sx of [-1, 1]) {
      diamond(cx + sx * 340, cy, 60, 90, rug.accent2, 4);
      diamond(cx + sx * 340, cy, 30, 48, rug.accent, 2);
    }
  } else if (rug.pattern === 'plain') {
    g.strokeStyle = rug.border;
    g.lineWidth = 18;
    g.strokeRect(50, 50, S - 100, RH - 100);
    g.strokeStyle = rug.accent;
    g.lineWidth = 5;
    g.strokeRect(84, 84, S - 168, RH - 168);
  } else {
    // round: concentric rings (the rug geometry is a disc)
    const cx = S / 2;
    const cy = RH / 2;
    for (let k = 0; k < 6; k++) {
      g.strokeStyle = k % 2 ? rug.accent : rug.border;
      g.lineWidth = 10;
      g.beginPath();
      g.ellipse(cx, cy, S * 0.45 - k * 60, RH * 0.45 - k * 45, 0, 0, 6.283);
      g.stroke();
    }
  }
  // wool finish: soften the weave, add abrash banding and fibre noise
  {
    const tmp = makeCanvas(S, RH);
    tmp.g.filter = 'blur(1.2px)';
    tmp.g.drawImage(c, 0, 0, S, RH, 0, 0, S, RH);
    g.drawImage(tmp.c, 0, 0);
    for (let y = 0; y < RH; y += 6 + r() * 30) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,245,225' : '60,40,20'},${0.02 + r() * 0.04})`;
      g.fillRect(0, y, S, 4 + r() * 24);
    }
    const img = g.getImageData(0, 0, S, RH);
    const nz = tileNoise(256, 192, 24, 3, seed + 5);
    for (let y = 0; y < RH; y++)
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const n = (r() - 0.5) * 34 + (nz[((y >> 2) % 192) * 256 + ((x >> 2) % 256)] - 0.5) * 30;
        img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
        img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
        img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n * 0.9));
      }
    g.putImageData(img, 0, 0);
  }
  // ---- doormat: bottom-left 512x256 (coir with border and paw)
  const dy = RH;
  if (doormat) {
    g.fillStyle = '#9a7445';
    g.fillRect(0, dy, 512, 256);
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '60,35,15' : '210,170,110'},${0.2 + r() * 0.3})`;
      g.fillRect(r() * 512, dy + r() * 256, 1 + r() * 2, 1 + r() * 2);
    }
    g.strokeStyle = '#4b3220';
    g.lineWidth = 14;
    g.strokeRect(14, dy + 14, 484, 228);
    g.fillStyle = '#4b3220';
    const paw = (px: number, py: number, s: number) => {
      g.beginPath();
      g.ellipse(px, py, 22 * s, 18 * s, 0, 0, 6.283);
      g.fill();
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        g.ellipse(px + (k - 1.5) * 16 * s, py - 28 * s - (k === 1 || k === 2 ? 8 * s : 0), 8 * s, 10 * s, 0, 0, 6.283);
        g.fill();
      }
    };
    paw(170, dy + 140, 1.3);
    paw(340, dy + 120, 1.3);
  }
  // ---- bowl mat: bottom-right (silicone, rounded, paw prints)
  g.fillStyle = '#9ec3c9';
  g.fillRect(512, dy, 512, 256);
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.lineWidth = 6;
  g.strokeRect(530, dy + 18, 476, 220);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  for (let k = 0; k < 5; k++) {
    const px = 590 + k * 90;
    const py = dy + 200 - (k % 2) * 40;
    g.beginPath();
    g.ellipse(px, py, 11, 9, 0, 0, 6.283);
    g.fill();
    for (let j = 0; j < 4; j++) {
      g.beginPath();
      g.arc(px + (j - 1.5) * 8, py - 14 - (j === 1 || j === 2 ? 4 : 0), 4, 0, 6.283);
      g.fill();
    }
  }
  grainCanvas(c, 14, seed);
  return canvasTex(c, true, false);
}

/** One tatami mat (u across its 0.9 m width, v along its 1.8 m length): rush weave plus cloth borders. */
export function tatamiTextures(seed: number) {
  const r = rng(seed);
  const W = 512;
  const H = 1024;
  const { c, g } = makeCanvas(W, H);
  const h = new Float32Array(W * H);
  const img = g.createImageData(W, H);
  const heri = 15; // border width in px (~2.7 cm)
  const base = { r: 0, g: 0, b: 0 };
  new THREE.Color('#d0ca92').getRGB(base, THREE.SRGBColorSpace);
  const nz = tileNoise(64, 128, 8, 3, seed);
  const rows = Array.from({ length: H }, () => 0.9 + r() * 0.16);
  for (let y = 0; y < H; y++) {
    const ridge = 0.5 + 0.5 * Math.sin((y / 4) * Math.PI);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const warp = x % 32 < 2 ? 0.86 : 1; // cotton warp threads every ~5.6 cm
      const n = nz[((y >> 3) % 128) * 64 + ((x >> 3) % 64)];
      let t = rows[y] * (0.82 + 0.18 * ridge) * warp * (0.92 + n * 0.16);
      let cr = base.r * t;
      let cg = base.g * t;
      let cb = base.b * t;
      let hv = ridge * 0.6 + (warp < 1 ? -0.3 : 0);
      if (x < heri || x >= W - heri) {
        // woven cloth border (heri): dark with a subtle pattern
        const px = (x < heri ? x : W - 1 - x) / heri;
        const pat = ((x >> 2) + (y >> 2)) % 2 ? 1 : 0.9;
        cr = 0.2 * pat;
        cg = 0.19 * pat;
        cb = 0.15 * pat;
        hv = 0.9 - (px < 0.12 ? 0.6 : 0);
      }
      if (y < 3 || y > H - 4) hv = 0;
      img.data[i * 4] = Math.min(255, cr * 255);
      img.data[i * 4 + 1] = Math.min(255, cg * 255);
      img.data[i * 4 + 2] = Math.min(255, cb * 255);
      img.data[i * 4 + 3] = 255;
      h[i] = hv;
    }
  }
  g.putImageData(img, 0, 0);
  // subtle sun-bleaching gradient
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgba(255,240,190,0.06)');
  gr.addColorStop(1, 'rgba(90,110,40,0.06)');
  g.fillStyle = gr;
  g.fillRect(heri, 0, W - 2 * heri, H);
  return { map: canvasTex(c, true, false), normalMap: normalFromHeight(h, W, H, 1.6) };
}

/** Washi paper (shoji), near-white with fibres. */
export function paperTexture(seed: number, px = 256) {
  const r = rng(seed);
  const { c, g } = makeCanvas(px);
  g.fillStyle = '#f7f3ea';
  g.fillRect(0, 0, px, px);
  for (let i = 0; i < 260; i++) {
    g.strokeStyle = `rgba(${r() < 0.5 ? '200,190,170' : '255,255,255'},${0.2 + r() * 0.3})`;
    g.lineWidth = 0.5 + r();
    g.beginPath();
    const x = r() * px;
    const y = r() * px;
    g.moveTo(x, y);
    g.quadraticCurveTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30, x + (r() - 0.5) * 40, y + (r() - 0.5) * 40);
    g.stroke();
  }
  grainCanvas(c, 6, seed);
  return canvasTex(c);
}

export const paintFusuma: Painter = (g, x, y, w, h, r) => {
  g.fillStyle = '#efe4c8';
  g.fillRect(x, y, w, h);
  // gold clouds
  g.fillStyle = 'rgba(214,176,92,0.55)';
  for (let i = 0; i < 5; i++) {
    const cy = y + h * (0.12 + r() * 0.3);
    const cx = x + r() * w;
    const cw = w * (0.2 + r() * 0.25);
    g.beginPath();
    g.ellipse(cx, cy, cw, h * 0.03, 0, 0, 6.283);
    g.fill();
    g.beginPath();
    g.ellipse(cx + cw * 0.3, cy - h * 0.025, cw * 0.6, h * 0.025, 0, 0, 6.283);
    g.fill();
  }
  // distant ink-wash mountains, two soft layers
  for (const [base, alpha, amp] of [[0.6, 0.22, 0.1], [0.7, 0.32, 0.06]] as const) {
    const grd = g.createLinearGradient(0, y + h * (base - amp), 0, y + h * (base + 0.15));
    grd.addColorStop(0, `rgba(88,112,128,${alpha})`);
    grd.addColorStop(1, 'rgba(88,112,128,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(x, y + h * (base + 0.15));
    let px = x;
    g.lineTo(px, y + h * base);
    while (px < x + w) {
      const step = w * (0.06 + r() * 0.1);
      const peak = y + h * (base - amp * (0.4 + r() * 0.8));
      g.quadraticCurveTo(px + step * 0.5, peak, px + step, y + h * (base - amp * 0.1 * r()));
      px += step;
    }
    g.lineTo(x + w, y + h * (base + 0.15));
    g.fill();
  }
  // pine branch
  g.strokeStyle = '#4a3a2a';
  g.lineWidth = w * 0.012;
  g.beginPath();
  g.moveTo(x + w * 0.05, y + h * 0.9);
  g.bezierCurveTo(x + w * 0.25, y + h * 0.6, x + w * 0.35, y + h * 0.55, x + w * 0.6, y + h * 0.5);
  g.stroke();
  for (let i = 0; i < 7; i++) {
    const px = x + w * (0.15 + i * 0.07);
    const py = y + h * (0.72 - i * 0.03);
    g.fillStyle = i % 2 ? '#3d5f3a' : '#4e7446';
    g.beginPath();
    g.ellipse(px, py - h * 0.03, w * 0.06, h * 0.022, -0.2, 0, 6.283);
    g.fill();
  }
};

export const paintScroll: Painter = (g, x, y, w, h, r) => {
  g.fillStyle = '#6b5a3c';
  g.fillRect(x, y, w, h);
  const m = w * 0.1;
  g.fillStyle = '#efe6d2';
  g.fillRect(x + m, y + h * 0.12, w - 2 * m, h * 0.76);
  // ink mountains
  const ix = x + m;
  const iw = w - 2 * m;
  for (let k = 0; k < 3; k++) {
    g.fillStyle = `rgba(40,40,45,${0.18 + k * 0.18})`;
    g.beginPath();
    g.moveTo(ix, y + h * (0.55 + k * 0.1));
    for (let i = 0; i <= 8; i++) g.lineTo(ix + (i / 8) * iw, y + h * (0.4 + k * 0.1 + (i % 2 ? -0.06 : 0.03) * (0.5 + r())));
    g.lineTo(ix + iw, y + h * 0.88);
    g.lineTo(ix, y + h * 0.88);
    g.fill();
  }
  g.fillStyle = '#b8322a';
  g.fillRect(ix + iw * 0.72, y + h * 0.2, iw * 0.12, iw * 0.12);
  g.fillStyle = 'rgba(30,30,30,0.85)';
  for (let i = 0; i < 5; i++) g.fillRect(ix + iw * 0.18, y + h * (0.18 + i * 0.035), iw * 0.06, h * 0.02);
};

// ============================================================================
// Room shell
// ============================================================================

export type WallId = 'L' | 'R' | 'B' | 'F';
export interface Opening {
  wall: WallId;
  /** centre along the wall (z for L/R, x for B/F) */
  c: number;
  w: number;
  y0: number;
  y1: number;
}
export interface Dims {
  W: number;
  D: number;
  H: number;
  t: number;
}

/** Wall-local (s along wall, y, n = distance into the room) to world. */
export function wallPoint(d: Dims, wall: WallId, s: number, y: number, n: number): THREE.Vector3 {
  switch (wall) {
    case 'L':
      return new THREE.Vector3(-d.W / 2 + n, y, s);
    case 'R':
      return new THREE.Vector3(d.W / 2 - n, y, s);
    case 'B':
      return new THREE.Vector3(s, y, -d.D / 2 + n);
    case 'F':
      return new THREE.Vector3(s, y, d.D / 2 - n);
  }
}
/** Yaw turning an object's +Z to face into the room from this wall. */
export const wallYaw = (w: WallId) => ({ L: Math.PI / 2, R: -Math.PI / 2, B: 0, F: Math.PI })[w];
const wallLen = (d: Dims, w: WallId) => (w === 'L' || w === 'R' ? d.D : d.W);

/** Place a geometry authored facing +Z (x along the wall) against a wall. */
export function onWall<T extends THREE.BufferGeometry>(g: T, d: Dims, wall: WallId, s: number, y: number, n: number): T {
  const p = wallPoint(d, wall, s, y, n);
  // local +x should run along +s
  const yaw = wallYaw(wall);
  const flipS = wall === 'L' || wall === 'F';
  if (flipS) tf(g, 0, 0, 0, 0, 0, 0, -1, 1, 1), flipWinding(g);
  return tf(g, p.x, p.y, p.z, yaw);
}
function flipWinding(g: THREE.BufferGeometry) {
  // after a mirror scale the normals are already mirrored by applyMatrix4; only fix winding
  if (g.index) {
    const a = g.index.array as Uint16Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
  } else {
    for (const key of Object.keys(g.attributes)) {
      const at = g.attributes[key];
      for (let i = 0; i < at.count; i += 3)
        for (let k = 0; k < at.itemSize; k++) {
          const t = at.getComponent(i + 1, k);
          at.setComponent(i + 1, k, at.getComponent(i + 2, k));
          at.setComponent(i + 2, k, t);
        }
    }
  }
}

/** Solid wall rectangles [s0, s1, y0, y1] around the openings of one wall. */
function wallPieces(d: Dims, wall: WallId, openings: Opening[]): [number, number, number, number][] {
  const len = wallLen(d, wall);
  const ext = wall === 'B' || wall === 'F' ? d.t : 0;
  const os = openings.filter((o) => o.wall === wall).sort((a, b) => a.c - b.c);
  const out: [number, number, number, number][] = [];
  let cur = -len / 2 - ext;
  for (const o of os) {
    const a = o.c - o.w / 2;
    const b = o.c + o.w / 2;
    if (a > cur) out.push([cur, a, 0, d.H]);
    if (o.y0 > 0) out.push([a, b, 0, o.y0]);
    if (o.y1 < d.H) out.push([a, b, o.y1, d.H]);
    cur = b;
  }
  out.push([cur, len / 2 + ext, 0, d.H]);
  return out;
}

/** Free intervals along a wall where something at height y can run (e.g. baseboards). */
export function wallRuns(d: Dims, wall: WallId, openings: Opening[], y: number, inset = 0): [number, number][] {
  const len = wallLen(d, wall);
  const os = openings.filter((o) => o.wall === wall && o.y0 <= y && o.y1 >= y).sort((a, b) => a.c - b.c);
  const out: [number, number][] = [];
  let cur = -len / 2;
  for (const o of os) {
    const a = o.c - o.w / 2 - inset;
    if (a > cur) out.push([cur, a]);
    cur = o.c + o.w / 2 + inset;
  }
  if (cur < len / 2) out.push([cur, len / 2]);
  return out;
}

/** Walls (thick boxes, world-UV'd) and ceiling. Everything casts shadows so light only enters via openings. */
export function buildShell(b: Batch, wallMat: THREE.Material, d: Dims, openings: Opening[], wallColor: THREE.ColorRepresentation, ceilColor: THREE.ColorRepresentation, tile = 1.2) {
  for (const wall of ['L', 'R', 'B', 'F'] as WallId[]) {
    for (const [s0, s1, y0, y1] of wallPieces(d, wall, openings)) {
      const len = s1 - s0;
      const h = y1 - y0;
      if (len <= 1e-3 || h <= 1e-3) continue;
      const sm = (s0 + s1) / 2;
      const ym = (y0 + y1) / 2;
      let g: THREE.BufferGeometry;
      if (wall === 'B' || wall === 'F') g = tf(box(len, h, d.t), sm, ym, (wall === 'B' ? -1 : 1) * (d.D / 2 + d.t / 2));
      else g = tf(box(d.t, h, len), (wall === 'L' ? -1 : 1) * (d.W / 2 + d.t / 2), ym, sm);
      b.add(wallMat, boxUV(g, tile), wallColor);
    }
  }
  b.add(wallMat, boxUV(tf(box(d.W + 2 * d.t, d.t, d.D + 2 * d.t), 0, d.H + d.t / 2, 0), tile), ceilColor);
}

/** Floor plane with planks running along world z (u = z). */
export function buildFloor(b: Batch, mat: THREE.Material, d: Dims, tile: number, alongZ = true) {
  const g = tf(new THREE.PlaneGeometry(d.W, d.D, 1, 1), 0, 0, 0, 0, -Math.PI / 2);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    if (alongZ) uv.setXY(i, p.getZ(i) / tile, p.getX(i) / tile);
    else uv.setXY(i, p.getX(i) / tile, p.getZ(i) / tile);
  }
  b.add(mat, g);
}

/** Continuous moulding (baseboard, chair rail, crown) along all walls, skipping openings. */
export function moulding(b: Batch, mat: THREE.Material, d: Dims, openings: Opening[], y: number, h: number, depth: number, color: THREE.ColorRepresentation, profile: 'flat' | 'round' = 'flat', skipInset = 0) {
  for (const wall of ['L', 'R', 'B', 'F'] as WallId[]) {
    for (const [s0, s1] of wallRuns(d, wall, openings, y + h / 2, skipInset)) {
      const len = s1 - s0 + (wall === 'B' || wall === 'F' ? depth * 2 : 0);
      const g = profile === 'round' ? rbox(len, h, depth * 2, Math.min(h, depth) * 0.45, 2) : box(len, h, depth * 2);
      b.add(mat, boxUV(onWall(g, d, wall, (s0 + s1) / 2, y + h / 2, 0), 0.8), color);
    }
  }
}

// ============================================================================
// Props
// ============================================================================

/** Shared material slots for props. Most are vertex-coloured so one material serves many objects. */
export interface PropMats {
  paint: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  fabric: THREE.MeshStandardMaterial;
  plush: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  ceramic: THREE.MeshStandardMaterial;
  matte: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  wicker: THREE.MeshStandardMaterial;
  art: THREE.MeshStandardMaterial;
}

/** Build the common prop materials (textures are procedural). */
export function makePropMats(seed: number, art: THREE.Texture): PropMats {
  const wood = woodTexture(seed + 1);
  const weave = weaveTextures(seed + 2, 40, 512, 0.6);
  const plush = plushTextures(seed + 3);
  const paint = paintTextures(seed + 4);
  const wick = wickerTextures(seed + 5);
  const leaf = foliageTexture(seed + 6);
  return {
    paint: stdMat('paint', { map: paint.map, normalMap: paint.normalMap, normalScale: new THREE.Vector2(0.35, 0.35), vertexColors: true, roughness: 0.82 }),
    wood: stdMat('wood', { map: wood.map, normalMap: wood.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), vertexColors: true, roughness: 0.5 }),
    fabric: stdMat('fabric', { map: weave.map, normalMap: weave.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }),
    plush: stdMat('plush', { map: plush.map, normalMap: plush.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true, roughness: 1 }),
    metal: stdMat('metal', { vertexColors: true, metalness: 1, roughness: 0.32 }),
    ceramic: stdMat('ceramic', { vertexColors: true, roughness: 0.22 }),
    matte: stdMat('matte', { vertexColors: true, roughness: 0.75 }),
    leaf: stdMat('leaf', { map: leaf, vertexColors: true, roughness: 0.38, side: THREE.DoubleSide }),
    glow: stdMat('glow', { map: weave.map, vertexColors: true, roughness: 1, emissive: new THREE.Color('#ffc987'), emissiveIntensity: 0.9, emissiveMap: weave.map, side: THREE.DoubleSide, cast: false }),
    wicker: stdMat('wicker', { map: wick.map, normalMap: wick.normalMap, roughness: 0.85, side: THREE.DoubleSide }),
    art: stdMat('art', { map: art, roughness: 0.75 }),
  };
}

/** Two leaf styles side by side: u 0..0.5 broad leaf, 0.5..1 banded blade. */
export function foliageTexture(seed: number) {
  const a = leafTexture(seed).image as HTMLCanvasElement;
  const b = leafTexture(seed + 1, true).image as HTMLCanvasElement;
  const { c, g } = makeCanvas(256, 256);
  g.drawImage(a, 0, 0, 128, 256);
  g.drawImage(b, 128, 0, 128, 256);
  return canvasTex(c, true, false);
}

export interface Kit {
  b: Batch;
  m: PropMats;
  cs: ContactShadows;
  obstacles: Circle[];
  r: Rand;
}

/** Returns a function that moves local geometry into place (yaw about Y, then translate). */
export function placer(x: number, y: number, z: number, ry = 0) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1));
  return <T extends THREE.BufferGeometry>(g: T): T => {
    g.applyMatrix4(m);
    return g;
  };
}

const ringPts = (x: number, z: number, w: number, d: number, ry: number, r: number): Circle[] => {
  // cover a w x d rectangle with circles
  const out: Circle[] = [];
  const n = Math.max(1, Math.round(w / (r * 1.5)));
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  for (let i = 0; i < n; i++) {
    const lx = n === 1 ? 0 : -w / 2 + r * 0.7 + (i / (n - 1)) * (w - r * 1.4);
    out.push({ x: x + lx * c, z: z - lx * s, r: Math.max(r, d / 2) });
  }
  return out;
};

/**
 * A soft slab (blanket, towel) following a 2D path in the local x/y plane, `width` along z,
 * centred on zc. Thickness is offset outward from the path's left-hand normal.
 */
export function drapedSlab(path: THREE.Vector2[], width: number, thick: number, zc: number, ripple = 0.01) {
  const curve = new THREE.SplineCurve(path);
  const segs = 48;
  const g = new THREE.BoxGeometry(1, thick, width, segs, 1, 8);
  const p = g.attributes.position;
  const T = new THREE.Vector2();
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp(p.getX(i) + 0.5, 0, 1);
    const y = p.getY(i);
    const z = p.getZ(i);
    const P = curve.getPointAt(t);
    curve.getTangentAt(t, T);
    const nx = T.y;
    const ny = -T.x;
    const wob = Math.sin(t * 17 + z * 20) * ripple * t;
    p.setXYZ(i, P.x + nx * (y + thick / 2 + wob), P.y + ny * (y + thick / 2 + wob), zc + z * (1 + 0.04 * t));
  }
  g.computeVertexNormals();
  return g;
}

/** Three-seat sofa facing +z (local), back against -z. */
export function sofa(k: Kit, x: number, z: number, ry: number, o: { w?: number; d?: number; color: string; leg: string; pillows: string[]; modern?: boolean; throwColor?: string }) {
  const { b, m } = k;
  const w = o.w ?? 2.1;
  const d = o.d ?? 0.92;
  const P = placer(x, 0, z, ry);
  const legH = o.modern ? 0.16 : 0.1;
  const F = (g: THREE.BufferGeometry, col: string) => b.add(m.fabric, P(g), col);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = o.modern ? cyl(0.012, 0.012, legH, 10) : cyl(0.024, 0.016, legH, 12);
      b.add(o.modern ? m.metal : m.wood, P(tf(leg, sx * (w / 2 - 0.1), legH / 2, sz * (d / 2 - 0.1))), o.leg);
    }
  const baseTop = legH + 0.24;
  F(boxUV(tf(rbox(w - 0.02, 0.24, d, 0.035), 0, legH + 0.12, 0), 0.1), o.color);
  const armW = o.modern ? 0.16 : 0.2;
  const armH = o.modern ? 0.34 : 0.54;
  for (const sx of [-1, 1]) F(boxUV(tf(rbox(armW, armH, d, o.modern ? 0.03 : 0.07), sx * (w / 2 - armW / 2), legH + armH / 2, 0), 0.1), o.color);
  const backH = o.modern ? 0.34 : 0.5;
  F(boxUV(tf(rbox(w - 0.02, backH, 0.2, 0.06), 0, baseTop + backH / 2 - 0.02, -d / 2 + 0.1), 0.1), o.color);
  const inner = w - 2 * armW;
  const nSeat = o.modern ? 3 : 2;
  const cw = inner / nSeat;
  for (let i = 0; i < nSeat; i++) {
    const cx = -inner / 2 + cw * (i + 0.5);
    F(boxUV(tf(rbox(cw - 0.01, 0.15, d - 0.24, 0.05, 3), cx, baseTop + 0.07, 0.11), 0.1), o.color);
    const back = boxUV(pillow(cw - 0.03, o.modern ? 0.36 : 0.46, 0.2, 0.5, 8), 0.1);
    F(tf(back, cx, baseTop + (o.modern ? 0.3 : 0.33), -d / 2 + 0.3, 0, -0.14), o.color);
  }
  o.pillows.forEach((col, i) => {
    const sx = i % 2 ? 1 : -1;
    const lx = sx * (inner / 2 - 0.25 - Math.floor(i / 2) * 0.3);
    F(tf(boxUV(pillow(0.42, 0.42, 0.15, 0.85), 0.1), lx, baseTop + 0.34, -0.05 - Math.floor(i / 2) * 0.05, -sx * 0.25, -0.3, sx * 0.08), col);
  });
  if (o.throwColor) {
    // knitted throw folded over the left arm: from the seat, over the arm, down the outside
    const ain = -w / 2 + armW;
    const aout = -w / 2;
    const top = legH + armH;
    const seatTop = baseTop + 0.145;
    const path = [
      new THREE.Vector2(ain + 0.3, seatTop + 0.006),
      new THREE.Vector2(ain + 0.08, seatTop + 0.012),
      new THREE.Vector2(ain + 0.012, seatTop + 0.08),
      new THREE.Vector2(ain + 0.006, top - 0.04),
      new THREE.Vector2((ain + aout) / 2, top + 0.008),
      new THREE.Vector2(aout - 0.004, top - 0.05),
      new THREE.Vector2(aout - 0.008, top - 0.32),
    ];
    F(boxUV(drapedSlab(path, 0.5, 0.022, 0.12, 0.006), 0.07), o.throwColor);
  }
  k.cs.rect(x, z, w * 0.98, d * 0.95, 0.16, ry, 0.9);
  k.obstacles.push(...ringPts(x, z, w, d, ry, 0.45));
}

/** Pot from a lathe profile, with soil. Returns the soil height. */
export function pot(k: Kit, x: number, y: number, z: number, h: number, r: number, color: string, style: 'taper' | 'bowl' | 'cyl' | 'basket' = 'taper') {
  const { b, m } = k;
  let prof: [number, number][];
  if (style === 'bowl')
    prof = [[0.001, 0], [r * 0.6, 0], [r * 0.9, h * 0.35], [r, h * 0.8], [r * 1.02, h], [r * 0.92, h], [r * 0.9, h * 0.9]];
  else if (style === 'cyl') prof = [[0.001, 0], [r, 0], [r, h], [r * 0.93, h], [r * 0.93, h * 0.92]];
  else prof = [[0.001, 0], [r * 0.72, 0], [r * 0.76, 0.015], [r * 0.95, h * 0.9], [r, h * 0.92], [r * 1.02, h], [r * 0.93, h], [r * 0.9, h * 0.94]];
  if (style === 'basket') {
    const outer = cyl(r, r * 0.85, h, 28, true);
    scaleUV(outer, (2 * Math.PI * r) / 0.14, h / 0.14);
    b.add(m.wicker, tf(outer, x, y + h / 2, z));
    b.add(m.wicker, tf(scaleUV(new THREE.TorusGeometry(r, 0.018, 8, 36), 8, 1), x, y + h, z, 0, Math.PI / 2));
  } else {
    b.add(m.ceramic, tf(lathe(prof, 28), x, y, z), color);
  }
  const soilY = y + h * 0.9;
  b.add(m.matte, tf(new THREE.CircleGeometry(r * 0.9, 20), x, soilY, z, 0, -Math.PI / 2), '#3b2a1e');
  k.cs.blob(x, z, r * 1.8, 0.8, y + 0.003);
  return soilY;
}

/** Stamp a single leaf. `u` selects the atlas half (0 broad, 1 banded). */
function leaf(k: Kit, u: 0 | 1, pos: THREE.Vector3, yaw: number, pitch: number, len: number, width: number, color: THREE.Color, fold = 0.25, droop = 0.25, roll = 0, tipPow = 0.8, skew = 1) {
  const g = leafGeometry(len, width, fold, droop, tipPow, 9, 6, skew);
  atlasUV(g, u * 0.5, 0, u * 0.5 + 0.5, 1);
  tf(g, pos.x, pos.y, pos.z, yaw, -pitch, roll);
  k.b.add(k.m.leaf, g, color);
}

/** Fiddle-leaf fig in a planter: a slim trunk with big, glossy, violin-shaped leaves. */
export function figTree(k: Kit, x: number, z: number, height = 1.55, planter: 'basket' | 'taper' = 'basket', potColor = '#e9e4da') {
  const { b, r } = k;
  const soil = pot(k, x, 0, z, 0.36, 0.2, potColor, planter);
  const stems = [
    [new THREE.Vector3(x, soil, z), new THREE.Vector3(x + 0.03, soil + 0.45, z - 0.01), new THREE.Vector3(x - 0.02, height * 0.72, z + 0.03), new THREE.Vector3(x + 0.02, height - 0.1, z)],
    [new THREE.Vector3(x + 0.02, soil + 0.5, z), new THREE.Vector3(x + 0.13, soil + 0.72, z + 0.07), new THREE.Vector3(x + 0.22, height * 0.68, z + 0.12)],
    [new THREE.Vector3(x + 0.0, soil + 0.62, z), new THREE.Vector3(x - 0.12, soil + 0.84, z - 0.05), new THREE.Vector3(x - 0.2, height * 0.78, z - 0.09)],
  ];
  stems.forEach((pts, si) => {
    b.add(k.m.wood, tube(pts, si ? 0.01 : 0.016, 20, 6), '#6b5038');
    const curve = new THREE.CatmullRomCurve3(pts);
    const n = si ? 7 : 13;
    for (let i = 0; i < n; i++) {
      const t = 0.3 + (i / (n - 1)) * 0.7;
      const p = curve.getPoint(t);
      const yaw = i * 2.4 + si * 1.3 + r() * 0.5;
      const len = 0.24 + r() * 0.1;
      const col = new THREE.Color().setHSL(0.27 + r() * 0.03, 0.5 + r() * 0.15, 0.17 + r() * 0.07);
      const top = t > 0.92;
      leaf(k, 0, p, yaw, top ? 0.9 + r() * 0.3 : 0.35 + r() * 0.45, len, len * 0.82, col, 0.1, top ? 0.06 : 0.14, (r() - 0.5) * 0.5, 0.5, 1.5);
    }
  });
  k.obstacles.push({ x, z, r: 0.35 });
}

/** Snake plant (upright banded blades). */
export function snakePlant(k: Kit, x: number, z: number, potColor = '#f1ede6', scale = 1) {
  const { r } = k;
  const soil = pot(k, x, 0, z, 0.3 * scale, 0.15 * scale, potColor, 'cyl');
  for (let i = 0; i < 11; i++) {
    const a = r() * 6.283;
    const off = r() * 0.08 * scale;
    const len = (0.45 + r() * 0.4) * scale;
    const col = new THREE.Color().setHSL(0.27 + r() * 0.05, 0.4, 0.28 + r() * 0.1);
    leaf(k, 1, new THREE.Vector3(x + Math.cos(a) * off, soil - 0.01, z + Math.sin(a) * off), a + Math.PI / 2 + (r() - 0.5), 1.25 + r() * 0.25, len, 0.07 * scale, col, 0.15, 0.02, (r() - 0.5) * 0.8, 0.45);
  }
  k.obstacles.push({ x, z, r: 0.25 * scale });
}

/** Small trailing plant (pothos) in a pot on a surface at height y. */
export function trailingPlant(k: Kit, x: number, y: number, z: number, potColor = '#d77b54', sprawl = 1) {
  const { r } = k;
  const soil = pot(k, x, y, z, 0.12, 0.08, potColor, 'taper');
  for (let v = 0; v < 6; v++) {
    const a = (v / 6) * 6.283 + r() * 0.5;
    const pts: THREE.Vector3[] = [];
    const reach = (0.12 + r() * 0.25) * sprawl;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const out = 0.02 + Math.min(1, t * 2) * 0.1;
      pts.push(new THREE.Vector3(x + Math.cos(a) * out, soil + 0.03 - Math.max(0, t - 0.4) * reach * 1.6 + (t < 0.4 ? t * 0.1 : 0.04), z + Math.sin(a) * out));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    for (let i = 0; i < 7; i++) {
      const p = curve.getPoint(0.1 + (i / 7) * 0.9);
      const col = new THREE.Color().setHSL(0.24 + r() * 0.05, 0.5, 0.3 + r() * 0.12);
      leaf(k, 0, p, a + (r() - 0.5) * 2, 0.2 + r() * 0.8, 0.055 + r() * 0.03, 0.045, col, 0.2, 0.1, (r() - 0.5));
    }
  }
}

/** Succulent rosette in a tiny pot. */
export function succulent(k: Kit, x: number, y: number, z: number, potColor = '#c9744e') {
  const { r } = k;
  const soil = pot(k, x, y, z, 0.07, 0.05, potColor, 'taper');
  for (let i = 0; i < 14; i++) {
    const a = i * 2.4;
    const ring = i / 14;
    const col = new THREE.Color().setHSL(0.3 + r() * 0.05, 0.25, 0.42 + ring * 0.1);
    leaf(k, 0, new THREE.Vector3(x, soil + 0.005, z), a, 0.2 + ring * 0.9, 0.045 - ring * 0.018, 0.022, col, 0.45, -0.1, 0, 0.6);
  }
}

/** Floor lamp with a glowing fabric shade. */
export function floorLamp(k: Kit, x: number, z: number, shade = '#f4ead8', metal = '#c9a36a', h = 1.55) {
  const { b, m } = k;
  b.add(m.metal, tf(cyl(0.14, 0.15, 0.025, 32), x, 0.0125, z), metal);
  b.add(m.metal, tf(cyl(0.011, 0.011, h - 0.2, 10), x, (h - 0.2) / 2, z), metal);
  const s = cyl(0.17, 0.22, 0.3, 36, true);
  scaleUV(s, 8, 2);
  b.add(m.glow, tf(s, x, h - 0.12, z), shade);
  b.add(m.metal, tf(cyl(0.02, 0.03, 0.08, 10), x, h - 0.25, z), metal);
  k.cs.blob(x, z, 0.28, 0.7);
  k.obstacles.push({ x, z, r: 0.2 });
}

/** Table lamp standing on a surface. */
export function tableLamp(k: Kit, x: number, y: number, z: number, base = '#d9cdb4', shade = '#f5ecdc') {
  const { b, m } = k;
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.06, 0], [0.085, 0.08], [0.08, 0.16], [0.03, 0.22], [0.012, 0.25]], 24), x, y, z), base);
  b.add(m.metal, tf(cyl(0.006, 0.006, 0.1, 6), x, y + 0.29, z), '#b8955a');
  b.add(m.glow, tf(scaleUV(cyl(0.1, 0.14, 0.18, 28, true), 5, 1), x, y + 0.36, z), shade);
}

/** Picture frame on a wall; `uv` is an atlas rect on the art material. */
export function wallFrame(k: Kit, d: Dims, wall: WallId, s: number, y: number, w: number, h: number, uv: [number, number, number, number], frameColor: string, frameW = 0.035, mat = 0.05) {
  const { b, m } = k;
  const depth = 0.025;
  const fw = frameW;
  const parts: THREE.BufferGeometry[] = [
    tf(box(w + 2 * fw, fw, depth), 0, h / 2 + fw / 2, depth / 2),
    tf(box(w + 2 * fw, fw, depth), 0, -h / 2 - fw / 2, depth / 2),
    tf(box(fw, h, depth), -w / 2 - fw / 2, 0, depth / 2),
    tf(box(fw, h, depth), w / 2 + fw / 2, 0, depth / 2),
  ];
  for (const p of parts) b.add(m.wood, boxUV(onWall(p, d, wall, s, y, 0), 0.3), frameColor);
  if (mat > 0) b.add(m.paint, onWall(tf(box(w, h, 0.004), 0, 0, 0.01), d, wall, s, y, 0), '#f7f4ee');
  const pic = new THREE.PlaneGeometry(w - 2 * mat, h - 2 * mat);
  atlasUV(pic, ...uv);
  b.add(m.art, onWall(tf(pic, 0, 0, 0.0125), d, wall, s, y, 0));
  k.cs.wall(wallPoint(d, wall, s, y - 0.01, 0.002).x, y - 0.015, wallPoint(d, wall, s, y, 0.002).z, w + 2 * fw, h + 2 * fw, 0.035, wallYaw(wall), 0.35);
}

/** Row of books between s0 and s1 along local x, standing on y. Local frame is passed via `P`. */
export function books(k: Kit, P: (g: THREE.BufferGeometry) => THREE.BufferGeometry, x0: number, x1: number, y: number, zBack: number, depth: number, maxH: number, palette: string[]) {
  const { b, m, r } = k;
  let x = x0;
  while (x < x1 - 0.03) {
    if (r() < 0.08) {
      x += 0.06 + r() * 0.1;
      continue;
    }
    const t = 0.018 + r() * 0.035;
    const h = maxH * (0.62 + r() * 0.36);
    const dd = depth * (0.75 + r() * 0.25);
    const lean = x + t > x1 - 0.1 && r() < 0.5 ? 0.25 : 0;
    const col = palette[Math.floor(r() * palette.length)];
    b.add(m.matte, P(tf(rbox(t, h, dd, 0.003, 1), x + t / 2 + (lean ? h * 0.12 : 0), y + h / 2 - (lean ? h * 0.03 : 0), zBack + dd / 2, 0, 0, -lean)), col);
    // a pale page block peeking at the top
    x += t + 0.001;
    if (lean) break;
  }
}

/** Round, plush dog bed centred on (x, z). */
export function dogBed(k: Kit, x: number, z: number, rim: string, cushion: string, radius = 0.38) {
  const { b, m } = k;
  const R = radius;
  b.add(m.plush, boxUV(tf(cyl(R, R + 0.01, 0.05, 40), x, 0.025, z), 0.25), rim);
  const torus = new THREE.TorusGeometry(R - 0.08, 0.085, 16, 48);
  scaleUV(torus, 10, 2);
  b.add(m.plush, tf(torus, x, 0.1, z, 0, Math.PI / 2, 0, 1, 1, 0.85), rim);
  const pad = new THREE.SphereGeometry(R - 0.1, 32, 12);
  scaleUV(pad, 4, 2);
  b.add(m.plush, tf(pad, x, 0.055, z, 0, 0, 0, 1, 0.14, 1), cushion);
  k.cs.blob(x, z, R * 1.35, 0.85);
}

/** Open wicker toy basket. */
export function toyBasket(k: Kit, x: number, z: number, r = 0.2, h = 0.22, felt?: string) {
  const { b, m } = k;
  if (felt) {
    const outer = cyl(r, r * 0.95, h, 40, true);
    scaleUV(outer, 6, 1);
    b.add(m.plush, tf(outer, x, h / 2, z), felt);
    b.add(m.plush, tf(flip(cyl(r - 0.008, r * 0.95 - 0.008, h, 40, true)), x, h / 2, z), felt);
    b.add(m.plush, tf(new THREE.TorusGeometry(r - 0.004, 0.005, 6, 40), x, h, z, 0, Math.PI / 2), felt);
    b.add(m.plush, tf(new THREE.CircleGeometry(r * 0.95, 28), x, 0.01, z, 0, -Math.PI / 2), felt);
    for (const s of [-1, 1]) b.add(m.matte, tf(rbox(0.07, 0.03, 0.02, 0.008, 2), x + s * r * 0.98, h - 0.04, z, Math.PI / 2), '#5a4a3c');
  } else {
    const outer = cyl(r, r * 0.88, h, 32, true);
    scaleUV(outer, (2 * Math.PI * r) / 0.13, h / 0.13);
    b.add(m.wicker, tf(outer, x, h / 2, z));
    b.add(m.wicker, tf(scaleUV(new THREE.CircleGeometry(r * 0.88, 28), 3, 3), x, 0.01, z, 0, -Math.PI / 2));
    b.add(m.wicker, tf(scaleUV(new THREE.TorusGeometry(r, 0.016, 8, 40), 10, 1), x, h, z, 0, Math.PI / 2));
    for (const s of [-1, 1]) {
      const hnd = new THREE.TorusGeometry(0.05, 0.01, 6, 16, Math.PI);
      b.add(m.wicker, tf(scaleUV(hnd, 3, 1), x + s * r * 0.98, h - 0.015, z, Math.PI / 2 + (s > 0 ? Math.PI : 0), 0, 0));
    }
  }
  k.cs.blob(x, z, r * 1.6, 0.8);
}

/** Wooden cabinet / sideboard facing +z (local). Returns its top height. */
export function sideboard(k: Kit, x: number, z: number, ry: number, w: number, h: number, d: number, color: string, knob: string, doors = 3, legH = 0.14) {
  const { b, m } = k;
  const P = placer(x, 0, z, ry);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) b.add(m.wood, P(tf(cyl(0.018, 0.012, legH, 10), sx * (w / 2 - 0.06), legH / 2, sz * (d / 2 - 0.06), 0, sz * 0.12)), color);
  const bh = h - legH;
  b.add(m.wood, P(boxUV(tf(box(w, bh - 0.03, d - 0.02), 0, legH + (bh - 0.03) / 2, -0.01), 0.5)), color);
  b.add(m.wood, P(boxUV(tf(rbox(w + 0.02, 0.03, d + 0.01, 0.006, 1), 0, h - 0.015, 0), 0.5)), color);
  const dw = (w - 0.04) / doors;
  for (let i = 0; i < doors; i++) {
    const cx = -w / 2 + 0.02 + dw * (i + 0.5);
    b.add(m.wood, P(boxUV(tf(box(dw - 0.008, bh - 0.08, 0.016), cx, legH + (bh - 0.03) / 2, d / 2 - 0.012), 0.5)), color);
    b.add(m.metal, P(tf(new THREE.SphereGeometry(0.012, 10, 8), cx + (i % 2 ? -1 : 1) * (dw / 2 - 0.05), legH + bh * 0.55, d / 2 + 0.005)), knob);
  }
  k.cs.rect(x, z, w, d, 0.1, ry, 0.75);
  k.obstacles.push(...ringPts(x, z, w, d, ry, 0.3));
  return h;
}

/** Open bookcase facing +z (local) with books on its shelves. */
export function bookcase(k: Kit, x: number, z: number, ry: number, w: number, h: number, d: number, shelves: number[], color: string, bookColors: string[], mat: THREE.MeshStandardMaterial = k.m.wood) {
  const { b } = k;
  const P = placer(x, 0, z, ry);
  const th = 0.022;
  b.add(mat, P(boxUV(tf(box(th, h, d), -w / 2 + th / 2, h / 2, 0), 0.5)), color);
  b.add(mat, P(boxUV(tf(box(th, h, d), w / 2 - th / 2, h / 2, 0), 0.5)), color);
  b.add(mat, P(boxUV(tf(box(w, h - 0.05, 0.01), 0, h / 2, -d / 2 + 0.005), 0.5)), color);
  b.add(mat, P(boxUV(tf(box(w - 2 * th, 0.06, th), 0, 0.03, d / 2 - th / 2), 0.5)), color);
  for (const sy of [0.06, ...shelves, h - th]) b.add(mat, P(boxUV(tf(box(w - 2 * th, th, d), 0, sy + th / 2, 0), 0.5)), color);
  const levels = [0.06, ...shelves];
  levels.forEach((sy, i) => {
    const top = i + 1 < levels.length ? levels[i + 1] : h - th;
    books(k, P, -w / 2 + th + 0.02, w / 2 - th - 0.02 - (i % 2 ? 0.3 : 0), sy + th, -d / 2 + 0.02, d - 0.05, top - sy - th - 0.03, bookColors);
  });
  k.cs.rect(x, z, w, d, 0.1, ry, 0.8);
  k.obstacles.push(...ringPts(x, z, w, d, ry, 0.3));
}

/** Round side table on a pedestal. */
export function sideTable(k: Kit, x: number, z: number, h: number, r: number, color: string) {
  const { b, m } = k;
  b.add(m.wood, boxUV(tf(cyl(r, r, 0.03, 36), x, h - 0.015, z), 0.4), color);
  b.add(m.wood, boxUV(tf(cyl(0.025, 0.03, h - 0.03, 12), x, (h - 0.03) / 2, z), 0.4), color);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * 6.283;
    b.add(m.wood, tf(rbox(0.22, 0.03, 0.04, 0.01, 1), x + Math.cos(a) * 0.1, 0.015, z + Math.sin(a) * 0.1, -a), color);
  }
  k.cs.blob(x, z, r * 1.4, 0.6);
  k.obstacles.push({ x, z, r: r + 0.05 });
}

/** Vase with a few tulips. */
export function tulips(k: Kit, x: number, y: number, z: number, colors: string[]) {
  const { b, m, r } = k;
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.045, 0], [0.06, 0.06], [0.04, 0.16], [0.032, 0.2], [0.04, 0.22]], 20), x, y, z), '#8fb3c2');
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1;
    const top = new THREE.Vector3(x + Math.cos(a) * 0.07, y + 0.36 + r() * 0.08, z + Math.sin(a) * 0.07);
    b.add(m.matte, tube([new THREE.Vector3(x, y + 0.15, z), new THREE.Vector3(x + Math.cos(a) * 0.03, y + 0.28, z + Math.sin(a) * 0.03), top], 0.004, 8, 4), '#5f8a3a');
    const head = new THREE.SphereGeometry(0.025, 12, 10);
    b.add(m.ceramic, tf(head, top.x, top.y + 0.02, top.z, 0, 0, 0, 1, 1.5, 1), colors[i % colors.length]);
    leaf(k, 0, new THREE.Vector3(x, y + 0.2, z), a + 0.5, 1.0, 0.12, 0.03, new THREE.Color('#5e8c3c'), 0.3, 0.1);
  }
}

/** Panelled interior door with casing and knob, in an opening on a wall. */
export function panelDoor(k: Kit, d: Dims, o: Opening, color: string, casing: string, knob: string, panels: 'six' | 'flush' = 'six') {
  const { b, m } = k;
  const W = o.w - 0.02;
  const H = o.y1 - 0.01;
  const L = (g: THREE.BufferGeometry) => onWall(g, d, o.wall, o.c, 0, 0);
  // leaf, recessed slightly into the opening
  b.add(m.paint, L(boxUV(tf(box(W, H, 0.04), 0, H / 2 + 0.005, -0.03), 1)), color);
  if (panels === 'six') {
    const cols = [-W / 4 + 0.01, W / 4 - 0.01];
    const rows: [number, number][] = [
      [0.12, 0.62],
      [0.8, 1.35],
      [1.52, H - 0.12],
    ];
    for (const cx of cols)
      for (const [y0, y1] of rows) {
        const pw = W / 2 - 0.16;
        const ph = y1 - y0;
        const bv = 0.018;
        for (const g of [tf(box(pw, bv, 0.012), cx, y0, 0), tf(box(pw, bv, 0.012), cx, y1, 0), tf(box(bv, ph, 0.012), cx - pw / 2, (y0 + y1) / 2, 0), tf(box(bv, ph, 0.012), cx + pw / 2, (y0 + y1) / 2, 0)])
          b.add(m.paint, L(boxUV(g, 1)), color);
        b.add(m.paint, L(boxUV(tf(box(pw - 0.07, ph - 0.07, 0.012), cx, (y0 + y1) / 2, -0.004), 1)), color);
      }
  }
  // casing
  const cw = 0.085;
  for (const sx of [-1, 1]) b.add(m.paint, L(boxUV(tf(box(cw, o.y1 + cw, 0.022), sx * (o.w / 2 + cw / 2), (o.y1 + cw) / 2, 0.011), 1)), casing);
  b.add(m.paint, L(boxUV(tf(box(o.w + 2 * cw + 0.02, cw, 0.026), 0, o.y1 + cw / 2, 0.013), 1)), casing);
  // reveal liners
  for (const sx of [-1, 1]) b.add(m.paint, L(tf(box(0.01, o.y1, d.t), sx * (o.w / 2 - 0.005), o.y1 / 2, -d.t / 2)), casing);
  b.add(m.paint, L(tf(box(o.w, 0.01, d.t), 0, o.y1 - 0.005, -d.t / 2)), casing);
  // knob (panelled) or lever handle (flush)
  const kx = W / 2 - 0.08;
  b.add(m.metal, L(tf(cyl(0.028, 0.028, 0.01, 20), kx, 1.0, 0.0, 0, Math.PI / 2)), knob);
  if (panels === 'six') {
    b.add(m.metal, L(tf(cyl(0.008, 0.008, 0.05, 10), kx, 1.0, 0.03, 0, Math.PI / 2)), knob);
    b.add(m.metal, L(tf(new THREE.SphereGeometry(0.028, 16, 12), kx, 1.0, 0.065, 0, 0, 0, 1, 1, 0.8)), knob);
  } else {
    b.add(m.metal, L(tf(cyl(0.009, 0.009, 0.055, 10), kx, 1.0, 0.03, 0, Math.PI / 2)), knob);
    b.add(m.metal, L(tf(rbox(0.14, 0.018, 0.018, 0.008, 2), kx - 0.06, 1.0, 0.058)), knob);
    // shadow gap around the flush leaf
    for (const sx of [-1, 1]) b.add(m.matte, L(tf(box(0.006, H, 0.005), sx * (W / 2 + 0.002), H / 2, -0.008)), '#6b6862');
    b.add(m.matte, L(tf(box(W, 0.006, 0.005), 0, H + 0.004, -0.008)), '#6b6862');
  }
  // hinges
  for (const hy of [0.25, 1.8]) b.add(m.metal, L(tf(box(0.02, 0.09, 0.012), -W / 2 + 0.01, hy, 0)), knob);
  k.cs.wall(wallPoint(d, o.wall, o.c, 0.1, 0.01).x, 0.1, wallPoint(d, o.wall, o.c, 0.1, 0.01).z, o.w, 0.1, 0.1, wallYaw(o.wall), 0.0);
}

/** Classic painted window: frame, mullions, transom, casing and stool. */
export function windowUnit(k: Kit, d: Dims, o: Opening, color: string, cols = 3, transomFromTop = 0.42, stool = true) {
  const { b, m } = k;
  const W = o.w;
  const H = o.y1 - o.y0;
  const L = (g: THREE.BufferGeometry) => boxUV(onWall(g, d, o.wall, o.c, o.y0, 0), 1);
  const fd = 0.07;
  const fn = -d.t * 0.62; // frame depth position
  const fw = 0.055;
  b.add(m.paint, L(tf(box(fw, H, fd), -W / 2 + fw / 2, H / 2, fn)), color);
  b.add(m.paint, L(tf(box(fw, H, fd), W / 2 - fw / 2, H / 2, fn)), color);
  b.add(m.paint, L(tf(box(W, fw, fd), 0, H - fw / 2, fn)), color);
  b.add(m.paint, L(tf(box(W, fw * 1.3, fd + 0.02), 0, fw * 0.65, fn)), color);
  for (let i = 1; i < cols; i++) b.add(m.paint, L(tf(box(0.045, H, fd * 0.8), -W / 2 + (W / cols) * i, H / 2, fn)), color);
  if (transomFromTop > 0) b.add(m.paint, L(tf(box(W, 0.045, fd * 0.8), 0, H - transomFromTop, fn)), color);
  // glazing beads (thin) to catch highlights
  for (let i = 0; i < cols; i++) {
    const cx = -W / 2 + (W / cols) * (i + 0.5);
    b.add(m.paint, L(tf(box(0.018, H - transomFromTop - 0.08, 0.02), cx - W / cols / 2 + 0.035, (H - transomFromTop) / 2, fn + 0.04)), color);
  }
  // reveal liners
  for (const sx of [-1, 1]) b.add(m.paint, L(tf(box(0.01, H, d.t * 0.55), sx * (W / 2 - 0.005), H / 2, -d.t * 0.28)), color);
  b.add(m.paint, L(tf(box(W, 0.01, d.t * 0.55), 0, H - 0.005, -d.t * 0.28)), color);
  // casing
  const cw = 0.085;
  for (const sx of [-1, 1]) b.add(m.paint, L(tf(box(cw, H + cw, 0.022), sx * (W / 2 + cw / 2), (H + cw) / 2 - (stool ? 0 : cw / 2), 0.011)), color);
  b.add(m.paint, L(tf(box(W + 2 * cw + 0.02, cw, 0.026), 0, H + cw / 2, 0.013)), color);
  if (stool) {
    b.add(m.paint, L(tf(rbox(W + 0.26, 0.032, d.t * 0.62 + 0.07, 0.008, 1), 0, -0.016 + 0.016, -d.t * 0.31 + 0.035 + 0.016)), color);
    b.add(m.paint, L(tf(box(W + 2 * cw, 0.08, 0.02), 0, -0.05, 0.01)), color);
  }
}

/** Gathered curtain panel hanging from `top` to the floor, `w` wide, against a wall. */
export function curtain(b: Batch, mat: THREE.Material, d: Dims, wall: WallId, s: number, top: number, w: number, n: number, color: string, folds = 7, seed = 1) {
  const r = rng(seed);
  const g = new THREE.PlaneGeometry(w, top - 0.02, 40, 16);
  const p = g.attributes.position;
  const phase = r() * 6;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const v = 0.5 - y / (top - 0.02); // 0 top .. 1 bottom
    const f = Math.sin((x / w) * folds * 6.283 + phase + v * 0.6);
    const amp = 0.028 + 0.02 * v;
    p.setZ(i, f * amp + amp);
    p.setX(i, x * (1 + v * 0.12));
  }
  g.computeVertexNormals();
  scaleUV(g, w / 0.18, (top - 0.02) / 0.18);
  b.add(mat, onWall(tf(g, 0, (top - 0.02) / 2 + 0.02, 0), d, wall, s, 0, n), color);
}

/** Wall clock. */
export function wallClock(k: Kit, d: Dims, wall: WallId, s: number, y: number, r: number, rim: string) {
  const { b, m } = k;
  b.add(m.wood, onWall(tf(new THREE.TorusGeometry(r, 0.018, 10, 40), 0, 0, 0.02), d, wall, s, y, 0), rim);
  b.add(m.paint, onWall(tf(cyl(r, r, 0.02, 40), 0, 0, 0.012, 0, Math.PI / 2), d, wall, s, y, 0), '#faf6ee');
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 6.283;
    b.add(m.matte, onWall(tf(box(0.006, i % 3 ? 0.012 : 0.024, 0.003), Math.sin(a) * r * 0.82, Math.cos(a) * r * 0.82, 0.024, 0, 0, -a), d, wall, s, y, 0), '#2b2622');
  }
  b.add(m.matte, onWall(tf(box(0.008, r * 0.5, 0.003), 0, r * 0.22, 0.026, 0, 0, 0.9), d, wall, s, y, 0), '#2b2622');
  b.add(m.matte, onWall(tf(box(0.006, r * 0.75, 0.003), 0, r * 0.33, 0.028, 0, 0, -0.9), d, wall, s, y, 0), '#2b2622');
}

// ============================================================================
// Sunbeam: faint light shaft and floating dust
// ============================================================================

/** A soft additive light shaft through an opening plus drifting dust motes. */
export function sunbeam(d: Dims, o: Opening, dir: THREE.Vector3, color: THREE.ColorRepresentation, strength = 0.05, motes = 220, seed = 3) {
  const group = new THREE.Group();
  group.name = 'sunbeam';
  const L = dir.clone().normalize();
  // A few soft "light cards": slices through the beam, feathered at their edges.
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const card = (a: THREE.Vector3, bb: THREE.Vector3) => {
    const base = pos.length / 3;
    const ea = a.clone().addScaledVector(L, -a.y / L.y);
    const eb = bb.clone().addScaledVector(L, -bb.y / L.y);
    pos.push(...a.toArray(), ...bb.toArray(), ...eb.toArray(), ...ea.toArray());
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const f of [0.25, 0.5, 0.75]) {
    const y = o.y0 + (o.y1 - o.y0) * f;
    card(wallPoint(d, o.wall, o.c - o.w / 2, y, 0), wallPoint(d, o.wall, o.c + o.w / 2, y, 0));
    const sx = o.c + (f - 0.5) * o.w;
    card(wallPoint(d, o.wall, sx, o.y0, 0), wallPoint(d, o.wall, sx, o.y1, 0));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const shaftMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0);
        vN = normalize(mat3(modelMatrix) * normal); vV = cameraPosition - wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uStrength; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ float facing = abs(dot(normalize(vN), normalize(vV)));
        float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
        float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.35, 0.95, vUv.y));
        float a = uStrength * facing * edge * along;
        gl_FragColor = vec4(uColor * a, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const shaft = new THREE.Mesh(g, shaftMat);
  shaft.name = 'sunShaft';
  shaft.renderOrder = 2;
  group.add(shaft);

  // dust motes inside the beam
  const r = rng(seed);
  const mp = new Float32Array(motes * 3);
  const ph = new Float32Array(motes);
  for (let i = 0; i < motes; i++) {
    const s = o.c + (r() - 0.5) * o.w;
    const y = o.y0 + r() * (o.y1 - o.y0);
    const p0 = wallPoint(d, o.wall, s, y, 0);
    const t = r() * (p0.y / -L.y) * 0.85;
    p0.addScaledVector(L, t);
    mp.set([p0.x, p0.y, p0.z], i * 3);
    ph[i] = r() * 100;
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
  mg.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
  const moteMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uScale: { value: 900 } },
    vertexShader: /* glsl */ `
      attribute float phase; uniform float uTime; uniform float uScale; varying float vA;
      void main(){ vec3 p = position;
        p.x += sin(uTime*0.13 + phase) * 0.12; p.y += sin(uTime*0.09 + phase*1.7) * 0.08 + sin(uTime*0.02+phase)*0.05; p.z += cos(uTime*0.11 + phase*0.7) * 0.12;
        vec4 mv = modelViewMatrix * vec4(p,1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uScale * 0.0045 / -mv.z, 1.0, 6.0);
        vA = 0.35 + 0.35 * sin(uTime*0.7 + phase*3.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main(){ vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c)) * vA; gl_FragColor = vec4(uColor * a, 1.0); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(mg, moteMat);
  pts.name = 'dust';
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  group.add(pts);
  return {
    group,
    update(time: number, pixelHeight: number) {
      moteMat.uniforms.uTime.value = time;
      moteMat.uniforms.uScale.value = pixelHeight;
    },
  };
}

// ============================================================================
// Room themes
// ============================================================================

export const ROOM_THEMES: RoomTheme[] = [
  { id: 'default', name: 'Sunny Living Room', price: 0, blurb: 'A cosy, sunlit living room with warm wooden floors.' },
  { id: 'japanese', name: 'Japanese Room', price: 2000, blurb: 'Tatami mats, shoji screens and a quiet garden view.' },
  { id: 'modern', name: 'Modern Loft', price: 3000, blurb: 'Light oak, white walls and a glass door onto the garden.' },
];

/** Painted wainscot with raised-panel mouldings and a chair rail. */
function wainscot(k: Kit, d: Dims, openings: Opening[], top: number, color: string) {
  const { b, m } = k;
  for (const wall of ['L', 'R', 'B', 'F'] as WallId[]) {
    for (const [s0, s1] of wallRuns(d, wall, openings, 0.3, 0.085)) {
      // split around windows whose sill is below the chair rail
      const cuts = openings
        .filter((o) => o.wall === wall && o.y0 > 0.3 && o.y0 < top)
        .map((o) => [o.c - o.w / 2 - 0.085, o.c + o.w / 2 + 0.085, o.y0 - 0.09] as const)
        .filter(([a, bb]) => bb > s0 && a < s1)
        .sort((p, q) => p[0] - q[0]);
      const segs: [number, number, number][] = [];
      let cur = s0;
      for (const [a, bb, h] of cuts) {
        if (a > cur) segs.push([cur, a, top]);
        segs.push([Math.max(a, s0), Math.min(bb, s1), h]);
        cur = bb;
      }
      if (cur < s1) segs.push([cur, s1, top]);
      for (const [a, bb, h] of segs) {
        const len = bb - a;
        if (len < 0.05) continue;
        const sm = (a + bb) / 2;
        const W = (g: THREE.BufferGeometry) => b.add(m.paint, boxUV(onWall(g, d, wall, sm, 0, 0), 1), color);
        W(tf(box(len, h, 0.012), 0, h / 2, 0.006));
        if (h === top) W(tf(rbox(len + 0.02, 0.045, 0.05, 0.012, 2), 0, top, 0.012));
        const n = Math.max(1, Math.round(len / 0.72));
        const pw = len / n;
        const y0 = 0.22;
        const y1 = h - 0.1;
        if (y1 - y0 < 0.12) continue;
        for (let i = 0; i < n; i++) {
          const cx = -len / 2 + pw * (i + 0.5);
          const iw = pw - 0.16;
          const ih = y1 - y0;
          const q = 0.018;
          W(tf(box(iw + q, q, 0.014), cx, y0, 0.016));
          W(tf(box(iw + q, q, 0.014), cx, y1, 0.016));
          W(tf(box(q, ih, 0.014), cx - iw / 2, (y0 + y1) / 2, 0.016));
          W(tf(box(q, ih, 0.014), cx + iw / 2, (y0 + y1) / 2, 0.016));
        }
      }
    }
  }
}

/** Soft darkening where the floor meets the walls, and in the vertical corners. */
function roomAO(cs: ContactShadows, d: Dims, strength = 0.45) {
  cs.rect(0, -d.D / 2, d.W, 0.02, 0.28, 0, strength);
  cs.rect(0, d.D / 2, d.W, 0.02, 0.28, 0, strength);
  cs.rect(-d.W / 2, 0, d.D, 0.02, 0.28, Math.PI / 2, strength);
  cs.rect(d.W / 2, 0, d.D, 0.02, 0.28, Math.PI / 2, strength);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      cs.wall(sx * (d.W / 2 - 0.002), d.H / 2, sz * d.D / 2 - sz * 0.001, 0.01, d.H, 0.22, 0, strength * 0.5);
      cs.wall(sx * d.W / 2 - sx * 0.001, d.H / 2, sz * (d.D / 2 - 0.002), 0.01, d.H, 0.22, Math.PI / 2, strength * 0.5);
    }
}

/** Outdoor backdrop visible through openings in `wall`: a painted panorama plus a lawn. */
function backdrop(group: THREE.Group, tex: THREE.Texture, d: Dims, wall: WallId, dist: number, groundY: number, brightness = 1.25) {
  const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
  mat.color.setScalar(brightness);
  mat.name = 'outside';
  const width = 36;
  const height = 16;
  const plane = new THREE.PlaneGeometry(width, height);
  atlasUV(plane, 0, 0.125, 1, 1);
  const lawn = new THREE.PlaneGeometry(width, dist, 1, 1);
  atlasUV(lawn, 0, 0.01, 1, 0.1);
  const n = -(d.t + dist);
  const g1 = onWall(tf(plane, 0, groundY + height / 2, 0), d, wall, 0, 0, n);
  const g2 = onWall(tf(lawn, 0, groundY, dist / 2, 0, -Math.PI / 2), d, wall, 0, 0, n);
  const mesh = new THREE.Mesh(mergeGeometries([g1, g2])!, mat);
  mesh.name = 'outside';
  group.add(mesh);
}

interface ThemeBuild {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  d: Dims;
  obstacles: Circle[];
  spots: Room['spots'];
  camera: Room['camera'];
  envBackground: THREE.Color;
  background: THREE.Color;
  beams: ReturnType<typeof sunbeam>[];
  /** receivers that must be covered by the sun's shadow camera (default: the room box) */
  shadowBox?: THREE.Box3;
  animate?: (dt: number, time: number) => void;
}

function finishRoom(renderer: THREE.WebGLRenderer, t: ThemeBuild, envScale = 1): Room {
  const { group, sun, d } = t;
  fitShadow(sun, t.shadowBox ?? new THREE.Box3(new THREE.Vector3(-d.W / 2 - d.t, 0, -d.D / 2 - d.t), new THREE.Vector3(d.W / 2 + d.t, d.H + d.t, d.D / 2 + d.t)), 0.25);
  // beams are additive; hide them from the environment capture
  for (const bm of t.beams) bm.group.visible = false;
  const environment = captureEnvironment(renderer, group, new THREE.Vector3(0, 0.9, 0.2), t.envBackground, envScale);
  for (const bm of t.beams) bm.group.visible = true;
  const size = new THREE.Vector2();
  const sunPos = sun.position.clone();
  const sunTarget = sun.target.position.clone();
  return {
    group,
    environment,
    background: t.background,
    sun,
    bounds: { minX: -1.75, maxX: 1.75, minZ: -1.75, maxZ: 1.75 },
    obstacles: t.obstacles,
    camera: t.camera,
    spots: t.spots,
    update(dt, time) {
      // the window light patches depend on this exact sun placement: keep it pinned
      sun.position.copy(sunPos);
      sun.target.position.copy(sunTarget);
      renderer.getDrawingBufferSize(size);
      for (const bm of t.beams) bm.update(time, size.y);
      t.animate?.(dt, time);
    },
    dispose() {
      disposeTree(group);
      environment.dispose();
    },
  };
}

function lights(group: THREE.Group, sun: THREE.DirectionalLight, sky: string, ground: string, hemi: number) {
  group.add(sun, sun.target);
  const h = new THREE.HemisphereLight(sky, ground, hemi);
  h.name = 'fill';
  group.add(h);
}

// ---- default: sunny living room -------------------------------------------------

function buildDefaultRoom(): ThemeBuild {
  const d: Dims = { W: 5.4, D: 5.4, H: 2.65, t: 0.16 };
  const win: Opening = { wall: 'L', c: 0.1, w: 2.2, y0: 0.5, y1: 2.2 };
  const door: Opening = { wall: 'R', c: -1.3, w: 0.92, y0: 0, y1: 2.08 };
  const openings = [win, door];
  const group = new THREE.Group();
  group.name = 'room:default';
  const r = rng(11);
  const art = pictureAtlas([paintLandscape, paintDogPortrait, paintAbstract, paintBotanical], 5);
  const m = makePropMats(100, art);
  const fl = plankTextures({ px: texSize(2048), rows: 12, minLen: 0.35, maxLen: 0.75, colors: ['#bb8c5f', '#c29568', '#b08152', '#b8885c', '#c49b6d', '#a97c50'], seed: 7, knots: 0 });
  const floorMat = stdMat('floor', { map: fl.map, normalMap: fl.normalMap, roughnessMap: fl.roughnessMap, roughness: 1, normalScale: new THREE.Vector2(0.7, 0.7), cast: false });
  const textile = textileAtlas(21, { field: '#dccaa8', border: '#9e4b35', accent: '#3f5f6e', accent2: '#c99a4b', pattern: 'kilim' });
  const pile = plushTextures(22, 256);
  pile.normalMap.repeat.set(28, 20);
  const textileMat = stdMat('textile', { map: textile, normalMap: pile.normalMap, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1, cast: false });
  const sheer = weaveTextures(31, 56, 256, 0.8);
  const curtainMat = stdMat('curtain', { map: sheer.map, normalMap: sheer.normalMap, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, emissive: new THREE.Color('#6b563c'), emissiveMap: sheer.map, emissiveIntensity: 0.35 });

  const b = new Batch();
  const cs = new ContactShadows(0.5);
  const k: Kit = { b, m, cs, obstacles: [], r };
  const WALL = '#f3e9d6';
  const TRIM = '#fbf8f1';
  buildShell(b, m.paint, d, openings, WALL, '#fbf8f2');
  buildFloor(b, floorMat, d, 2.0);
  wainscot(k, d, openings, 0.86, TRIM);
  moulding(b, m.paint, d, openings, 0, 0.13, 0.02, TRIM, 'round', 0.085);
  moulding(b, m.paint, d, [], d.H - 0.07, 0.07, 0.035, TRIM, 'round');
  roomAO(cs, d);

  // window, curtains and sill plants
  windowUnit(k, d, win, TRIM);
  const rodY = win.y1 + 0.2;
  b.add(m.metal, onWall(tf(cyl(0.013, 0.013, win.w + 1.1, 12), 0, 0, 0, 0, 0, Math.PI / 2), d, 'L', win.c, rodY, 0.13), '#b08a55');
  for (const sx of [-1, 1]) {
    b.add(m.metal, onWall(tf(new THREE.SphereGeometry(0.03, 14, 10), sx * (win.w / 2 + 0.56), 0, 0), d, 'L', win.c, rodY, 0.13), '#b08a55');
    b.add(m.metal, onWall(tf(cyl(0.008, 0.008, 0.13, 8), sx * (win.w / 2 + 0.4), 0, 0.065, 0, Math.PI / 2), d, 'L', win.c, rodY, 0), '#b08a55');
    curtain(b, curtainMat, d, 'L', win.c + sx * (win.w / 2 + 0.2), rodY - 0.02, 0.62, 0.1, '#f3ebdc', 6, 40 + sx);
    for (let i = 0; i < 7; i++) b.add(m.metal, onWall(tf(new THREE.TorusGeometry(0.022, 0.004, 6, 16), sx * (win.w / 2 + 0.2) + (i - 3) * 0.09, 0, 0), d, 'L', win.c, rodY - 0.005, 0.13), '#b08a55');
  }
  succulent(k, -d.W / 2 + 0.07, win.y0 + 0.012, win.c - 0.55, '#c9744e');
  succulent(k, -d.W / 2 + 0.07, win.y0 + 0.012, win.c - 0.35, '#e6dfd2');
  trailingPlant(k, -d.W / 2 + 0.07, win.y0 + 0.012, win.c + 0.6, '#9fb8c4', 0.6);

  // back wall: sofa, gallery, lamp, fig
  sofa(k, 0.35, -d.D / 2 + 0.48, 0, { color: '#9aae97', leg: '#5b3b22', pillows: ['#e0a23e', '#efe5d3', '#c46d4f'], throwColor: '#e9dcc4' });
  wallFrame(k, d, 'B', 0.35, 1.62, 0.62, 0.46, atlasCell(0, 0.62 / 0.46), '#6d4a2c');
  wallFrame(k, d, 'B', -0.42, 1.55, 0.3, 0.38, atlasCell(3, 0.3 / 0.38), '#f2ede3');
  wallFrame(k, d, 'B', 1.12, 1.55, 0.3, 0.38, atlasCell(1, 0.3 / 0.38), '#2d2a28');
  floorLamp(k, -1.15, -d.D / 2 + 0.35);
  figTree(k, -d.W / 2 + 0.42, -d.D / 2 + 0.42, 1.6);
  sideTable(k, 1.85, -d.D / 2 + 0.36, 0.55, 0.24, '#8a5a38');
  trailingPlant(k, 1.8, 0.55, -d.D / 2 + 0.3, '#e7e1d6', 0.8);
  b.add(m.ceramic, tf(cyl(0.035, 0.03, 0.09, 16), 1.95, 0.55 + 0.045, -d.D / 2 + 0.45), '#d8574a');

  // right wall: door, doormat, leash hook, sideboard with lamp, books and tulips
  panelDoor(k, d, door, '#f6f1e7', TRIM, '#c09a5c');
  const hook = wallPoint(d, 'R', door.c + door.w / 2 + 0.3, 1.45, 0);
  b.add(m.metal, onWall(tf(cyl(0.006, 0.006, 0.06, 8), 0, 0, 0.03, 0, Math.PI / 2), d, 'R', door.c + door.w / 2 + 0.3, 1.45, 0), '#b08a55');
  b.add(m.matte, tube([hook.clone().add(new THREE.Vector3(-0.05, 0, 0)), hook.clone().add(new THREE.Vector3(-0.04, -0.35, 0.05)), hook.clone().add(new THREE.Vector3(-0.03, -0.62, 0.0)), hook.clone().add(new THREE.Vector3(-0.035, -0.3, -0.06)), hook.clone().add(new THREE.Vector3(-0.05, 0, -0.005))], 0.011, 48, 6), '#c8332b');
  b.add(m.metal, tf(new THREE.TorusGeometry(0.02, 0.005, 6, 14), hook.x - 0.035, hook.y - 0.64, hook.z), '#b0b0b0');
  const dm = rbox(0.82, 0.012, 0.52, 0.005, 1);
  atlasUV(dm, 0, 0, 0.5, 0.25);
  b.add(textileMat, tf(dm, d.W / 2 - 0.34, 0.006, door.c, Math.PI / 2));
  const sbZ = 1.05;
  const top = sideboard(k, d.W / 2 - 0.25, sbZ, -Math.PI / 2, 1.7, 0.78, 0.46, '#a87850', '#c9a36a');
  tableLamp(k, d.W / 2 - 0.25, top, sbZ + 0.55);
  tulips(k, d.W / 2 - 0.27, top, sbZ - 0.35, ['#f06b7a', '#f5c24e', '#f7f0e4']);
  const P = placer(d.W / 2 - 0.25, top, sbZ - 0.05, -Math.PI / 2);
  ['#2f4f6b', '#c9b48a', '#8b3a32'].forEach((c, i) => b.add(m.matte, P(tf(rbox(0.26 - i * 0.02, 0.035, 0.19, 0.004, 1), 0, 0.018 + i * 0.036, 0, i * 0.12)), c));
  wallFrame(k, d, 'R', sbZ, 1.55, 0.9, 0.6, atlasCell(2, 0.9 / 0.6), '#c9a36a', 0.03, 0.06);

  // front wall: bookcase, clock, snake plant
  bookcase(k, -0.55, d.D / 2 - 0.17, Math.PI, 1.7, 0.95, 0.32, [0.36, 0.66], '#d7b58a', ['#8b3a32', '#2f4f6b', '#d9b36a', '#50704a', '#e6ddcc', '#3a3a3a', '#b86b3e', '#6b87a8']);
  trailingPlant(k, -1.1, 0.95, d.D / 2 - 0.17, '#e7e1d6', 1);
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.05, 0], [0.07, 0.08], [0.03, 0.2], [0.035, 0.24]], 20), 0.0, 0.95, d.D / 2 - 0.18), '#6e8f9c');
  wallClock(k, d, 'F', -0.55, 1.75, 0.16, '#6d4a2c');
  wallFrame(k, d, 'F', -1.25, 1.45, 0.34, 0.44, atlasCell(0, 0.34 / 0.44), '#f2ede3', 0.03, 0.05);
  wallFrame(k, d, 'F', 0.15, 1.45, 0.34, 0.44, atlasCell(3, 0.34 / 0.44), '#6d4a2c', 0.03, 0.05);
  snakePlant(k, -d.W / 2 + 0.35, d.D / 2 - 0.35);

  // rug with fringe, the puppy's bed, toy basket, bowl mat
  const rugW = 2.2;
  const rugD = 1.5;
  const rugG = box(rugW, 0.01, rugD);
  atlasUV(rugG, 0, 0.25, 1, 1);
  b.add(textileMat, tf(rugG, -0.15, 0.005, 0.1));
  for (const sx of [-1, 1])
    for (let i = 0; i < 44; i++) {
      const z = 0.1 - rugD / 2 + 0.03 + (i / 43) * (rugD - 0.06);
      b.add(m.plush, tf(box(0.05, 0.003, 0.007), -0.15 + sx * (rugW / 2 + 0.022), 0.003, z, (r() - 0.5) * 0.35), '#efe4cf');
    }
  cs.rect(-0.15, 0.1, rugW, rugD, 0.03, 0, 0.25);
  const spots: Room['spots'] = {
    food: new THREE.Vector3(1.5, 0, 0.32),
    water: new THREE.Vector3(1.5, 0, 0.78),
    bed: new THREE.Vector3(-1.3, 0, -1.3),
    door: new THREE.Vector3(1.55, 0, door.c),
    toybox: new THREE.Vector3(1.55, 0, 1.6),
  };
  dogBed(k, spots.bed.x, spots.bed.z, '#b86a4b', '#f1e3cc');
  toyBasket(k, spots.toybox.x, spots.toybox.z);
  const bm = rbox(0.9, 0.006, 0.42, 0.003, 1);
  atlasUV(bm, 0.5, 0, 1, 0.25);
  b.add(textileMat, tf(bm, 1.5, 0.003, 0.55, Math.PI / 2));

  b.build(group, 'room');
  cs.build(group);

  // light: warm late-afternoon sun through the window + soft fill
  const sunDir = new THREE.Vector3(0.78, -0.5, -0.3);
  const sun = makeSun('#ffe2ba', 3.3, sunDir, new THREE.Vector3(0, 0, 0));
  lights(group, sun, '#f8f4ec', '#b8a48c', 1.35);
  const garden = gardenTexture(9, { sky: ['#78b4e6', '#e9f3f8'], far: ['#9cb9a8', '#a9c4b4', '#8fae9c'], trees: ['#4d7a35', '#5f8d3f', '#3f6a2d', '#6f9c48'], lawn: '#7aa84c', fence: '#f4f1ea', flowers: ['#f2a7b6', '#f7d65c', '#ffffff', '#d85a5a'] });
  backdrop(group, garden, d, 'L', 11, -0.35);
  const beam = sunbeam(d, win, sunDir, '#ffe2b8', 0.05);
  group.add(beam.group);

  return {
    group,
    sun,
    d,
    obstacles: k.obstacles,
    spots,
    camera: { position: new THREE.Vector3(1.25, 0.8, 1.7), target: new THREE.Vector3(-0.35, 0.22, -0.45), fov: 50 },
    envBackground: new THREE.Color('#dfe9ee'),
    background: new THREE.Color('#cfe2f0'),
    beams: [beam],
  };
}

// ---- japanese: tatami room -------------------------------------------------------

/** Square floor cushion (zabuton) / square dog futon. */
export function zabuton(k: Kit, x: number, z: number, size: number, thick: number, color: string, ry = 0) {
  const g = boxUV(pillow(size, size * 1.08, thick, 0.55, 10), 0.12);
  k.b.add(k.m.fabric, tf(g, x, thick * 0.42, z, ry, -Math.PI / 2), color);
  k.cs.rect(x, z, size * 0.9, size, 0.06, ry, 0.5);
}

/** Low wooden table (chabudai-style, rectangular) with a tea set. */
function lowTable(k: Kit, x: number, z: number, ry: number, w: number, dd: number, h: number, color: string) {
  const { b, m } = k;
  const P = placer(x, 0, z, ry);
  b.add(m.wood, P(boxUV(tf(rbox(w, 0.035, dd, 0.012, 2), 0, h - 0.0175, 0), 0.6)), color);
  b.add(m.wood, P(boxUV(tf(box(w - 0.12, 0.05, dd - 0.12), 0, h - 0.06, 0), 0.6)), color);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(m.wood, P(boxUV(tf(box(0.05, h - 0.035, 0.05), sx * (w / 2 - 0.08), (h - 0.035) / 2, sz * (dd / 2 - 0.08)), 0.3)), color);
  // tea set
  b.add(m.ceramic, P(tf(lathe([[0.001, 0], [0.05, 0], [0.065, 0.04], [0.06, 0.08], [0.03, 0.095], [0.012, 0.11]], 20), 0.05, h, 0)), '#3f5a4a');
  b.add(m.ceramic, P(tf(cyl(0.008, 0.012, 0.07, 8), 0.12, h + 0.05, 0, 0, 0, -1.0)), '#3f5a4a');
  for (const cx of [-0.15, -0.28]) b.add(m.ceramic, P(tf(lathe([[0.001, 0], [0.025, 0], [0.034, 0.055], [0.03, 0.055], [0.02, 0.008]], 16), cx, h, 0.05)), '#e8e0d0');
  k.cs.rect(x, z, w * 0.8, dd * 0.8, 0.12, ry, 0.5);
  k.obstacles.push(...ringPts(x, z, w, dd, ry, 0.35));
}

/** Tansu chest with drawers and iron pulls. */
function tansu(k: Kit, x: number, z: number, ry: number, w: number, h: number, dd: number, color: string) {
  const { b, m } = k;
  const P = placer(x, 0, z, ry);
  b.add(m.wood, P(boxUV(tf(box(w, h, dd - 0.02), 0, h / 2, -0.01), 0.5)), color);
  const rows = 3;
  const rh = (h - 0.06) / rows;
  for (let i = 0; i < rows; i++) {
    const cols = i === 0 ? 2 : 1;
    for (let j = 0; j < cols; j++) {
      const cw = (w - 0.06) / cols;
      const cx = -w / 2 + 0.03 + cw * (j + 0.5);
      const cy = 0.03 + rh * (i + 0.5);
      b.add(m.wood, P(boxUV(tf(box(cw - 0.012, rh - 0.012, 0.014), cx, cy, dd / 2 - 0.01), 0.5)), color);
      b.add(m.metal, P(tf(new THREE.TorusGeometry(0.03, 0.005, 6, 14, Math.PI), cx, cy, dd / 2 + 0.004, 0, 0, Math.PI)), '#2c2724');
      b.add(m.metal, P(tf(box(0.07, 0.05, 0.004), cx, cy + 0.01, dd / 2 + 0.001)), '#2c2724');
    }
  }
  for (const sx of [-1, 1]) for (const sy of [0, 1]) b.add(m.metal, P(tf(box(0.06, 0.06, 0.004), sx * (w / 2 - 0.03), 0.03 + sy * (h - 0.06), dd / 2 + 0.002)), '#2c2724');
  k.cs.rect(x, z, w, dd, 0.08, ry, 0.75);
  k.obstacles.push(...ringPts(x, z, w, dd, ry, 0.3));
}

/** Paper floor lantern (andon). */
function andon(k: Kit, x: number, z: number, h = 0.7) {
  const { b, m } = k;
  const s = 0.28;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(m.wood, tf(box(0.022, h, 0.022), x + sx * s / 2, h / 2, z + sz * s / 2), '#4a3322');
  for (const y of [0.1, h - 0.01]) {
    b.add(m.wood, tf(box(s + 0.02, 0.02, 0.02), x, y, z + s / 2), '#4a3322');
    b.add(m.wood, tf(box(s + 0.02, 0.02, 0.02), x, y, z - s / 2), '#4a3322');
    b.add(m.wood, tf(box(0.02, 0.02, s + 0.02), x + s / 2, y, z), '#4a3322');
    b.add(m.wood, tf(box(0.02, 0.02, s + 0.02), x - s / 2, y, z), '#4a3322');
  }
  const paper = cyl(s * 0.68, s * 0.68, h - 0.14, 4, true);
  scaleUV(paper, 3, 3);
  b.add(m.glow, tf(paper, x, 0.1 + (h - 0.12) / 2, z, Math.PI / 4), '#fff4de');
  k.cs.blob(x, z, 0.3, 0.6);
  k.obstacles.push({ x, z, r: 0.22 });
}

/** Ikebana: dark vase with a blossoming branch. */
function ikebana(k: Kit, x: number, y: number, z: number) {
  const { b, m, r } = k;
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.07, 0], [0.09, 0.05], [0.06, 0.16], [0.045, 0.2], [0.05, 0.22]], 24), x, y, z), '#2e2a2a');
  const pts = [new THREE.Vector3(x, y + 0.18, z), new THREE.Vector3(x + 0.08, y + 0.4, z + 0.02), new THREE.Vector3(x + 0.25, y + 0.55, z + 0.04), new THREE.Vector3(x + 0.38, y + 0.52, z + 0.05)];
  b.add(m.wood, tube(pts, 0.009, 24, 6), '#4a3526');
  b.add(m.wood, tube([pts[1], new THREE.Vector3(x - 0.1, y + 0.55, z), new THREE.Vector3(x - 0.16, y + 0.7, z + 0.02)], 0.006, 16, 5), '#4a3526');
  const curve = new THREE.CatmullRomCurve3(pts);
  for (let i = 0; i < 16; i++) {
    const p = curve.getPoint(0.3 + r() * 0.7).add(new THREE.Vector3((r() - 0.5) * 0.04, (r() - 0.5) * 0.04, (r() - 0.5) * 0.04));
    b.add(m.ceramic, tf(new THREE.IcosahedronGeometry(0.014, 1), p.x, p.y, p.z), r() < 0.5 ? '#f3b6c6' : '#f7d3dc');
  }
  for (let i = 0; i < 6; i++) leaf(k, 0, curve.getPoint(0.2 + i * 0.13), i * 2.1, 0.3, 0.06, 0.03, new THREE.Color('#5d7f3a'), 0.3, 0.1);
}

/** Bonsai on a surface. */
function bonsai(k: Kit, x: number, y: number, z: number) {
  const { b, m, r } = k;
  b.add(m.ceramic, tf(rbox(0.3, 0.07, 0.2, 0.012, 2), x, y + 0.035, z), '#3a4a5a');
  b.add(m.matte, tf(box(0.27, 0.01, 0.17), x, y + 0.07, z), '#4c6b3a');
  const pts = [new THREE.Vector3(x, y + 0.07, z), new THREE.Vector3(x + 0.05, y + 0.14, z), new THREE.Vector3(x - 0.04, y + 0.22, z + 0.01), new THREE.Vector3(x + 0.03, y + 0.3, z)];
  b.add(m.wood, tube(pts, 0.018, 20, 7), '#5a4232');
  const pads: [number, number, number, number][] = [
    [x + 0.1, y + 0.2, z, 0.08],
    [x - 0.1, y + 0.26, z + 0.02, 0.07],
    [x + 0.03, y + 0.34, z, 0.09],
  ];
  for (const [px, py, pz, pr] of pads) {
    b.add(m.wood, tube([new THREE.Vector3(x + (px - x) * 0.2, py - 0.03, pz), new THREE.Vector3(px, py - 0.01, pz)], 0.006, 6, 4), '#5a4232');
    for (let i = 0; i < 5; i++) {
      const g = new THREE.IcosahedronGeometry(pr * (0.45 + r() * 0.25), 1);
      b.add(m.matte, tf(g, px + (r() - 0.5) * pr, py + (r() - 0.3) * pr * 0.25, pz + (r() - 0.5) * pr * 0.6, 0, 0, 0, 1, 0.45, 1), new THREE.Color().setHSL(0.27, 0.45, 0.22 + r() * 0.08));
    }
  }
}

function buildJapaneseRoom(): ThemeBuild {
  const d: Dims = { W: 5.4, D: 5.4, H: 2.5, t: 0.16 };
  const shoji: Opening = { wall: 'L', c: 0, w: 3.6, y0: 0, y1: 1.8 };
  const fusuma: Opening = { wall: 'R', c: -0.9, w: 1.8, y0: 0, y1: 1.8 };
  const toko: Opening = { wall: 'B', c: -1.2, w: 1.8, y0: 0, y1: 1.9 };
  const openings = [shoji, fusuma, toko];
  const group = new THREE.Group();
  group.name = 'room:japanese';
  const r = rng(31);
  const art = pictureAtlas([paintFusuma, paintScroll, paintBotanical, paintLandscape], 7);
  const m = makePropMats(300, art);
  m.wicker.color.set('#e8d6a8');
  const tat = tatamiTextures(5);
  const tatamiMat = stdMat('tatami', { map: tat.map, normalMap: tat.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.85, cast: false });
  const paperMat = stdMat('shoji', { map: paperTexture(8), roughness: 0.95, emissive: new THREE.Color('#fff3dc'), emissiveIntensity: 0.55, side: THREE.DoubleSide, cast: false });
  const plaster = paintTextures(41, 512, 1.3);
  const plasterMat = stdMat('plaster', { map: plaster.map, normalMap: plaster.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), vertexColors: true, roughness: 0.95 });

  const b = new Batch();
  const cs = new ContactShadows(0.5);
  const k: Kit = { b, m, cs, obstacles: [], r };
  const WOOD = '#8a6242';
  const DARK = '#4e3524';
  buildShell(b, plasterMat, d, openings, '#eadcc0', '#eadcc0', 1.0);

  // tatami: 3x3 blocks of two mats, alternating orientation
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const cx = -1.8 + 1.8 * i;
      const cz = -1.8 + 1.8 * j;
      for (const o of [-0.45, 0.45]) {
        const g = new THREE.PlaneGeometry(0.9, 1.8);
        if ((i + j) % 2 === 0) b.add(tatamiMat, tf(g, cx, 0, cz + o, Math.PI / 2, -Math.PI / 2));
        else b.add(tatamiMat, tf(g, cx + o, 0, cz, 0, -Math.PI / 2));
      }
    }
  roomAO(cs, d, 0.4);

  // timber frame: posts, nageshi band, sill boards, wooden ceiling
  const post = (x: number, z: number) => b.add(m.wood, boxUV(tf(box(0.12, d.H, 0.12), x, d.H / 2, z), 0.6, 1.2), WOOD);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) post(sx * (d.W / 2 - 0.05), sz * (d.D / 2 - 0.05));
  for (const s of [shoji.c - shoji.w / 2 - 0.06, shoji.c + shoji.w / 2 + 0.06]) post(-d.W / 2 + 0.05, s);
  for (const s of [fusuma.c - fusuma.w / 2 - 0.06, fusuma.c + fusuma.w / 2 + 0.06]) post(d.W / 2 - 0.05, s);
  post(toko.c + toko.w / 2 + 0.06, -d.D / 2 + 0.05);
  post(0.9, d.D / 2 - 0.05);
  // natural-log tokobashira
  b.add(m.wood, tf(cyl(0.06, 0.065, d.H, 12), toko.c - toko.w / 2 - 0.02, d.H / 2, -d.D / 2 + 0.03), '#9a7a58');
  moulding(b, m.wood, d, [], 1.8, 0.1, 0.03, WOOD);
  moulding(b, m.wood, d, [], d.H - 0.05, 0.05, 0.03, WOOD);
  moulding(b, m.wood, d, openings, 0, 0.05, 0.012, DARK);
  // ceiling boards with battens
  for (let i = 0; i < 12; i++) b.add(m.wood, boxUV(tf(box(d.W, 0.01, d.D / 12 - 0.004), 0, d.H - 0.005, -d.D / 2 + (d.D / 12) * (i + 0.5)), 1.2), i % 2 ? '#c29a70' : '#bb946a');
  for (let i = 1; i < 9; i++) b.add(m.wood, boxUV(tf(box(0.03, 0.03, d.D), -d.W / 2 + (d.W / 9) * i, d.H - 0.025, 0), 1), WOOD);

  // shoji screens: two panels slid open, lattice casts the sunlight pattern
  const sill = (o: Opening) => b.add(m.wood, onWall(boxUV(tf(box(o.w, 0.02, 0.1), 0, 0.005, -0.05), 1), d, o.wall, o.c, 0, 0), '#9a7454');
  sill(shoji);
  sill(fusuma);
  const panel = (s: number, n: number) => {
    const pw = 0.9;
    const ph = 1.8;
    const W = (g: THREE.BufferGeometry) => b.add(m.wood, boxUV(onWall(g, d, 'L', s, 0, n), 0.5), '#c9a57c');
    W(tf(box(0.035, ph, 0.03), -pw / 2 + 0.0175, ph / 2, 0));
    W(tf(box(0.035, ph, 0.03), pw / 2 - 0.0175, ph / 2, 0));
    W(tf(box(pw, 0.05, 0.03), 0, 0.025, 0));
    W(tf(box(pw, 0.035, 0.03), 0, ph - 0.0175, 0));
    W(tf(box(pw, 0.2, 0.012), 0, 0.14, 0));
    for (let i = 1; i < 3; i++) W(tf(box(0.014, ph - 0.25, 0.022), -pw / 2 + (pw / 3) * i, 0.25 + (ph - 0.25) / 2, 0));
    for (let i = 1; i < 7; i++) W(tf(box(pw, 0.014, 0.022), 0, 0.25 + ((ph - 0.25) / 7) * i, 0));
    const paper = new THREE.PlaneGeometry(pw - 0.06, ph - 0.28);
    scaleUV(paper, 3, 5);
    b.add(paperMat, onWall(tf(paper, 0, 0.25 + (ph - 0.28) / 2, -0.012), d, 'L', s, 0, n));
  };
  panel(-1.35, -0.05);
  panel(-1.15, -0.1);
  panel(1.35, -0.05);
  panel(1.15, -0.1);
  // engawa veranda outside
  for (let i = 0; i < 9; i++) b.add(m.wood, boxUV(tf(box(0.11, 0.04, 6.4), -d.W / 2 - d.t - 0.06 - i * 0.12, -0.02, 0), 0.8), i % 2 ? '#a07a58' : '#9a7352');

  // fusuma (exit)
  for (const [i, sx] of [[0, -1], [1, 1]] as const) {
    const s = fusuma.c + sx * 0.45;
    const g = new THREE.PlaneGeometry(0.9 - 0.04, 1.8 - 0.06);
    const cell = atlasCell(0, 1);
    atlasUV(g, cell[0] + (cell[2] - cell[0]) * (i * 0.5), cell[1], cell[0] + (cell[2] - cell[0]) * (i * 0.5 + 0.5), cell[3]);
    b.add(m.art, onWall(tf(g, 0, 0.9, -0.03 + i * 0.02), d, 'R', s, 0, 0));
    const F = (g2: THREE.BufferGeometry) => b.add(m.wood, boxUV(onWall(g2, d, 'R', s, 0, 0), 0.5), '#3a2a20');
    F(tf(box(0.02, 1.8, 0.03), -0.44, 0.9, -0.03 + i * 0.02));
    F(tf(box(0.02, 1.8, 0.03), 0.44, 0.9, -0.03 + i * 0.02));
    F(tf(box(0.9, 0.03, 0.03), 0, 0.015, -0.03 + i * 0.02));
    F(tf(box(0.9, 0.03, 0.03), 0, 1.785, -0.03 + i * 0.02));
    b.add(m.metal, onWall(tf(cyl(0.028, 0.028, 0.006, 20), sx * -0.36, 0.85, -0.012 + i * 0.02, 0, Math.PI / 2), d, 'R', s, 0, 0), '#b89b5e');
  }

  // tokonoma alcove with raised floor, scroll and ikebana
  const ad = 0.75;
  const az = -d.D / 2 - ad;
  const ax0 = toko.c - toko.w / 2;
  const ax1 = toko.c + toko.w / 2;
  b.add(plasterMat, boxUV(tf(box(toko.w + 0.3, toko.y1 + 0.3, 0.1), toko.c, (toko.y1 + 0.3) / 2, az - 0.05), 1), '#e2d2b2');
  for (const x of [ax0 - 0.05, ax1 + 0.05]) b.add(plasterMat, boxUV(tf(box(0.1, toko.y1 + 0.3, ad + 0.2), x, (toko.y1 + 0.3) / 2, -d.D / 2 - ad / 2), 1), '#e2d2b2');
  b.add(m.wood, boxUV(tf(box(toko.w + 0.3, 0.06, ad + 0.2), toko.c, toko.y1 + 0.03, -d.D / 2 - ad / 2), 1), '#bb946a');
  b.add(m.wood, boxUV(tf(box(toko.w, 0.12, ad), toko.c, 0.06, -d.D / 2 - ad / 2 + 0.02), 0.8), '#7a5638');
  b.add(m.wood, boxUV(tf(box(toko.w, 0.125, 0.07), toko.c, 0.0625, -d.D / 2 - 0.02), 0.8), '#2e2018');
  const scroll = new THREE.PlaneGeometry(0.46, 1.25);
  atlasUV(scroll, ...atlasCell(1, 0.46 / 1.25));
  b.add(m.art, tf(scroll, toko.c + 0.1, 1.08, az + 0.005));
  b.add(m.wood, tf(cyl(0.012, 0.012, 0.54, 10), toko.c + 0.1, 0.455, az + 0.02, 0, 0, Math.PI / 2), '#2e2018');
  b.add(m.wood, tf(cyl(0.008, 0.008, 0.48, 8), toko.c + 0.1, 1.71, az + 0.012, 0, 0, Math.PI / 2), '#6b5a3c');
  ikebana(k, toko.c - 0.35, 0.12, az + 0.3);
  cs.rect(toko.c, az + 0.3, toko.w - 0.1, 0.3, 0.2, 0, 0.3, 0.126);

  // furniture
  tansu(k, 1.5, -d.D / 2 + 0.22, 0, 1.1, 0.72, 0.42, '#6b4428');
  bonsai(k, 1.35, 0.72, -d.D / 2 + 0.22);
  andon(k, d.W / 2 - 0.35, -d.D / 2 + 0.35);
  lowTable(k, 1.95, 1.5, Math.PI / 2, 1.0, 0.7, 0.33, '#5a3a24');
  zabuton(k, 1.25, 1.55, 0.58, 0.09, '#8b3a3a', 0.1);
  zabuton(k, 1.95, 2.3, 0.58, 0.09, '#8b3a3a', Math.PI / 2);
  tansu(k, -1.0, d.D / 2 - 0.22, Math.PI, 1.2, 0.6, 0.42, '#7a5030');
  snakePlant(k, -d.W / 2 + 0.35, d.D / 2 - 0.35, '#3a3632', 0.9);
  figTree(k, -d.W / 2 + 0.4, -d.D / 2 + 0.4, 1.3, 'taper', '#3a3632');

  const spots: Room['spots'] = {
    food: new THREE.Vector3(1.45, 0, -0.05),
    water: new THREE.Vector3(1.45, 0, 0.4),
    bed: new THREE.Vector3(-1.25, 0, -1.3),
    door: new THREE.Vector3(1.55, 0, fusuma.c),
    toybox: new THREE.Vector3(-1.5, 0, 1.55),
  };
  zabuton(k, spots.bed.x, spots.bed.z, 0.75, 0.13, '#34507a', 0.3);
  toyBasket(k, spots.toybox.x, spots.toybox.z);
  b.add(m.wood, boxUV(tf(rbox(0.36, 0.012, 0.85, 0.005, 1), 1.45, 0.006, 0.175), 0.3), '#b89066');

  b.build(group, 'room');
  cs.build(group);

  const sunDir = new THREE.Vector3(0.78, -0.5, -0.3);
  const sun = makeSun('#ffe4bf', 3.1, sunDir, new THREE.Vector3(0, 0, 0));
  lights(group, sun, '#f7f3ea', '#b5a27e', 1.45);
  const garden = gardenTexture(19, { sky: ['#7db6e3', '#eaf3f6'], far: ['#8fae95', '#9fbca2', '#7f9f86'], trees: ['#4b7a3a', '#5d8a42', '#3e6a30', '#6a9848'], lawn: '#6f9a48', bamboo: true, maple: true });
  backdrop(group, garden, d, 'L', 11, -0.4);
  const beam = sunbeam(d, { ...shoji, c: 0, w: 1.6 }, sunDir, '#ffe6c4', 0.04);
  group.add(beam.group);
  return {
    group,
    sun,
    d,
    obstacles: k.obstacles,
    spots,
    camera: { position: new THREE.Vector3(1.25, 0.8, 1.7), target: new THREE.Vector3(-0.35, 0.22, -0.45), fov: 50 },
    envBackground: new THREE.Color('#e3ebe6'),
    background: new THREE.Color('#cfe2f0'),
    beams: [beam],
    shadowBox: new THREE.Box3(new THREE.Vector3(-d.W / 2 - d.t, 0, -d.D / 2 - ad - 0.2), new THREE.Vector3(d.W / 2 + d.t, d.H + d.t, d.D / 2 + d.t)),
  };
}

// ---- modern: light oak loft ------------------------------------------------------

/** Arc floor lamp: marble base, black arc, white dome with a glowing underside. */
function arcLamp(k: Kit, x: number, z: number, toX: number, toZ: number) {
  const { b, m } = k;
  b.add(m.ceramic, tf(rbox(0.3, 0.22, 0.2, 0.02, 2), x, 0.11, z), '#ecebe8');
  const dx = toX - x;
  const dz = toZ - z;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const a = t * Math.PI * 0.62;
    pts.push(new THREE.Vector3(x + dx * (1 - Math.cos(a)) / (1 - Math.cos(Math.PI * 0.62)), 0.22 + Math.sin(a) * 1.75 - t * t * 0.1, z + dz * (1 - Math.cos(a)) / (1 - Math.cos(Math.PI * 0.62))));
  }
  b.add(m.metal, tube(pts, 0.012, 40, 8), '#1e1e1e');
  const end = pts[pts.length - 1];
  const dome = new THREE.SphereGeometry(0.2, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(m.ceramic, tf(dome, end.x, end.y - 0.12, end.z), '#f4f4f2');
  b.add(m.glow, tf(new THREE.CircleGeometry(0.19, 28), end.x, end.y - 0.121, end.z, 0, Math.PI / 2), '#fff3dd');
  k.cs.blob(x, z, 0.3, 0.7);
  k.obstacles.push({ x, z, r: 0.22 });
}

/** Ceiling pendant light over (x, z). */
function pendant(k: Kit, x: number, z: number, H: number, drop: number) {
  const { b, m } = k;
  b.add(m.matte, tf(cyl(0.004, 0.004, drop, 6), x, H - drop / 2, z), '#222');
  b.add(m.matte, tf(cyl(0.05, 0.05, 0.015, 20), x, H - 0.008, z), '#f4f4f2');
  const shade = lathe([[0.03, 0.2], [0.06, 0.19], [0.17, 0.06], [0.2, 0], [0.19, 0]], 36);
  b.add(m.metal, tf(shade, x, H - drop - 0.2, z), '#c9a36a');
  b.add(m.glow, tf(new THREE.CircleGeometry(0.19, 28), x, H - drop - 0.199, z, 0, Math.PI / 2), '#fff3dd');
}

function buildModernRoom(): ThemeBuild {
  const d: Dims = { W: 5.4, D: 5.4, H: 2.8, t: 0.16 };
  const glass: Opening = { wall: 'L', c: -0.1, w: 3.4, y0: 0, y1: 2.5 };
  const door: Opening = { wall: 'R', c: -1.4, w: 0.9, y0: 0, y1: 2.2 };
  const openings = [glass, door];
  const group = new THREE.Group();
  group.name = 'room:modern';
  const r = rng(51);
  const art = pictureAtlas([paintAbstract, paintBotanical, paintLandscape, paintDogPortrait], 12);
  const m = makePropMats(500, art);
  const fl = plankTextures({ px: texSize(2048), rows: 9, minLen: 0.55, maxLen: 1.0, colors: ['#dcc3a0', '#d6bb95', '#e0c9a8', '#d2b58c', '#dac09b'], seed: 17, dark: '120,90,55', grain: 0.3, seam: 0.35 });
  const floorMat = stdMat('floor', { map: fl.map, normalMap: fl.normalMap, roughnessMap: fl.roughnessMap, roughness: 1.25, normalScale: new THREE.Vector2(0.5, 0.5), cast: false });
  const textile = textileAtlas(61, { field: '#d9d3c9', border: '#bdb4a7', accent: '#cfc6b8', accent2: '#a59b8d', pattern: 'round' }, false);
  const pile = plushTextures(62, 256);
  pile.normalMap.repeat.set(22, 16);
  const textileMat = stdMat('textile', { map: textile, normalMap: pile.normalMap, normalScale: new THREE.Vector2(1, 1), roughness: 1, cast: false });
  const glassMat = physMat('glass', { color: '#ffffff', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.08, envMapIntensity: 1.5, cast: false, receive: false });
  glassMat.depthWrite = false;

  const b = new Batch();
  const cs = new ContactShadows(0.45);
  const k: Kit = { b, m, cs, obstacles: [], r };
  const WHITE = '#f4f3ef';
  buildShell(b, m.paint, d, openings, WHITE, '#f7f6f3');
  buildFloor(b, floorMat, d, 2.2);
  moulding(b, m.paint, d, openings, 0, 0.07, 0.01, WHITE, 'flat');
  roomAO(cs, d, 0.35);

  // glass sliding doors: slim black frames, faint glass
  const F = (g: THREE.BufferGeometry) => b.add(m.metal, boxUV(onWall(g, d, 'L', glass.c, 0, -d.t * 0.5), 1), '#1d1d1f');
  const gw = glass.w;
  const gh = glass.y1;
  F(tf(box(0.05, gh, 0.08), -gw / 2 + 0.025, gh / 2, 0));
  F(tf(box(0.05, gh, 0.08), gw / 2 - 0.025, gh / 2, 0));
  F(tf(box(gw, 0.05, 0.08), 0, gh - 0.025, 0));
  F(tf(box(gw, 0.03, 0.08), 0, 0.015, 0));
  const panels = 3;
  for (let i = 1; i < panels; i++) F(tf(box(0.06, gh, 0.07), -gw / 2 + (gw / panels) * i, gh / 2, (i % 2 ? 0.02 : -0.02)));
  for (let i = 0; i < panels; i++) {
    const pg = new THREE.PlaneGeometry(gw / panels - 0.06, gh - 0.08);
    b.add(glassMat, onWall(tf(pg, -gw / 2 + (gw / panels) * (i + 0.5), gh / 2, i % 2 ? 0.02 : -0.02), d, 'L', glass.c, 0, -d.t * 0.5));
  }
  // long handle on the middle panel
  F(tf(box(0.02, 0.5, 0.03), -gw / 2 + gw / panels + 0.08, 1.05, 0.06));
  // deck outside
  for (let i = 0; i < 20; i++) b.add(m.wood, boxUV(tf(box(0.13, 0.04, 7), -d.W / 2 - d.t - 0.08 - i * 0.145, -0.03, 0), 0.8), i % 3 ? '#a8835f' : '#9c7856');

  // back wall: low sofa, big canvas, arc lamp, tall plant
  sofa(k, 0.2, -d.D / 2 + 0.5, 0, { w: 2.3, d: 0.95, color: '#a8a39b', leg: '#1d1d1f', pillows: ['#c96f4a', '#e9e2d5', '#2f4858'], modern: true });
  wallFrame(k, d, 'B', 0.2, 1.45, 1.3, 0.8, atlasCell(0, 1.3 / 0.8), '#f4f3ef', 0.02, 0);
  arcLamp(k, -1.55, -d.D / 2 + 0.3, -0.6, -d.D / 2 + 0.75);
  figTree(k, 1.95, -d.D / 2 + 0.45, 1.7, 'taper', '#f1efea');

  // right wall: door, sideboard with objects, two prints
  panelDoor(k, d, door, '#f7f6f2', WHITE, '#1d1d1f', 'flush');
  const sbZ = 0.95;
  const top = sideboard(k, d.W / 2 - 0.24, sbZ, -Math.PI / 2, 1.8, 0.62, 0.44, '#cfae84', '#1d1d1f', 2, 0.18);
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.06, 0], [0.09, 0.12], [0.05, 0.28], [0.03, 0.3]], 24), d.W / 2 - 0.25, top, sbZ + 0.55), '#f2f0eb');
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.05, 0], [0.07, 0.07], [0.02, 0.16], [0.025, 0.19]], 24), d.W / 2 - 0.22, top, sbZ + 0.38), '#2a2a2a');
  b.add(m.ceramic, tf(new THREE.SphereGeometry(0.06, 24, 16), d.W / 2 - 0.26, top + 0.06, sbZ - 0.5), '#c96f4a');
  const P = placer(d.W / 2 - 0.25, top, sbZ - 0.1, -Math.PI / 2);
  ['#e9e2d5', '#2f4858', '#cfc6b8'].forEach((c, i) => b.add(m.matte, P(tf(rbox(0.3 - i * 0.03, 0.03, 0.22, 0.004, 1), 0, 0.015 + i * 0.031, 0, i * 0.08)), c));
  trailingPlant(k, d.W / 2 - 0.26, top, sbZ + 0.15, '#f1efea', 0.7);
  wallFrame(k, d, 'R', sbZ - 0.4, 1.5, 0.45, 0.6, atlasCell(1, 0.45 / 0.6), '#1d1d1f', 0.015, 0.06);
  wallFrame(k, d, 'R', sbZ + 0.3, 1.5, 0.45, 0.6, atlasCell(2, 0.45 / 0.6), '#1d1d1f', 0.015, 0.06);

  // front wall: white shelving, plant
  bookcase(k, -0.4, d.D / 2 - 0.18, Math.PI, 2.2, 1.1, 0.34, [0.4, 0.75], WHITE, ['#e9e2d5', '#2f4858', '#c96f4a', '#cfc6b8', '#8a8f8c', '#d9b36a'], m.paint);
  b.add(m.ceramic, tf(lathe([[0.001, 0], [0.07, 0], [0.1, 0.1], [0.06, 0.25], [0.04, 0.3]], 24), 0.45, 1.1, d.D / 2 - 0.2), '#e0dcd4');
  wallFrame(k, d, 'F', -0.4, 1.75, 1.1, 0.7, atlasCell(2, 1.1 / 0.7), '#1d1d1f', 0.015, 0.07);
  snakePlant(k, -d.W / 2 + 0.4, d.D / 2 - 0.4, '#e0dcd4', 1.1);
  pendant(k, -0.15, 0.05, d.H, 0.9);

  // round rug, bed, felt basket, bowl mat
  const rug = new THREE.CircleGeometry(1.15, 64);
  atlasUV(rug, 0, 0.25, 1, 1);
  b.add(textileMat, tf(rug, -0.15, 0.006, 0.05, 0, -Math.PI / 2));
  b.add(textileMat, tf(cyl(1.15, 1.15, 0.006, 64, true), -0.15, 0.003, 0.05));
  cs.blob(-0.15, 0.05, 1.25, 0.25);
  const spots: Room['spots'] = {
    food: new THREE.Vector3(1.5, 0, 0.3),
    water: new THREE.Vector3(1.5, 0, 0.75),
    bed: new THREE.Vector3(-1.3, 0, -1.25),
    door: new THREE.Vector3(1.55, 0, door.c),
    toybox: new THREE.Vector3(1.55, 0, 1.6),
  };
  dogBed(k, spots.bed.x, spots.bed.z, '#9ea3a8', '#efe9df');
  toyBasket(k, spots.toybox.x, spots.toybox.z, 0.2, 0.22, '#8d9296');
  const bm = rbox(0.9, 0.006, 0.42, 0.003, 1);
  atlasUV(bm, 0.5, 0, 1, 0.25);
  b.add(textileMat, tf(bm, 1.5, 0.003, 0.525, Math.PI / 2));

  b.build(group, 'room');
  cs.build(group);

  const sunDir = new THREE.Vector3(0.78, -0.52, -0.3);
  const sun = makeSun('#ffe8c8', 3.2, sunDir, new THREE.Vector3(0, 0, 0));
  lights(group, sun, '#f8f7f4', '#c8b8a2', 1.35);
  const garden = gardenTexture(29, { sky: ['#6fb0e8', '#eef5f9'], far: ['#9cb9a8', '#a9c4b4', '#8fae9c'], trees: ['#4f7f38', '#62923f', '#40702f', '#72a04a'], lawn: '#7cae4e', flowers: ['#ffffff', '#f7d65c', '#c9a0dc'] });
  backdrop(group, garden, d, 'L', 11, -0.35);
  const beam = sunbeam(d, glass, sunDir, '#ffe9cc', 0.035);
  group.add(beam.group);
  return {
    group,
    sun,
    d,
    obstacles: k.obstacles,
    spots,
    camera: { position: new THREE.Vector3(1.25, 0.8, 1.7), target: new THREE.Vector3(-0.35, 0.22, -0.45), fov: 50 },
    envBackground: new THREE.Color('#e6eef3'),
    background: new THREE.Color('#cfe2f0'),
    beams: [beam],
  };
}

/** Build a home room for the given theme id ('default' | 'japanese' | 'modern'). */
export function buildRoom(themeId: string, renderer: THREE.WebGLRenderer): Room {
  switch (themeId) {
    case 'japanese':
      return finishRoom(renderer, buildJapaneseRoom());
    case 'modern':
      return finishRoom(renderer, buildModernRoom());
    default:
      return finishRoom(renderer, buildDefaultRoom());
  }
}
