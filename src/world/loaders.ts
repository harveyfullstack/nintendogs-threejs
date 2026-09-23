import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type {
  Accessory, AccessoryFit, AccessoryKind, AgilityCourse, Bathroom, Bowl, CollectibleKind, DiscArena, FoodKind, ItemKind,
  Kennel, ObedienceRing, Place, Room, RoomTheme, Toy, ToyKind, TownLayout, TownWorld,
} from './types';

// Loads the environment / prop modules. Each loader falls back to a simple
// placeholder if a module isn't available, so the game always runs.

const mods = import.meta.glob(['./room.ts', './bathroom.ts', './kennel.ts', './obedience.ts', './town.ts', './park.ts', './discArena.ts', './agility.ts', './props.ts', './icons.ts']);

async function mod<T = any>(name: string): Promise<T | null> {
  const l = mods[`./${name}.ts`];
  if (!l) return null;
  try { return (await l()) as T; } catch (e) { console.error('failed to load', name, e); return null; }
}

// ---------- placeholder builders ----------

function placeholderPlace(renderer: THREE.WebGLRenderer, color = '#d8c7a8', size = 4): Place {
  const group = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size * 3, size * 3), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: '#f1e6d2', roughness: 0.9 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(size * 3, 3), wallMat);
  wall.position.set(0, 1.5, -size / 2);
  group.add(wall);
  const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
  sun.position.set(2, 4, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -3; sc.right = 3; sc.top = 3; sc.bottom = -3;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  group.add(sun, sun.target);
  group.add(new THREE.HemisphereLight('#fff8ee', '#9c8468', 0.9));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  return {
    group, sun, environment: env, background: new THREE.Color('#e9dcc6'),
    bounds: { minX: -size / 2, maxX: size / 2, minZ: -size / 2, maxZ: size / 2 },
    obstacles: [],
    camera: { position: new THREE.Vector3(0, 0.8, size / 2 + 0.3), target: new THREE.Vector3(0, 0.2, 0) },
    dispose() { env.dispose(); },
  };
}

export const FALLBACK_THEMES: RoomTheme[] = [{ id: 'default', name: 'Living Room', price: 0, blurb: 'A cosy living room.' }];

export async function loadRoomThemes(): Promise<RoomTheme[]> {
  const m = await mod<{ ROOM_THEMES: RoomTheme[] }>('room');
  return m?.ROOM_THEMES ?? FALLBACK_THEMES;
}

export async function loadRoom(theme: string, renderer: THREE.WebGLRenderer): Promise<Room> {
  const m = await mod<{ buildRoom: (t: string, r: THREE.WebGLRenderer) => Room }>('room');
  if (m) return m.buildRoom(theme, renderer);
  const p = placeholderPlace(renderer);
  return {
    ...p,
    spots: {
      food: new THREE.Vector3(-1.3, 0, -1.4), water: new THREE.Vector3(-0.95, 0, -1.4), bed: new THREE.Vector3(1.3, 0, -1.3),
      door: new THREE.Vector3(1.8, 0, 0), toybox: new THREE.Vector3(1.5, 0, 0.8),
    },
  };
}

export async function loadBathroom(renderer: THREE.WebGLRenderer): Promise<Bathroom> {
  const m = await mod<{ buildBathroom: (r: THREE.WebGLRenderer) => Bathroom }>('bathroom');
  if (m) return m.buildBathroom(renderer);
  const p = placeholderPlace(renderer, '#cfe3ea', 2);
  return { ...p, tubCenter: new THREE.Vector3(0, 0, 0), tubHalf: { x: 0.5, z: 0.35 } };
}

export async function loadKennel(renderer: THREE.WebGLRenderer): Promise<Kennel> {
  const m = await mod<{ buildKennel: (r: THREE.WebGLRenderer) => Kennel }>('kennel');
  if (m) return m.buildKennel(renderer);
  const p = placeholderPlace(renderer, '#e8dcc0', 3);
  return { ...p, penCenter: new THREE.Vector3(0, 0, 0), penHalf: { x: 1.2, z: 0.8 } };
}

export async function loadObedience(renderer: THREE.WebGLRenderer): Promise<ObedienceRing> {
  const m = await mod<{ buildObedienceRing: (r: THREE.WebGLRenderer) => ObedienceRing }>('obedience');
  if (m) return m.buildObedienceRing(renderer);
  const p = placeholderPlace(renderer, '#7a9a6a', 6);
  return { ...p, start: new THREE.Vector3(0, 0, 0) };
}

export async function loadTown(layout: TownLayout, renderer: THREE.WebGLRenderer): Promise<TownWorld> {
  const m = await mod<{ buildTown: (l: TownLayout, r: THREE.WebGLRenderer) => TownWorld }>('town');
  if (m) return m.buildTown(layout, renderer);
  const p = placeholderPlace(renderer, '#9aa39a', 200);
  return p;
}

