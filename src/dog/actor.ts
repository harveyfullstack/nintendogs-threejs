import * as THREE from 'three';
import type { Bounds, Circle } from '../world/types';
import type { Breed, CoatDef } from './breeds';
import { DogModel } from './dogModel';
import { DogRig } from './rig';

// A dog in the world: model + rig + locomotion + touch proxy.

export type DogRegion = 'head' | 'muzzle' | 'chin' | 'ear' | 'neck' | 'chest' | 'back' | 'belly' | 'rump' | 'tail' | 'frontPaw' | 'hindPaw' | 'side';

interface Capsule {
  a: THREE.Bone; b: THREE.Bone | null;
  aOff: THREE.Vector3; bOff: THREE.Vector3;
  r: number;
  region: DogRegion;
}

export interface DogHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  region: DogRegion;
  distance: number;
  /** bone that was hit, for attaching effects */
  bone: THREE.Bone;
}

export interface MoveOpts {
  speed?: number;
  arrive?: number;
  onArrive?: () => void;
  /** face this point after arriving */
  faceAfter?: THREE.Vector3 | null;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class DogActor {
  readonly model: DogModel;
  readonly rig: DogRig;
  readonly group: THREE.Group;
  heading = 0;
  speed = 0;
  private angVel = 0;
  private lastHeading = 0;
  private turnSmooth = 0;
  target: THREE.Vector3 | null = null;
  private moveOpts: MoveOpts = {};
  maxSpeed = 0.6;
  bounds: Bounds | null = null;
  obstacles: Circle[] = [];
  floorY = 0;
  faceTarget: THREE.Vector3 | null = null;
  readonly mouth = new THREE.Object3D();
  held: THREE.Object3D | null = null;
  private capsules: Capsule[] = [];
  /** 0..1 how out of breath from running */
  exertion = 0;
  jump: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; h: number; onLand?: () => void } | null = null;

  constructor(readonly breed: Breed, readonly coat: CoatDef, quality = 1) {
    this.model = new DogModel(breed, coat, { quality });
    this.rig = new DogRig(this.model);
    this.rig.solvePoses();
    this.group = this.model.root;
    this.group.userData.actor = this;
    // mouth anchor sits between the front teeth; it rides on the skull so an
    // opening jaw doesn't drop whatever the pup is carrying
    const d = this.model.design.dims;
    const head = this.model.boneWorldRest('head');
    this.mouth.position.set(0, d.jawHinge[1] - head.y - 0.004 * d.hs, d.noseTip[2] - head.z - 0.022 * d.hs);
    this.model.bones.head.add(this.mouth);
    this.buildProxy();
  }

  get position() { return this.group.position; }
  get forward() { return _v.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }
  get size() { return this.model.design.dims.H; }

  place(x: number, z: number, heading = this.heading) {
    this.group.position.set(x, this.floorY, z);
    this.heading = heading;
    this.lastHeading = heading;
    this.turnSmooth = 0;
    this.group.rotation.y = heading;
  }

  goTo(p: THREE.Vector3, opts: MoveOpts = {}) {
    this.target = (this.target || new THREE.Vector3()).copy(p);
    this.target.y = this.floorY;
    this.moveOpts = opts;
  }

  stop() {
    this.target = null;
  }

  get moving() { return !!this.target; }

  /** Rotate in place to face a point (when not moving). */
  face(p: THREE.Vector3 | null) {
    this.faceTarget = p ? (this.faceTarget || new THREE.Vector3()).copy(p) : null;
  }

  headingTo(p: THREE.Vector3) {
    return Math.atan2(p.x - this.position.x, p.z - this.position.z);
  }

  distanceTo(p: THREE.Vector3) {
    return Math.hypot(p.x - this.position.x, p.z - this.position.z);
  }

  jumpTo(to: THREE.Vector3, height: number, dur: number, onLand?: () => void) {
    this.jump = { from: this.position.clone(), to: to.clone(), t: 0, dur, h: height, onLand };
    this.heading = this.headingTo(to);
    this.rig.setPose('jump', 14);
  }

