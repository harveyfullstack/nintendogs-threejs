import * as THREE from 'three';
import type { DogModel } from './dogModel';

// Procedural animation for a DogModel.
//
// Poses are authored with leg segments as sagittal directions (0 = straight
// down, +PI/2 = pointing backwards) so they transfer between breeds with very
// different leg proportions. Spine bones use local rotations, neck and head use
// root-relative pitch. A contact based ground solver keeps the dog on the floor.

type LegPose = [number, number, number, number]; // upper, lower, pastern/meta directions + paw pitch

export interface PoseDef {
  body?: [number, number, number];
  pelvis?: [number, number, number];
  chest?: [number, number, number];
  neck?: number; // absolute pitch rotation
  neckYaw?: number;
  head?: [number, number, number]; // absolute pitch, yaw, roll
  jaw?: number;
  tail?: [number, number]; // tail base pitch (positive = raise), tail curl delta
  fl?: LegPose; fr?: LegPose; hl?: LegPose; hr?: LegPose;
  /** leg roll (splay outwards) in radians for front and hind */
  splay?: [number, number];
  /** solve body pitch so that contact groups A and B touch the floor together */
  solve?: [string[], string[]];
  ears?: number; // -1 flattened back, 0 neutral, 1 perked
}

const LEGS = {
  fl: ['upperarm_L', 'forearm_L', 'wrist_L', 'fpaw_L'],
  fr: ['upperarm_R', 'forearm_R', 'wrist_R', 'fpaw_R'],
  hl: ['thigh_L', 'shin_L', 'meta_L', 'hpaw_L'],
  hr: ['thigh_R', 'shin_R', 'meta_R', 'hpaw_R'],
} as const;
type LegKey = keyof typeof LEGS;

const SIT_FRONT: LegPose = [0.12, -0.04, -0.2, 0];
const SIT_HIND: LegPose = [-1.45, 0.55, -1.52, 0];

