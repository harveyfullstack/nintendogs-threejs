import * as THREE from 'three';
import type { DogSave } from '../game/state';
import { clamp } from '../game/state';
import type { TrickId } from '../game/tricks';
import type { DogActor, DogRegion } from './actor';
import { wrapAngle } from './actor';

// Behaviour for a puppy. The brain owns one Activity at a time; scenes feed it
// events (called, petted, toy thrown...) and it drives the actor and rig.

export type DogSound = 'bark' | 'yip' | 'woof' | 'growl' | 'whine' | 'howl' | 'sneeze' | 'pant' | 'sniff' | 'yawn' | 'lap' | 'crunch' | 'happy';
export type Emote = 'heart' | 'sparkle' | 'note' | 'zzz' | 'question' | 'exclaim' | 'anger' | 'bulb' | 'sweat';

export interface WorldToy {
  id: number;
  kind: string;
  object: THREE.Object3D;
  grip: THREE.Vector3;
  velocity: THREE.Vector3;
  /** true while the owner holds it */
  inHand: boolean;
  /** dog currently carrying it */
  carrier: DogActor | null;
  resting: boolean;
  radius: number;
  squeaky?: boolean;
}

export interface BrainEnv {
  /** floor point where the owner "is" (in front of the camera) */
  playerSpot(): THREE.Vector3;
  cameraPos(): THREE.Vector3;
  foodBowl?: { pos: THREE.Vector3; fill: () => number; eat: (amount: number) => void; rim: number };
  waterBowl?: { pos: THREE.Vector3; fill: () => number; drink: (amount: number) => void; rim: number };
  bed?: THREE.Vector3;
  toys(): WorldToy[];
  sound(actor: DogActor, kind: DogSound): void;
  emote(actor: DogActor, kind: Emote): void;
  /** the dog dropped / released a toy */
  releaseToy?(toy: WorldToy, actor: DogActor): void;
  pickUpToy?(toy: WorldToy, actor: DogActor): void;
  event?(name: string, data?: unknown): void;
  /** allow random wandering (false in bath, contests...) */
  roam: boolean;
}

export type Posture = 'stand' | 'sit' | 'down' | 'other';

abstract class Act {
  done = false;
  t = 0;
  abstract readonly name: string;
  /** can be replaced by idle choices; higher = harder to interrupt */
  priority = 0;
  constructor(protected b: Brain) {}
  start() {}
  abstract step(dt: number): void;
  stop() {}
  get dog() { return this.b.actor; }
  get rig() { return this.b.actor.rig; }
  get env() { return this.b.env; }
  finish() { this.done = true; }
}

// ------------------------------------------------------------------ idles

class IdleAct extends Act {
  name = 'idle';
  private lookT = 0;
  constructor(b: Brain, private dur: number, private pose: string = 'stand', private watchOwner = false) { super(b); }
  start() {
    this.rig.setPose(this.pose, this.pose === 'stand' ? 6 : 4);
    this.b.posture = postureOf(this.pose);
    this.dog.stop();
  }
  step(dt: number) {
    this.lookT -= dt;
    if (this.lookT <= 0) {
      this.lookT = 1.2 + Math.random() * 2.5;
      if (this.watchOwner || Math.random() < 0.45 + this.b.attention * 0.4) {
        this.b.lookAtCamera(0.9);
      } else {
        const p = this.dog.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 0.5, (Math.random() - 0.3) * 3));
        this.rig.look = { point: p, weight: 0.8 };
      }
      if (Math.random() < 0.15) this.rig.headTilt = (Math.random() - 0.5) * 0.5;
      else this.rig.headTilt = 0;
    }
    if (this.t > this.dur) this.finish();
  }
  stop() { this.rig.headTilt = 0; }
}

class WanderAct extends Act {
  name = 'wander';
  start() {
    const p = this.dog.randomPoint(1.6, this.b.home());
    this.b.posture = 'stand';
    this.rig.setPose('stand', 6);
    this.dog.goTo(p, { speed: 0.22 + Math.random() * 0.2, arrive: 0.08, onArrive: () => this.finish() });
    this.rig.look = { point: null, weight: 0 };
  }
  step() {
    if (this.t > 10) this.finish();
  }
  stop() { this.dog.stop(); }
}

class SniffAct extends Act {
  name = 'sniff';
  private phase = 0;
  private sniffT = 0;
  start() {
    const p = this.dog.randomPoint(1.0, this.b.home());
    this.b.posture = 'stand';
    this.rig.setPose('sniff', 5);
    this.dog.goTo(p, { speed: 0.15, arrive: 0.1, onArrive: () => { this.phase = 1; this.t = 0; } });
  }
  step(dt: number) {
    this.sniffT -= dt;
    if (this.sniffT < 0) {
      this.sniffT = 0.6 + Math.random() * 0.6;
      this.env.sound(this.dog, 'sniff');
    }
    this.rig.overlay.head = [Math.sin(this.b.time * 9) * 0.04, Math.sin(this.b.time * 2.3) * 0.2, 0];
    if (this.phase === 1 && this.t > 2.5) this.finish();
    if (this.t > 9) this.finish();
  }
  stop() { delete this.rig.overlay.head; this.dog.stop(); this.rig.setPose('stand'); }
}