  update(dt: number) {
    const rig = this.rig;
    if (this.jump) {
      const j = this.jump;
      j.t += dt;
      const f = Math.min(1, j.t / j.dur);
      this.position.lerpVectors(j.from, j.to, f);
      this.position.y = this.floorY;
      rig.rootLift = 4 * j.h * f * (1 - f);
      rig.speed = 0;
      if (f >= 1) {
        rig.rootLift = 0;
        this.jump = null;
        rig.setPose('stand', 10);
        j.onLand?.();
      }
    } else if (this.target) {
      const dx = this.target.x - this.position.x, dz = this.target.z - this.position.z;
      const dist = Math.hypot(dx, dz);
      const arrive = this.moveOpts.arrive ?? 0.05;
      if (dist <= arrive) {
        const opts = this.moveOpts;
        this.target = null;
        if (opts.faceAfter) this.face(opts.faceAfter);
        opts.onArrive?.();
      } else {
        const want = Math.atan2(dx, dz);
        const diff = wrapAngle(want - this.heading);
        const maxTurn = (this.speed > 1 ? 5 : 3.5) * dt;
        const turn = THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
        this.heading += turn;
        this.angVel = turn / Math.max(dt, 1e-4);
        const top = this.moveOpts.speed ?? this.maxSpeed;
        let desired = Math.min(top, Math.max(0.12, dist * 2.2));
        // slow down smoothly for sharp turns rather than switching speeds
        desired *= THREE.MathUtils.clamp(Math.cos(diff) * 1.15, 0.2, 1);
        const acc = desired > this.speed ? 2.5 : 4;
        this.speed += THREE.MathUtils.clamp(desired - this.speed, -acc * dt, acc * dt);
      }
    }
    if (!this.target && !this.jump) {
      this.speed = Math.max(0, this.speed - 3 * dt);
      if (this.faceTarget) {
        const want = this.headingTo(this.faceTarget);
        const diff = wrapAngle(want - this.heading);
        const maxTurn = 3 * dt;
        const turn = THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
        this.heading += turn;
        this.angVel = turn / Math.max(dt, 1e-4);
        if (Math.abs(diff) < 0.05) this.faceTarget = null;
      } else {
        this.angVel *= Math.exp(-8 * dt);
      }
    }
    // integrate position
    if (this.speed > 0 && !this.jump) {
      this.position.x += Math.sin(this.heading) * this.speed * dt;
      this.position.z += Math.cos(this.heading) * this.speed * dt;
      this.collide();
    }
    this.position.y = this.floorY;
    this.group.rotation.y = this.heading;
    // measure how fast the dog actually turned this frame (including spins
    // driven by tricks) so the legs can step around
    const measured = wrapAngle(this.heading - this.lastHeading) / Math.max(dt, 1e-4);
    this.lastHeading = this.heading;
    this.turnSmooth += (THREE.MathUtils.clamp(measured, -8, 8) - this.turnSmooth) * (1 - Math.exp(-12 * dt));
    rig.speed = this.jump ? 0 : this.speed;
    rig.turnRate = this.jump ? 0 : this.turnSmooth;
    this.exertion = THREE.MathUtils.clamp(this.exertion + (this.speed > 1.0 ? dt * 0.12 : -dt * 0.05), 0, 1);
    rig.update(dt);
  }

  private collide() {
    const r = this.model.design.dims.BL * 0.5;
    for (const o of this.obstacles) {
      const dx = this.position.x - o.x, dz = this.position.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + r * 0.6;
      if (d < min && d > 1e-4) {
        this.position.x = o.x + (dx / d) * min;
        this.position.z = o.z + (dz / d) * min;
      }
    }
    const b = this.bounds;
    if (b) {
      this.position.x = THREE.MathUtils.clamp(this.position.x, b.minX + r * 0.5, b.maxX - r * 0.5);
      this.position.z = THREE.MathUtils.clamp(this.position.z, b.minZ + r * 0.5, b.maxZ - r * 0.5);
    }
  }

