// Builds a dog's skin mesh as plain typed arrays: sculpt → surface nets → per-vertex
// skin weights, coat paint, fur and baked AO. Pure computation with no DOM or GPU
// objects, so it runs in a worker (see meshWorker.ts) as well as on the main thread.
//
// The sculpt is meshed finely so the surface is accurate, then simplified into
// levels of detail that share one set of vertices, each bounded by how far it may
// stray from the true surface: under a quarter of a millimetre for the skin up
// close, a millimetre or so for fur shells and distant views (each shell redraws
// the whole body, so that is where triangles add up). Only the vertices the finest
// level keeps are painted.

import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { Breed, CoatDef } from './breeds';
import { designDog, type DogDesign } from './design';
import { paintVertex } from './patterns';
import { evalField, sampleGrid, type Prim } from './sdf';
import { surfaceNets } from './surfaceNets';

export type Index = Uint16Array | Uint32Array;

export interface DogMeshData {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** x: fur length (m), y: gloss, z: baked AO, w: unused */
  furData: Float32Array;
  /** hair direction in bind space (tangent to the skin) */
  furDir: Float32Array;
  /**
   * Triangles at decreasing detail over the same vertices: [0] is the skin up close,
   * [1] and [2] are coarser (fur shells, shadows, the skin further away). Each is
   * simplified from the one before, so every level only uses vertices of level 0.
   */
  lods: Index[];
  /** worst surface deviation of each level from the sculpt, in metres */
  lodError: number[];
  /** average coat colour above each eye (for the eyelids), linear RGB */
  lidColors: [number, number, number][];
  /** timings, for tuning */
  ms: Record<string, number>;
}

export interface DogMeshOptions {
  /** 0.5 .. 1.5: sculpt resolution and detail kept by the levels of detail */
  quality?: number;
  /** false: keep the full sculpt mesh (for comparisons) */
  simplify?: boolean;
}

/** Surface deviation (m) allowed for each level of detail at quality 1, for a labrador-sized pup. */
export const LOD_ERRORS = [0.00022, 0.00055, 0.0014];

let simplifierOk = false;
let simplifierReady: Promise<boolean> | null = null;
/** Resolves true once the WASM simplifier can run (false where WebAssembly isn't available). */
export function meshSimplifierReady(): Promise<boolean> {
  simplifierReady ??= (MeshoptSimplifier.supported ? MeshoptSimplifier.ready.then(() => true, () => false) : Promise.resolve(false))
    .then((ok) => (simplifierOk = ok));
  return simplifierReady;
}
meshSimplifierReady();