class ScratchAct extends Act {
  name = 'scratch';
  start() { this.rig.setPose('scratch', 6); this.b.posture = 'other'; this.dog.stop(); }
  step() {
    const s = Math.sin(this.b.time * 22) * 0.35;
    this.rig.overlay['shin_L'] = [s, 0, 0];
    this.rig.overlay['meta_L'] = [-s * 0.6, 0, 0];
    this.rig.eyesClosed = 0.6;
    if (this.t > 2.2) this.finish();
  }
  stop() { delete this.rig.overlay['shin_L']; delete this.rig.overlay['meta_L']; this.rig.eyesClosed = 0; this.rig.setPose('sit', 5); this.b.posture = 'sit'; }
}

class StretchAct extends Act {
  name = 'stretch';
  start() { this.rig.setPose('bow', 3); this.b.posture = 'other'; this.dog.stop(); }
  step() {
    if (this.t > 0.6 && this.t < 0.7) this.env.sound(this.dog, 'yawn');
    this.rig.mouthOpen = this.t > 0.6 && this.t < 1.6 ? 1 : 0;
    this.rig.eyesClosed = this.t > 0.6 && this.t < 1.6 ? 0.8 : 0;
    if (this.t > 2.4) this.finish();
  }
  stop() { this.rig.mouthOpen = 0; this.rig.eyesClosed = 0; this.rig.setPose('stand', 4); this.b.posture = 'stand'; }
}

class BarkAct extends Act {
  name = 'bark';
  private barks = 0;
  private next = 0.3;
  constructor(b: Brain, private count = 2, private at?: THREE.Vector3) { super(b); }
  start() {
    this.dog.stop();
    if (this.at) this.rig.look = { point: this.at, weight: 1 };
    else this.b.lookAtCamera(1);
    this.rig.earPerk = 1;
  }
  step() {
    if (this.t > this.next && this.barks < this.count) {
      this.barks++;
      this.next = this.t + 0.45 + Math.random() * 0.25;
      this.env.sound(this.dog, this.dog.size < 0.22 ? 'yip' : 'bark');
      this.rig.mouthOpen = 1;
      this.rig.overlay.head = [-0.15, 0, 0];
      this.b.onBark();
    }
    if (this.t > this.next - 0.3) { this.rig.mouthOpen = 0; delete this.rig.overlay.head; }
    if (this.barks >= this.count && this.t > this.next - 0.1) this.finish();
  }
  stop() { this.rig.mouthOpen = 0; delete this.rig.overlay.head; this.rig.earPerk = 0; }
}

class SleepAct extends Act {
  name = 'sleep';
  priority = 1;
  private phase = 0;
  private zT = 0;
  start() {
    const bed = this.env.bed;
    if (bed && this.env.roam) {
      this.rig.setPose('stand');
      this.dog.goTo(bed, { speed: 0.25, arrive: 0.12, onArrive: () => this.lieDown() });
    } else this.lieDown();
  }
  private lieDown() {
    this.phase = 1;
    this.t = 0;
    this.rig.setPose('lie', 2.5);
    this.b.posture = 'down';
  }
  step(dt: number) {
    if (this.phase === 1 && this.t > 2) {
      this.phase = 2;
      this.rig.setPose('sleep', 1.2);
      this.b.posture = 'other';
    }
    if (this.phase === 2) {
      this.rig.eyesClosed = 1;
      this.rig.wagAmp = 0;
      this.rig.look = { point: null, weight: 0 };
      this.zT -= dt;
      if (this.zT < 0) { this.zT = 2.5; this.env.emote(this.dog, 'zzz'); }
      this.b.save.energy = clamp(this.b.save.energy + dt * 1.2);
      if (this.b.save.energy > 95 && this.t > 20) this.finish();
    }
  }
  wake() {
    this.rig.eyesClosed = 0;
    this.finish();
  }
  stop() { this.rig.eyesClosed = 0; this.dog.stop(); this.rig.setPose('stand', 3); this.b.posture = 'stand'; }
}

// ------------------------------------------------------------------ owner interactions

class ComeAct extends Act {
  name = 'come';
  priority = 3;
  private arrived = false;
  start() {
    this.rig.setPose('stand', 8);
    this.b.posture = 'stand';
    this.rig.earPerk = 1;
    this.b.excite = Math.max(this.b.excite, 0.6);
    const spot = this.env.playerSpot();
    this.dog.goTo(spot, {
      speed: this.dog.size * 4.2, arrive: 0.1, faceAfter: this.env.cameraPos(),
      onArrive: () => { this.arrived = true; this.t = 0; },
    });
  }
  step() {
    this.b.lookAtCamera(this.arrived ? 1 : 0.6);
    if (this.arrived) {
      if (this.t > 0.6 && this.b.posture !== 'sit' && Math.random() < 0.5) { this.rig.setPose('sit', 5); this.b.posture = 'sit'; }
      if (this.t > 3.5) this.finish();
    } else if (this.t > 8) this.finish();
  }
  stop() { this.rig.earPerk = 0; this.dog.stop(); }
}

