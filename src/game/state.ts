import type { AccessoryKind, FoodKind } from '../world/types';
import type { TrickId } from './tricks';

export interface TrickProgress {
  /** word the owner chose */
  command: string;
  /** repetitions done while teaching */
  reps: number;
  learned: boolean;
  /** 0..1, grows with successful performances */
  mastery: number;
}

export interface DogSave {
  id: string;
  name: string;
  breedId: string;
  coatId: string;
  sex: 'male' | 'female';
  adoptedAt: number;
  hunger: number; // 100 = full
  thirst: number; // 100 = quenched
  clean: number; // 100 = spotless
  energy: number; // 100 = rested
  affection: number; // long term bond, 0..100 (hearts)
  mood: number; // short term happiness 0..100
  /** how well it knows its name 0..1 */
  nameLearned: number;
  tricks: Partial<Record<TrickId, TrickProgress>>;
  accessory: AccessoryKind | null;
  lastWalk: number;
  walks: number;
  walkDistance: number;
  trainerPoints: number;
  /** highest contest class won per contest: 0 none, 1 beginner, 2 open, 3 expert, 4 championship */
  contests: { disc: number; obedience: number; agility: number };
  /** personality 0..1 */
  playful: number;
  calm: number;
}

export interface Photo { id: string; dataUrl: string; date: number; dogName: string }

export interface Settings {
  music: number;
  sfx: number;
  quality: number; // 0.6..1.3
  voice: boolean;
  /** DS-style dithered look: 'off' | 'subtle' | 'ds' */
  retro?: 'off' | 'subtle' | 'ds';
}

export interface SaveData {
  version: 1;
  ownerName: string;
  money: number;
  ownerPoints: number;
  dogs: DogSave[];
  activeDog: string;
  inventory: Record<string, number>;
  collectibles: Record<string, number>;
  roomTheme: string;
  ownedRooms: string[];
  bowls: { food: number; foodKind: FoodKind | null; water: number };
  photos: Photo[];
  settings: Settings;
  createdAt: number;
  lastUpdate: number;
  /** progress of the home time simulation */
  day: number;
}

const KEY = 'nintendogs-three-save-v1';

export function newSave(ownerName: string): SaveData {
  const now = Date.now();
  return {
    version: 1,
    ownerName,
    money: 1000,
    ownerPoints: 0,
    dogs: [],
    activeDog: '',
    inventory: { dryFood: 5, waterBottle: 1, tennisBall: 1, brush: 1, shampoo: 1, jerky: 3 },
    collectibles: {},
    roomTheme: 'default',
    ownedRooms: ['default'],
    bowls: { food: 0, foodKind: null, water: 1 },
    photos: [],
    settings: { music: 0.6, sfx: 0.9, quality: 1, voice: true, retro: 'subtle' },
    createdAt: now,
    lastUpdate: now,
    day: 0,
  };
}

export function newDog(name: string, breedId: string, coatId: string, sex: 'male' | 'female'): DogSave {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name,
    breedId,
    coatId,
    sex,
    adoptedAt: Date.now(),
    hunger: 70,
    thirst: 70,
    clean: 90,
    energy: 90,
    affection: 10,
    mood: 60,
    nameLearned: 0,
    tricks: {},
    accessory: null,
    lastWalk: 0,
    walks: 0,
    walkDistance: 0,
    trainerPoints: 0,
    contests: { disc: 0, obedience: 0, agility: 0 },
    playful: 0.4 + Math.random() * 0.5,
    calm: 0.3 + Math.random() * 0.5,
  };
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SaveData;
    if (!s || typeof s !== 'object' || s.version !== 1) return null;
    return normalizeSave(s);
  } catch {
    return null;
  }
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const obj = <T extends object>(v: unknown, fallback: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback);