interface Component {
  prims: Prim[];
  voxel: number;
  name: 'body' | 'jaw' | 'earL' | 'earR';
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function buildDogMesh(breed: Breed, coat: CoatDef, opts: DogMeshOptions = {}, design: DogDesign = designDog(breed)): DogMeshData {
  const ms: Record<string, number> = {};
  let t0 = now();
  const lap = (k: string) => { const t = now(); ms[k] = (ms[k] ?? 0) + t - t0; t0 = t; };
  const quality = opts.quality ?? 1;
  const d = design;
  const vox = d.dims.voxel / Math.sqrt(quality);
  const earVox = Math.min(vox * 0.55, breed.shape.ear.T * d.dims.hs * 0.34);
  const comps: Component[] = [
    { prims: d.body, voxel: vox, name: 'body' },
    { prims: d.jaw, voxel: vox * 0.6, name: 'jaw' },
    { prims: d.ears[0], voxel: earVox, name: 'earL' },
    { prims: d.ears[1], voxel: earVox, name: 'earR' },
  ];

  // ---- mesh every component and concatenate
  const raws = comps.map((c) => surfaceNets(sampleGrid(c.prims, c.voxel), c.prims, 3));
  lap('mesh');
  let nv = 0, ni = 0;
  for (const r of raws) { nv += r.positions.length / 3; ni += r.indices.length; }
  const fullPos = new Float32Array(nv * 3);
  const fullNrm = new Float32Array(nv * 3);
  const fullIdx = new Uint32Array(ni);
  const compOf = new Uint8Array(nv);
  {
    let v = 0, i = 0;
    raws.forEach((r, ci) => {
      fullPos.set(r.positions, v * 3);
      fullNrm.set(r.normals, v * 3);
      compOf.fill(ci, v, v + r.positions.length / 3);
      for (let k = 0; k < r.indices.length; k++) fullIdx[i + k] = r.indices[k] + v;
      v += r.positions.length / 3;
      i += r.indices.length;
    });
  }

  // ---- coat paint, skin weights and hair direction for every vertex (needed before
  // simplifying, so pattern edges like a blaze or spots keep their vertices)
  const boneIndex: Record<string, number> = {};
  d.bones.forEach((b, i) => (boneIndex[b.name] = i));
  const tailPts = [0, 1, 2, 3, 4].map((i) => d.bones.find((b) => b.name === 'tail' + i)!.pos).concat([d.dims.tailTip]);
  const furLen = breed.fur.len;
  const eyeInfo = d.eyes;
  const A = d.dims.atlas;
  const hs = d.dims.hs;
  const lidAcc = [[0, 0, 0], [0, 0, 0]];
  const lidCnt = [0, 0];
  const weighedOf = comps.map((c) => c.prims.filter((p) => p.weigh));
  const sigmaOf = comps.map((c) => (c.name === 'body' ? 0.009 * Math.max(0.55, d.dims.g) : 0.004 * hs));
  const tagSigma = 0.0028 * hs;
  const maxWeighed = Math.max(...weighedOf.map((w) => w.length));
  const dists = new Float64Array(maxWeighed);
  const nb = d.bones.length;
  const bw = new Float64Array(nb);
  const seen = new Uint8Array(nb);
  const touched: number[] = [];
  const addBone = (b: number, w: number) => {
    if (!seen[b]) { seen[b] = 1; touched.push(b); }
    bw[b] += w;
  };
  // per vertex: r, g, b, fur (relative to the breed's length) — also what the simplifier weighs
  const paintAttr = new Float32Array(nv * 4);
  const glossA = new Float32Array(nv);
  const skinIdxA = new Uint16Array(nv * 4);
  const skinWA = new Float32Array(nv * 4);
  const furDirA = new Float32Array(nv * 3);

  for (let v = 0; v < nv; v++) {
    const ci = compOf[v];
    const c = comps[ci];
    const weighed = weighedOf[ci];
    const sigma = sigmaOf[ci];
    const x = fullPos[v * 3], y = fullPos[v * 3 + 1], z = fullPos[v * 3 + 2];
    const nx = fullNrm[v * 3], ny = fullNrm[v * 3 + 1], nz = fullNrm[v * 3 + 2];
    // influences
    let dmin = Infinity;
    for (let i = 0; i < weighed.length; i++) {
      const p = weighed[i];
      const m = p.k + sigma * 6;
      if (x < p.min[0] - m || y < p.min[1] - m || z < p.min[2] - m || x > p.max[0] + m || y > p.max[1] + m || z > p.max[2] + m) {
        dists[i] = Infinity;
        continue;
      }
      const dd = p.d(x, y, z);
      dists[i] = dd;
      if (dd < dmin) dmin = dd;
    }
    const tags: Record<string, number> = {};
    let fx = 0, fy = 0, fz = 0, tsum = 0;
    touched.length = 0;
    for (let i = 0; i < weighed.length; i++) {
      if (dists[i] === Infinity) continue;
      const p = weighed[i];
      const tw = Math.exp(-(dists[i] - dmin) / tagSigma);
      if (tw > 0.01) { tags[p.tag] = (tags[p.tag] || 0) + tw; tsum += tw; }
      const w = Math.exp(-(dists[i] - dmin) / sigma);
      if (w < 0.01) continue;
      const f = typeof p.flow === 'function' ? p.flow(x, y, z) : p.flow;
      fx += f[0] * w; fy += f[1] * w; fz += f[2] * w;
      if (typeof p.bone === 'string') addBone(boneIndex[p.bone], w);
      else {
        const list = typeof p.bone === 'function' ? p.bone(x, y, z) : p.bone;
        for (const [bn, bwv] of list) if (bwv > 0) addBone(boneIndex[bn], w * bwv);
      }
    }
    for (const k in tags) tags[k] /= tsum || 1;
    // top 4 bones
    touched.sort((a, b) => bw[b] - bw[a]);
    let tot = 0;
    const nTop = Math.min(4, touched.length);
    for (let i = 0; i < nTop; i++) tot += bw[touched[i]];
    for (let i = 0; i < 4; i++) {
      const b = i < nTop ? touched[i] : -1;
      skinIdxA[v * 4 + i] = b >= 0 ? b : 0;
      skinWA[v * 4 + i] = b >= 0 ? bw[b] / tot : 0;
    }
    for (const b of touched) { bw[b] = 0; seen[b] = 0; }
    // hair direction projected onto the tangent plane
    const dn = fx * nx + fy * ny + fz * nz;
    let tx = fx - nx * dn, ty = fy - ny * dn, tz = fz - nz * dn;
    let tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-4) { tx = 0; ty = -1; tz = 0; const d2 = -ny; tx -= nx * d2; ty -= ny * d2; tz -= nz * d2; tl = Math.hypot(tx, ty, tz) || 1; }
    furDirA[v * 3] = tx / tl; furDirA[v * 3 + 1] = ty / tl; furDirA[v * 3 + 2] = tz / tl;

    // eye distance
    let eyeD = Infinity;
    for (const e of eyeInfo.pos) eyeD = Math.min(eyeD, Math.hypot(x - e[0], y - e[1], z - e[2]) / eyeInfo.r);
    // tail fraction
    let tailF = 0;
    if (tags.tail) {
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const a = tailPts[i], b = tailPts[i + 1];
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
        const l2 = abx * abx + aby * aby + abz * abz;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / l2));
        const dd = Math.hypot(x - a[0] - abx * t, y - a[1] - aby * t, z - a[2] - abz * t);
        if (dd < best) { best = dd; tailF = (i + t) / 5; }
      }
    }
    const paint = paintVertex({
      p: [x, y, z], n: [nx, ny, nz], tags, design: d,
      hx: (x - A[0]) / hs, hy: (y - A[1]) / hs, hz: (z - A[2]) / hs,
      u: (z - d.dims.hipZ) / (d.dims.shZ - d.dims.hipZ), eyeD, tailF,
    }, coat, d.furRegions);

    if (c.name === 'body' && eyeD > 1.5 && eyeD < 2.6) {
      for (let e = 0; e < 2; e++) {
        const ep = eyeInfo.pos[e];
        if (Math.hypot(x - ep[0], y - ep[1], z - ep[2]) / eyeInfo.r < 2.6 && y > ep[1]) {
          lidAcc[e][0] += paint.color.r; lidAcc[e][1] += paint.color.g; lidAcc[e][2] += paint.color.b; lidCnt[e]++;
        }
      }
    }

    let furMul = paint.fur;
    if (c.name === 'earL' || c.name === 'earR') {
      // thin the coat towards the rim of the ear leather so shells don't stair-step
      const en = d.earNormals[c.name === 'earL' ? 0 : 1];
      const k = Math.abs(nx * en[0] + ny * en[1] + nz * en[2]);
      furMul *= 0.15 + 0.85 * Math.min(1, Math.max(0, (k - 0.25) / 0.5));
    }
    paintAttr[v * 4] = paint.color.r; paintAttr[v * 4 + 1] = paint.color.g; paintAttr[v * 4 + 2] = paint.color.b;
    paintAttr[v * 4 + 3] = furMul;
    glossA[v] = paint.gloss;
  }
  lap('paint');

  // ---- levels of detail (index buffers over the same vertices)
  // Errors are absolute (metres), scaled with the dog's size and the quality setting.
  // Colour and coat length count too (a colour step across an edge costs a fraction
  // of the edge's length), so pattern edges like a blaze, spots or a mask keep their
  // vertices while plain areas of coat simplify freely.
  const size = Math.max(0.6, d.dims.g);
  const lodError = LOD_ERRORS.map((e) => (e * size) / quality);
  const levels: Uint32Array<ArrayBufferLike>[] = [];
  if (simplifierOk && opts.simplify !== false) {
    // colours roughly as they look (gamma ~2) so dark markings weigh what they show
    const simpAttr = new Float32Array(nv * 4);
    for (let i = 0; i < nv * 4; i++) simpAttr[i] = (i & 3) === 3 ? paintAttr[i] : Math.sqrt(Math.max(0, paintAttr[i]));
    let prev: Uint32Array<ArrayBufferLike> = fullIdx;
    for (const err of lodError) {
      const wc = 0.6, wf = 0.3;
      // aim low on triangles; the error bound decides where it actually stops
      const target = Math.max(3, Math.floor(prev.length / 3 / 50) * 3);
      const [out] = MeshoptSimplifier.simplifyWithAttributes(prev, fullPos, 3, simpAttr, 4, [wc, wc, wc, wf], null, target, err, ['ErrorAbsolute']);
      if (out.length >= 3) prev = out;
      levels.push(prev);
    }
  } else {
    // no WebAssembly (or asked not to): every level is the full mesh, correct but slower
    for (let i = 0; i < lodError.length; i++) levels.push(fullIdx);
    lodError.fill(0);
  }
  const baseIdx = levels[0];
  lap('simplify');

  // ---- keep only the vertices the finest level uses
  const remap = new Int32Array(nv).fill(-1);
  let kept = 0;
  for (let i = 0; i < baseIdx.length; i++) {
    const v = baseIdx[i];
    if (remap[v] < 0) remap[v] = kept++;
  }
  const lods: Index[] = levels.map((lv) => {
    const out = kept < 65536 ? new Uint16Array(lv.length) : new Uint32Array(lv.length);
    for (let i = 0; i < lv.length; i++) out[i] = remap[lv[i]];
    return out;
  });

  const position = new Float32Array(kept * 3);
  const normal = new Float32Array(kept * 3);
  const color = new Float32Array(kept * 3);
  const skinIndex = new Uint16Array(kept * 4);
  const skinWeight = new Float32Array(kept * 4);
  const furData = new Float32Array(kept * 4);
  const furDir = new Float32Array(kept * 3);
  for (let v = 0; v < nv; v++) {
    const k = remap[v];
    if (k < 0) continue;
    for (let j = 0; j < 3; j++) {
      position[k * 3 + j] = fullPos[v * 3 + j];
      normal[k * 3 + j] = fullNrm[v * 3 + j];
      color[k * 3 + j] = paintAttr[v * 4 + j];
      furDir[k * 3 + j] = furDirA[v * 3 + j];
    }
    for (let j = 0; j < 4; j++) {
      skinIndex[k * 4 + j] = skinIdxA[v * 4 + j];
      skinWeight[k * 4 + j] = skinWA[v * 4 + j];
    }
    furData[k * 4] = furLen * paintAttr[v * 4 + 3];
    furData[k * 4 + 1] = glossA[v];
  }
  lap('compact');

  // ---- ambient occlusion from the sculpt (only for the vertices kept)
  const allPrims = [d.body, d.jaw];
  const aoField = (x: number, y: number, z: number) => {
    let m = 1e3;
    for (const p of allPrims) m = Math.min(m, evalField(p, x, y, z));
    return m;
  };
  const aoStep = 0.005 * Math.max(0.5, d.dims.g);
  for (let v = 0; v < kept; v++) {
    const x = position[v * 3], y = position[v * 3 + 1], z = position[v * 3 + 2];
    const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2];
    let occ = 0;
    for (let i = 1; i <= 5; i++) {
      const dist = aoStep * i;
      const f = aoField(x + nx * dist, y + ny * dist, z + nz * dist);
      occ += Math.max(0, dist - f) / dist / (1 << (i - 1));
    }
    furData[v * 4 + 2] = Math.min(1, Math.max(0.45, 1 - occ * 0.5));
  }
  lap('ao');
  const lidColors = lidAcc.map((c, i): [number, number, number] => (lidCnt[i] ? [c[0] / lidCnt[i], c[1] / lidCnt[i], c[2] / lidCnt[i]] : [0.3, 0.2, 0.1]));
  return { position, normal, color, skinIndex, skinWeight, furData, furDir, lods, lodError, lidColors, ms };
}

/** The typed arrays in a mesh, for transferring it out of a worker without copying. */
export function meshTransferables(m: DogMeshData): ArrayBuffer[] {
  const arrays = [m.position, m.normal, m.color, m.skinIndex, m.skinWeight, m.furData, m.furDir, ...m.lods];
  // levels share one array when simplification was skipped: list each buffer once
  return [...new Set(arrays.map((a) => a.buffer as ArrayBuffer))];
}