class FollowHandAct extends Act {
  name = 'hand';
  priority = 2;
  private lickT = 0;
  private following = false;
  start() { this.rig.setPose('stand', 6); this.b.posture = 'stand'; }
  step(dt: number) {
    const h = this.b.hand;
    if (!h) { if (this.t > 0.8) this.finish(); return; }
    this.t = 0;
    const floor = new THREE.Vector3(h.x, this.dog.floorY, h.z);
    const d = this.dog.distanceTo(floor);
    const reach = this.dog.model.design.dims.BL * 0.9;
    this.rig.look = { point: h, weight: 1 };
    // hysteresis so the pup doesn't stop-start right at the edge of reach
    if (this.following ? d > reach * 0.85 : d > reach * 1.25) {
      this.following = true;
      const dir = floor.clone().sub(this.dog.position).setY(0).normalize();
      const goal = floor.clone().addScaledVector(dir, -reach * 0.75);
      this.dog.goTo(goal, { speed: Math.min(this.dog.size * 3.5, 0.3 + d * 1.2), arrive: 0.04 });
    } else {
      this.following = false;
      this.dog.stop();
      this.dog.face(floor);
      this.lickT -= dt;
      if (this.lickT < 0) {
        this.lickT = 0.8 + Math.random();
        this.env.sound(this.dog, Math.random() < 0.5 ? 'sniff' : 'happy');
        this.rig.tongueOut = Math.random() < 0.4 ? 1 : 0;
      }
    }
  }
  stop() { this.rig.tongueOut = 0; this.dog.stop(); }
}

class PettedAct extends Act {
  name = 'petted';
  priority = 4;
  private idle = 0;
  private sparkT = 0;
  private rolled = false;
  private strokeSum = 0;
  start() {
    this.dog.stop();
    if (this.b.posture === 'stand' && Math.random() < 0.35) { this.rig.setPose('sit', 4); this.b.posture = 'sit'; }
  }
  step(dt: number) {
    const b = this.b;
    const p = b.pet;
    if (!p || p.idle > 0.25) this.idle += dt; else this.idle = 0;
    if (this.idle > 1.6) { this.finish(); return; }
    const pleasure = b.petPleasure;
    this.rig.happy = Math.min(1, pleasure * 1.4);
    this.rig.eyesClosed = pleasure > 0.6 ? 0.55 : 0;
    this.rig.earPerk = -Math.min(1, pleasure * 1.2);
    this.rig.headTilt = p ? Math.sin(b.time * 0.9) * 0.18 * pleasure : 0;
    if (p) {
      this.rig.look = { point: p.point, weight: 0.35 };
      this.strokeSum += p.speed * dt;
    }
    this.sparkT -= dt;
    if (p && p.speed > 0.08 && this.sparkT < 0) {
      this.sparkT = 0.35;
      this.env.emote(this.dog, pleasure > 0.5 ? 'heart' : 'sparkle');
      if (Math.random() < 0.25) this.env.sound(this.dog, 'happy');
    }
    // lots of belly or chest rubbing gets the pup to flop over
    if (!this.rolled && p && (p.region === 'belly' || p.region === 'side' || p.region === 'chest') && this.strokeSum > 1.2 && b.save.affection > 15) {
      this.rolled = true;
      this.rig.setPose('belly', 3);
      b.posture = 'other';
      this.env.sound(this.dog, 'happy');
    }
  }
  stop() {
    this.rig.happy = 0;
    this.rig.eyesClosed = 0;
    this.rig.earPerk = 0;
    this.rig.headTilt = 0;
    if (this.rolled) { this.rig.setPose('lie', 3); this.b.posture = 'down'; }
  }
}

class EatAct extends Act {
  name = 'eat';
  priority = 2;
  private eating = false;
  private chewT = 0;
  constructor(b: Brain, private water: boolean) { super(b); }
  start() {
    const bowl = this.water ? this.env.waterBowl : this.env.foodBowl;
    if (!bowl) { this.finish(); return; }
    this.rig.setPose('stand', 6);
    this.b.posture = 'stand';
    const dir = this.dog.position.clone().sub(bowl.pos).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    const d = this.dog.model.design.dims;
    const reach = (d.noseTip[2] - d.shZ) + d.shZ * 0.55 + 0.04;
    const spot = bowl.pos.clone().addScaledVector(dir, reach);
    this.dog.goTo(spot, {
      speed: this.dog.size * 3, arrive: 0.04, faceAfter: bowl.pos,
      onArrive: () => { this.eating = true; this.t = 0; this.rig.setPose('eat', 4); },
    });
  }
  step(dt: number) {
    const bowl = this.water ? this.env.waterBowl : this.env.foodBowl;
    if (!bowl) { this.finish(); return; }
    this.rig.look = { point: bowl.pos, weight: 0.3 };
    if (!this.eating) { if (this.t > 10) this.finish(); return; }
    if (this.dog.faceTarget) return;
    this.chewT -= dt;
    if (this.chewT < 0) {
      this.chewT = this.water ? 0.28 : 0.45;
      this.env.sound(this.dog, this.water ? 'lap' : 'crunch');
    }
    this.rig.mouthOpen = 0.5 + 0.5 * Math.sin(this.b.time * (this.water ? 22 : 12));
    this.rig.tongueOut = this.water ? 0.6 : 0;
    this.rig.overlay.head = [Math.sin(this.b.time * 12) * 0.05, 0, 0];
    const rate = dt * 0.12;
    const s = this.b.save;
    if (this.water) {
      bowl.fill() > 0 && (this.env.waterBowl!.drink(rate), s.thirst = clamp(s.thirst + rate * 170));
      if (s.thirst >= 99 || bowl.fill() <= 0 || this.t > 9) this.finish();
    } else {
      bowl.fill() > 0 && (this.env.foodBowl!.eat(rate * 0.8), s.hunger = clamp(s.hunger + rate * 140));
      if (s.hunger >= 99 || bowl.fill() <= 0 || this.t > 12) this.finish();
    }
  }
  stop() {
    this.rig.mouthOpen = 0;
    this.rig.tongueOut = 0;
    delete this.rig.overlay.head;
    this.rig.setPose('stand', 5);
    this.dog.stop();
    if (this.eating) { this.b.excite = 0.4; this.env.event?.(this.water ? 'drank' : 'ate'); this.rig.tongueOut = 1; setTimeout(() => (this.rig.tongueOut = 0), 900); }
  }
}

