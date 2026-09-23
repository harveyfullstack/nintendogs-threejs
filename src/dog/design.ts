// Turns a breed description into a skeleton plus SDF sculpt primitives.
// Coordinate frame: dog faces +Z, +Y is up, +X is the dog's left side. Metres.

import type { Breed } from './breeds';
import {
  BoneSpec, Prim, V3, add, basisFromY, cross, custom, ellipsoid, evalField, flatCone, lerp3, mulM3, norm,
  rotXYZ, roundBox, roundCone, scale, sphere, sub,
} from './sdf';

export interface BoneDef {
  name: string;
  parent: string | null;
  pos: V3;
}

export interface ContactDef {
  bone: string;
  pos: V3;
  name: string;
}

export interface DogDims {
  H: number;
  BL: number;
  CD: number;
  g: number;
  hs: number;
  shZ: number;
  hipZ: number;
  atlas: V3;
  jawHinge: V3;
  noseTip: V3;
  pawR: number;
  eyeR: number;
  headTop: number;
  tailBase: V3;
  tailTip: V3;
  voxel: number;
  earSide: 'floppy' | 'erect';
  mouthZ: number;
  stopZ: number;
  muzzleW: number;
  muzzleL: number;
}

export interface DogDesign {
  bones: BoneDef[];
  body: Prim[];
  jaw: Prim[];
  ears: Prim[][];
  /** normal of each ear's flat face (for thinning fur at the rim) */
  earNormals: V3[];
  eyes: { pos: V3[]; dir: V3[]; r: number };
  tongue: { pos: V3; r: V3 };
  contacts: ContactDef[];
  dims: DogDims;
  furRegions: Record<string, number>;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const DEFAULT_FUR_REGIONS: Record<string, number> = {
  nose: 0, lip: 0.3, muzzle: 0.42, chin: 0.45, jaw: 0.45, brow: 0.55, skull: 0.65, cheek: 0.75,
  throat: 1.0, ear: 0.55, neck: 1.1, chest: 1.1, ribs: 1.0, back: 1.0, belly: 0.7, rump: 1.0,
  shoulder: 0.9, thigh: 1.0, legFup: 0.8, legF: 0.55, legHup: 0.95, legH: 0.6, paw: 0.4, tail: 1.1,
};

export function designDog(breed: Breed): DogDesign {
  const s = breed.shape;
  const { H, BL, CD, CW, HW } = s;
  const g = CD / 0.165;
  const hs = s.hs;
  const shZ = BL / 2;
  const hipZ = -BL / 2;
  const lf = s.pawR / 0.034;
  const lt = s.legT * lf;
  const pawR = s.pawR;
  const pawY = pawR * 0.52;

  const bones: BoneDef[] = [];
  const bone = (name: string, parent: string | null, pos: V3) => bones.push({ name, parent, pos });

  // ---------------- skeleton ----------------
  const bodyC: V3 = [0, H - CD * 0.45, 0];
  const pelvisC: V3 = [0, H * 0.84, hipZ + 0.03 * g];
  const chestC: V3 = [0, H - CD * 0.4, shZ - 0.07 * g];

  bone('root', null, [0, 0, 0]);
  bone('body', 'root', bodyC);
  bone('pelvis', 'body', pelvisC);
  bone('chest', 'body', chestC);

  const fx = CW * 0.33;
  const hx = HW * 0.34;
  const legs = (side: 1 | -1, sfx: string) => {
    const shoulderJ: V3 = [fx * side, H - CD * 0.42, shZ - 0.004 * g];
    const elbow: V3 = [fx * 1.03 * side, H - CD + 0.004 * g, shZ - 0.034 * g];
    const wrist: V3 = [fx * 0.98 * side, pawY + (elbow[1] - pawY) * 0.3, shZ - 0.017 * g];
    const fpaw: V3 = [fx * 0.98 * side, pawY, shZ - 0.006 * g];
    bone('upperarm' + sfx, 'chest', shoulderJ);
    bone('forearm' + sfx, 'upperarm' + sfx, elbow);
    bone('wrist' + sfx, 'forearm' + sfx, wrist);
    bone('fpaw' + sfx, 'wrist' + sfx, fpaw);

    const hipJ: V3 = [hx * side, H * 0.79, hipZ + 0.03 * g];
    const span = hipJ[1] - pawY;
    const knee: V3 = [hx * 1.08 * side, hipJ[1] - span * 0.4, hipZ + 0.072 * g];
    const hock: V3 = [hx * side, pawY + span * 0.27, hipZ - 0.016 * g];
    const hpaw: V3 = [hx * side, pawY, hipZ - 0.006 * g];
    bone('thigh' + sfx, 'pelvis', hipJ);
    bone('shin' + sfx, 'thigh' + sfx, knee);
    bone('meta' + sfx, 'shin' + sfx, hock);
    bone('hpaw' + sfx, 'meta' + sfx, hpaw);
    return { shoulderJ, elbow, wrist, fpaw, hipJ, knee, hock, hpaw };
  };
  const L = legs(1, '_L');
  const R = legs(-1, '_R');

  const neckBase: V3 = [0, H - CD * 0.18, shZ - 0.012 * g];
  const nk = s.neckL * Math.pow(g, 0.7);
  const A: V3 = add(neckBase, [0, 0.07 * nk, 0.058 * nk]);
  bone('neck', 'chest', neckBase);
  bone('head', 'neck', A);

  const hp = (x: number, y: number, z: number): V3 => [A[0] + x * hs, A[1] + y * hs, A[2] + z * hs];
  const [skW, skH, skL] = s.skull;
  const [mW, mH, mL] = s.muzzle;
  const drop = s.muzzleDrop;
  const stopZ = 0.028 + skL * 0.46;
  const jawHinge = hp(0, -0.014, 0.044);
  bone('jaw', 'head', jawHinge);

  const earBase = (side: 1 | -1): V3 => hp(s.ear.pos[0] * side, s.ear.pos[1], s.ear.pos[2]);
  bone('ear_L', 'head', earBase(1));
  bone('ear_R', 'head', earBase(-1));

  // tail chain
  const rumpR: V3 = [HW * 0.5, CD * 0.45, BL * 0.19];
  const rumpC: V3 = [0, H * 0.955 - rumpR[1], hipZ + 0.03 * g];
  const t = s.tail;
  const tailBase: V3 = [0, rumpC[1] + rumpR[1] * 0.42, rumpC[2] - rumpR[2] * 0.82];
  const NT = 5;
  const tailPts: V3[] = [tailBase];
  for (let i = 0; i < NT; i++) {
    const f = (i + 0.5) / NT;
    const ang = t.carry + t.curl * f;
    const d = norm([t.side * f * 1.2, Math.sin(ang), -Math.cos(ang)]);
    tailPts.push(add(tailPts[i], scale(d, t.L / NT)));
  }
  for (let i = 0; i < NT; i++) bone('tail' + i, i === 0 ? 'pelvis' : 'tail' + (i - 1), tailPts[i]);

  // ---------------- weighting helpers ----------------
  const spineW: BoneSpec = (_x, _y, z) => {
    const u = (z - hipZ) / (shZ - hipZ);
    const wp = 1 - smooth(0.05, 0.5, u);
    const wc = smooth(0.45, 0.92, u);
    return [['pelvis', wp], ['body', Math.max(0, 1 - wp - wc)], ['chest', wc]];
  };
  const neckDir = sub(A, neckBase);
  const neckLen2 = neckDir[0] ** 2 + neckDir[1] ** 2 + neckDir[2] ** 2;
  const neckW: BoneSpec = (x, y, z) => {
    const u = ((x - neckBase[0]) * neckDir[0] + (y - neckBase[1]) * neckDir[1] + (z - neckBase[2]) * neckDir[2]) / neckLen2;
    const wc = 1 - smooth(-0.1, 0.35, u);
    const wh = smooth(0.7, 1.05, u);
    return [['chest', wc], ['neck', Math.max(0, 1 - wc - wh)], ['head', wh]];
  };

  const flowBack: V3 = [0, -0.25, -1];
  const flowDown: V3 = [0, -1, -0.15];

  // ---------------- body sculpt ----------------
  const body: Prim[] = [];
  const P = (p: Prim) => body.push(p);
  const kb = 0.03 * g;

  P(ellipsoid([0, H - CD * 0.5, shZ - BL * 0.19], [CW * 0.5, CD * 0.5, BL * 0.3], { bone: spineW, tag: 'ribs', k: kb, flow: flowBack }));
  P(ellipsoid([0, H - CD * 0.56, shZ + 0.004 * g], [CW * 0.37, CD * 0.38, 0.05 * g], { bone: 'chest', tag: 'chest', k: kb, flow: flowDown }));
  const loinRy = CD * 0.37 * (1 - 0.3 * s.tuck);
  P(ellipsoid([0, H * 0.975 - loinRy, -BL * 0.1], [CW * 0.43, loinRy, BL * 0.25], { bone: spineW, tag: 'back', k: kb * 1.2, flow: flowBack }));
  const bellyRy = CD * 0.3 * s.belly * (1 - 0.35 * s.tuck);
  P(ellipsoid([0, H - CD * (0.62 + 0.06 * (1 - s.tuck)), -BL * 0.02], [CW * 0.4, bellyRy, BL * 0.24], { bone: spineW, tag: 'belly', k: kb * 1.3, flow: flowBack }));
  P(ellipsoid(rumpC, rumpR, { bone: 'pelvis', tag: 'rump', k: kb, flow: [0, -0.6, -1] }));

  for (const [side, sfx, J] of [[1, '_L', L], [-1, '_R', R]] as const) {
    // shoulder blade / upper arm muscle
    P(ellipsoid([CW * 0.34 * side, H - CD * 0.34, shZ - 0.03 * g], [CW * 0.16, CD * 0.42, 0.05 * g],
      { bone: [['chest', 0.65], ['upperarm' + sfx, 0.35]], tag: 'shoulder', k: kb, flow: flowDown }, rotXYZ(-0.4, 0, 0)));
    // front leg
    P(roundCone(J.shoulderJ, J.elbow, 0.036 * g, 0.027 * lt, { bone: 'upperarm' + sfx, tag: 'legFup', k: 0.022 * g, flow: flowDown }));
    P(sphere(add(J.elbow, [0, 0.002, -0.007 * lf]), 0.02 * lt, { bone: 'forearm' + sfx, tag: 'legF', k: 0.012 * lt, flow: flowDown }));
    P(roundCone(J.elbow, J.wrist, 0.025 * lt, 0.0185 * lt, { bone: 'forearm' + sfx, tag: 'legF', k: 0.012 * lt, flow: flowDown }));
    P(roundCone(J.wrist, J.fpaw, 0.019 * lt, 0.0195 * lt, { bone: 'wrist' + sfx, tag: 'legF', k: 0.01 * lt, flow: flowDown }));
    paw(J.fpaw, 'fpaw' + sfx, side, 1);

    // hind leg
    const tdir = norm(sub(J.knee, J.hipJ));
    const tl = Math.hypot(...sub(J.knee, J.hipJ));
    P(ellipsoid(add(lerp3(J.hipJ, J.knee, 0.36), [HW * 0.04 * side, 0, 0.004 * g]), [HW * 0.17, tl * 0.62, 0.052 * g],
      { bone: 'thigh' + sfx, tag: 'thigh', k: kb, flow: flowDown }, basisFromY(tdir)));
    P(roundCone(J.hipJ, J.knee, 0.04 * g, 0.029 * lt, { bone: 'thigh' + sfx, tag: 'legHup', k: 0.02 * g, flow: flowDown }));
    P(roundCone(J.knee, J.hock, 0.027 * lt, 0.0165 * lt, { bone: 'shin' + sfx, tag: 'legH', k: 0.012 * lt, flow: flowDown }));
    P(sphere(add(J.hock, [0, 0.004 * lf, -0.01 * lf]), 0.0135 * lt, { bone: 'meta' + sfx, tag: 'legH', k: 0.008 * lt, flow: flowDown }));
    P(roundCone(J.hock, J.hpaw, 0.0165 * lt, 0.019 * lt, { bone: 'meta' + sfx, tag: 'legH', k: 0.01 * lt, flow: flowDown }));
    paw(J.hpaw, 'hpaw' + sfx, side, 0.95);
  }

  function paw(c: V3, b: string, side: number, sz: number) {
    const r = pawR * sz;
    P(ellipsoid(add(c, [0, 0, r * 0.3]), [r * 0.78, r * 0.52, r * 0.95], { bone: b, tag: 'paw', k: 0.012 * lf, flow: [0, -0.3, 1] }));
    for (const a of [-1.5, -0.5, 0.5, 1.5]) {
      const ang = a * 0.34;
      const tc: V3 = add(c, [Math.sin(ang) * r * 0.6 * side, -r * 0.2 + (Math.abs(a) < 1 ? 0.002 : 0), r * 0.32 + Math.cos(ang) * r * (Math.abs(a) < 1 ? 0.62 : 0.52)]);
      P(sphere(tc, r * 0.31, { bone: b, tag: 'paw', k: 0.008 * lf, flow: [0, -0.3, 1] }));
    }
  }

  // neck + throat
  P(roundCone(neckBase, hp(0, -0.012, -0.004), 0.066 * g * s.neckT, 0.047 * hs * s.neckT,
    { bone: neckW, tag: 'neck', k: 0.03 * g, flow: (x, y, z) => norm([0, -0.5, -1]) }));
  P(ellipsoid(add(lerp3(neckBase, A, 0.62), [0, -0.028 * hs, 0.018 * hs]), [0.04 * hs * s.neckT, 0.04 * hs, 0.04 * hs],
    { bone: neckW, tag: 'throat', k: 0.03 * g, flow: [0, -1, -0.4] }));

  // head
  const kh = 0.018 * hs;
  const headFlow = (): V3 => norm([0, -0.15, -1]);
  P(ellipsoid(hp(0, 0.026, 0.028), [skW / 2 * hs, skH / 2 * hs, skL / 2 * hs], { bone: 'head', tag: 'skull', k: kh, flow: headFlow }));
  P(ellipsoid(hp(0, 0.032, stopZ - 0.018), [skW * 0.3 * hs, 0.024 * hs, 0.026 * hs], { bone: 'head', tag: 'skull', k: kh, flow: headFlow }));
  for (const side of [1, -1]) {
    P(ellipsoid(hp(0.02 * side, s.eyeY + 0.011, stopZ - 0.006), [0.016 * hs, 0.011 * hs * s.stop, 0.014 * hs * s.stop], { bone: 'head', tag: 'brow', k: kh * 0.8, flow: s.beard ? [0, 0.3, 1] : headFlow }));
    P(ellipsoid(hp(0.031 * side * (skW / 0.104), -0.004, stopZ - 0.018), [0.022 * hs * s.cheek, 0.025 * hs, 0.029 * hs], { bone: 'head', tag: 'cheek', k: kh, flow: [0, -0.3, -1] }));
  }
  // muzzle: rounded box from the stop to the nose, sloping slightly down
  const mY = 0.006 - drop;
  const rr = Math.min(mW, mH) * 0.42 * hs;
  const mC = hp(0, mY, stopZ + mL * 0.5 - 0.004);
  P(roundBox(mC, [Math.max(0.001, mW * 0.5 * hs - rr), Math.max(0.001, mH * 0.5 * hs - rr), Math.max(0.001, mL * 0.5 * hs - rr * 0.5)], rr,
    { bone: 'head', tag: 'muzzle', k: 0.02 * hs, flow: s.beard ? [0, -0.6, 0.6] : [0, 0.1, -1] }, rotXYZ(0.06, 0, 0)));
  for (const side of [1, -1]) {
    P(ellipsoid(hp(mW * 0.28 * side, mY - mH * 0.4, stopZ + mL * 0.5), [0.0105 * hs * (mW / 0.056) * s.flews, 0.012 * hs * s.flews, mL * 0.48 * hs],
      { bone: 'head', tag: 'lip', k: 0.012 * hs, flow: s.beard ? [0, -0.9, 0.35] : [0, -0.4, -1] }));
  }
  const muzzleFront = mC[2] + mL * 0.5 * hs + rr * 0.5;
  const noseC: V3 = [0, mC[1] + mH * 0.22 * hs - (muzzleFront - mC[2]) * 0.06, muzzleFront - 0.0105 * hs * s.nose * 0.3];
  const nr: V3 = [0.0155 * hs * s.nose, 0.0112 * hs * s.nose, 0.0105 * hs * s.nose];
  P(ellipsoid(noseC, nr, { bone: 'head', tag: 'nose', k: 0.007 * hs, flow: [0, 0, -1] }));
  for (const side of [1, -1]) {
    P(ellipsoid(add(noseC, [nr[0] * 0.42 * side, -nr[1] * 0.1, nr[2] * 0.82]), [nr[0] * 0.24, nr[1] * 0.27, nr[2] * 0.42],
      { bone: 'head', tag: 'nose', k: 0.002 * hs, sub: true }, rotXYZ(0, 0.5 * side, -0.4 * side)));
  }
  P(roundCone(add(noseC, [0, -nr[1] * 0.3, nr[2] * 0.85]), add(noseC, [0, -nr[1] * 2.2, nr[2] * 0.1]), 0.0014 * hs, 0.0011 * hs,
    { bone: 'head', tag: 'nose', k: 0.0025 * hs, sub: true }));

  // eyes: find the skin surface along the gaze and sink the eyeball into it
  const eyePos: V3[] = [];
  const eyeDir: V3[] = [];
  const headOnly = body.slice();
  for (const side of [1, -1]) {
    const dir = norm([Math.sin(s.eyeOut) * side, 0.06, Math.cos(s.eyeOut)]);
    let q = hp(s.eyeX * side, s.eyeY, s.eyeZ);
    for (let i = 0; i < 12; i++) {
      const f = evalField(headOnly, q[0], q[1], q[2]);
      q = add(q, scale(dir, -f));
    }
    const e = add(q, scale(dir, -s.eyeR * (s.eyeSink ?? 0.72)));
    eyePos.push(e);
    eyeDir.push(dir);
    P(sphere(e, s.eyeR * 1.07, { bone: 'head', tag: 'eye', k: 0.005 * hs, sub: true }));
  }

  // tail: a smooth tube through the tail joints (Catmull-Rom, subdivided) so it
  // doesn't look like a string of beads where the segments meet
  const taper = t.type === 'otter' ? 0.55 : t.type === 'whip' || t.type === 'saber' ? 0.72 : t.type === 'bob' ? 0.2 : 0.5;
  const SUB = 3;
  const cr = (i: number, u: number): V3 => {
    const p0 = tailPts[Math.max(0, i - 1)], p1 = tailPts[i], p2 = tailPts[i + 1], p3 = tailPts[Math.min(NT, i + 2)];
    const u2 = u * u, u3 = u2 * u;
    const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
  };
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < SUB; j++) {
      const u0 = j / SUB, u1 = (j + 1) / SUB;
      const f0 = (i + u0) / NT, f1 = (i + u1) / NT;
      const r0 = t.T * (1 - taper * f0), r1 = t.T * (1 - taper * f1);
      const a = cr(i, u0), b = cr(i, u1);
      const dir = norm(sub(b, a));
      const first = i === 0 && j === 0;
      P(roundCone(a, b, r0, r1, { bone: 'tail' + i, tag: 'tail', k: first ? 0.025 * g : Math.min(0.004, r1 * 0.3), flow: dir }));
    }
  }

  // ---------------- jaw (separate shell) ----------------
  const jaw: Prim[] = [];
  const mwS = mW / 0.056;
  // short-muzzled breeds get a smaller jaw tucked under the muzzle
  const jf = Math.min(1, Math.max(0.55, mL / 0.05));
  jaw.push(flatCone(hp(0, -0.02 * jf, 0.05), hp(0, -0.0205 * jf - drop, stopZ + mL * 0.72), 0.017 * hs * mwS * jf, 0.012 * hs * mwS * jf, 1, 0.7,
    { bone: 'jaw', tag: 'jaw', k: 0.01 * hs, flow: s.beard ? [0, -1, 0.3] : [0, -0.2, -1] }, [0, 1, 0]));
  jaw.push(ellipsoid(hp(0, -0.0255 * jf - drop, stopZ + mL * 0.56), [0.0135 * hs * mwS * jf, 0.0085 * hs * jf, 0.015 * hs * jf],
    { bone: 'jaw', tag: 'chin', k: 0.01 * hs, flow: s.beard ? [0, -1, 0.3] : [0, -0.3, -1] }));

  // ---------------- ears ----------------
  const ears: Prim[][] = [];
  const earNormals: V3[] = [];
  const e = s.ear;
  for (const side of [1, -1] as const) {
    const b = earBase(side);
    const eb = side > 0 ? 'ear_L' : 'ear_R';
    const list: Prim[] = [];
    const EL = e.L * hs, EW = e.W * hs, ET = e.T * hs;
    if (e.type === 'button') {
      // folded ear: a short upright base, then the leather folds forward and down over it
      const Rb = rotXYZ(0, 0, -e.splay * side * 0.6);
      const up = mulM3(Rb, [0, 1, 0]);
      const out = mulM3(Rb, [side, 0, 0]);
      const baseTop = add(b, scale(up, EL * 0.26));
      // the flap folds over and lies along the side of the skull, tip towards the eye
      const flapDir = norm([side * 0.6, -0.72, 0.5]);
      // orthonormal frame for the flap plate: width along `out`, length along flapDir
      const flapN = norm(cross(out, flapDir));
      const flapX = cross(flapDir, flapN);
      earNormals.push(flapN);
      const frame = (x: V3, y: V3, z: V3) => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
      // upright base plate, buried a little in the skull
      list.push(ellipsoid(add(b, scale(up, EL * 0.1)), [EW * 0.46, EL * 0.2, ET * 0.75],
        { bone: eb, tag: 'ear', k: 0.004 * hs, flow: up }, frame(out, up, cross(out, up))));
      // folded flap hanging forward over it
      list.push(ellipsoid(add(baseTop, scale(flapDir, EL * 0.3)), [EW * 0.48, EL * 0.36, ET * 0.5],
        { bone: eb, tag: 'ear', k: 0.005 * hs, flow: flapDir }, frame(flapX, flapDir, flapN)));
      // the rounded crease of the fold
      list.push(roundCone(add(baseTop, scale(out, -EW * 0.34)), add(baseTop, scale(out, EW * 0.34)), ET * 0.8, ET * 0.8,
        { bone: eb, tag: 'ear', k: 0.005 * hs, flow: flapDir }));
    } else if (e.type === 'floppy' || e.type === 'rose') {
      const Rm = rotXYZ(e.lean, 0, e.splay * side);
      const top = add(b, mulM3(Rm, [0.004 * side * hs, -EL * 0.18, EW * 0.08]));
      const bot = add(b, mulM3(Rm, [0.006 * side * hs, -EL * 0.86, EW * 0.14]));
      const earOut = mulM3(Rm, [side, 0, 0]);
      earNormals.push(earOut);
      list.push(flatCone(top, bot, EW * 0.5, EW * 0.2, 1, ET / EW, { bone: eb, tag: 'ear', k: 0.004 * hs, flow: mulM3(Rm, [0, -1, 0]) }, earOut));
      list.push(ellipsoid(add(b, mulM3(Rm, [0.002 * side * hs, -0.006 * hs, EW * 0.06])), [ET * 1.1, 0.012 * hs, EW * 0.4],
        { bone: eb, tag: 'ear', k: 0.006 * hs, flow: mulM3(Rm, [0, -1, 0]) }, Rm));
    } else {
      // erect ears: flattened cone with a hollow cup facing forward
      const Rm = rotXYZ(e.lean, 0, -e.splay * side);
      const up = mulM3(Rm, [0, 1, 0]);
      const fwd = mulM3(Rm, [0, 0, 1]);
      earNormals.push(fwd);
      const tip = add(b, scale(up, EL));
      const depth = ET * 2.6 / EW;
      list.push(flatCone(b, tip, EW / 2, EW * 0.045, 1, depth * 1.6, { bone: eb, tag: 'ear', k: 0.003 * hs, flow: up }, fwd));
      list.push(flatCone(add(add(b, scale(fwd, ET * 1.2)), scale(up, EL * 0.1)), add(add(tip, scale(up, -EL * 0.14)), scale(fwd, ET * 0.35)),
        EW * 0.39, EW * 0.02, 1, depth * 1.3, { bone: eb, tag: 'ear', k: 0.003 * hs, sub: true }, fwd));
      // fill into the skull so the base is buried
      list.push(ellipsoid(add(b, scale(up, -0.004 * hs)), [EW * 0.42, 0.012 * hs, ET * 1.6], { bone: eb, tag: 'ear', k: 0.004 * hs, flow: up }, Rm));
    }
    ears.push(list);
  }

  // ---------------- contacts for the ground solver ----------------
  const contacts: ContactDef[] = [];
  const C = (name: string, b: string, p: V3) => contacts.push({ bone: b, pos: p, name });
  for (const [sfx, J] of [['_L', L], ['_R', R]] as const) {
    C('fpaw', 'fpaw' + sfx, [J.fpaw[0], 0, J.fpaw[2] + pawR * 0.25]);
    C('fpaw', 'fpaw' + sfx, [J.fpaw[0], 0.004, J.fpaw[2] + pawR * 1.05]);
    C('fpaw', 'fpaw' + sfx, [J.fpaw[0], 0.004, J.fpaw[2] - pawR * 0.5]);
    C('hpaw', 'hpaw' + sfx, [J.hpaw[0], 0, J.hpaw[2] + pawR * 0.25]);
    C('hpaw', 'hpaw' + sfx, [J.hpaw[0], 0.004, J.hpaw[2] + pawR * 1.0]);
    C('hock', 'meta' + sfx, [J.hock[0], J.hock[1] - 0.004, J.hock[2] - 0.014 * lf]);
    C('hock', 'meta' + sfx, [J.hock[0], (J.hock[1] + J.hpaw[1]) / 2, J.hock[2] - 0.011 * lf]);
    C('elbow', 'forearm' + sfx, [J.elbow[0], J.elbow[1] - 0.012 * lf, J.elbow[2] - 0.006]);
    C('wrist', 'wrist' + sfx, [J.wrist[0], J.wrist[1], J.wrist[2] - 0.012 * lf]);
    C('wrist', 'fpaw' + sfx, [J.fpaw[0], J.fpaw[1], J.fpaw[2] - pawR * 0.6]);
    C('knee', 'shin' + sfx, [J.knee[0], J.knee[1] - 0.01, J.knee[2] + 0.018 * lf]);
    C('knee', 'thigh' + sfx, [J.knee[0] * 1.3, J.knee[1] + 0.02 * g, J.knee[2]]);
  }
  C('sternum', 'chest', [0, H - CD - 0.004, shZ - 0.05 * g]);
  C('sternum', 'chest', [0, H - CD * 0.6, shZ + 0.05 * g]);
  C('belly', 'body', [0, H - CD * 0.98, -BL * 0.02]);
  C('butt', 'pelvis', [0, H * 0.6, hipZ - 0.02 * g]);
  C('butt', 'pelvis', [0, H * 0.72, hipZ - 0.05 * g]);
  for (const side of [1, -1]) {
    C('hip', 'pelvis', [HW * 0.5 * side, H * 0.78, hipZ + 0.03 * g]);
    C('butt', 'pelvis', [HW * 0.36 * side, H * 0.63, hipZ - 0.0 * g]);
    C('ribs', 'chest', [CW * 0.5 * side, H - CD * 0.5, shZ - 0.08 * g]);
    C('ribs', 'body', [CW * 0.46 * side, H - CD * 0.45, -BL * 0.05]);
    C('head', 'head', hp(0.052 * side, 0.02, 0.03));
  }
  C('back', 'body', [0, H, 0]);
  C('back', 'chest', [0, H, shZ - 0.06 * g]);
  C('back', 'pelvis', [0, H * 0.96, hipZ + 0.02]);
  C('chin', 'head', hp(0, -0.04, 0.06));
  C('head', 'head', hp(0, 0.075, 0.03));
  C('chin', 'jaw', hp(0, -0.032 - drop, stopZ + mL * 0.56));
  C('neck', 'neck', add(lerp3(neckBase, A, 0.5), [0, 0.045 * g, -0.01]));

  const tailTip = tailPts[NT];
  const headTop = A[1] + (0.028 + skH / 2) * hs;
  const voxel = Math.max(0.0022, 0.0042 * Math.pow(Math.max(g, hs * 0.8), 0.8));

  const furRegions: Record<string, number> = { ...DEFAULT_FUR_REGIONS };
  for (const [k, v] of Object.entries(breed.fur.regions)) if (v !== undefined) furRegions[k] = v;

  return {
    bones,
    body,
    jaw,
    ears,
    earNormals,
    eyes: { pos: eyePos, dir: eyeDir, r: s.eyeR },
    tongue: { pos: hp(0, -0.0155 - drop, stopZ + mL * 0.34), r: [0.0145 * hs * mwS, 0.0042 * hs, mL * 0.55 * hs] },
    contacts,
    dims: {
      H, BL, CD, g, hs, shZ, hipZ, atlas: A, jawHinge, noseTip: add(noseC, [0, 0, nr[2]]), pawR,
      eyeR: s.eyeR, headTop, tailBase, tailTip, voxel,
      earSide: e.type === 'floppy' || e.type === 'rose' || e.type === 'button' ? 'floppy' : 'erect',
      mouthZ: stopZ + mL * 0.3, stopZ, muzzleW: mW, muzzleL: mL,
    },
    furRegions,
  };
}

export { custom };
