// Signed distance field primitives used to sculpt the dogs.
// Everything works on plain numbers to keep the mesher fast.

export type V3 = [number, number, number];

/** Bone weighting spec: a single bone, or a function returning weighted bones for a point. */
export type BoneSpec = string | [string, number][] | ((x: number, y: number, z: number) => [string, number][]);

export interface Prim {
  /** signed distance */
  d: (x: number, y: number, z: number) => number;
  /** smooth blend radius used when combining with the field so far */
  k: number;
  sub: boolean;
  /** axis aligned bounds of the primitive itself (before blend expansion) */
  min: V3;
  max: V3;
  bone: BoneSpec;
  tag: string;
  /** hair flow direction hint (bind space) */
  flow: V3 | ((x: number, y: number, z: number) => V3);
  /** if false this primitive does not contribute to skin weights / tags */
  weigh: boolean;
}

export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

// ---------- 3x3 rotation helpers (row-major) ----------
export type M3 = number[];

export function rotXYZ(rx: number, ry: number, rz: number): M3 {
  // R = Rz * Ry * Rx  (applied to vectors as R*v)
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

/** Rotation that maps local +Y onto direction d (unit), keeping roll stable. */
export function basisFromY(d: V3): M3 {
  const [dx, dy, dz] = norm(d);
  // pick helper axis
  let ax: V3 = Math.abs(dx) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  // z = normalize(cross(ax, y)), x = cross(y, z)
  let zx = ax[1] * dz - ax[2] * dy, zy = ax[2] * dx - ax[0] * dz, zz = ax[0] * dy - ax[1] * dx;
  const zl = Math.hypot(zx, zy, zz);
  zx /= zl; zy /= zl; zz /= zl;
  const xx = dy * zz - dz * zy, xy = dz * zx - dx * zz, xz = dx * zy - dy * zx;
  // columns: x, y, z
  ax = [xx, xy, xz];
  return [ax[0], dx, zx, ax[1], dy, zy, ax[2], dz, zz];
}

export function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function add(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function scale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s]; }
export function lerp3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function mulM3(m: M3, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// ---------- primitive distance functions ----------

export function sdEllipsoid(px: number, py: number, pz: number, rx: number, ry: number, rz: number): number {
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

/** iq's round cone between points a and b with radii r1, r2 */
export function makeRoundCone(a: V3, b: V3, r1: number, r2: number) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  return (px: number, py: number, pz: number) => {
    const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
    const y = pax * bax + pay * bay + paz * baz;
    const z = y - l2;
    const qx = pax * l2 - bax * y, qy = pay * l2 - bay * y, qz = paz * l2 - baz * y;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = y * y * l2;
    const z2 = z * z * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
  };
}

export interface PrimOpts {
  k?: number;
  sub?: boolean;
  bone: BoneSpec;
  tag: string;
  flow?: V3 | ((x: number, y: number, z: number) => V3);
  weigh?: boolean;
}

function finish(d: Prim['d'], min: V3, max: V3, o: PrimOpts): Prim {
  return {
    d,
    k: o.k ?? 0,
    sub: !!o.sub,
    min,
    max,
    bone: o.bone,
    tag: o.tag,
    flow: o.flow ?? [0, 0, -1],
    weigh: o.weigh ?? !o.sub,
  };
}

export function ellipsoid(c: V3, r: V3, o: PrimOpts, rot?: M3): Prim {
  const R = Math.max(r[0], r[1], r[2]);
  const min: V3 = [c[0] - R, c[1] - R, c[2] - R];
  const max: V3 = [c[0] + R, c[1] + R, c[2] + R];
  if (!rot) {
    return finish((x, y, z) => sdEllipsoid(x - c[0], y - c[1], z - c[2], r[0], r[1], r[2]), min, max, o);
  }
  // rot maps local -> world; inverse is transpose
  const m = rot;
  return finish((x, y, z) => {
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    const lx = m[0] * dx + m[3] * dy + m[6] * dz;
    const ly = m[1] * dx + m[4] * dy + m[7] * dz;
    const lz = m[2] * dx + m[5] * dy + m[8] * dz;
    return sdEllipsoid(lx, ly, lz, r[0], r[1], r[2]);
  }, min, max, o);
}

export function sphere(c: V3, r: number, o: PrimOpts): Prim {
  return finish((x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r,
    [c[0] - r, c[1] - r, c[2] - r], [c[0] + r, c[1] + r, c[2] + r], o);
}

export function roundCone(a: V3, b: V3, r1: number, r2: number, o: PrimOpts): Prim {
  const f = makeRoundCone(a, b, r1, r2);
  const R = Math.max(r1, r2);
  return finish(f,
    [Math.min(a[0], b[0]) - R, Math.min(a[1], b[1]) - R, Math.min(a[2], b[2]) - R],
    [Math.max(a[0], b[0]) + R, Math.max(a[1], b[1]) + R, Math.max(a[2], b[2]) + R], o);
}

/**
 * Round cone evaluated in a squashed space: `squash` scales the cross-section
 * along the given local axis (x or z of the cone frame). Handy for flattened
 * limbs, tails, ears.
 */
export function flatCone(a: V3, b: V3, r1: number, r2: number, sx: number, sz: number, o: PrimOpts, up?: V3): Prim {
  // local frame: y along a->b, x/z perpendicular; x aligned to `up`-orthogonal side
  const dir = norm(sub(b, a));
  let m = basisFromY(dir);
  if (up) {
    // build frame where local z is closest to `up`
    const u = norm(up);
    let zx = u[0] - dir[0] * (u[0] * dir[0] + u[1] * dir[1] + u[2] * dir[2]);
    let zy = u[1] - dir[1] * (u[0] * dir[0] + u[1] * dir[1] + u[2] * dir[2]);
    let zz = u[2] - dir[2] * (u[0] * dir[0] + u[1] * dir[1] + u[2] * dir[2]);
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;
    const xx = dir[1] * zz - dir[2] * zy, xy = dir[2] * zx - dir[0] * zz, xz = dir[0] * zy - dir[1] * zx;
    m = [xx, dir[0], zx, xy, dir[1], zy, xz, dir[2], zz];
  }
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const cone = makeRoundCone([0, 0, 0], [0, len, 0], r1, r2);
  const smin_ = Math.min(sx, sz, 1);
  const R = Math.max(r1, r2) * Math.max(sx, sz, 1);
  return finish((x, y, z) => {
    const dx = x - a[0], dy = y - a[1], dz = z - a[2];
    const lx = (m[0] * dx + m[3] * dy + m[6] * dz) / sx;
    const ly = m[1] * dx + m[4] * dy + m[7] * dz;
    const lz = (m[2] * dx + m[5] * dy + m[8] * dz) / sz;
    return cone(lx, ly, lz) * smin_;
  },
  [Math.min(a[0], b[0]) - R, Math.min(a[1], b[1]) - R, Math.min(a[2], b[2]) - R],
  [Math.max(a[0], b[0]) + R, Math.max(a[1], b[1]) + R, Math.max(a[2], b[2]) + R], o);
}

export function roundBox(c: V3, half: V3, radius: number, o: PrimOpts, rot?: M3): Prim {
  const R = Math.hypot(half[0], half[1], half[2]) + radius;
  const hx = half[0], hy = half[1], hz = half[2];
  const m = rot;
  return finish((x, y, z) => {
    let dx = x - c[0], dy = y - c[1], dz = z - c[2];
    if (m) {
      const lx = m[0] * dx + m[3] * dy + m[6] * dz;
      const ly = m[1] * dx + m[4] * dy + m[7] * dz;
      const lz = m[2] * dx + m[5] * dy + m[8] * dz;
      dx = lx; dy = ly; dz = lz;
    }
    const qx = Math.abs(dx) - hx, qy = Math.abs(dy) - hy, qz = Math.abs(dz) - hz;
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
    return Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0) - radius;
  }, [c[0] - R, c[1] - R, c[2] - R], [c[0] + R, c[1] + R, c[2] + R], o);
}

/** Generic custom primitive with explicit bounds. */
export function custom(d: Prim['d'], min: V3, max: V3, o: PrimOpts): Prim {
  return finish(d, min, max, o);
}

// ---------- field evaluation ----------

const BIG = 1e3;

export function evalField(prims: Prim[], x: number, y: number, z: number): number {
  let d = BIG;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const m = p.k + 0.002;
    if (x < p.min[0] - m || y < p.min[1] - m || z < p.min[2] - m ||
        x > p.max[0] + m || y > p.max[1] + m || z > p.max[2] + m) continue;
    const v = p.d(x, y, z);
    d = p.sub ? smax(d, -v, p.k) : smin(d, v, p.k);
  }
  return d;
}

