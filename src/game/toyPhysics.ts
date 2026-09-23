import * as THREE from 'three';
import type { WorldToy } from '../dog/brain';
import type { Bounds, Circle, Toy } from '../world/types';

// Minimal physics for thrown toys: gravity, floor bounces, wall and furniture
// collisions, and a little lift for flying discs.

let nextId = 1;

export interface ToyEntry extends WorldToy {
  toy: Toy;
  spin: THREE.Vector3;
  glide: boolean;
  bounce: number;
  airTime: number;
  /** height of the toy's origin above the floor when lying still */
  rest: number;
  onBounce?: (impact: number) => void;
}

export class ToyWorld {
  readonly list: ToyEntry[] = [];
  bounds: Bounds;
  obstacles: Circle[];
  floorY = 0;
  onBounce: ((t: ToyEntry, impact: number) => void) | null = null;
  onLand: ((t: ToyEntry) => void) | null = null;

  constructor(readonly parent: THREE.Object3D, bounds: Bounds, obstacles: Circle[] = []) {
    this.bounds = bounds;
    this.obstacles = obstacles;
  }

  add(toy: Toy, at: THREE.Vector3): ToyEntry {
    const e: ToyEntry = {
      id: nextId++,
      kind: toy.kind,
      toy,
      object: toy.object,
      grip: toy.grip,
      velocity: new THREE.Vector3(),
      inHand: false,
      carrier: null,
      resting: true,
      radius: toy.radius,
      rest: (toy as Toy & { rest?: number }).rest ?? (toy.glide ? 0.012 : toy.radius),
      squeaky: toy.kind === 'squeaky',
      spin: new THREE.Vector3(),
      glide: toy.glide,
      bounce: toy.bounce,
      airTime: 0,
    };
    toy.object.position.copy(at);
    this.parent.add(toy.object);
    this.list.push(e);
    return e;
  }

  remove(e: ToyEntry) {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    e.object.removeFromParent();
    e.toy.dispose();
  }

  throw(e: ToyEntry, from: THREE.Vector3, vel: THREE.Vector3) {
    this.parent.attach(e.object);
    e.object.position.copy(from);
    e.velocity.copy(vel);
    e.inHand = false;
    e.carrier = null;
    e.resting = false;
    e.airTime = 0;
    if (e.glide) {
      // discs fly flat and spin
      e.object.rotation.set(0, 0, 0);
      e.spin.set(0, 18, 0);
    } else {
      e.spin.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 20);
    }
  }

  /** Put down a toy the dog was carrying. */
  dropAt(e: ToyEntry, pos: THREE.Vector3) {
    this.parent.attach(e.object);
    e.object.position.copy(pos);
    e.velocity.set(0, 0, 0);
    e.carrier = null;
    e.resting = false;
  }

  update(dt: number) {
    for (const e of this.list) {
      e.toy.update?.(dt, e.carrier ? 0.6 : 0);
      if (e.inHand || e.carrier || e.resting) continue;
      const o = e.object;
      const v = e.velocity;
      e.airTime += dt;
      const r = e.radius;
      const floorContact = o.position.y <= this.floorY + e.rest + 1e-3;
      if (e.glide && !floorContact) {
        const hs = Math.hypot(v.x, v.z);
        // lift and drag for a flying disc
        v.y += (-9.8 + Math.min(9.0, hs * hs * 0.55)) * dt;
        v.multiplyScalar(1 - 0.18 * dt);
      } else {
        v.y -= 9.8 * dt;
        v.multiplyScalar(1 - 0.05 * dt);
      }
      o.position.addScaledVector(v, dt);
      // spin
      o.rotation.x += e.spin.x * dt;
      o.rotation.y += e.spin.y * dt;
      o.rotation.z += e.spin.z * dt;
      // floor
      const minY = this.floorY + e.rest;
      if (o.position.y < minY) {
        o.position.y = minY;
        const impact = -v.y;
        if (impact > 0.4) {
          v.y = impact * e.bounce;
          this.onBounce?.(e, impact);
        } else v.y = 0;
        // rolling friction
        const f = e.glide ? 0.9 : 0.25;
        v.x *= Math.max(0, 1 - f * dt * 6);
        v.z *= Math.max(0, 1 - f * dt * 6);
        e.spin.multiplyScalar(0.8);
        if (e.glide) { o.rotation.x *= 0.8; o.rotation.z *= 0.8; }
        if (!e.glide && Math.hypot(v.x, v.z) > 0.02) {
          // roll the ball visually
          o.rotation.x += (v.z / r) * dt;
          o.rotation.z -= (v.x / r) * dt;
        }
        if (Math.abs(v.y) < 0.05 && Math.hypot(v.x, v.z) < 0.05) {
          v.set(0, 0, 0);
          e.resting = true;
          this.onLand?.(e);
        }
      }
      // walls
      const b = this.bounds;
      if (o.position.x < b.minX + r) { o.position.x = b.minX + r; v.x = Math.abs(v.x) * 0.5; this.onBounce?.(e, Math.abs(v.x)); }
      if (o.position.x > b.maxX - r) { o.position.x = b.maxX - r; v.x = -Math.abs(v.x) * 0.5; this.onBounce?.(e, Math.abs(v.x)); }
      if (o.position.z < b.minZ + r) { o.position.z = b.minZ + r; v.z = Math.abs(v.z) * 0.5; this.onBounce?.(e, Math.abs(v.z)); }
      if (o.position.z > b.maxZ - r) { o.position.z = b.maxZ - r; v.z = -Math.abs(v.z) * 0.5; this.onBounce?.(e, Math.abs(v.z)); }
      for (const c of this.obstacles) {
        const dx = o.position.x - c.x, dz = o.position.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d < c.r + r && o.position.y < 0.6) {
          const nx = dx / (d || 1), nz = dz / (d || 1);
          o.position.x = c.x + nx * (c.r + r);
          o.position.z = c.z + nz * (c.r + r);
          const vn = v.x * nx + v.z * nz;
          if (vn < 0) { v.x -= 1.5 * vn * nx; v.z -= 1.5 * vn * nz; }
        }
      }
    }
  }
}

/** How a dog should hold a world toy: balls poke out of the front of the mouth. */
export function holdToy(actor: { hold(o: THREE.Object3D, g?: THREE.Vector3, r?: number): void }, t: WorldToy) {
  const ball = t.kind === 'tennisBall' || t.kind === 'rubberBall';
  actor.hold(t.object, t.grip, ball ? t.radius : 0);
}