export const POSES: Record<string, PoseDef> = {
  stand: {},
  sit: {
    pelvis: [-0.45, 0, 0], chest: [0.08, 0, 0], neck: -0.45, head: [0.05, 0, 0], tail: [-0.6, 0],
    fl: SIT_FRONT, fr: SIT_FRONT, hl: SIT_HIND, hr: SIT_HIND, splay: [0, 0.18],
    solve: [['fpaw'], ['butt', 'hock']],
  },
  lie: {
    pelvis: [-0.05, 0, 0], neck: -0.2, head: [0.12, 0, 0], tail: [-0.2, 0],
    fl: [0.95, -1.52, -1.56, 0.05], fr: [0.95, -1.52, -1.56, 0.05],
    hl: [-1.25, 1.45, -1.52, 0.05], hr: [-1.25, 1.45, -1.52, 0.05], splay: [0.05, 0.32],
    solve: [['elbow', 'wrist'], ['hock', 'knee', 'belly']],
  },
  sleep: {
    body: [0, 0, 1.35], pelvis: [0.1, 0.15, 0], chest: [0, -0.2, 0], neck: 0.25, neckYaw: -0.35, head: [0.35, -0.4, 0.5], tail: [-0.3, 0.6],
    fl: [-0.35, 0.3, 0.4, 0.4], fr: [-0.2, 0.5, 0.5, 0.5], hl: [-0.9, 1.1, 0.2, 0.3], hr: [-0.7, 1.2, 0.3, 0.3],
    ears: -0.3,
  },
  playdead: {
    body: [0, 0, 1.52], neck: 0.05, head: [0.1, 0, 0.15], tail: [-0.2, 0],
    fl: [-0.45, -0.1, -0.1, 0], fr: [-0.35, -0.05, -0.1, 0], hl: [-0.1, 0.3, -0.2, 0], hr: [0.05, 0.35, -0.2, 0],
  },
  belly: {
    body: [0, 0, Math.PI], pelvis: [0, 0, 0.12], neck: 0.2, head: [0.3, 0.35, -0.4], tail: [0.2, 0],
    fl: [-0.5, 0.9, 1.3, 1.0], fr: [-0.4, 1.0, 1.4, 1.0], hl: [-1.0, 1.1, -0.2, 0.2], hr: [-0.9, 1.2, -0.1, 0.2],
    splay: [0.25, 0.55], ears: -0.2,
  },
  beg: {
    body: [-1.2, 0, 0], pelvis: [-0.25, 0, 0], chest: [0.12, 0, 0], neck: -0.95, head: [-0.05, 0, 0], tail: [-0.5, 0],
    fl: [-1.25, 0.1, 0.95, 0.9], fr: [-1.25, 0.1, 0.95, 0.9], hl: SIT_HIND, hr: SIT_HIND, splay: [0.05, 0.2],
  },
  shake: {
    pelvis: [-0.45, 0, 0], chest: [0.08, 0, 0], neck: -0.45, head: [0.1, 0.1, 0.12], tail: [-0.6, 0],
    fl: [-1.25, -1.1, -0.9, -0.3], fr: SIT_FRONT, hl: SIT_HIND, hr: SIT_HIND, splay: [0, 0.18],
    solve: [['fpaw'], ['butt', 'hock']],
  },
  bow: {
    pelvis: [0.12, 0, 0], chest: [-0.05, 0, 0], neck: -0.55, head: [0.1, 0, 0], tail: [0.8, 0], ears: 0.5,
    fl: [0.85, -1.5, -1.56, 0.05], fr: [0.85, -1.5, -1.56, 0.05],
    solve: [['elbow', 'wrist'], ['hpaw']],
  },
  standUp: {
    body: [-1.35, 0, 0], pelvis: [-0.1, 0, 0], neck: -1.0, head: [-0.1, 0, 0], tail: [0.2, 0],
    fl: [-1.1, 0.3, 0.8, 0.7], fr: [-1.0, 0.4, 0.9, 0.7], hl: [-0.35, 0.45, -0.05, 0], hr: [-0.35, 0.45, -0.05, 0],
  },
  jump: {
    body: [-0.25, 0, 0], neck: -0.3, head: [0.1, 0, 0], tail: [0.4, 0],
    fl: [-0.9, 0.6, 0.9, 0.6], fr: [-0.9, 0.6, 0.9, 0.6], hl: [0.4, 1.2, 0.2, 0.3], hr: [0.4, 1.2, 0.2, 0.3],
  },
  eat: {
    chest: [0.12, 0, 0], neck: 1.0, head: [0.95, 0, 0], tail: [0.1, 0],
    fl: [0.05, -0.05, -0.1, 0], fr: [0.05, -0.05, -0.1, 0],
  },
  sniff: {
    chest: [0.08, 0, 0], neck: 0.85, head: [0.75, 0, 0], tail: [0.15, 0],
  },
  howl: {
    pelvis: [-0.45, 0, 0], chest: [0.08, 0, 0], neck: -1.05, head: [-0.95, 0, 0], jaw: 0.35, tail: [-0.6, 0],
    fl: SIT_FRONT, fr: SIT_FRONT, hl: SIT_HIND, hr: SIT_HIND, splay: [0, 0.18],
    solve: [['fpaw'], ['butt', 'hock']],
  },
  scratch: {
    pelvis: [-0.45, 0, 0], chest: [0.08, 0, 0], neck: -0.3, head: [0.3, 0.2, 0.5], tail: [-0.6, 0],
    fl: SIT_FRONT, fr: SIT_FRONT, hl: [-1.55, 1.2, -0.3, 0.4], hr: SIT_HIND, splay: [0, 0.18],
    solve: [['fpaw'], ['butt', 'hock']],
  },
  shakeOff: {
    neck: -0.1, head: [0.1, 0, 0], tail: [0.1, 0], splay: [0.12, 0.12],
    fl: [0.05, 0, -0.05, 0], fr: [0.05, 0, -0.05, 0], hl: [-0.1, 0, 0, 0], hr: [-0.1, 0, 0, 0],
  },
};

const BONE_ORDER_EXTRA = ['root'];

export type Gait = 'walk' | 'trot' | 'gallop';

const GAIT: Record<Gait, { freq: number; duty: number; phase: Record<LegKey, number> }> = {
  walk: { freq: 1.9, duty: 0.62, phase: { hl: 0, fl: 0.25, hr: 0.5, fr: 0.75 } },
  trot: { freq: 2.6, duty: 0.5, phase: { fl: 0, hr: 0.02, fr: 0.5, hl: 0.52 } },
  gallop: { freq: 3.3, duty: 0.38, phase: { hl: 0, hr: 0.1, fl: 0.48, fr: 0.58 } },
};