/** Fill in anything missing or broken (older versions, a half-written save) so no scene trips over it. */
export function normalizeSave(s: SaveData): SaveData {
  const d = newSave(typeof s.ownerName === 'string' ? s.ownerName : '');
  const dogs = (Array.isArray(s.dogs) ? s.dogs : [])
    .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.breedId === 'string' && typeof x.coatId === 'string')
    .map((x) => {
      const base = newDog(typeof x.name === 'string' && x.name ? x.name : 'Pup', x.breedId, x.coatId, x.sex === 'female' ? 'female' : 'male');
      const dog: DogSave = { ...base, ...x, sex: base.sex, name: base.name };
      for (const k of ['hunger', 'thirst', 'clean', 'energy', 'affection', 'mood', 'nameLearned', 'lastWalk', 'walks', 'walkDistance', 'trainerPoints', 'playful', 'calm', 'adoptedAt'] as const) {
        dog[k] = num(x[k], base[k]);
      }
      dog.tricks = obj(x.tricks, {});
      dog.contests = { ...base.contests, ...obj(x.contests, base.contests) };
      return dog;
    });
  const out: SaveData = {
    ...d,
    ...s,
    money: num(s.money, d.money),
    ownerPoints: num(s.ownerPoints, d.ownerPoints),
    dogs,
    inventory: obj(s.inventory, d.inventory),
    collectibles: obj(s.collectibles, d.collectibles),
    ownedRooms: Array.isArray(s.ownedRooms) && s.ownedRooms.length ? s.ownedRooms : d.ownedRooms,
    roomTheme: typeof s.roomTheme === 'string' ? s.roomTheme : d.roomTheme,
    bowls: { ...d.bowls, ...obj(s.bowls, d.bowls) },
    photos: Array.isArray(s.photos) ? s.photos.filter((p) => p && typeof p.dataUrl === 'string') : [],
    settings: { ...d.settings, ...obj(s.settings, d.settings) },
    lastUpdate: num(s.lastUpdate, d.lastUpdate),
    createdAt: num(s.createdAt, d.createdAt),
    day: num(s.day, 0),
  };
  if (!dogs.some((x) => x.id === out.activeDog)) out.activeDog = dogs[0]?.id ?? '';
  return out;
}

let saveTimer = 0;
export function writeSave(s: SaveData, immediate = false) {
  s.lastUpdate = Date.now();
  if ((window as any).__noPersist) return;
  const doWrite = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) {
      // photos can blow the quota; drop the oldest and retry once
      if (s.photos.length) {
        s.photos.shift();
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* give up */ }
      }
    }
  };
  if (immediate) { doWrite(); return; }
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(doWrite, 400);
}

export function deleteSave() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable: nothing to delete */ }
}

const HOUR = 3600 * 1000;

/** Apply real time passing to every dog. Called at load and periodically. */
export function simulateTime(s: SaveData, now = Date.now()) {
  const dtH = Math.max(0, (now - s.lastUpdate) / HOUR);
  if (dtH <= 0) return;
  for (const d of s.dogs) {
    d.hunger = clamp(d.hunger - dtH * (100 / 20));
    d.thirst = clamp(d.thirst - dtH * (100 / 14));
    d.clean = clamp(d.clean - dtH * (100 / 96));
    d.energy = clamp(d.energy + dtH * 40);
    d.mood = clamp(d.mood + (55 - d.mood) * (1 - Math.exp(-dtH / 3)));
    if (d.hunger < 15 || d.thirst < 15) d.affection = clamp(d.affection - dtH * 0.5);
  }
  // bowls slowly get dusty; water evaporates a little
  s.bowls.water = Math.max(0, s.bowls.water - dtH * 0.01);
  s.lastUpdate = now;
}

export function clamp(v: number, lo = 0, hi = 100) {
  return Math.min(hi, Math.max(lo, v));
}

export function activeDog(s: SaveData): DogSave | undefined {
  return s.dogs.find((d) => d.id === s.activeDog) || s.dogs[0];
}

/** Owner points needed for each additional dog. */
export const DOG_SLOTS = [0, 1000, 3000, 6000];

export function maxDogs(s: SaveData) {
  let n = 0;
  for (const p of DOG_SLOTS) if (s.ownerPoints >= p) n++;
  return n;
}