// ------------------------------------------------------------------ toys

class ChaseAct extends Act {
  name = 'chase';
  priority = 3;
  private phase: 'chase' | 'return' | 'drop' = 'chase';
  private keepAway = false;
  constructor(b: Brain, private toy: WorldToy) { super(b); }
  start() {
    this.rig.setPose('stand', 10);
    this.b.posture = 'stand';
    this.rig.earPerk = 1;
    this.b.excite = 1;
    this.keepAway = Math.random() < 0.12 * this.b.save.playful;
  }
  step(dt: number) {
    const toy = this.toy;
    const dog = this.dog;
    if (toy.inHand || (toy.carrier && toy.carrier !== dog)) { this.finish(); return; }
    if (this.phase === 'chase') {
      const tp = toy.object.getWorldPosition(new THREE.Vector3());
      this.rig.look = { point: tp, weight: 1 };
      // lead a moving toy slightly
      const lead = tp.clone().addScaledVector(new THREE.Vector3(toy.velocity.x, 0, toy.velocity.z), 0.25);
      const speed = this.dog.size * 6.5 * (0.7 + this.b.save.energy / 330);
      dog.goTo(lead, { speed, arrive: 0.02 });
      const mouth = dog.mouthWorld(new THREE.Vector3());
      const d = mouth.distanceTo(tp);
      // jump for discs in the air
      if (toy.object.position.y > dog.size * 0.8 && d < dog.size * 1.6 && toy.velocity.y < 0.5 && !dog.jump && toy.kind.includes('isc')) {
        const land = tp.clone().setY(dog.floorY).addScaledVector(new THREE.Vector3(toy.velocity.x, 0, toy.velocity.z), 0.3);
        dog.jumpTo(land, Math.min(0.8, tp.y - dog.size * 0.6), 0.45);
      }
      const nearFloor = dog.distanceTo(tp) < dog.model.design.dims.BL * 0.9;
      if (d < Math.max(0.08, toy.radius + 0.05) || (nearFloor && toy.resting && dog.distanceTo(tp) < dog.model.design.dims.noseTip[2] + 0.05)) {
        this.grab();
      }
      if (this.t > 15) this.finish();
    } else if (this.phase === 'return') {
      this.b.lookAtCamera(0.7);
      if (this.keepAway && this.t < 3) {
        if (!dog.moving) dog.goTo(dog.randomPoint(1.4, this.b.home()), { speed: dog.size * 4, arrive: 0.1 });
        return;
      }
      const spot = this.env.playerSpot();
      dog.goTo(spot, {
        speed: dog.size * 4, arrive: 0.12, faceAfter: this.env.cameraPos(),
        onArrive: () => { this.phase = 'drop'; this.t = 0; },
      });
      if (this.t > 12) { this.phase = 'drop'; this.t = 0; }
    } else {
      this.b.lookAtCamera(1);
      if (this.t > 0.7 && toy.carrier === dog) {
        this.rig.mouthOpen = 0.6;
        this.env.releaseToy?.(toy, dog);
        this.b.excite = 0.8;
        this.env.event?.('fetched');
      }
      if (this.t > 1.4) this.finish();
    }
  }
  private grab() {
    this.env.pickUpToy?.(this.toy, this.dog);
    this.phase = 'return';
    this.t = 0;
    this.rig.overlay.head = [0, 0, 0];
    if (this.toy.squeaky) this.env.event?.('squeak');
  }
  stop() {
    this.rig.mouthOpen = 0;
    this.rig.earPerk = 0;
    delete this.rig.overlay.head;
    this.dog.stop();
  }
}

class PlayToyAct extends Act {
  name = 'playtoy';
  private phase = 0;
  constructor(b: Brain, private toy: WorldToy) { super(b); }
  start() {
    this.rig.setPose('stand', 6);
    this.b.posture = 'stand';
  }
  step() {
    const toy = this.toy;
    if (toy.inHand || (toy.carrier && toy.carrier !== this.dog)) { this.finish(); return; }
    const tp = toy.object.getWorldPosition(new THREE.Vector3());
    if (this.phase === 0) {
      this.rig.look = { point: tp, weight: 1 };
      this.dog.goTo(tp, { speed: this.dog.size * 2.5, arrive: this.dog.model.design.dims.noseTip[2] * 0.9 });
      if (this.dog.distanceTo(tp) < this.dog.model.design.dims.noseTip[2] + 0.04 || !this.dog.moving) {
        this.env.pickUpToy?.(toy, this.dog);
        this.phase = 1;
        this.t = 0;
        this.rig.setPose(Math.random() < 0.5 ? 'lie' : 'stand', 4);
      }
      if (this.t > 8) this.finish();
    } else {
      // shake it about / chew
      this.rig.overlay.head = [Math.sin(this.b.time * 5) * 0.1, Math.sin(this.b.time * 13) * 0.35 * (this.t < 1.2 ? 1 : 0.2), 0];
      this.rig.mouthOpen = 0.3 + 0.3 * Math.sin(this.b.time * 8);
      this.b.excite = 0.5;
      if (this.t > 3 + Math.random()) this.finish();
    }
  }
  stop() {
    delete this.rig.overlay.head;
    this.rig.mouthOpen = 0;
    if (this.toy.carrier === this.dog) this.env.releaseToy?.(this.toy, this.dog);
    this.dog.stop();
  }
}