export interface LookTarget {
  /** world space point to look at, or null to look straight */
  point: THREE.Vector3 | null;
  weight: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const GAITS: Gait[] = ['walk', 'trot', 'gallop'];
const LEG_KEYS = Object.keys(LEGS) as LegKey[];
const _locals = new Float64Array(4);
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

function smoothTo(cur: number, target: number, rate: number, dt: number) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

export class DogRig {
  readonly names: string[];
  readonly index: Record<string, number> = {};
  /** local euler angles per bone */
  readonly cur: Float32Array;
  readonly target: Float32Array;
  private readonly out: Float32Array;
  readonly compiled: Record<string, Float32Array> = {};
  private readonly restDir: Record<string, number> = {};

  pose = 'stand';
  poseRate = 7;

  // locomotion
  speed = 0; // m/s actual
  private phase = 0;
  gait: Gait = 'walk';
  private gaitBlend = { walk: 1, trot: 0, gallop: 0 };
  turnRate = 0; // rad/s, for spine bend
  private bendSmooth = 0;
  moveWeight = 0;

  // expression / procedural layers
  wagAmp = 0.3; // rad
  wagFreq = 3;
  private wagPhase = 0;
  tailRaise = 0;
  happy = 0; // 0..1 squint
  mouthOpen = 0; // 0..1 target
  private jawCur = 0;
  /** jaw opening while carrying something (overrides panting and barking) */
  jawHold = 0;
  panting = 0; // 0..1
  private pantPhase = 0;
  tongueOut = 0; // 0..1 target
  private tongueCur = 0;
  eyesClosed = 0; // 0..1 target
  private lidCur = 0;
  private blinkT = 2;
  private blinkAmt = 0;
  earPerk = 0; // -1 back, 1 forward
  headTilt = 0; // cute tilt (roll)
  private headTiltCur = 0;
  look: LookTarget = { point: null, weight: 0 };
  private lookYaw = 0;
  private lookPitch = 0;
  private eyeYaw = 0;
  private eyePitch = 0;
  // extra overlay angles for actions (bark, shake off, roll...)
  overlay: Record<string, [number, number, number]> = {};
  rootLift = 0; // metres above the ground solution (jumps)
  rootRoll = 0; // extra roll around the body axis for roll-over
  breathe = 0;
  groundSnap = true;
  private groundY = 0;
  private earVel = [0, 0];
  private earAng = [0, 0];
  private prevHeadQ = new THREE.Quaternion();
  private headAngVel = new THREE.Vector3();
  time = 0;

  constructor(readonly model: DogModel) {
    this.names = model.design.bones.map((b) => b.name);
    this.names.forEach((n, i) => (this.index[n] = i));
    const n = this.names.length * 3;
    this.cur = new Float32Array(n);
    this.target = new Float32Array(n);
    this.out = new Float32Array(n);
    // sagittal rest directions of leg segments
    for (const leg of Object.values(LEGS)) {
      for (let i = 0; i < 3; i++) {
        const a = model.boneWorldRest(leg[i]);
        const b = model.boneWorldRest(leg[i + 1]);
        this.restDir[leg[i]] = Math.atan2(-(b.z - a.z), -(b.y - a.y));
      }
    }
    for (const name of Object.keys(POSES)) this.compiled[name] = this.compile(POSES[name]);
    this.target.set(this.compiled.stand);
    this.cur.set(this.compiled.stand);
    this.prevHeadQ.copy(model.bones.head.quaternion);
  }

  private set(arr: Float32Array, bone: string, x: number, y = 0, z = 0) {
    const i = this.index[bone] * 3;
    arr[i] = x; arr[i + 1] = y; arr[i + 2] = z;
  }
  private get(arr: Float32Array, bone: string, axis = 0) {
    return arr[this.index[bone] * 3 + axis];
  }