  /** Pick a point inside bounds that avoids obstacles. */
  randomPoint(radius = 1.5, around?: THREE.Vector3): THREE.Vector3 {
    const c = around || this.position;
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * radius;
      const p = new THREE.Vector3(c.x + Math.cos(a) * d, this.floorY, c.z + Math.sin(a) * d);
      if (this.bounds) {
        const b = this.bounds, m = 0.2;
        if (p.x < b.minX + m || p.x > b.maxX - m || p.z < b.minZ + m || p.z > b.maxZ - m) continue;
      }
      if (this.obstacles.some((o) => Math.hypot(p.x - o.x, p.z - o.z) < o.r + 0.2)) continue;
      return p;
    }
    return c.clone();
  }

  // ---------- mouth ------------------------------------------------------------

  /**
   * Carry an object. `grip` is the point on the object that goes between the
   * teeth; round toys (pass `ballRadius`) are held with the ball poking out in front.
   */
  hold(obj: THREE.Object3D, grip?: THREE.Vector3, ballRadius = 0) {
    this.drop();
    this.held = obj;
    this.mouth.add(obj);
    obj.rotation.set(0, 0, 0);
    if (ballRadius > 0) obj.position.set(0, -ballRadius * 0.15, ballRadius * 0.45);
    else if (grip) obj.position.copy(grip).multiplyScalar(-1);
    else obj.position.set(0, 0, 0);
    const size = ballRadius > 0 ? ballRadius * 2 : 0.03;
    this.rig.jawHold = Math.min(0.5, 0.12 + size * 4);
  }

  /** Detach the held object into `parent`, keeping its world transform. */
  drop(parent?: THREE.Object3D): THREE.Object3D | null {
    const o = this.held;
    if (!o) return null;
    this.held = null;
    this.rig.jawHold = 0;
    if (parent) parent.attach(o);
    else o.removeFromParent();
    return o;
  }

  mouthWorld(out = new THREE.Vector3()) {
    return this.mouth.getWorldPosition(out);
  }

  headWorld(out = new THREE.Vector3()) {
    return this.model.bones.head.getWorldPosition(out);
  }

  noseWorld(out = new THREE.Vector3()) {
    const d = this.model.design.dims;
    const head = this.model.boneWorldRest('head');
    out.set(d.noseTip[0] - head.x, d.noseTip[1] - head.y, d.noseTip[2] - head.z);
    return this.model.bones.head.localToWorld(out);
  }

  // ---------- touch proxy ------------------------------------------------------

  private buildProxy() {
    const m = this.model;
    const d = m.design.dims;
    const s = this.breed.shape;
    const B = m.bones;
    const rest = (n: string) => m.boneWorldRest(n);
    const off = (bone: string, p: THREE.Vector3) => p.clone().sub(rest(bone));
    const add = (a: string, pa: THREE.Vector3, b: string | null, pb: THREE.Vector3, r: number, region: DogRegion) => {
      this.capsules.push({ a: B[a], b: b ? B[b] : null, aOff: off(a, pa), bOff: b ? off(b, pb) : pb.clone(), r, region });
    };
    const H = d.H, CD = d.CD;
    const fur = this.breed.fur.len;
    const midY = H - CD * 0.5;
    // torso split into back/belly by the hit normal later
    add('pelvis', new THREE.Vector3(0, midY + CD * 0.05, d.hipZ), 'chest', new THREE.Vector3(0, midY, d.shZ - 0.04 * d.g), CD * 0.5 + fur, 'back');
    add('chest', new THREE.Vector3(0, midY - CD * 0.05, d.shZ - 0.02), 'chest', new THREE.Vector3(0, midY - CD * 0.1, d.shZ + 0.02 * d.g), CD * 0.42 + fur, 'chest');
    add('pelvis', new THREE.Vector3(0, H * 0.8, d.hipZ - 0.01), 'pelvis', new THREE.Vector3(0, H * 0.78, d.hipZ + 0.02), s.HW * 0.5 + fur, 'rump');
    const A = new THREE.Vector3(...d.atlas);
    const neckBase = rest('neck');
    add('neck', neckBase, 'head', A.clone().add(new THREE.Vector3(0, -0.01, 0)), 0.055 * d.hs * s.neckT + fur, 'neck');
    const skullC = A.clone().add(new THREE.Vector3(0, 0.026 * d.hs, 0.03 * d.hs));
    add('head', skullC, null, new THREE.Vector3(0, 0, 0), (s.skull[0] * 0.5) * d.hs + fur, 'head');
    const nose = new THREE.Vector3(...d.noseTip);
    add('head', A.clone().add(new THREE.Vector3(0, 0.005, d.stopZ * d.hs)), 'head', nose, s.muzzle[0] * 0.5 * d.hs, 'muzzle');
    add('jaw', A.clone().add(new THREE.Vector3(0, -0.025 * d.hs, 0.06 * d.hs)), 'jaw', A.clone().add(new THREE.Vector3(0, -0.028 * d.hs, (d.stopZ + d.muzzleL * 0.6) * d.hs)), 0.016 * d.hs, 'chin');
    for (const sfx of ['_L', '_R']) {
      add('upperarm' + sfx, rest('forearm' + sfx), 'wrist' + sfx, rest('wrist' + sfx), s.pawR * 0.7, 'frontPaw');
      add('wrist' + sfx, rest('wrist' + sfx), 'fpaw' + sfx, rest('fpaw' + sfx).add(new THREE.Vector3(0, 0, s.pawR * 0.5)), s.pawR * 0.8, 'frontPaw');
      add('shin' + sfx, rest('shin' + sfx), 'hpaw' + sfx, rest('hpaw' + sfx), s.pawR * 0.7, 'hindPaw');
      const ear = rest('ear' + sfx);
      add('ear' + sfx, ear, 'ear' + sfx, ear.clone().add(new THREE.Vector3(0, d.earSide === 'floppy' ? -s.ear.L * d.hs * 0.7 : s.ear.L * d.hs * 0.7, 0.005)), s.ear.W * 0.35 * d.hs, 'ear');
    }
    add('tail0', rest('tail0'), 'tail4', new THREE.Vector3(...d.tailTip), s.tail.T + fur * 1.5, 'tail');
  }

  /** Ray test against the capsule proxy. */
  raycast(ray: THREE.Ray): DogHit | null {
    let best: DogHit | null = null;
    for (const c of this.capsules) {
      c.a.updateWorldMatrix(true, false);
      _a.copy(c.aOff).applyMatrix4(c.a.matrixWorld);
      if (c.b) { c.b.updateWorldMatrix(true, false); _b.copy(c.bOff).applyMatrix4(c.b.matrixWorld); }
      else _b.copy(_a).add(_w.set(0, 1e-4, 0));
      const t = rayCapsule(ray, _a, _b, c.r);
      if (t === null || (best && t >= best.distance)) continue;
      const point = ray.at(t, new THREE.Vector3());
      // normal from closest point on the segment
      const ab = _w.copy(_b).sub(_a);
      const u = THREE.MathUtils.clamp(point.clone().sub(_a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
      const cp = _a.clone().addScaledVector(ab, u);
      const normal = point.clone().sub(cp).normalize();
      let region = c.region;
      if (region === 'back') {
        // decide back / side / belly from the normal in the dog's space
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.model.bones.body.getWorldQuaternion(new THREE.Quaternion()));
        const k = normal.dot(up);
        region = k > 0.45 ? 'back' : k < -0.35 ? 'belly' : 'side';
      }
      best = { point, normal, region, distance: t, bone: c.a };
    }
    return best;
  }

  dispose() {
    this.model.dispose();
  }
}