class TugAct extends Act {
  name = 'tug';
  priority = 4;
  private gripped = false;
  constructor(b: Brain, private toy: WorldToy, private endWorld: () => THREE.Vector3) { super(b); }
  start() {
    this.rig.setPose('stand', 8);
    this.b.posture = 'stand';
    this.b.excite = 1;
  }
  step(dt: number) {
    const end = this.endWorld();
    this.rig.look = { point: end, weight: 1 };
    const dog = this.dog;
    if (!this.toy.inHand) { this.finish(); return; }
    const floor = end.clone().setY(dog.floorY);
    const d = dog.distanceTo(floor);
    const reach = dog.model.design.dims.noseTip[2] + 0.02;
    if (!this.gripped) {
      dog.goTo(floor, { speed: dog.size * 4, arrive: reach });
      if (d < reach + 0.05) { this.gripped = true; this.b.onTugGrip(); }
    } else {
      // pull back with head shakes and a growl now and then
      dog.face(floor);
      this.rig.setPose('bow', 5);
      this.rig.overlay.head = [0.1, Math.sin(this.b.time * 11) * 0.3, Math.sin(this.b.time * 7) * 0.15];
      this.rig.overlay.body = [0, 0, Math.sin(this.b.time * 11) * 0.05];
      if (Math.random() < dt * 0.5) this.env.sound(dog, 'growl');
      if (d > reach + 0.2) dog.goTo(floor, { speed: dog.size * 3, arrive: reach });
      else if (d < reach - 0.05) {
        const back = dog.position.clone().addScaledVector(dog.forward, -0.1);
        dog.goTo(back, { speed: 0.2, arrive: 0.02 });
      }
    }
    if (this.t > 30) this.finish();
  }
  stop() {
    delete this.rig.overlay.head;
    delete this.rig.overlay.body;
    this.rig.setPose('stand', 5);
    this.dog.stop();
    this.b.onTugRelease();
  }
}

// ------------------------------------------------------------------ tricks

class TrickAct extends Act {
  name = 'trick';
  priority = 5;
  private stage = 0;
  constructor(b: Brain, readonly trick: TrickId, private hold = 2.5, private onDone?: () => void) { super(b); }
  start() {
    this.dog.stop();
    this.b.lookAtCamera(1);
    // tricks that need a different starting posture chain through it
    const from = startPose(this.trick);
    if (from === 'sit' && this.b.posture !== 'sit') { this.rig.setPose('sit', 7); this.b.posture = 'sit'; this.stage = -0.6; }
    else if (from === 'down' && this.b.posture !== 'down') {
      if (this.b.posture !== 'sit') this.rig.setPose('sit', 8);
      this.stage = -1.0;
    } else if (from === 'stand' && this.b.posture !== 'stand') { this.rig.setPose('stand', 7); this.b.posture = 'stand'; this.stage = -0.5; }
  }
  step(dt: number) {
    const tr = this.trick;
    const rig = this.rig;
    if (this.stage < 0) {
      if (startPose(tr) === 'down' && this.t > 0.45 && this.b.posture !== 'down') { rig.setPose('lie', 6); this.b.posture = 'down'; }
      if (this.t > -this.stage) { this.stage = 0; this.t = 0; }
      return;
    }
    if (this.stage === 0) {
      this.stage = 1;
      this.t = 0;
      switch (tr) {
        case 'sit': rig.setPose('sit', 7); this.b.posture = 'sit'; break;
        case 'down': rig.setPose('lie', 6); this.b.posture = 'down'; break;
        case 'shake': rig.setPose('shake', 6); break;
        case 'beg': rig.setPose('beg', 5); break;
        case 'bow': rig.setPose('bow', 6); rig.earPerk = 0.6; break;
        case 'standup': rig.setPose('standUp', 4); break;
        case 'playdead': rig.setPose('playdead', 3.5); rig.eyesClosed = 1; rig.tongueOut = 1; break;
        case 'speak': break;
        case 'howl': rig.setPose('howl', 4); break;
        case 'jump': rig.setPose('jump', 12); break;
        case 'rollover': rig.setPose('belly', 7); break;
        case 'spin': rig.setPose('stand', 8); break;
      }
    }
    const t = this.t;
    switch (tr) {
      case 'rollover': {
        const dur = 1.3;
        const f = Math.min(1, t / dur);
        rig.rootRoll = f * Math.PI * 2 * (f < 1 ? 1 : 0);
        rig.overlay.body = [0, 0, 0];
        if (f >= 1) { rig.rootRoll = 0; rig.setPose('lie', 5); this.b.posture = 'down'; if (t > dur + 0.8) this.end(); }
        return;
      }
      case 'spin': {
        const dur = 1.4;
        if (t < dur) {
          this.dog.heading += dt * (Math.PI * 2 / dur);
        } else if (t > dur + 0.5) this.end();
        return;
      }
      case 'jump': {
        if (t < 0.55) rig.rootLift = Math.sin((t / 0.55) * Math.PI) * this.dog.size * 1.1;
        else { rig.rootLift = 0; rig.setPose('stand', 8); this.b.posture = 'stand'; if (t > 1.0) this.end(); }
        if (t < 0.02) this.env.sound(this.dog, 'yip');
        return;
      }
      case 'speak': {
        if (t < 0.02) this.b.startAct(new BarkAct(this.b, 2));
        return;
      }
      case 'howl': {
        if (t > 0.5 && t < 0.52) this.env.sound(this.dog, 'howl');
        rig.mouthOpen = t > 0.5 && t < 2.8 ? 0.5 + Math.sin(t * 3) * 0.1 : 0;
        rig.eyesClosed = t > 0.5 && t < 2.8 ? 0.5 : 0;
        if (t > 3.2) { rig.setPose('sit', 5); this.b.posture = 'sit'; this.end(); }
        return;
      }
      case 'standup': {
        rig.overlay.body = [Math.sin(t * 4) * 0.05, 0, Math.sin(t * 2.7) * 0.06];
        if (t > this.hold) { delete rig.overlay.body; rig.setPose('stand', 5); this.b.posture = 'stand'; if (t > this.hold + 0.6) this.end(); }
        return;
      }
      case 'shake': {
        rig.overlay['upperarm_L'] = [Math.sin(t * 6) * 0.08, 0, 0];
        if (t > this.hold * 0.8) { delete rig.overlay['upperarm_L']; rig.setPose('sit', 6); this.b.posture = 'sit'; if (t > this.hold * 0.8 + 0.5) this.end(); }
        return;
      }
      case 'beg': {
        rig.overlay['forearm_L'] = [Math.sin(t * 7) * 0.2, 0, 0];
        rig.overlay['forearm_R'] = [Math.sin(t * 7 + 1) * 0.2, 0, 0];
        if (t > this.hold) { delete rig.overlay['forearm_L']; delete rig.overlay['forearm_R']; rig.setPose('sit', 5); this.b.posture = 'sit'; if (t > this.hold + 0.5) this.end(); }
        return;
      }
      case 'bow':
        if (t > this.hold * 0.7) { rig.setPose('stand', 5); this.b.posture = 'stand'; rig.earPerk = 0; if (t > this.hold * 0.7 + 0.5) this.end(); }
        return;
      case 'playdead':
        if (t > this.hold + 1) { rig.eyesClosed = 0; rig.tongueOut = 0; rig.setPose('lie', 3); this.b.posture = 'down'; if (t > this.hold + 1.8) this.end(); }
        return;
      default:
        if (t > this.hold) this.end();
    }
  }
  private end() {
    if (!this.done) { this.finish(); this.onDone?.(); }
  }
  stop() {
    const rig = this.rig;
    rig.rootRoll = 0;
    rig.rootLift = 0;
    rig.eyesClosed = 0;
    rig.tongueOut = 0;
    rig.mouthOpen = 0;
    for (const k of ['body', 'upperarm_L', 'forearm_L', 'forearm_R']) delete rig.overlay[k];
  }
}