export interface Grid {
  data: Float32Array;
  nx: number; ny: number; nz: number;
  ox: number; oy: number; oz: number;
  h: number;
}

/** Sample a field on a grid with per primitive bounding box culling. */
export function sampleGrid(prims: Prim[], h: number, pad = 3): Grid {
  let min: V3 = [Infinity, Infinity, Infinity];
  let max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    if (p.sub) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.min[i] - p.k);
      max[i] = Math.max(max[i], p.max[i] + p.k);
    }
  }
  min = [min[0] - pad * h, min[1] - pad * h, min[2] - pad * h];
  max = [max[0] + pad * h, max[1] + pad * h, max[2] + pad * h];
  const nx = Math.ceil((max[0] - min[0]) / h) + 1;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const data = new Float32Array(nx * ny * nz).fill(BIG);
  const ox = min[0], oy = min[1], oz = min[2];
  for (const p of prims) {
    const m = p.k + 2 * h;
    const i0 = Math.max(0, Math.floor((p.min[0] - m - ox) / h));
    const j0 = Math.max(0, Math.floor((p.min[1] - m - oy) / h));
    const k0 = Math.max(0, Math.floor((p.min[2] - m - oz) / h));
    const i1 = Math.min(nx - 1, Math.ceil((p.max[0] + m - ox) / h));
    const j1 = Math.min(ny - 1, Math.ceil((p.max[1] + m - oy) / h));
    const k1 = Math.min(nz - 1, Math.ceil((p.max[2] + m - oz) / h));
    for (let k = k0; k <= k1; k++) {
      const z = oz + k * h;
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * h;
        let idx = i0 + nx * (j + ny * k);
        for (let i = i0; i <= i1; i++, idx++) {
          const x = ox + i * h;
          const v = p.d(x, y, z);
          const d = data[idx];
          data[idx] = p.sub ? smax(d, -v, p.k) : smin(d, v, p.k);
        }
      }
    }
  }
  return { data, nx, ny, nz, ox, oy, oz, h };
}
