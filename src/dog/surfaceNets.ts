import { Grid, Prim, evalField } from './sdf';

export interface RawMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

const CUBE_EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Naive surface nets over a sampled grid, followed by projection of every
 * vertex onto the analytic zero set so the result is smooth and exact.
 */
export function surfaceNets(grid: Grid, prims: Prim[], refineIters = 3): RawMesh {
  const { data, nx, ny, nz, ox, oy, oz, h } = grid;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellIndex = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corner = new Float32Array(8);
  const sx = 1, sy = nx, sz = nx * ny;
  const offs = [0, sx, sy, sx + sy, sz, sz + sx, sz + sy, sz + sx + sy];

  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const base = i + nx * (j + ny * k);
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = data[base + offs[c]];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let ax = 0, ay = 0, az = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = CUBE_EDGES[e][0], b = CUBE_EDGES[e][1];
          const inA = (mask >> a) & 1, inB = (mask >> b) & 1;
          if (inA === inB) continue;
          const t = corner[a] / (corner[a] - corner[b]);
          const pax = a & 1, pay = (a >> 1) & 1, paz = (a >> 2) & 1;
          const pbx = b & 1, pby = (b >> 1) & 1, pbz = (b >> 2) & 1;
          ax += pax + (pbx - pax) * t;
          ay += pay + (pby - pay) * t;
          az += paz + (pbz - paz) * t;
          n++;
        }
        cellIndex[i + cx * (j + cy * k)] = pos.length / 3;
        pos.push(ox + (i + ax / n) * h, oy + (j + ay / n) * h, oz + (k + az / n) * h);
      }
    }
  }

  const idx: number[] = [];
  const cell = (i: number, j: number, k: number) => cellIndex[i + cx * (j + cy * k)];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { const t = b; b = d; d = t; }
    // split along the shorter diagonal
    const d1 = dist2(pos, a, c), d2 = dist2(pos, b, d);
    if (d1 < d2) idx.push(a, b, c, a, c, d);
    else idx.push(a, b, d, b, c, d);
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v0 = data[i + nx * (j + ny * k)];
        const in0 = v0 < 0;
        // x edge
        if (i < nx - 1 && j > 0 && k > 0 && j < cy && k < cz) {
          const in1 = data[i + 1 + nx * (j + ny * k)] < 0;
          if (in0 !== in1) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), !in0);
        }
        // y edge
        if (j < ny - 1 && i > 0 && k > 0 && i < cx && k < cz) {
          const in1 = data[i + nx * (j + 1 + ny * k)] < 0;
          if (in0 !== in1) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), !in0);
        }
        // z edge
        if (k < nz - 1 && i > 0 && j > 0 && i < cx && j < cy) {
          const in1 = data[i + nx * (j + ny * (k + 1))] < 0;
          if (in0 !== in1) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), !in0);
        }
      }
    }
  }

  const positions = new Float32Array(pos);
  const normals = new Float32Array(positions.length);
  const e = h * 0.25;
  const vcount = positions.length / 3;
  for (let v = 0; v < vcount; v++) {
    let x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let gx = 0, gy = 0, gz = 1;
    for (let it = 0; it <= refineIters; it++) {
      const f = evalField(prims, x, y, z);
      gx = evalField(prims, x + e, y, z) - evalField(prims, x - e, y, z);
      gy = evalField(prims, x, y + e, z) - evalField(prims, x, y - e, z);
      gz = evalField(prims, x, y, z + e) - evalField(prims, x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (it === refineIters) break;
      let step = f;
      if (step > h) step = h; else if (step < -h) step = -h;
      x -= gx * step; y -= gy * step; z -= gz * step;
    }
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
    normals[v * 3] = gx; normals[v * 3 + 1] = gy; normals[v * 3 + 2] = gz;
  }

  return { positions, normals, indices: new Uint32Array(idx) };
}

function dist2(p: number[], a: number, b: number) {
  const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Light laplacian smoothing that keeps vertices near their original positions. */
export function smoothMesh(mesh: RawMesh, iterations: number, amount = 0.5) {
  const { positions, indices } = mesh;
  const n = positions.length / 3;
  const nbrStart = new Int32Array(n + 1);
  for (let i = 0; i < indices.length; i++) nbrStart[indices[i] + 1] += 2;
  for (let i = 0; i < n; i++) nbrStart[i + 1] += nbrStart[i];
  const fill = nbrStart.slice(0, n);
  const nbr = new Int32Array(nbrStart[n]);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    nbr[fill[a]++] = b; nbr[fill[a]++] = c;
    nbr[fill[b]++] = c; nbr[fill[b]++] = a;
    nbr[fill[c]++] = a; nbr[fill[c]++] = b;
  }
  const tmp = new Float32Array(positions.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0;
      const s = nbrStart[i], e = nbrStart[i + 1];
      for (let j = s; j < e; j++) {
        const q = nbr[j];
        sx += positions[q * 3]; sy += positions[q * 3 + 1]; sz += positions[q * 3 + 2];
      }
      const c = e - s || 1;
      tmp[i * 3] = positions[i * 3] + (sx / c - positions[i * 3]) * amount;
      tmp[i * 3 + 1] = positions[i * 3 + 1] + (sy / c - positions[i * 3 + 1]) * amount;
      tmp[i * 3 + 2] = positions[i * 3 + 2] + (sz / c - positions[i * 3 + 2]) * amount;
    }
    positions.set(tmp);
  }
}
