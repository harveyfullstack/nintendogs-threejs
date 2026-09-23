// Contracts between the game code and the environment / prop builders.
// Units are metres, +Y is up. A puppy is roughly 0.2-0.35 m tall, so the
// camera usually sits 0.4-1.2 m above the floor looking at the dog.

import type * as THREE from 'three';

export interface Circle { x: number; z: number; r: number }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

/** Common result for every self-contained 3D location. */
export interface Place {
  /** Everything for the location, including its lights. Floor/ground is at y = 0 unless noted. */
  group: THREE.Group;
  /** Optional image-based lighting for reflections (eyes, glossy props). Set on scene.environment. */
  environment?: THREE.Texture;
  /** Optional scene background (colour or texture). */
  background?: THREE.Color | THREE.Texture;
  /** Optional fog. */
  fog?: THREE.Fog | THREE.FogExp2;
  /** The main shadow casting light, if any (the game may move its target to follow the dog). */
  sun?: THREE.DirectionalLight;
  /** Area where dogs can freely walk. */
  bounds: Bounds;
  /** Furniture / trees the dog should walk around. */
  obstacles: Circle[];
  /** Default camera placement. */
  camera: { position: THREE.Vector3; target: THREE.Vector3; fov?: number };
  /** Per-frame animation (water, curtains, clouds, shadow follow). `focus` is where the dog is. */
  update?(dt: number, time: number, focus: THREE.Vector3): void;
  dispose(): void;
}

export interface RoomTheme { id: string; name: string; price: number; blurb: string }

export interface Room extends Place {
  /** Floor points (y = 0). food/water: where bowls go, bed: dog cushion, door: where you leave for walks. */
  spots: { food: THREE.Vector3; water: THREE.Vector3; bed: THREE.Vector3; door: THREE.Vector3; toybox: THREE.Vector3 };
}

export interface Bathroom extends Place {
  /** Centre of the tub floor where the dog stands; y is the tub floor height. */
  tubCenter: THREE.Vector3;
  /** Inner half-size of the tub floor (x, z). */
  tubHalf: { x: number; z: number };
}

export interface Kennel extends Place {
  /** Centre of the puppy pen floor and its inner half-size. Puppies roam inside it. */
  penCenter: THREE.Vector3;
  penHalf: { x: number; z: number };
}

export interface DiscArena extends Place {
  /** Where the player throws from (the dog waits here). Distance lines run along +Z from here. */
  throwLine: THREE.Vector3;
  /** Metres between marked distance lines. */
  lineSpacing: number;
}

export interface ObedienceRing extends Place {
  /** Where the dog starts / sits facing the camera. */
  start: THREE.Vector3;
}

export type AgilityObstacleKind = 'hurdle' | 'tunnel' | 'weave' | 'aframe' | 'tire' | 'start' | 'finish';
export interface AgilityObstacle {
  kind: AgilityObstacleKind;
  /** centre on the ground */
  position: THREE.Vector3;
  /** direction the dog must travel through it (unit vector on XZ) */
  dir: THREE.Vector3;
  /** length along dir (weave poles, tunnel, a-frame) */
  length: number;
  object: THREE.Object3D;
}
export interface AgilityCourse extends Place {
  /** In running order, beginning with 'start' and ending with 'finish'. */
  course: AgilityObstacle[];
}

// ----- Town -------------------------------------------------------------------

export type PoiKind = 'home' | 'park' | 'shop' | 'gym' | 'kennel' | 'secondhand';

export interface TownPoi {
  kind: PoiKind;
  /** block column / row the building (or park) occupies */
  col: number;
  row: number;
  /** which street the entrance faces */
  side: 'n' | 's' | 'e' | 'w';
  name: string;
}

export interface TownLayout {
  cols: number; // number of blocks along x
  rows: number; // number of blocks along z
  block: number; // block side length (m)
  street: number; // total street width including both sidewalks (m)
  sidewalk: number; // width of each sidewalk (m)
  pois: TownPoi[];
}

export interface TownWorld extends Place {}

// ----- Props ------------------------------------------------------------------

export type ToyKind = 'tennisBall' | 'rubberBall' | 'frisbee' | 'rope' | 'squeaky' | 'plushie' | 'bone' | 'goldDisc';

export interface Toy {
  kind: ToyKind;
  object: THREE.Object3D;
  /** radius used for physics / picking (m) */
  radius: number;
  /** 0..1 restitution */
  bounce: number;
  /** true for discs: they glide */
  glide: boolean;
  /** local point on the toy the dog bites (in object space) */
  grip: THREE.Vector3;
  /** for the rope: move its two ends (world or parent space points) and it re-shapes with a sag */
  setEnds?(a: THREE.Vector3, b: THREE.Vector3): void;
  /** optional wobble/squash animation hook, `squeeze` 0..1 when bitten */
  update?(dt: number, squeeze: number): void;
  dispose(): void;
}

export interface Bowl {
  object: THREE.Object3D;
  /** 0 = empty, 1 = full */
  setFill(f: number): void;
  /** for food bowls: which food is shown */
  setFood?(kind: FoodKind): void;
  update?(dt: number, time: number): void;
  /** height of the bowl rim, so the dog knows how far to lower its head */
  rimHeight: number;
  radius: number;
  dispose(): void;
}

export type FoodKind = 'dry' | 'canned' | 'premium' | 'jerky' | 'milk';

export type ItemKind =
  | 'dryFood' | 'cannedFood' | 'premiumFood' | 'jerky' | 'milk' | 'waterBottle'
  | 'brush' | 'shampoo' | 'towel' | 'showerHead' | 'poopBag' | 'present';

export type CollectibleKind =
  | 'oldBoot' | 'seashell' | 'goldNugget' | 'trophy' | 'marble' | 'emptyCan'
  | 'toyCar' | 'pocketWatch' | 'flower' | 'glasses' | 'gem' | 'feather';

export type AccessoryKind = 'collarRed' | 'collarBlue' | 'bandana' | 'ribbon' | 'cap' | 'sunglasses' | 'bowtie' | 'flowerCrown';

/** Measurements of a particular dog so accessories can be fitted. All in the bone's local space. */
export interface AccessoryFit {
  /** radius of the neck (including fur) where a collar sits */
  neckRadius: number;
  /** collar ring centre relative to the neck bone, and the neck's axis direction (unit) in that space */
  collarCenter: THREE.Vector3;
  neckAxis: THREE.Vector3;
  /** head scale (1 = labrador puppy) */
  headScale: number;
  /** for head accessories: point on top of the skull, relative to the head bone */
  headTop: THREE.Vector3;
  /** for glasses: point between the eyes, relative to the head bone, and eye spacing */
  eyeCenter: THREE.Vector3;
  eyeSpacing: number;
}

export interface Accessory {
  kind: AccessoryKind;
  /** 'neck' accessories get parented to the neck bone, 'head' ones to the head bone */
  bone: 'neck' | 'head';
  object: THREE.Object3D;
  dispose(): void;
}
