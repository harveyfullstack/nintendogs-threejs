// Breed definitions. All measurements are metres for a ~3-4 month old puppy,
// matching the puppies you raise in Nintendogs.

export type V3 = [number, number, number];

export type EarType = 'floppy' | 'pointy' | 'button' | 'rose' | 'bat';
export type TailType = 'otter' | 'whip' | 'curl' | 'sickle' | 'bob' | 'plume' | 'saber';

export interface EarDef {
  type: EarType;
  /** length / width in metres (before head scale) */
  L: number;
  W: number;
  /** thickness of the ear leather */
  T: number;
  /** base position relative to the atlas joint (head units) */
  pos: V3;
  /** outward splay (rad) */
  splay: number;
  /** forward lean (rad) */
  lean: number;
}

export interface TailDef {
  type: TailType;
  L: number;
  T: number;
  /** base direction angle from straight back, positive = upward (rad) */
  carry: number;
  /** total bend along the tail (rad, positive curls up/forward) */
  curl: number;
  /** lateral drift for curled tails */
  side: number;
}

export interface ShapeDef {
  H: number; // height at withers
  BL: number; // body length shoulder->buttock
  CD: number; // chest depth
  CW: number; // chest width
  HW: number; // hip width
  tuck: number; // belly tuck-up 0..1
  belly: number; // puppy belly roundness
  legT: number; // leg thickness multiplier
  pawR: number; // paw radius
  neckL: number;
  neckT: number;
  hs: number; // head scale
  skull: V3; // width, height, length
  muzzle: V3; // width, height, length
  muzzleDrop: number; // how far the muzzle sits below the skull line
  stop: number; // brow prominence
  flews: number;
  nose: number;
  cheek: number;
  eyeR: number;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  eyeOut: number;
  /** how deep the eyeball sits behind the skin, in eye radii (default 0.72) */
  eyeSink?: number;
  /** furnishings: muzzle hair falls down and forward into a beard, brows comb forward */
  beard?: boolean;
  ear: EarDef;
  tail: TailDef;
}

export interface FurDef {
  len: number; // metres at the back
  density: number; // strands per metre
  shells: number;
  comb: number; // how much outer shells lean along the coat direction
  gravity: number; // droop for long coats
  curl: number; // 0..1 poodle curls
  clump: number; // 0..1 how clumpy/wavy
  /** per-region multipliers */
  regions: Partial<Record<string, number>>;
}

export interface CoatDef {
  id: string;
  name: string;
  pattern: string;
  colors: Record<string, string>;
  eye: string;
  nose: string;
  pad?: string;
  /** optional pattern tuning knobs, read by the pattern functions in patterns.ts */
  opts?: Record<string, number>;
}

export interface Breed {
  id: string;
  name: string;
  blurb: string;
  price: number;
  size: 'Small' | 'Medium' | 'Large';
  shape: ShapeDef;
  fur: FurDef;
  coats: CoatDef[];
  voice: { pitch: number; rough: number };
  /** 0..1, how quickly they tire and how excitable they are */
  energy: number;
}

const labShape: ShapeDef = {
  H: 0.33,
  BL: 0.37,
  CD: 0.175,
  CW: 0.165,
  HW: 0.155,
  tuck: 0.12,
  belly: 1.1,
  legT: 1.2,
  pawR: 0.037,
  neckL: 0.78,
  neckT: 1.15,
  hs: 1.1,
  skull: [0.102, 0.086, 0.1],
  muzzle: [0.052, 0.045, 0.058],
  muzzleDrop: 0.004,
  stop: 1,
  flews: 1,
  nose: 1,
  cheek: 1,
  eyeR: 0.0122,
  eyeX: 0.025,
  eyeY: 0.03,
  eyeZ: 0.08,
  eyeOut: 0.3,
  eyeSink: 0.86,
  ear: { type: 'floppy', L: 0.07, W: 0.05, T: 0.007, pos: [0.042, 0.04, 0.042], splay: 0.22, lean: 0.12 },
  tail: { type: 'otter', L: 0.13, T: 0.02, carry: -0.35, curl: 0.35, side: 0 },
};

const shortFur: FurDef = {
  len: 0.0075,
  density: 950,
  shells: 12,
  comb: 0.7,
  gravity: 0.1,
  curl: 0,
  clump: 0.1,
  regions: {},
};

function shape(over: Partial<ShapeDef> & { ear?: Partial<EarDef>; tail?: Partial<TailDef> }): ShapeDef {
  return {
    ...labShape,
    ...over,
    ear: { ...labShape.ear, ...(over.ear || {}) },
    tail: { ...labShape.tail, ...(over.tail || {}) },
  } as ShapeDef;
}

function fur(over: Partial<FurDef>): FurDef {
  return { ...shortFur, ...over, regions: { ...(over.regions || {}) } };
}