/** Keep dogs from walking through each other (soft pairwise push). */
export function separateDogs(actors: DogActor[]) {
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i], b = actors[j];
      if (a.jump || b.jump) continue;
      const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
      const d = Math.hypot(dx, dz);
      const min = (a.model.design.dims.BL + b.model.design.dims.BL) * 0.42;
      if (d >= min) continue;
      const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
      const push = (min - d) * 0.5;
      a.position.x -= nx * push; a.position.z -= nz * push;
      b.position.x += nx * push; b.position.z += nz * push;
    }
  }
}

export function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Ray vs capsule (segment a-b, radius r). Returns distance or null. */
function rayCapsule(ray: THREE.Ray, a: THREE.Vector3, b: THREE.Vector3, r: number): number | null {
  const ro = ray.origin, rd = ray.direction;
  const ba = _v.copy(b).sub(a);
  const oa = new THREE.Vector3().copy(ro).sub(a);
  const baba = ba.dot(ba);
  const bard = ba.dot(rd);
  const baoa = ba.dot(oa);
  const rdoa = rd.dot(oa);
  const oaoa = oa.dot(oa);
  const aa = baba - bard * bard;
  let bb = baba * rdoa - baoa * bard;
  let cc = baba * oaoa - baoa * baoa - r * r * baba;
  let h = bb * bb - aa * cc;
  if (h >= 0) {
    const t = (-bb - Math.sqrt(h)) / aa;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t > 0) return t;
    // caps
    const oc = y <= 0 ? oa : new THREE.Vector3().copy(ro).sub(b);
    bb = rd.dot(oc);
    cc = oc.dot(oc) - r * r;
    h = bb * bb - cc;
    if (h > 0) {
      const t2 = -bb - Math.sqrt(h);
      if (t2 > 0) return t2;
    }
  }
  return null;
}