/** Holds a guided pose while training, waiting for the owner's word. */
class TrainHoldAct extends Act {
  name = 'trainhold';
  priority = 6;
  constructor(b: Brain, readonly trick: TrickId, readonly holdFor = 7) { super(b); }
  start() {
    this.dog.stop();
    const rig = this.rig;
    switch (this.trick) {
      case 'sit': rig.setPose('sit', 6); this.b.posture = 'sit'; break;
      case 'down': rig.setPose('lie', 5); this.b.posture = 'down'; break;
      case 'shake': rig.setPose('shake', 6); break;
      case 'beg': rig.setPose('beg', 5); break;
      case 'bow': rig.setPose('bow', 6); break;
      case 'standup': rig.setPose('standUp', 4); break;
      case 'playdead': rig.setPose('playdead', 4); rig.eyesClosed = 1; break;
      case 'rollover': rig.setPose('belly', 4); break;
      default: break;
    }
  }
  step(dt: number) {
    this.b.lookAtCamera(0.8);
    if (this.trick === 'rollover' && this.t < 1.3) this.rig.rootRoll = (this.t / 1.3) * Math.PI * 2;
    else if (this.trick === 'rollover') { this.rig.rootRoll = 0; this.rig.setPose('lie', 5); this.b.posture = 'down'; }
    if (this.trick === 'spin' && this.t < 1.4) this.dog.heading += (Math.PI * 2 / 1.4) * dt;
    if (this.trick === 'jump') this.rig.rootLift = this.t < 0.55 ? Math.sin((this.t / 0.55) * Math.PI) * this.dog.size * 1.1 : 0;
    if (this.t > this.holdFor) this.finish();
  }
  stop() {
    this.rig.rootRoll = 0;
    this.rig.rootLift = 0;
    this.rig.eyesClosed = 0;
    if (this.trick === 'playdead' || this.trick === 'rollover') { this.rig.setPose('lie', 4); this.b.posture = 'down'; }
    if (['shake', 'beg'].includes(this.trick)) { this.rig.setPose('sit', 5); this.b.posture = 'sit'; }
    if (['bow', 'standup', 'jump', 'spin'].includes(this.trick)) { this.rig.setPose('stand', 5); this.b.posture = 'stand'; }
  }
}