  /** Convert a pose definition into local euler angles for this dog. */
  compile(def: PoseDef, bodyPitch?: number): Float32Array {
    const arr = new Float32Array(this.names.length * 3);
    const body = def.body || [0, 0, 0];
    const bx = bodyPitch ?? body[0];
    this.set(arr, 'body', bx, body[1], body[2]);
    const pel = def.pelvis || [0, 0, 0];
    const ch = def.chest || [0, 0, 0];
    this.set(arr, 'pelvis', pel[0], pel[1], pel[2]);
    this.set(arr, 'chest', ch[0], ch[1], ch[2]);
    const frontBase = bx + ch[0];
    const hindBase = bx + pel[0];
    const neckAbs = def.neck ?? 0;
    this.set(arr, 'neck', neckAbs - frontBase, def.neckYaw ?? 0, 0);
    const head = def.head || [0, 0, 0];
    this.set(arr, 'head', head[0] - neckAbs, head[1], head[2]);
    this.set(arr, 'jaw', def.jaw ?? 0);
    const tail = def.tail || [0, 0];
    this.set(arr, 'tail0', -tail[0]);
    for (let i = 1; i < 5; i++) this.set(arr, 'tail' + i, -tail[1] / 4);
    const splay = def.splay || [0, 0];
    for (const key of Object.keys(LEGS) as LegKey[]) {
      const bones = LEGS[key];
      const pose = def[key];
      const side = key.endsWith('l') ? 1 : -1;
      const base = key[0] === 'f' ? frontBase : hindBase;
      const sp = (key[0] === 'f' ? splay[0] : splay[1]) * side;
      if (!pose) {
        // keep rest direction relative to the root
        let parentAbs = base;
        for (let i = 0; i < 4; i++) {
          const abs = 0;
          this.set(arr, bones[i], abs - parentAbs, 0, i === 0 ? -sp : i === 1 ? sp * 0.6 : 0);
          parentAbs = abs;
        }
        continue;
      }
      let parentAbs = base;
      for (let i = 0; i < 3; i++) {
        const abs = pose[i] - this.restDir[bones[i]];
        this.set(arr, bones[i], abs - parentAbs, 0, i === 0 ? -sp : i === 1 ? sp * 0.6 : 0);
        parentAbs = abs;
      }
      this.set(arr, bones[3], pose[3] - parentAbs);
    }
    // ears
    this.set(arr, 'ear_L', 0, 0, 0);
    this.set(arr, 'ear_R', 0, 0, 0);
    return arr;
  }

  /** Solve the body pitch for poses that must rest on two contact groups. */
  solvePoses() {
    for (const [name, def] of Object.entries(POSES)) {
      if (!def.solve) continue;
      let lo = -1.5, hi = 0.9;
      const f = (bx: number) => {
        const arr = this.compile(def, bx);
        this.applyAngles(arr);
        this.model.bones.root.position.set(0, 0, 0);
        this.model.bones.root.quaternion.identity();
        const a = this.model.lowestContact(def.solve![0]);
        const b = this.model.lowestContact(def.solve![1]);
        return a - b;
      };
      // f increases when the front rises (negative pitch lifts the front)
      const flo = f(lo), fhi = f(hi);
      if (Math.sign(flo) === Math.sign(fhi)) {
        this.compiled[name] = this.compile(def, Math.abs(flo) < Math.abs(fhi) ? lo : hi);
        continue;
      }
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (Math.sign(fm) === Math.sign(flo)) lo = mid; else hi = mid;
      }
      this.compiled[name] = this.compile(def, (lo + hi) / 2);
    }
    this.applyAngles(this.cur);
  }

