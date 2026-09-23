// Trick catalogue. Like Nintendogs, you teach a trick by guiding the puppy
// into it while in Training mode; a light bulb appears and you then say a
// word of your choice. Repeat until it's learned.

export type TrickId = 'sit' | 'down' | 'rollover' | 'shake' | 'beg' | 'spin' | 'playdead' | 'standup' | 'jump' | 'bow' | 'speak' | 'howl';

export interface TrickDef {
  id: TrickId;
  name: string;
  /** how to teach it, shown in the training help */
  how: string;
  /** pose the dog must be in before it can be taught */
  from: 'stand' | 'sit' | 'down' | 'any';
  /** repetitions needed */
  reps: number;
  /** obedience contest difficulty weight */
  difficulty: number;
  /** suggested default word */
  hint: string;
}

export const TRICKS: TrickDef[] = [
  { id: 'sit', name: 'Sit', how: 'While your pup is standing, gently push down on its head or back.', from: 'stand', reps: 3, difficulty: 1, hint: 'sit' },
  { id: 'down', name: 'Lie Down', how: 'While it is sitting, drag its head down towards the floor.', from: 'sit', reps: 3, difficulty: 1, hint: 'down' },
  { id: 'shake', name: 'Shake', how: 'While it is sitting, tap one of its front paws.', from: 'sit', reps: 3, difficulty: 1.5, hint: 'shake' },
  { id: 'beg', name: 'Beg', how: 'While it is sitting, drag upwards from its nose.', from: 'sit', reps: 4, difficulty: 2, hint: 'beg' },
  { id: 'rollover', name: 'Roll Over', how: 'While it is lying down, swipe sideways across its body.', from: 'down', reps: 4, difficulty: 2.5, hint: 'roll over' },
  { id: 'playdead', name: 'Play Dead', how: 'While it is lying down, tap its side twice quickly.', from: 'down', reps: 4, difficulty: 3, hint: 'bang' },
  { id: 'spin', name: 'Spin', how: 'While it is standing, draw a circle around its head.', from: 'stand', reps: 4, difficulty: 2, hint: 'spin' },
  { id: 'standup', name: 'Stand Up', how: 'While it is standing, drag slowly upwards from its head and hold.', from: 'stand', reps: 4, difficulty: 2.5, hint: 'up' },
  { id: 'jump', name: 'Jump', how: 'While it is standing, flick quickly upwards above its head.', from: 'stand', reps: 3, difficulty: 2, hint: 'jump' },
  { id: 'bow', name: 'Bow', how: 'Stay in Training mode until your pup stretches into a play bow on its own.', from: 'stand', reps: 3, difficulty: 2, hint: 'bow' },
  { id: 'speak', name: 'Speak', how: 'Wait in Training mode until your pup barks on its own.', from: 'any', reps: 3, difficulty: 1.5, hint: 'speak' },
  { id: 'howl', name: 'Howl', how: 'Blow the whistle a lot in Training mode, and it may howl along.', from: 'any', reps: 3, difficulty: 3, hint: 'sing' },
];

export function getTrick(id: string) {
  return TRICKS.find((t) => t.id === id);
}

// ----- fuzzy word matching ------------------------------------------------------

export function normalizeWords(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function lev(a: string, b: string) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** crude phonetic key so "sit"/"sitt"/"set" or "fido"/"fighto" land close */
function phonetic(s: string) {
  return s
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/[aeiouy]+/g, (m, off) => (off === 0 ? 'a' : ''))
    .replace(/(.)\1+/g, '$1');
}

/** 0..1 similarity between a heard phrase and a command word. */
export function similarity(heard: string, command: string): number {
  const h = normalizeWords(heard), c = normalizeWords(command);
  if (!h || !c) return 0;
  if (h === c) return 1;
  const score = (x: string) => {
    const d = lev(x, c) / Math.max(x.length, c.length);
    const p1 = phonetic(x), p2 = phonetic(c);
    const pd = lev(p1, p2) / Math.max(1, Math.max(p1.length, p2.length));
    return Math.max(1 - d, (1 - pd) * 0.92);
  };
  let best = score(h);
  // the command may be one word inside a longer utterance ("good boy, sit!")
  const words = h.split(' ');
  const cw = c.split(' ').length;
  for (let i = 0; i + cw <= words.length; i++) best = Math.max(best, score(words.slice(i, i + cw).join(' ')));
  return best;
}