export const BREEDS: Breed[] = [
  {
    id: 'labrador',
    name: 'Labrador Retriever',
    blurb: 'Friendly, eager to please and endlessly food motivated.',
    price: 800,
    size: 'Large',
    shape: labShape,
    fur: fur({}),
    coats: [
      { id: 'yellow', name: 'Yellow', pattern: 'solid', colors: { base: '#e3bf86', light: '#f3dcb0', dark: '#c99a5b' }, eye: '#4a2a12', nose: '#2b2320' },
      { id: 'black', name: 'Black', pattern: 'solid', colors: { base: '#1b1917', light: '#2c2824', dark: '#0f0e0d' }, eye: '#3a2210', nose: '#141212' },
      { id: 'chocolate', name: 'Chocolate', pattern: 'solid', colors: { base: '#6b4128', light: '#80523a', dark: '#4e2d1b' }, eye: '#6b4a1e', nose: '#4a2b20' },
    ],
    voice: { pitch: 0.85, rough: 0.5 },
    energy: 0.7,
  },
  {
    id: 'dachshund',
    name: 'Miniature Dachshund',
    blurb: 'Long, low and brave. A big personality in a tiny sausage.',
    price: 700,
    size: 'Small',
    shape: shape({
      H: 0.165, BL: 0.29, CD: 0.1, CW: 0.115, HW: 0.1, tuck: 0.2, belly: 1.0, legT: 1.15, pawR: 0.027,
      neckL: 0.72, neckT: 1.15, hs: 0.88,
      skull: [0.1, 0.09, 0.115], muzzle: [0.05, 0.045, 0.07], muzzleDrop: 0.002, stop: 0.7, flews: 0.85, nose: 0.95,
      eyeR: 0.0102, eyeX: 0.026, eyeY: 0.031, eyeZ: 0.085, eyeSink: 0.9,
      ear: { type: 'floppy', L: 0.09, W: 0.06, T: 0.007, pos: [0.044, 0.046, 0.02], splay: 0.14, lean: 0.05 },
      tail: { type: 'whip', L: 0.15, T: 0.015, carry: 0.1, curl: 0.25, side: 0 },
    }),
    fur: fur({ len: 0.006, density: 1100 }),
    coats: [
      { id: 'red', name: 'Red', pattern: 'solid', colors: { base: '#a24f25', light: '#bd6a3b', dark: '#7c3616' }, eye: '#4a2812', nose: '#1d1614' },
      { id: 'blacktan', name: 'Black & Tan', pattern: 'tan', colors: { base: '#1c1817', light: '#2a2522', dark: '#100e0d', tan: '#b76a33' }, eye: '#452611', nose: '#141111' },
      { id: 'choc', name: 'Chocolate & Tan', pattern: 'tan', colors: { base: '#4f2e1e', light: '#603a27', dark: '#3a2015', tan: '#c08250' }, eye: '#6c4a22', nose: '#402519' },
    ],
    voice: { pitch: 1.35, rough: 0.35 },
    energy: 0.6,
  },
  {
    id: 'shiba',
    name: 'Shiba Inu',
    blurb: 'Spirited, fox-like and a little bit independent.',
    price: 900,
    size: 'Medium',
    shape: shape({
      H: 0.25, BL: 0.26, CD: 0.125, CW: 0.13, HW: 0.12, tuck: 0.2, belly: 1.0, legT: 1.25, pawR: 0.03,
      neckL: 0.75, neckT: 1.15, hs: 1.0,
      skull: [0.114, 0.092, 0.1], muzzle: [0.05, 0.044, 0.048], muzzleDrop: 0.004, stop: 0.8, flews: 0.55, nose: 0.85, cheek: 1.3,
      eyeR: 0.0105, eyeX: 0.028, eyeY: 0.033, eyeZ: 0.083, eyeOut: 0.34, eyeSink: 0.88,
      ear: { type: 'pointy', L: 0.05, W: 0.046, T: 0.01, pos: [0.036, 0.066, 0.028], splay: 0.3, lean: 0.22 },
      tail: { type: 'curl', L: 0.16, T: 0.022, carry: 1.05, curl: 3.6, side: 0.35 },
    }),
    fur: fur({ len: 0.018, density: 900, shells: 18, comb: 0.6, gravity: 0.15, regions: { tail: 1.7, neck: 1.25, cheek: 1.25 } }),
    coats: [
      { id: 'red', name: 'Red', pattern: 'urajiro', colors: { base: '#c46a2b', light: '#d98b48', dark: '#9e4f1c', cream: '#f3e2c4' }, eye: '#3f220f', nose: '#171311', opts: { pip: 0.75, pipY: 1.55 } },
      { id: 'blacktan', name: 'Black & Tan', pattern: 'urajiro-tan', colors: { base: '#221c19', light: '#322a25', dark: '#161210', cream: '#efe0c6', tan: '#b77a3f' }, eye: '#3f220f', nose: '#141111', opts: { pip: 0.8, pipY: 1.55 } },
      { id: 'cream', name: 'Cream', pattern: 'urajiro', colors: { base: '#e8d2ab', light: '#f2e2c4', dark: '#d2b588', cream: '#f8efdc' }, eye: '#3f220f', nose: '#2a1f1b', opts: { pip: 0.75, pipY: 1.55 } },
    ],
    voice: { pitch: 1.05, rough: 0.45 },
    energy: 0.75,
  },
  {
    id: 'golden',
    name: 'Golden Retriever',
    blurb: 'Gentle, patient and happiest with a toy in its mouth.',
    price: 850,
    size: 'Large',
    shape: shape({
      H: 0.33, BL: 0.36, CD: 0.17, CW: 0.16, HW: 0.145, pawR: 0.037, neckL: 0.75, neckT: 1.2, hs: 1.12,
      skull: [0.108, 0.094, 0.108], muzzle: [0.058, 0.05, 0.054], eyeR: 0.012, eyeSink: 0.88,
      ear: { type: 'floppy', L: 0.082, W: 0.058, T: 0.008, pos: [0.047, 0.044, 0.03], splay: 0.32, lean: 0.1 },
      tail: { type: 'plume', L: 0.18, T: 0.02, carry: -0.2, curl: 0.4, side: 0 },
    }),
    fur: fur({ len: 0.022, density: 750, shells: 24, comb: 0.9, gravity: 0.35, clump: 0.3, regions: { muzzle: 0.3, skull: 0.4, brow: 0.3, cheek: 0.55, ear: 0.8, tail: 1.5, chest: 1.3, neck: 1.2, throat: 1.1, legFback: 1.3, legH: 0.9, paw: 0.4, legF: 0.55 } }),
    coats: [
      { id: 'golden', name: 'Golden', pattern: 'solid', colors: { base: '#d59a4f', light: '#ecc07e', dark: '#b87a36', ear: '#bd7a3a' }, eye: '#4a2a14', nose: '#231a17' },
      { id: 'light', name: 'Light Golden', pattern: 'solid', colors: { base: '#e7c48e', light: '#f5dfb7', dark: '#cfa467', ear: '#d2a262' }, eye: '#4a2a14', nose: '#231a17' },
      { id: 'red', name: 'Dark Golden', pattern: 'solid', colors: { base: '#b36a2e', light: '#cc8649', dark: '#8e4d1c', ear: '#96521f' }, eye: '#4a2a14', nose: '#231a17' },
    ],
    voice: { pitch: 0.82, rough: 0.45 },
    energy: 0.7,
  },
  {
    id: 'chihuahua',
    name: 'Chihuahua',
    blurb: 'Tiny, alert and fiercely loyal. Big ears, bigger heart.',
    price: 750,
    size: 'Small',
    shape: shape({
      H: 0.13, BL: 0.13, CD: 0.072, CW: 0.085, HW: 0.075, tuck: 0.2, belly: 1.0, legT: 1.1, pawR: 0.018,
      neckL: 0.6, neckT: 1.05, hs: 0.8,
      skull: [0.118, 0.11, 0.098], muzzle: [0.04, 0.035, 0.032], muzzleDrop: 0.008, stop: 1.0, flews: 0.4, nose: 0.75, cheek: 0.75,
      eyeR: 0.0116, eyeX: 0.031, eyeY: 0.029, eyeZ: 0.078, eyeOut: 0.42, eyeSink: 0.9,
      ear: { type: 'bat', L: 0.076, W: 0.066, T: 0.007, pos: [0.038, 0.07, 0.02], splay: 0.62, lean: 0.12 },
      tail: { type: 'sickle', L: 0.12, T: 0.013, carry: 0.75, curl: 1.9, side: 0.1 },
    }),
    fur: fur({ len: 0.005, density: 1200, shells: 10 }),
    coats: [
      { id: 'fawn', name: 'Fawn', pattern: 'solid', colors: { base: '#d9a86b', light: '#ecd0a2', dark: '#b88348' }, eye: '#4a2a14', nose: '#241a17' },
      { id: 'blacktan', name: 'Black & Tan', pattern: 'tan', colors: { base: '#1d1917', light: '#2c2622', dark: '#120f0e', tan: '#c98b4e' }, eye: '#4a2a14', nose: '#141111' },
      { id: 'cream', name: 'Cream', pattern: 'solid', colors: { base: '#efe0c4', light: '#f8eedc', dark: '#dcc59c' }, eye: '#4a2a14', nose: '#3a2a26' },
    ],
    voice: { pitch: 1.75, rough: 0.2 },
    energy: 0.8,
  },
  {
    id: 'corgi',
    name: 'Pembroke Welsh Corgi',
    blurb: 'A herding dog on short legs, with a fluffy bottom and huge grin.',
    price: 850,
    size: 'Medium',
    shape: shape({
      H: 0.2, BL: 0.31, CD: 0.115, CW: 0.14, HW: 0.13, tuck: 0.15, belly: 1.0, legT: 1.25, pawR: 0.029,
      neckL: 0.8, neckT: 1.15, hs: 1.0,
      skull: [0.112, 0.092, 0.105], muzzle: [0.05, 0.044, 0.05], muzzleDrop: 0.006, stop: 0.75, flews: 0.6, nose: 0.9, cheek: 1.1,
      eyeR: 0.0112, eyeX: 0.028, eyeY: 0.032, eyeZ: 0.083, eyeSink: 0.88,
      ear: { type: 'pointy', L: 0.068, W: 0.058, T: 0.009, pos: [0.036, 0.064, 0.028], splay: 0.42, lean: 0.12 },
      tail: { type: 'bob', L: 0.035, T: 0.024, carry: -0.2, curl: 0, side: 0 },
    }),
    fur: fur({ len: 0.018, density: 850, shells: 16, comb: 0.8, gravity: 0.2, clump: 0.25, regions: { rump: 1.5, neck: 1.35, chest: 1.3, muzzle: 0.35, skull: 0.5, legF: 0.55, paw: 0.4, ear: 0.5 } }),
    coats: [
      { id: 'red', name: 'Red & White', pattern: 'corgi', colors: { base: '#c9742f', light: '#dd9352', dark: '#a85820', white: '#f6f0e6' }, eye: '#452612', nose: '#161211' },
      { id: 'tri', name: 'Tricolor', pattern: 'corgi-tri', colors: { base: '#bb7336', light: '#cf8b4b', dark: '#9e5a24', white: '#f6f0e6', black: '#1d1917' }, eye: '#452612', nose: '#141111' },
      { id: 'sable', name: 'Sable', pattern: 'corgi', colors: { base: '#a8743f', light: '#c9985e', dark: '#5a3b20', white: '#f6f0e6' }, eye: '#452612', nose: '#161211' },
    ],
    voice: { pitch: 1.1, rough: 0.45 },
    energy: 0.75,
  },
  {
    id: 'beagle',
    name: 'Beagle',
    blurb: 'Merry, curious scent hound. Follows its nose everywhere.',
    price: 750,
    size: 'Medium',
    shape: shape({
      H: 0.26, BL: 0.28, CD: 0.128, CW: 0.13, HW: 0.12, tuck: 0.2, belly: 1.0, legT: 1.25, pawR: 0.03,
      neckL: 0.75, neckT: 1.1, hs: 1.0,
      skull: [0.1, 0.094, 0.105], muzzle: [0.052, 0.048, 0.052], muzzleDrop: 0.006, stop: 1.2, flews: 1.25, nose: 1.05,
      eyeR: 0.0128, eyeX: 0.028, eyeY: 0.03, eyeZ: 0.083, eyeSink: 0.9,
      ear: { type: 'floppy', L: 0.095, W: 0.064, T: 0.007, pos: [0.045, 0.034, 0.024], splay: 0.12, lean: 0.06 },
      tail: { type: 'saber', L: 0.14, T: 0.017, carry: 0.95, curl: 0.45, side: 0 },
    }),
    fur: fur({ len: 0.0065, density: 1050 }),
    coats: [
      { id: 'tri', name: 'Tricolor', pattern: 'tricolor', colors: { base: '#b36d33', light: '#c98949', dark: '#8d4f20', black: '#1c1816', white: '#f4efe6' }, eye: '#4a2a14', nose: '#171311' },
      { id: 'lemon', name: 'Lemon', pattern: 'tricolor', colors: { base: '#e2bd7c', light: '#efd29f', dark: '#caa060', black: '#c79b5c', white: '#f6f2ea' }, eye: '#4a2a12', nose: '#3d2a24' },
      { id: 'redwhite', name: 'Red & White', pattern: 'tricolor', colors: { base: '#a9542a', light: '#c26d3e', dark: '#843d1a', black: '#9b4b24', white: '#f4efe6' }, eye: '#4a2a14', nose: '#211816' },
    ],
    voice: { pitch: 1.05, rough: 0.55 },
    energy: 0.8,
  },
  {
    id: 'husky',
    name: 'Siberian Husky',
    blurb: 'Tireless, talkative sled dog with striking blue eyes.',
    price: 900,
    size: 'Large',
    shape: shape({
      H: 0.3, BL: 0.32, CD: 0.148, CW: 0.145, HW: 0.13, tuck: 0.2, belly: 0.95, legT: 1.25, pawR: 0.034,
      neckL: 0.75, neckT: 1.2, hs: 1.05,
      skull: [0.112, 0.094, 0.108], muzzle: [0.054, 0.046, 0.054], muzzleDrop: 0.004, stop: 0.85, flews: 0.6, nose: 0.95, cheek: 1.2,
      eyeR: 0.0115, eyeX: 0.029, eyeY: 0.033, eyeZ: 0.085, eyeOut: 0.36, eyeSink: 0.88,
      ear: { type: 'pointy', L: 0.058, W: 0.052, T: 0.01, pos: [0.036, 0.066, 0.026], splay: 0.28, lean: 0.2 },
      tail: { type: 'sickle', L: 0.2, T: 0.024, carry: 0.7, curl: 1.5, side: 0.05 },
    }),
    fur: fur({ len: 0.02, density: 850, shells: 18, comb: 0.75, gravity: 0.2, clump: 0.2, regions: { tail: 1.9, neck: 1.4, cheek: 1.3, muzzle: 0.35, skull: 0.55, brow: 0.45, legF: 0.55, paw: 0.45, ear: 0.55 } }),
    coats: [
      { id: 'black', name: 'Black & White', pattern: 'husky', colors: { base: '#2a2826', light: '#48433f', dark: '#171615', white: '#f3f1ee' }, eye: '#5ea7d8', nose: '#141212' },
      { id: 'grey', name: 'Grey & White', pattern: 'husky', colors: { base: '#78736f', light: '#9c9791', dark: '#4e4a47', white: '#f3f1ee' }, eye: '#5ea7d8', nose: '#171414' },
      { id: 'red', name: 'Red & White', pattern: 'husky', colors: { base: '#9e5a31', light: '#bb7747', dark: '#6f3a1c', white: '#f5efe8' }, eye: '#8c5d24', nose: '#4a2c20' },
    ],
    voice: { pitch: 0.95, rough: 0.35 },
    energy: 0.9,
  },
  {
    id: 'pug',
    name: 'Pug',
    blurb: 'A clown in a small, wrinkly package. Snores, snorts and adores you.',
    price: 800,
    size: 'Small',
    shape: shape({
      H: 0.18, BL: 0.19, CD: 0.095, CW: 0.13, HW: 0.115, tuck: 0.05, belly: 1.2, legT: 1.45, pawR: 0.024,
      neckL: 0.5, neckT: 1.4, hs: 0.98,
      skull: [0.125, 0.1, 0.095], muzzle: [0.056, 0.046, 0.014], muzzleDrop: 0.004, stop: 1.3, flews: 1.25, nose: 0.8, cheek: 1.3,
      eyeR: 0.013, eyeX: 0.034, eyeY: 0.026, eyeZ: 0.08, eyeOut: 0.45, eyeSink: 0.8,
      ear: { type: 'button', L: 0.042, W: 0.04, T: 0.006, pos: [0.055, 0.056, 0.026], splay: 0.12, lean: -0.3 },
      tail: { type: 'curl', L: 0.1, T: 0.018, carry: 1.3, curl: 4.5, side: 0.4 },
    }),
    fur: fur({ len: 0.005, density: 1200, shells: 10 }),
    coats: [
      { id: 'fawn', name: 'Fawn', pattern: 'pug', colors: { base: '#d9b27c', light: '#ecd2a4', dark: '#b98d55', mask: '#1d1816' }, eye: '#3d2210', nose: '#141111', opts: { chin: 0.3 } },
      { id: 'apricot', name: 'Apricot', pattern: 'pug', colors: { base: '#d39a5c', light: '#e8bd86', dark: '#b07a40', mask: '#1d1816' }, eye: '#3d2210', nose: '#141111' },
      { id: 'black', name: 'Black', pattern: 'solid', colors: { base: '#1b1918', light: '#2b2725', dark: '#100f0e' }, eye: '#3d2210', nose: '#121010' },
    ],
    voice: { pitch: 1.35, rough: 0.65 },
    energy: 0.5,
  },
  {
    id: 'poodle',
    name: 'Toy Poodle',
    blurb: 'Clever, proud and bouncy, wrapped in a soft teddy-bear coat.',
    price: 900,
    size: 'Small',
    shape: shape({
      H: 0.19, BL: 0.16, CD: 0.084, CW: 0.088, HW: 0.082, tuck: 0.35, belly: 0.85, legT: 0.95, pawR: 0.018,
      neckL: 1.0, neckT: 1.0, hs: 0.8,
      skull: [0.094, 0.09, 0.1], muzzle: [0.035, 0.036, 0.062], muzzleDrop: 0.0, stop: 0.85, flews: 0.45, nose: 0.8, cheek: 0.7,
      eyeR: 0.0102, eyeX: 0.026, eyeY: 0.032, eyeZ: 0.082, eyeOut: 0.32, eyeSink: 0.9,
      ear: { type: 'floppy', L: 0.1, W: 0.058, T: 0.01, pos: [0.045, 0.032, 0.02], splay: 0.1, lean: 0.04 },
      tail: { type: 'saber', L: 0.1, T: 0.018, carry: 1.35, curl: 0.2, side: 0 },
    }),
    fur: fur({ len: 0.018, density: 580, shells: 22, comb: 0, gravity: 0, curl: 1, clump: 0.5, regions: { muzzle: 0.12, lip: 0.1, chin: 0.15, jaw: 0.2, nose: 0, skull: 1.8, brow: 1.0, cheek: 0.6, ear: 0.85, tail: 1.7, paw: 0.8, legF: 1.0, legH: 1.0, neck: 1.1, throat: 0.9 } }),
    coats: [
      { id: 'apricot', name: 'Apricot', pattern: 'solid', colors: { base: '#e0a567', light: '#efc594', dark: '#c4854a' }, eye: '#3d2210', nose: '#2a1d1a' },
      { id: 'black', name: 'Black', pattern: 'solid', colors: { base: '#1c1a19', light: '#2c2927', dark: '#121110' }, eye: '#3d2210', nose: '#121010' },
      { id: 'white', name: 'White', pattern: 'solid', colors: { base: '#f3efe8', light: '#fbf9f5', dark: '#ddd6ca' }, eye: '#3d2210', nose: '#161212' },
    ],
    voice: { pitch: 1.6, rough: 0.25 },
    energy: 0.8,
  },
  {
    id: 'dalmatian',
    name: 'Dalmatian',
    blurb: 'Athletic and full of stamina, with a coat of polka dots.',
    price: 850,
    size: 'Large',
    shape: shape({
      H: 0.34, BL: 0.36, CD: 0.16, CW: 0.145, HW: 0.135, tuck: 0.25, belly: 0.95, legT: 1.15, pawR: 0.034,
      neckL: 0.85, neckT: 1.1, hs: 1.05,
      skull: [0.1, 0.088, 0.105], muzzle: [0.05, 0.046, 0.058], muzzleDrop: 0.004, stop: 1.0, flews: 0.9,
      eyeR: 0.0118, eyeSink: 0.86,
      ear: { type: 'floppy', L: 0.07, W: 0.052, T: 0.006, pos: [0.044, 0.05, 0.034], splay: 0.25, lean: 0.08 },
      tail: { type: 'saber', L: 0.18, T: 0.018, carry: 0.15, curl: 0.5, side: 0 },
    }),
    fur: fur({ len: 0.0055, density: 1200, shells: 10 }),
    coats: [
      { id: 'black', name: 'Black Spotted', pattern: 'spots', colors: { base: '#f4f1ea', light: '#fbf9f4', dark: '#dcd6cc', spot: '#1b1918' }, eye: '#3a200e', nose: '#141111' },
      { id: 'liver', name: 'Liver Spotted', pattern: 'spots', colors: { base: '#f4f0e8', light: '#fbf8f2', dark: '#ddd5c9', spot: '#6a3a22' }, eye: '#8a5a2a', nose: '#5a3222' },
    ],
    voice: { pitch: 0.9, rough: 0.4 },
    energy: 0.9,
  },
  {
    id: 'shepherd',
    name: 'German Shepherd',
    blurb: 'Loyal, brave and quick to learn. Those big ears miss nothing.',
    price: 950,
    size: 'Large',
    shape: shape({
      H: 0.34, BL: 0.37, CD: 0.16, CW: 0.15, HW: 0.135, tuck: 0.2, belly: 1.0, legT: 1.3, pawR: 0.038,
      neckL: 0.8, neckT: 1.2, hs: 1.1,
      skull: [0.108, 0.09, 0.108], muzzle: [0.052, 0.046, 0.062], muzzleDrop: 0.004, stop: 0.8, flews: 0.7, nose: 1.0, cheek: 1.1,
      eyeR: 0.0115, eyeX: 0.028, eyeY: 0.032, eyeZ: 0.084, eyeOut: 0.34, eyeSink: 0.88,
      ear: { type: 'pointy', L: 0.075, W: 0.058, T: 0.009, pos: [0.036, 0.064, 0.026], splay: 0.3, lean: 0.15 },
      tail: { type: 'plume', L: 0.2, T: 0.024, carry: -0.5, curl: 0.6, side: 0 },
    }),
    fur: fur({ len: 0.014, density: 900, shells: 16, comb: 0.75, gravity: 0.2, clump: 0.2, regions: { tail: 1.8, neck: 1.3, thigh: 1.2, legFback: 1.1, muzzle: 0.35, skull: 0.5, ear: 0.5, paw: 0.4, legF: 0.55 } }),
    coats: [
      { id: 'blacktan', name: 'Black & Tan', pattern: 'saddle', colors: { base: '#b9793e', light: '#d19c62', dark: '#98602c', black: '#1b1816' }, eye: '#3a200e', nose: '#141111' },
      { id: 'sable', name: 'Sable', pattern: 'sable', colors: { base: '#8c6d48', light: '#bb9a6e', dark: '#5a4128', black: '#1e1a17' }, eye: '#3a200e', nose: '#141111', opts: { sable: 1.25, mask: 0.95, ears: 0.9 } },
      { id: 'black', name: 'Black', pattern: 'solid', colors: { base: '#1b1918', light: '#2b2725', dark: '#100f0e' }, eye: '#3a200e', nose: '#121010' },
    ],
    voice: { pitch: 0.85, rough: 0.5 },
    energy: 0.85,
  },
  {
    id: 'cavalier',
    name: 'Cavalier King Charles Spaniel',
    blurb: 'Sweet-natured lap dog with silky ears and soulful eyes.',
    price: 900,
    size: 'Small',
    shape: shape({
      H: 0.19, BL: 0.21, CD: 0.1, CW: 0.11, HW: 0.1, tuck: 0.15, belly: 1.05, legT: 1.15, pawR: 0.024,
      neckL: 0.7, neckT: 1.1, hs: 0.95,
      skull: [0.108, 0.096, 0.098], muzzle: [0.048, 0.042, 0.036], muzzleDrop: 0.006, stop: 1.3, flews: 1.0, nose: 0.85, cheek: 1.0,
      eyeR: 0.0128, eyeX: 0.03, eyeY: 0.028, eyeZ: 0.08, eyeOut: 0.35, eyeSink: 0.82,
      ear: { type: 'floppy', L: 0.105, W: 0.068, T: 0.007, pos: [0.047, 0.052, 0.024], splay: 0.18, lean: 0.05 },
      tail: { type: 'plume', L: 0.13, T: 0.016, carry: 0.3, curl: 0.4, side: 0 },
    }),
    fur: fur({ len: 0.014, density: 900, shells: 18, comb: 1.0, gravity: 0.4, clump: 0.3, regions: { ear: 1.2, muzzle: 0.25, skull: 0.35, brow: 0.3, cheek: 0.5, chest: 1.4, tail: 1.6, legFback: 1.4, legF: 0.5, paw: 0.5, neck: 1.1 } }),
    coats: [
      { id: 'blenheim', name: 'Blenheim', pattern: 'parti', colors: { base: '#f6f1e9', light: '#fbf8f3', dark: '#e0d8cc', patch: '#b5652b', patchLight: '#c98044', patchDark: '#94501f' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.008, blazeWide: 0.016, lozenge: 1, body: 0.18, saddle: 0.6 } },
      { id: 'tri', name: 'Tricolor', pattern: 'parti', colors: { base: '#f6f1e9', light: '#fbf8f3', dark: '#e0d8cc', patch: '#1c1917', patchLight: '#2a2522', patchDark: '#121010', tan: '#b86e35' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.008, blazeWide: 0.016, body: 0.18, saddle: 0.6 } },
      { id: 'ruby', name: 'Ruby', pattern: 'solid', colors: { base: '#8f3f1d', light: '#ab5a33', dark: '#6c2e12' }, eye: '#3d2210', nose: '#141111' },
    ],
    voice: { pitch: 1.25, rough: 0.3 },
    energy: 0.55,
  },
  {
    id: 'jackrussell',
    name: 'Jack Russell Terrier',
    blurb: 'A small dog with a huge engine. Loves to dig, chase and jump.',
    price: 750,
    size: 'Small',
    shape: shape({
      H: 0.2, BL: 0.21, CD: 0.1, CW: 0.105, HW: 0.095, tuck: 0.25, belly: 0.95, legT: 1.15, pawR: 0.025,
      neckL: 0.75, neckT: 1.1, hs: 0.92,
      skull: [0.104, 0.088, 0.1], muzzle: [0.046, 0.042, 0.05], muzzleDrop: 0.004, stop: 0.9, flews: 0.6, nose: 0.85, cheek: 1.1,
      eyeR: 0.0112, eyeX: 0.028, eyeY: 0.031, eyeZ: 0.083, eyeOut: 0.34, eyeSink: 0.88,
      ear: { type: 'button', L: 0.045, W: 0.042, T: 0.006, pos: [0.04, 0.07, 0.036], splay: 0.32, lean: -0.8 },
      tail: { type: 'saber', L: 0.1, T: 0.016, carry: 1.2, curl: 0.2, side: 0 },
    }),
    fur: fur({ len: 0.006, density: 1100, shells: 10 }),
    coats: [
      { id: 'tan', name: 'White & Tan', pattern: 'parti', colors: { base: '#f6f2ea', light: '#fbf9f4', dark: '#e0d9cd', patch: '#b8733a', patchLight: '#cc8f55', patchDark: '#94582a' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.006, blazeWide: 0.012, body: 0.15, tailBase: 1, cheek: 0.35, neck: 0 } },
      { id: 'tri', name: 'Tricolor', pattern: 'parti', colors: { base: '#f6f2ea', light: '#fbf9f4', dark: '#e0d9cd', patch: '#1d1a18', patchLight: '#2b2623', patchDark: '#121010', tan: '#b8733a' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.006, blazeWide: 0.012, body: 0.15, tailBase: 1, cheek: 0.35, neck: 0, earTan: 1 } },
      { id: 'black', name: 'White & Black', pattern: 'parti', colors: { base: '#f6f2ea', light: '#fbf9f4', dark: '#e0d9cd', patch: '#1d1a18', patchLight: '#2b2623', patchDark: '#121010' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.007, blazeWide: 0.014, body: 0.1, tailBase: 0, cheek: 0.35, neck: 0 } },
    ],
    voice: { pitch: 1.3, rough: 0.4 },
    energy: 0.95,
  },
  {
    id: 'pomeranian',
    name: 'Pomeranian',
    blurb: 'A tiny, bold puffball with a fox face and a plumed tail.',
    price: 950,
    size: 'Small',
    shape: shape({
      H: 0.12, BL: 0.13, CD: 0.068, CW: 0.085, HW: 0.075, tuck: 0.1, belly: 1.05, legT: 1.05, pawR: 0.016,
      neckL: 0.6, neckT: 1.1, hs: 0.78,
      skull: [0.11, 0.098, 0.092], muzzle: [0.036, 0.032, 0.032], muzzleDrop: 0.006, stop: 0.85, flews: 0.4, nose: 0.7, cheek: 1.0,
      eyeR: 0.009, eyeX: 0.028, eyeY: 0.029, eyeZ: 0.078, eyeOut: 0.38, eyeSink: 0.9,
      ear: { type: 'pointy', L: 0.035, W: 0.034, T: 0.008, pos: [0.034, 0.07, 0.026], splay: 0.35, lean: 0.15 },
      tail: { type: 'curl', L: 0.09, T: 0.018, carry: 1.4, curl: 2.5, side: 0.1 },
    }),
    fur: fur({ len: 0.03, density: 1000, shells: 26, comb: 0.5, gravity: 0.1, clump: 0.35, regions: { muzzle: 0.25, lip: 0.15, chin: 0.3, skull: 0.45, brow: 0.3, cheek: 0.9, ear: 0.35, neck: 1.3, chest: 1.3, throat: 1.3, tail: 1.4, legF: 0.5, legH: 0.6, paw: 0.3, thigh: 1.1, rump: 1.1 } }),
    coats: [
      { id: 'orange', name: 'Orange', pattern: 'solid', colors: { base: '#d9822b', light: '#f0b870', dark: '#b8651c' }, eye: '#3d2210', nose: '#141111' },
      { id: 'cream', name: 'Cream', pattern: 'solid', colors: { base: '#e9cf9c', light: '#f5e5c4', dark: '#d2b27a' }, eye: '#3d2210', nose: '#1a1413' },
      { id: 'black', name: 'Black', pattern: 'solid', colors: { base: '#1c1a19', light: '#2e2a28', dark: '#121110' }, eye: '#3d2210', nose: '#121010' },
    ],
    voice: { pitch: 1.8, rough: 0.2 },
    energy: 0.75,
  },
  {
    id: 'schnauzer',
    name: 'Miniature Schnauzer',
    blurb: 'Whiskery, alert little terrier with bushy brows and a big beard.',
    price: 800,
    size: 'Small',
    shape: shape({
      beard: true,
      H: 0.22, BL: 0.21, CD: 0.105, CW: 0.11, HW: 0.1, tuck: 0.25, belly: 0.95, legT: 1.2, pawR: 0.025,
      neckL: 0.8, neckT: 1.1, hs: 0.92,
      skull: [0.098, 0.084, 0.112], muzzle: [0.05, 0.048, 0.06], muzzleDrop: 0.002, stop: 0.6, flews: 1.5, nose: 0.9, cheek: 0.85,
      eyeR: 0.0105, eyeX: 0.027, eyeY: 0.031, eyeZ: 0.083, eyeOut: 0.32, eyeSink: 0.9,
      ear: { type: 'button', L: 0.045, W: 0.042, T: 0.006, pos: [0.04, 0.07, 0.036], splay: 0.32, lean: -0.85 },
      tail: { type: 'saber', L: 0.09, T: 0.016, carry: 1.1, curl: 0.3, side: 0 },
    }),
    fur: fur({ len: 0.01, density: 850, shells: 14, comb: 0.3, gravity: 0.35, clump: 0.4, regions: { muzzle: 2.4, chin: 2.6, jaw: 2.4, lip: 1.8, brow: 2.6, skull: 0.5, cheek: 0.9, legF: 1.5, legH: 1.4, paw: 1.2, belly: 1.6, chest: 1.3, throat: 1.2, ear: 0.4, back: 0.8, ribs: 0.9, legFup: 1.2 } }),
    coats: [
      { id: 'saltpepper', name: 'Salt & Pepper', pattern: 'grizzle', colors: { base: '#6f6c68', light: '#8a8680', dark: '#4a4744', pepper: '#262422', silver: '#bdbab3' }, eye: '#3d2210', nose: '#141111' },
      { id: 'blacksilver', name: 'Black & Silver', pattern: 'furnish', colors: { base: '#1d1b1a', light: '#2c2927', dark: '#121110', silver: '#b9b7b1' }, eye: '#3d2210', nose: '#121010' },
      { id: 'black', name: 'Black', pattern: 'solid', colors: { base: '#1d1b1a', light: '#2e2b29', dark: '#121110' }, eye: '#3d2210', nose: '#121010' },
    ],
    voice: { pitch: 1.2, rough: 0.5 },
    energy: 0.75,
  },
  {
    id: 'shihtzu',
    name: 'Shih Tzu',
    blurb: 'An affectionate little lion dog who lives to be pampered.',
    price: 850,
    size: 'Small',
    shape: shape({
      H: 0.14, BL: 0.19, CD: 0.085, CW: 0.1, HW: 0.09, tuck: 0.1, belly: 1.05, legT: 1.2, pawR: 0.02,
      neckL: 0.6, neckT: 1.15, hs: 0.92,
      skull: [0.118, 0.102, 0.095], muzzle: [0.05, 0.042, 0.016], muzzleDrop: 0.006, stop: 1.2, flews: 1.1, nose: 0.8, cheek: 1.15,
      eyeR: 0.0122, eyeX: 0.032, eyeY: 0.027, eyeZ: 0.08, eyeOut: 0.42, eyeSink: 0.82,
      ear: { type: 'floppy', L: 0.07, W: 0.05, T: 0.006, pos: [0.05, 0.045, 0.024], splay: 0.2, lean: 0.05 },
      tail: { type: 'plume', L: 0.11, T: 0.018, carry: 1.3, curl: 2.2, side: 0.3 },
    }),
    fur: fur({ len: 0.026, density: 850, shells: 28, comb: 0.8, gravity: 0.45, clump: 0.4, regions: { muzzle: 0.85, lip: 0.7, chin: 0.9, brow: 0.7, skull: 0.8, cheek: 0.8, ear: 0.75, tail: 1.5, legF: 0.9, legH: 0.9, paw: 0.6, chest: 1.2, neck: 1.2 } }),
    coats: [
      { id: 'gold', name: 'Gold & White', pattern: 'parti', colors: { base: '#f5f0e6', light: '#fbf8f2', dark: '#ddd5c8', patch: '#c98d4a', patchLight: '#ddaa6c', patchDark: '#a26b30' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.007, blazeWide: 0.02, body: 0.35, saddle: 0.9, cheek: 0.7, muzzle: 0 } },
      { id: 'black', name: 'Black & White', pattern: 'parti', colors: { base: '#f5f0e6', light: '#fbf8f2', dark: '#ddd5c8', patch: '#1d1a18', patchLight: '#2c2724', patchDark: '#121010' }, eye: '#3d2210', nose: '#141111', opts: { blaze: 0.007, blazeWide: 0.02, body: 0.35, saddle: 0.9, cheek: 0.7, muzzle: 0 } },
    ],
    voice: { pitch: 1.45, rough: 0.3 },
    energy: 0.5,
  },
  {
    id: 'yorkie',
    name: 'Yorkshire Terrier',
    blurb: 'Tiny but tenacious, with a silky black and tan coat.',
    price: 900,
    size: 'Small',
    shape: shape({
      H: 0.13, BL: 0.13, CD: 0.062, CW: 0.07, HW: 0.064, tuck: 0.25, belly: 0.9, legT: 0.95, pawR: 0.015,
      neckL: 0.7, neckT: 1.0, hs: 0.75,
      skull: [0.1, 0.088, 0.096], muzzle: [0.04, 0.036, 0.042], muzzleDrop: 0.004, stop: 1.0, flews: 0.5, nose: 0.75, cheek: 0.8,
      eyeR: 0.0105, eyeX: 0.027, eyeY: 0.03, eyeZ: 0.08, eyeOut: 0.36, eyeSink: 0.86,
      ear: { type: 'pointy', L: 0.05, W: 0.04, T: 0.007, pos: [0.034, 0.07, 0.024], splay: 0.3, lean: 0.1 },
      tail: { type: 'plume', L: 0.08, T: 0.016, carry: 1.15, curl: 0.4, side: 0 },
    }),
    fur: fur({ len: 0.016, density: 1100, shells: 20, comb: 0.8, gravity: 0.35, clump: 0.5, regions: { muzzle: 1.0, lip: 0.9, chin: 1.1, brow: 1.2, skull: 0.9, cheek: 1.2, ear: 0.35, legF: 0.9, legH: 0.9, paw: 0.7, tail: 1.1 } }),
    coats: [
      { id: 'blacktan', name: 'Black & Tan', pattern: 'yorkie', colors: { base: '#1d1a19', light: '#2b2725', dark: '#121110', tan: '#b98142', tanLight: '#cf9e62', tanDark: '#976429' }, eye: '#3d2210', nose: '#121010' },
      { id: 'bluegold', name: 'Blue & Gold', pattern: 'yorkie', colors: { base: '#4b5058', light: '#5f656e', dark: '#383c42', tan: '#c99a58', tanLight: '#dcb57c', tanDark: '#a8793c' }, eye: '#3d2210', nose: '#121010', opts: { crown: 0.4 } },
    ],
    voice: { pitch: 1.85, rough: 0.2 },
    energy: 0.8,
  },
];

export function getBreed(id: string): Breed {
  const b = BREEDS.find((b) => b.id === id);
  if (!b) throw new Error('Unknown breed ' + id);
  return b;
}