  private applyAngles(arr: Float32Array) {
    const bones = this.model.bones;
    for (let i = 0; i < this.names.length; i++) {
      const b = bones[this.names[i]];
      if (this.names[i] === 'root') continue;
      _e.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2], 'YXZ');
      b.quaternion.setFromEuler(_e);
    }
  }

  setPose(name: string, rate = 7) {
    if (!this.compiled[name]) return;
    this.pose = name;
    this.poseRate = rate;
    this.target.set(this.compiled[name]);
  }

  /** Blend towards an ad-hoc pose definition (e.g. a one-off action). */
  setCustomPose(def: PoseDef, rate = 7) {
    this.pose = 'custom';
    this.poseRate = rate;
    this.target.set(this.compile(def));
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const n = this.cur.length;
    const k = 1 - Math.exp(-this.poseRate * dt);
    for (let i = 0; i < n; i++) this.cur[i] += (this.target[i] - this.cur[i]) * k;
    this.out.set(this.cur);

    this.locomotion(dt);
    this.tailLayer(dt);
    this.headLayer(dt);
    this.faceLayer(dt);
    for (const bone in this.overlay) {
      const i = this.index[bone];
      if (i === undefined) continue;
      const a = this.overlay[bone];
      this.out[i * 3] += a[0]; this.out[i * 3 + 1] += a[1]; this.out[i * 3 + 2] += a[2];
    }
    // breathing
    this.breathe += dt * (1.4 + this.panting * 6);
    const br = Math.sin(this.breathe) * (0.012 + this.panting * 0.02);
    this.out[this.index.chest * 3] += br * 0.3;

    const root = this.model.bones.root;
    // a gentle dip twice per stride while moving
    const H = this.model.design.dims.H;
    const bob = -H * 0.012 * Math.min(1, this.speed / H) * 0.5 * (1 - Math.cos(this.phase * Math.PI * 4));
    const w = this.moveWeight;
    if (w > 0.001) {
      // legs are solved against the posed spine, so pose it first
      this.applyAngles(this.out);
      root.position.set(0, bob, 0);
      root.quaternion.identity();
      this.model.root.updateMatrixWorld(true);
      this.legIK();
    }
    this.applyAngles(this.out);
    this.earLayer(dt);

    // ground solver: settle whatever touches the floor onto it. While walking the
    // IK already keeps the paws on the floor, so the solver fades out.
    root.position.set(0, 0, 0);
    root.quaternion.setFromAxisAngle(_v.set(0, 0, 1), this.rootRoll);
    if (this.rootRoll !== 0) {
      // roll around the body centre rather than the feet
      const c = this.model.restPos.body;
      _v2.set(0, c.y, 0).applyQuaternion(root.quaternion);
      root.position.set(-_v2.x, c.y - _v2.y, 0);
    }
    const low = this.model.lowestContact();
    const gy = -low;
    const target = gy + (bob - gy) * w;
    this.groundY = this.groundSnap ? target : smoothTo(this.groundY, target, 12, dt);
    root.position.y += this.groundY + this.rootLift;
  }

  /** Gait timing and the spine's share of the stride; legs are solved later by IK. */
  private locomotion(dt: number) {
    const turning = Math.abs(this.turnRate) > 0.35;
    const target = this.speed > 0.02 || turning ? 1 : 0;
    this.moveWeight = smoothTo(this.moveWeight, target, 8, dt);
    // gait blend by speed (relative to size)
    const H = this.model.design.dims.H;
    const rel = this.speed / H; // body heights per second
    const want: Gait = rel < 1.3 ? 'walk' : rel < 3.6 ? 'trot' : 'gallop';
    this.gait = want;
    for (const g of GAITS) {
      this.gaitBlend[g] = smoothTo(this.gaitBlend[g], g === want ? 1 : 0, 6, dt);
    }
    const w = this.moveWeight;
    let freq = 0, duty = 0;
    for (const g of GAITS) {
      freq += GAIT[g].freq * this.gaitBlend[g];
      duty += GAIT[g].duty * this.gaitBlend[g];
    }
    // small dogs step faster
    freq *= Math.pow(0.33 / Math.max(0.12, H), 0.45);
    // never ask a foot to travel further in one stance than the leg can reach
    const reach = this.maxStance();
    const turnTravel = Math.abs(this.turnRate) * this.model.design.dims.BL * 0.5;
    freq = Math.max(freq, ((this.speed + turnTravel) * duty) / reach);
    this.stepFreq = smoothTo(this.stepFreq || freq, freq, 6, dt);
    this.phase = (this.phase + dt * this.stepFreq * Math.max(0.35, w)) % 1;
    this.bendSmooth = smoothTo(this.bendSmooth, THREE.MathUtils.clamp(this.turnRate * 0.18, -0.35, 0.35), 6, dt);
    if (w < 0.01 && Math.abs(this.bendSmooth) < 0.001) return;

    const o = this.out;
    // spine motion
    const gal = this.gaitBlend.gallop;
    const ph2 = this.phase * Math.PI * 2;
    o[this.index.pelvis * 3] += Math.sin(ph2) * 0.12 * gal * w;
    o[this.index.chest * 3] += -Math.sin(ph2) * 0.1 * gal * w;
    o[this.index.body * 3] += Math.sin(ph2 + 0.8) * 0.06 * gal * w;
    const trot = this.gaitBlend.trot + this.gaitBlend.walk * 0.6;
    o[this.index.body * 3 + 2] += Math.sin(ph2) * 0.03 * trot * w;
    o[this.index.head * 3] += Math.sin(ph2 * 2) * 0.025 * w;
    // turning bend
    o[this.index.chest * 3 + 1] += this.bendSmooth;
    o[this.index.pelvis * 3 + 1] -= this.bendSmooth * 0.8;
    o[this.index.neck * 3 + 1] += this.bendSmooth * 0.6;
  }

  private stepFreq = 0;
  private legInfo: Record<LegKey, { L1: number; L2: number; L3: number; foot: THREE.Vector3; front: boolean; side: number }> | null = null;

  private legs() {
    if (this.legInfo) return this.legInfo;
    const m = this.model;
    const info = {} as NonNullable<DogRig['legInfo']>;
    for (const key of Object.keys(LEGS) as LegKey[]) {
      const b = LEGS[key];
      const p = b.map((n) => m.boneWorldRest(n));
      info[key] = {
        L1: p[0].distanceTo(p[1]), L2: p[1].distanceTo(p[2]), L3: p[2].distanceTo(p[3]),
        foot: p[3].clone(), front: key[0] === 'f', side: key.endsWith('l') ? 1 : -1,
      };
    }
    this.legInfo = info;
    return info;
  }

  /** How far a paw may travel during one stance. */
  private maxStance() {
    const L = this.legs();
    const legLen = Math.min(L.fl.L1 + L.fl.L2, L.hl.L1 + L.hl.L2);
    return Math.max(0.03, legLen * 0.95);
  }

  /**
   * Plant the paws: each leg gets a foot target (on the floor during stance,
   * arcing forward during swing) and a two-bone IK solve for the upper and
   * lower segments. Runs after the spine is posed so it follows body pitch.
   */
  private legIK() {
    const w = this.moveWeight;
    if (w < 0.001) return;
    const m = this.model;
    const L = this.legs();
    const o = this.out;
    const idx = this.index;
    const zc = (m.design.dims.shZ + m.design.dims.hipZ) / 2;
    const freq = Math.max(0.3, this.stepFreq);
    const wTurn = this.turnRate;
    const bodyX = o[idx.body * 3];
    for (const key of LEG_KEYS) {
      const leg = L[key];
      const b = LEGS[key];
      // foot target, blended over the active gaits
      let fx = 0, fz = 0, lift = 0, gwSum = 0;
      for (const g of GAITS) {
        const gw = this.gaitBlend[g];
        if (gw < 0.01) continue;
        const G = GAIT[g];
        const ts = G.duty / freq; // stance duration
        // paw velocity relative to the body while planted: -(v + w x r)
        const rx = leg.foot.x, rz = leg.foot.z - zc;
        const dx = -(wTurn * rz) * ts;
        const dz = -(this.speed - wTurn * rx) * ts;
        const ph = (this.phase + G.phase[key]) % 1;
        let u: number, l: number;
        if (ph < G.duty) {
          u = ph / G.duty - 0.5; // -0.5 (ahead) .. 0.5 (behind)
          l = 0;
        } else {
          const t = (ph - G.duty) / (1 - G.duty);
          const e = t * t * (3 - 2 * t);
          u = 0.5 - e;
          l = Math.sin(Math.PI * t);
        }
        fx += gw * dx * u;
        fz += gw * dz * u;
        const travel = Math.hypot(dx, dz);
        lift += gw * l * Math.min(0.32 * (leg.L1 + leg.L2), 0.012 + travel * (g === 'gallop' ? 0.45 : 0.32));
        gwSum += gw;
      }
      if (gwSum > 0) { fx /= gwSum; fz /= gwSum; lift /= gwSum; }
      const swing = Math.min(1, lift / Math.max(1e-4, 0.25 * (leg.L1 + leg.L2)));

      // hip / shoulder joint in the dog's own space
      m.bones[b[0]].getWorldPosition(_v);
      m.root.worldToLocal(_v);
      const sy = _v.y, sz = _v.z;
      // third segment (pastern / metatarsus) keeps its rest angle, flicking back in swing
      const th3 = this.restDir[b[2]] + swing * (leg.front ? 1.1 : 0.45);
      const ty3 = leg.foot.y + lift, tz3 = leg.foot.z + fz;
      const ty2 = ty3 + Math.cos(th3) * leg.L3, tz2 = tz3 + Math.sin(th3) * leg.L3;
      // two-bone solve in the sagittal plane
      let dy = ty2 - sy, dz = tz2 - sz;
      let d = Math.hypot(dy, dz);
      const dMax = (leg.L1 + leg.L2) * 0.999, dMin = Math.abs(leg.L1 - leg.L2) * 1.01 + 1e-4;
      if (d > dMax) { dy *= dMax / d; dz *= dMax / d; d = dMax; }
      if (d < dMin) { d = dMin; }
      const phi = Math.atan2(-dz, -dy);
      const cosA = THREE.MathUtils.clamp((leg.L1 * leg.L1 + d * d - leg.L2 * leg.L2) / (2 * leg.L1 * d), -1, 1);
      const alpha = Math.acos(cosA);
      // elbows fold backwards, knees fold forwards
      const th1 = leg.front ? phi + alpha : phi - alpha;
      const ey = sy - Math.cos(th1) * leg.L1, ez = sz - Math.sin(th1) * leg.L1;
      const th2 = Math.atan2(-(sz + dz - ez), -(sy + dy - ey));
      const pawPitch = swing * (leg.front ? 1.2 : 0.8);

      const parentAbs = bodyX + o[(leg.front ? idx.chest : idx.pelvis) * 3];
      const a0 = th1 - this.restDir[b[0]];
      const a1 = th2 - this.restDir[b[1]];
      const a2 = th3 - this.restDir[b[2]];
      const locals = _locals;
      locals[0] = a0 - parentAbs; locals[1] = a1 - a0; locals[2] = a2 - a1; locals[3] = pawPitch - a2;
      for (let i = 0; i < 4; i++) {
        const j = idx[b[i]] * 3;
        o[j] += (locals[i] - o[j]) * w;
      }
      // sideways steps when turning: roll the leg out from the joint
      const legLen = leg.L1 + leg.L2 + leg.L3;
      o[idx[b[0]] * 3 + 2] += Math.asin(THREE.MathUtils.clamp(fx / legLen, -0.5, 0.5)) * w;
    }
  }

  private tailLayer(dt: number) {
    this.wagPhase += dt * this.wagFreq * Math.PI * 2;
    const o = this.out;
    for (let i = 0; i < 5; i++) {
      const lag = i * 0.45;
      o[this.index['tail' + i] * 3 + 1] += Math.sin(this.wagPhase - lag) * this.wagAmp * (i === 0 ? 0.6 : 0.35);
    }
    o[this.index.tail0 * 3] -= this.tailRaise;
    // the wag also sways the hips a little
    o[this.index.pelvis * 3 + 1] += Math.sin(this.wagPhase) * this.wagAmp * 0.04;
  }

  private headLayer(dt: number) {
    let yaw = 0, pitch = 0;
    if (this.look.point && this.look.weight > 0) {
      const neck = this.model.bones.neck;
      neck.updateWorldMatrix(true, false);
      // express target in the frame of the neck's parent (chest)
      const head = this.model.bones.head;
      head.getWorldPosition(_v2);
      _v.copy(this.look.point).sub(_v2);
      // into dog root space
      this.model.bones.chest.getWorldQuaternion(_q).invert();
      _v.applyQuaternion(_q);
      yaw = Math.atan2(_v.x, _v.z);
      pitch = -Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
      // behind the dog: don't twist fully
      yaw = THREE.MathUtils.clamp(yaw, -1.3, 1.3);
      pitch = THREE.MathUtils.clamp(pitch - this.get(this.out, 'head') * 0.0, -0.9, 0.8);
      yaw *= this.look.weight;
      pitch *= this.look.weight;
    }
    this.lookYaw = smoothTo(this.lookYaw, yaw, 7, dt);
    this.lookPitch = smoothTo(this.lookPitch, pitch, 7, dt);
    this.headTiltCur = smoothTo(this.headTiltCur, this.headTilt, 5, dt);
    const o = this.out;
    o[this.index.neck * 3 + 1] += this.lookYaw * 0.45;
    o[this.index.head * 3 + 1] += this.lookYaw * 0.55;
    o[this.index.neck * 3] += this.lookPitch * 0.35;
    o[this.index.head * 3] += this.lookPitch * 0.55;
    o[this.index.head * 3 + 2] += this.headTiltCur;
    // eyes follow the rest of the way
    this.eyeYaw = smoothTo(this.eyeYaw, (yaw - this.lookYaw) * 0.8, 14, dt);
    this.eyePitch = smoothTo(this.eyePitch, (pitch - this.lookPitch) * 0.8, 14, dt);
  }

  private faceLayer(dt: number) {
    const m = this.model;
    // jaw / panting
    this.pantPhase += dt * 11;
    const pant = this.panting * (0.5 + 0.5 * Math.sin(this.pantPhase)) * 0.35;
    const jawT = this.jawHold > 0 ? this.jawHold : Math.max(this.mouthOpen * 0.42, pant + this.panting * 0.15);
    this.jawCur = smoothTo(this.jawCur, jawT, 18, dt);
    this.out[this.index.jaw * 3] += this.jawCur;
    // tongue
    this.tongueCur = smoothTo(this.tongueCur, this.jawHold > 0 ? 0 : Math.max(this.tongueOut, this.panting), 8, dt);
    const d = m.design.dims;
    m.tongue.position.copy(m.tongueRest);
    m.tongue.position.z += this.tongueCur * d.muzzleL * d.hs * 0.55;
    m.tongue.position.y -= this.tongueCur * 0.006 * d.hs;
    m.tongue.rotation.x = this.tongueCur * 0.35 + pant * 0.3;
    m.tongue.scale.set(1, 1, 1 + this.tongueCur * 0.35);
    // blinking
    this.blinkT -= dt;
    if (this.blinkT < 0) {
      this.blinkT = 1.5 + Math.random() * 4;
      this.blinkAmt = 1;
    }
    this.blinkAmt = Math.max(0, this.blinkAmt - dt * 7);
    const blink = this.blinkAmt > 0.5 ? (1 - this.blinkAmt) * 2 : this.blinkAmt * 2;
    this.lidCur = smoothTo(this.lidCur, this.eyesClosed, 8, dt);
    m.setLids(Math.min(1, Math.max(this.lidCur, blink, this.happy * 0.35)), this.happy);
    // eyeballs
    for (const e of m.eyes) {
      e.ball.rotation.set(this.eyePitch, this.eyeYaw, 0);
    }
  }

  private earLayer(dt: number) {
    const m = this.model;
    const head = m.bones.head;
    // angular velocity of the head drives floppy ears
    head.updateWorldMatrix(true, false);
    head.getWorldQuaternion(_q);
    const dq = _dq.copy(this.prevHeadQ).invert().multiply(_q);
    this.prevHeadQ.copy(_q);
    _e.setFromQuaternion(dq, 'XYZ');
    const inv = 1 / Math.max(dt, 1e-3);
    this.headAngVel.set(_e.x * inv, _e.y * inv, _e.z * inv);
    const floppy = m.design.dims.earSide === 'floppy';
    const sides = [1, -1];
    for (let i = 0; i < 2; i++) {
      const b = m.bones[i === 0 ? 'ear_L' : 'ear_R'];
      const side = sides[i];
      if (floppy) {
        // spring towards a target flap angle; head roll/yaw kicks the ears
        const perk = this.earPerk * 0.35;
        const target = -perk * side;
        const kick = (this.headAngVel.z * 0.05 + this.headAngVel.y * 0.03 * side) - this.moveWeight * Math.sin(this.phase * Math.PI * 4) * 0.08 * side;
        this.earVel[i] += (-(this.earAng[i] - target) * 90 - this.earVel[i] * 9) * dt + kick;
        this.earAng[i] += this.earVel[i] * dt;
        this.earAng[i] = THREE.MathUtils.clamp(this.earAng[i], -0.9, 0.9);
        b.rotation.set(-this.earPerk * 0.15 + this.headAngVel.x * 0.01, 0, this.earAng[i] * side * -1 + (-perk) * side);
      } else {
        const back = Math.max(0, -this.earPerk);
        const fwd = Math.max(0, this.earPerk);
        const twitch = Math.sin(this.time * 0.7 + i * 2) > 0.985 ? 0.2 : 0;
        this.earAng[i] = smoothTo(this.earAng[i], -back * 0.9 + fwd * 0.15 + twitch, 10, dt);
        b.rotation.set(-this.earAng[i] * 0.9, 0, back * 0.5 * side);
      }
    }
  }

  get phaseValue() {
    return this.phase;
  }
}

export { BONE_ORDER_EXTRA };