export async function loadPark(renderer: THREE.WebGLRenderer): Promise<Place> {
  const m = await mod<{ buildPark: (r: THREE.WebGLRenderer) => Place }>('park');
  if (m) return m.buildPark(renderer);
  const p = placeholderPlace(renderer, '#6fae5a', 30);
  return p;
}

export async function loadDiscArena(renderer: THREE.WebGLRenderer): Promise<DiscArena> {
  const m = await mod<{ buildDiscArena: (r: THREE.WebGLRenderer) => DiscArena }>('discArena');
  if (m) return m.buildDiscArena(renderer);
  const p = placeholderPlace(renderer, '#6fae5a', 80);
  return { ...p, throwLine: new THREE.Vector3(0, 0, 0), lineSpacing: 10 };
}

export async function loadAgility(renderer: THREE.WebGLRenderer): Promise<AgilityCourse | null> {
  const m = await mod<{ buildAgilityCourse: (r: THREE.WebGLRenderer) => AgilityCourse }>('agility');
  return m ? m.buildAgilityCourse(renderer) : null;
}

// ---------- props ----------

export interface PropsModule {
  makeToy(kind: ToyKind): Toy;
  makeFoodBowl(): Bowl;
  makeWaterBowl(): Bowl;
  makeItem(kind: ItemKind): THREE.Object3D;
  makeCollectible(kind: CollectibleKind): THREE.Object3D;
  makePoop(): THREE.Object3D;
  makeAccessory(kind: AccessoryKind, fit: AccessoryFit): Accessory;
}

function simpleToy(kind: ToyKind): Toy {
  const disc = kind === 'frisbee' || kind === 'goldDisc';
  const geo = disc ? new THREE.CylinderGeometry(0.11, 0.1, 0.02, 32) : new THREE.SphereGeometry(0.033, 20, 14);
  const mat = new THREE.MeshStandardMaterial({ color: kind === 'tennisBall' ? '#d7f24a' : kind === 'goldDisc' ? '#e6b93a' : '#e0453a', roughness: 0.6 });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return {
    kind, object: m, radius: disc ? 0.11 : 0.033, bounce: disc ? 0.1 : 0.6, glide: disc,
    grip: new THREE.Vector3(disc ? 0.1 : 0, 0, 0), dispose() { geo.dispose(); mat.dispose(); },
  };
}

function simpleBowl(water: boolean): Bowl {
  const g = new THREE.Group();
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.05, 32, 1, true), new THREE.MeshStandardMaterial({ color: '#cfd6dc', metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide }));
  bowl.position.y = 0.025;
  const fill = new THREE.Mesh(new THREE.CircleGeometry(0.075, 24), new THREE.MeshStandardMaterial({ color: water ? '#8fc6e8' : '#8a5a33', roughness: water ? 0.1 : 0.9 }));
  fill.rotation.x = -Math.PI / 2;
  g.add(bowl, fill);
  return {
    object: g, rimHeight: 0.05, radius: 0.09,
    setFill(f) { fill.visible = f > 0.02; fill.position.y = 0.005 + 0.04 * f; },
    dispose() {},
  };
}

const fallbackProps: PropsModule = {
  makeToy: simpleToy,
  makeFoodBowl: () => simpleBowl(false),
  makeWaterBowl: () => simpleBowl(true),
  makeItem: () => new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.05), new THREE.MeshStandardMaterial({ color: '#e3a33d' })),
  makeCollectible: () => new THREE.Mesh(new THREE.OctahedronGeometry(0.04), new THREE.MeshStandardMaterial({ color: '#8fd3ff', metalness: 0.3, roughness: 0.2 })),
  makePoop: () => new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshStandardMaterial({ color: '#5a3a1e', roughness: 0.6 })),
  makeAccessory: (kind) => ({ kind, bone: 'neck', object: new THREE.Group(), dispose() {} }),
};

let propsCache: PropsModule | null = null;
export async function loadProps(): Promise<PropsModule> {
  if (propsCache) return propsCache;
  const m = await mod<PropsModule>('props');
  propsCache = m ?? fallbackProps;
  return propsCache;
}
export function props(): PropsModule {
  return propsCache ?? fallbackProps;
}

let iconFn: ((r: THREE.WebGLRenderer, o: THREE.Object3D, size?: number) => string) | null = null;
export async function loadIcons() {
  const m = await mod<{ renderIcon: typeof iconFn }>('icons');
  iconFn = m?.renderIcon ?? null;
}
const iconCache = new Map<string, string>();
/** Menu icon for an item; returns '' if icons aren't available. */
export function icon(renderer: THREE.WebGLRenderer, key: string, make: () => THREE.Object3D): string {
  if (!iconFn) return '';
  const c = iconCache.get(key);
  if (c) return c;
  try {
    const o = make();
    const url = iconFn(renderer, o, 128);
    iconCache.set(key, url);
    o.traverse((x: any) => { x.geometry?.dispose?.(); });
    return url;
  } catch {
    return '';
  }
}

export type { FoodKind };