class ShakeOffAct extends Act {
  name = 'shakeoff';
  priority = 3;
  start() { this.dog.stop(); this.rig.setPose('shakeOff', 8); this.env.event?.('shakeoff'); }
  step() {
    const t = this.t;
    const a = Math.sin(t * 38) * Math.min(1, t * 3) * Math.max(0, 1 - (t - 0.9) * 2);
    this.rig.overlay.body = [0, 0, a * 0.18];
    this.rig.overlay.chest = [0, a * 0.2, a * 0.25];
    this.rig.overlay.head = [0, a * 0.6, a * 0.5];
    this.rig.overlay.pelvis = [0, -a * 0.15, -a * 0.2];
    this.rig.eyesClosed = 0.8;
    if (t > 1.5) this.finish();
  }
  stop() {
    for (const k of ['body', 'chest', 'head', 'pelvis']) delete this.rig.overlay[k];
    this.rig.eyesClosed = 0;
    this.rig.setPose('stand', 5);
    this.b.posture = 'stand';
  }
}

function startPose(t: TrickId): 'stand' | 'sit' | 'down' | 'any' {
  switch (t) {
    case 'shake': case 'beg': return 'sit';
    case 'rollover': case 'playdead': return 'down';
    case 'spin': case 'standup': case 'jump': case 'bow': return 'stand';
    case 'down': return 'down';
    default: return 'any';
  }
}

function postureOf(pose: string): Posture {
  if (pose === 'stand' || pose === 'sniff') return 'stand';
  if (pose === 'sit') return 'sit';
  if (pose === 'lie') return 'down';
  return 'other';
}

// ------------------------------------------------------------------ brain

export interface PetState {
  point: THREE.Vector3;
  region: DogRegion;
  speed: number; // m/s of the stroke across the fur
  idle: number; // seconds since the last movement
}

export class Brain {
  act: Act | null = null;
  posture: Posture = 'stand';
  time = 0;
  excite = 0;
  attention = 0.5;
  hand: THREE.Vector3 | null = null;
  pet: PetState | null = null;
  petPleasure = 0;
  private boredom = 0;
  private barkCooldown = 5;
  enabled = true;
  /** where the dog hangs around when idle */
  homeSpot: THREE.Vector3 | null = null;
  onBarkListeners: (() => void)[] = [];
  /** fired when the pup does a trick-like thing on its own (e.g. a play bow while stretching) */
  onSpontaneous: ((trick: TrickId) => void) | null = null;
  tugging = false;
  /** training: stay put, keep the current posture and watch the owner */
  attentive = false;

  constructor(readonly actor: DogActor, readonly save: DogSave, public env: BrainEnv) {}

  home() {
    return this.homeSpot || this.actor.position;
  }

  startAct(a: Act) {
    if (this.act && !this.act.done) this.act.stop();
    this.act = a;
    a.start();
  }

  get activity() { return this.act && !this.act.done ? this.act.name : 'none'; }

  lookAtCamera(weight = 1) {
    this.actor.rig.look = { point: this.env.cameraPos(), weight };
  }

  // ----- events from the scene -----

  /** Owner said the dog's name or whistled. */
  call() {
    if (this.act instanceof SleepAct) { (this.act as SleepAct).wake(); }
    this.startAct(new ComeAct(this));
    this.env.emote(this.actor, 'exclaim');
    this.excite = Math.max(this.excite, 0.7);
  }

  /** Name not recognised: look confused. */
  confused() {
    this.actor.rig.headTilt = 0.35;
    this.env.emote(this.actor, 'question');
    this.lookAtCamera(1);
    setTimeout(() => (this.actor.rig.headTilt = 0), 1500);
  }

  setHand(p: THREE.Vector3 | null) {
    this.hand = p ? (this.hand || new THREE.Vector3()).copy(p) : null;
    if (p && this.act?.name !== 'hand' && (this.act?.priority ?? 0) < 3 && !(this.act instanceof SleepAct)) {
      this.startAct(new FollowHandAct(this));
    }
  }

  setPet(p: PetState | null) {
    this.pet = p;
    if (p && !(this.act instanceof PettedAct) && (this.act?.priority ?? 0) < 5) {
      if (this.act instanceof SleepAct) (this.act as SleepAct).wake();
      this.startAct(new PettedAct(this));
    }
  }

  toyThrown(toy: WorldToy) {
    if (this.save.energy < 8) { this.env.emote(this.actor, 'sweat'); return; }
    if (this.act instanceof SleepAct) return;
    if ((this.act?.priority ?? 0) >= 5) return;
    this.startAct(new ChaseAct(this, toy));
  }

  startTug(toy: WorldToy, end: () => THREE.Vector3) {
    this.startAct(new TugAct(this, toy, end));
  }
  onTugGrip() { this.tugging = true; this.env.event?.('tugGrip'); }
  onTugRelease() { this.tugging = false; }

  bowlFilled(water: boolean) {
    const s = this.save;
    const need = water ? s.thirst < 85 : s.hunger < 85;
    if (need && (this.act?.priority ?? 0) <= 3 && !(this.act instanceof ChaseAct)) {
      if (this.act instanceof SleepAct) (this.act as SleepAct).wake();
      this.env.emote(this.actor, 'exclaim');
      this.startAct(new EatAct(this, water));
    }
  }

  performTrick(trick: TrickId, onDone?: () => void) {
    if (this.act instanceof SleepAct) (this.act as SleepAct).wake();
    this.startAct(new TrickAct(this, trick, 2.5, onDone));
  }

  trainHold(trick: TrickId) {
    this.startAct(new TrainHoldAct(this, trick));
  }

  endTrainHold() {
    if (this.act instanceof TrainHoldAct) this.act.finish();
  }

  shakeOff() { this.startAct(new ShakeOffAct(this)); }

  sit() { this.startAct(new IdleAct(this, 4, 'sit', true)); }

  /** Go back to a posture (used between training repetitions). */
  resetPosture(p: 'stand' | 'sit' | 'down') {
    this.startAct(new IdleAct(this, 3, p === 'down' ? 'lie' : p, true));
  }

  onBark() {
    for (const l of this.onBarkListeners) l();
  }

  // ----- tick -----

  update(dt: number) {
    this.time += dt;
    const s = this.save;
    const rig = this.actor.rig;
    if (this.act && this.act.done) { this.act.stop(); this.act = null; }
    if (this.act) {
      this.act.t += dt;
      this.act.step(dt);
    } else if (this.enabled) {
      this.chooseIdle();
    }

    // petting pleasure builds with gentle strokes and fades otherwise
    if (this.pet && this.pet.idle < 0.3) {
      const good = this.pet.region === 'tail' || this.pet.region === 'ear' ? 0.2 : 1;
      this.petPleasure = Math.min(1, this.petPleasure + dt * Math.min(1.5, this.pet.speed * 2.5) * good);
      s.mood = clamp(s.mood + dt * 4 * good);
      s.affection = clamp(s.affection + dt * 0.25 * good);
    } else {
      this.petPleasure = Math.max(0, this.petPleasure - dt * 0.5);
    }

    // needs
    const moving = this.actor.speed;
    s.energy = clamp(s.energy - dt * (0.02 + moving * 0.35));
    this.excite = Math.max(0, this.excite - dt * 0.15);
    this.boredom += dt;

    // expression
    const happy = s.mood / 100;
    const tired = s.energy < 25 ? 1 : 0;
    const wag = this.act instanceof SleepAct ? 0 : 0.12 + happy * 0.25 + this.excite * 0.45 + this.petPleasure * 0.3;
    rig.wagAmp += (wag - rig.wagAmp) * Math.min(1, dt * 3);
    rig.wagFreq = 2.2 + this.excite * 5 + this.petPleasure * 2;
    rig.tailRaise = (happy - 0.4) * 0.4 + this.excite * 0.4 - tired * 0.3;
    rig.panting = Math.max(this.actor.exertion > 0.3 ? this.actor.exertion : 0, this.excite > 0.75 ? (this.excite - 0.75) * 3 : 0);
    if (this.act instanceof EatAct || this.act instanceof SleepAct || this.act instanceof ChaseAct || this.act instanceof TugAct) rig.panting = this.act instanceof ChaseAct ? rig.panting : 0;

    // occasional barks for attention when neglected or excited
    this.barkCooldown -= dt;
    if (this.barkCooldown < 0 && this.act?.name === 'idle' && Math.random() < dt * 0.05 * (0.5 + this.excite + this.boredom / 60)) {
      this.barkCooldown = 15 + Math.random() * 20;
      this.startAct(new BarkAct(this, 1 + Math.floor(Math.random() * 3)));
    }
  }

  private chooseIdle() {
    const s = this.save;
    const env = this.env;
    const r = Math.random();
    if (this.attentive) {
      // mostly wait for guidance; now and then stretch into a play bow or bark
      if (r < 0.06 && this.posture === 'stand') { this.startAct(new StretchAct(this)); this.onSpontaneous?.('bow'); return; }
      const pose = this.posture === 'sit' ? 'sit' : this.posture === 'down' ? 'lie' : 'stand';
      this.startAct(new IdleAct(this, 2 + Math.random() * 2, pose, true));
      return;
    }
    if (s.energy < 18 && env.roam) { this.startAct(new SleepAct(this)); return; }
    if (env.waterBowl && s.thirst < 70 && env.waterBowl.fill() > 0.05 && (s.thirst < 45 || r < 0.6)) { this.startAct(new EatAct(this, true)); return; }
    if (env.foodBowl && s.hunger < 70 && env.foodBowl.fill() > 0.05 && (s.hunger < 45 || r < 0.6)) { this.startAct(new EatAct(this, false)); return; }
    if (!env.roam) { this.startAct(new IdleAct(this, 2 + Math.random() * 3, Math.random() < 0.4 ? 'sit' : 'stand', true)); return; }
    const toys = env.toys().filter((t) => !t.inHand && !t.carrier && t.resting);
    const roll = Math.random();
    if (toys.length && roll < 0.1 * (0.5 + s.playful)) {
      this.startAct(new PlayToyAct(this, toys[Math.floor(Math.random() * toys.length)]));
      return;
    }
    const opts: [number, () => Act][] = [
      [3, () => new IdleAct(this, 2 + Math.random() * 3, 'stand', this.attention > 0.6)],
      [2.5, () => new IdleAct(this, 3 + Math.random() * 5, 'sit', true)],
      [s.energy < 50 ? 2.5 : 0.8, () => new IdleAct(this, 5 + Math.random() * 8, 'lie')],
      [2, () => new WanderAct(this)],
      [1.2, () => new SniffAct(this)],
      [0.4, () => new ScratchAct(this)],
      [0.4, () => new StretchAct(this)],
    ];
    let total = 0;
    for (const [w] of opts) total += w;
    let pick = Math.random() * total;
    for (const [w, f] of opts) {
      pick -= w;
      if (pick <= 0) { this.startAct(f()); return; }
    }
  }
}

export { wrapAngle };
