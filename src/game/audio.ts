/**
 * Audio for the Nintendogs remake.
 *
 * One WebAudio graph: a music bus and an SFX bus (each with its own reverb send) feed a master
 * gain -> limiter -> soft clipper, so the output never exceeds about -0.4 dBFS.
 *
 * - Dog voices: barks, yips, woofs, whines and happy whimpers come from small public-domain / CC0
 *   recordings in `public/sfx` (see CREDITS.md), pitch-shifted and filtered per voice. Everything
 *   else is synthesised, and each recorded kind also has a synthesised fallback that is used
 *   until the samples have loaded (or if they fail to load).
 * - SFX and loops are synthesised from oscillators, filtered noise and procedurally generated
 *   grain buffers.
 * - Music is composed procedurally: chord charts and melodies written as data, walking/bossa bass,
 *   comping and brush-drum patterns generated per loop with a seeded RNG, an improvised second
 *   chorus, and FM electric piano, vibes, marimba, flute, brass and Karplus-Strong guitar/bass
 *   instruments. Notes go through a look-ahead scheduler and tracks crossfade.
 *
 * Every public method is a safe no-op until `init()` has been called from a user gesture. Volume
 * settings and the requested music track are remembered and applied at init.
 */

export type DogSound =
  | 'bark' | 'yip' | 'woof' | 'growl' | 'whine' | 'howl' | 'sneeze'
  | 'pant' | 'sniff' | 'yawn' | 'lap' | 'crunch' | 'happy';
export type SfxName =
  | 'click' | 'select' | 'back' | 'open' | 'coin' | 'buy' | 'squeak' | 'bounce' | 'throw' | 'catch'
  | 'pop' | 'sparkle' | 'heart' | 'lightbulb' | 'learned' | 'whistle' | 'scrub' | 'shower' | 'splash'
  | 'shake' | 'brush' | 'rope' | 'bag' | 'door' | 'bell' | 'camera' | 'fanfare' | 'applause'
  | 'drumroll' | 'countdown' | 'start' | 'dig' | 'present' | 'footstep' | 'eat' | 'gulp' | 'error';
export type MusicTrack = 'title' | 'home' | 'walk' | 'park' | 'shop' | 'kennel' | 'contest' | 'results';
export type LoopName = 'scrub' | 'shower' | 'pant' | 'rain';
export type Surface = 'wood' | 'grass' | 'pavement';

export interface DogVoice {
  /** ~0.8 (big dog) .. 1.8 (chihuahua). */
  pitch: number;
  /** 0 (clean) .. 1 (gravelly). */
  rough: number;
}
export interface PlayOpts {
  /** Linear gain multiplier, default 1. */
  volume?: number;
  /** Stereo position -1 (left) .. 1 (right). */
  pan?: number;
}
export interface SfxOpts extends PlayOpts {
  /** Only used by 'footstep'. */
  surface?: Surface;
}
export interface SoundHandle {
  stop(): void;
}
export interface LoopHandle {
  stop(): void;
  setVolume(v: number): void;
}

export const DOG_SOUNDS: readonly DogSound[] = [
  'bark', 'yip', 'woof', 'growl', 'whine', 'howl', 'sneeze', 'pant', 'sniff', 'yawn', 'lap', 'crunch', 'happy',
];
export const SFX_NAMES: readonly SfxName[] = [
  'click', 'select', 'back', 'open', 'coin', 'buy', 'squeak', 'bounce', 'throw', 'catch', 'pop', 'sparkle',
  'heart', 'lightbulb', 'learned', 'whistle', 'scrub', 'shower', 'splash', 'shake', 'brush', 'rope', 'bag',
  'door', 'bell', 'camera', 'fanfare', 'applause', 'drumroll', 'countdown', 'start', 'dig', 'present',
  'footstep', 'eat', 'gulp', 'error',
];
export const MUSIC_TRACKS: readonly MusicTrack[] = ['title', 'home', 'walk', 'park', 'shop', 'kennel', 'contest', 'results'];
export const LOOP_NAMES: readonly LoopName[] = ['scrub', 'shower', 'pant', 'rain'];

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const LOOKAHEAD = 0.25; // seconds scheduled ahead of currentTime (tolerates main-thread hitches)
const TICK_MS = 30;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Percussive envelope: linear attack to `peak`, then exponential decay reaching ~-50 dB after `decay` s. */
function perc(p: AudioParam, t: number, peak: number, attack: number, decay: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, decay / 6);
}

/** Piecewise-linear automation through [offset, value] points relative to `t`. */
function ramp(p: AudioParam, t: number, pts: ReadonlyArray<readonly [number, number]>) {
  p.setValueAtTime(pts[0][1], t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) p.linearRampToValueAtTime(pts[i][1], t + pts[i][0]);
}

/** Exponential (musical) glide through [offset, hz] points relative to `t`. */
function glide(p: AudioParam, t: number, pts: ReadonlyArray<readonly [number, number]>) {
  p.setValueAtTime(pts[0][1], t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) p.exponentialRampToValueAtTime(Math.max(1, pts[i][1]), t + pts[i][0]);
}

// ---------------------------------------------------------------------------------------------
// Per-context caches: noise, periodic waves, curves, impulse responses, plucked strings
// ---------------------------------------------------------------------------------------------

type NoiseColor = 'white' | 'pink' | 'brown';
const noiseCache = new WeakMap<BaseAudioContext, Record<NoiseColor, AudioBuffer>>();

function noiseBuffers(ctx: BaseAudioContext): Record<NoiseColor, AudioBuffer> {
  let n = noiseCache.get(ctx);
  if (n) return n;
  const len = Math.floor(ctx.sampleRate * 2);
  const make = (fill: (d: Float32Array) => void) => {
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    fill(b.getChannelData(0));
    return b;
  };
  n = {
    white: make((d) => {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }),
    pink: make((d) => {
      // Paul Kellet's economical pink filter.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.2;
        b6 = w * 0.115926;
      }
    }),
    brown: make((d) => {
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
    }),
  };
  noiseCache.set(ctx, n);
  return n;
}

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
/** Periodic wave from harmonic amplitudes [h1, h2, ...] (sine phase). */
function periodicWave(ctx: BaseAudioContext, harmonics: readonly number[]): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) waveCache.set(ctx, (m = new Map()));
  const key = harmonics.join(',');
  let w = m.get(key);
  if (!w) {
    const real = new Float32Array(harmonics.length + 1);
    const imag = new Float32Array(harmonics.length + 1);
    harmonics.forEach((a, i) => (imag[i + 1] = a));
    w = ctx.createPeriodicWave(real, imag);
    m.set(key, w);
  }
  return w;
}

const curveCache = new Map<number, Float32Array<ArrayBuffer>>();
/** tanh saturation curve with drive k (normalised so full scale maps to full scale). */
function driveCurve(k: number): Float32Array<ArrayBuffer> {
  const key = Math.round(k * 10) / 10;
  let c = curveCache.get(key);
  if (!c) {
    c = new Float32Array(1024);
    const norm = Math.tanh(key);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(key * x) / norm;
    }
    curveCache.set(key, c);
  }
  return c;
}

/** Linear up to 0.8, then a tanh knee that can never exceed ~0.95 (-0.4 dBFS). */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  const knee = 0.8;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Stereo reverb impulse: a few early reflections plus a darkening exponential noise tail. */
function impulseResponse(ctx: BaseAudioContext, seconds: number, brightness: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.012);
      // One-pole lowpass whose cutoff falls over the tail, so it darkens like a real room.
      const k = brightness * (0.6 - 0.45 * (t / seconds)) + 0.05;
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * env;
    }
    for (let r = 0; r < 6; r++) {
      const at = Math.floor(sr * (0.007 + Math.random() * 0.045));
      d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.5 - r * 0.06);
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < len; i++) d[i] *= 0.5 / peak;
  }
  return buf;
}

/**
 * Procedural texture of short decaying noise grains, each coloured by a random two-pole
 * resonator: kibble crunches, plastic crinkles, grit, water droplets, claps.
 */
interface GrainSpec {
  dur: number;
  /** Grains per second. */
  density: number;
  /** Grain decay time constant in ms. */
  decayMs: number;
  /** Resonator frequency range [lo, hi] in Hz. */
  freq: readonly [number, number];
  /** Resonator pole radius 0..0.999 (higher = more ringing / tonal). */
  res: number;
  stereo?: boolean;
  /** Optional density/amplitude shape over normalised time 0..1. */
  shape?: (x: number) => number;
}
function grainBuffer(ctx: BaseAudioContext, g: GrainSpec): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.ceil(g.dur * sr));
  const chs = g.stereo ? 2 : 1;
  const buf = ctx.createBuffer(chs, n, sr);
  const data = Array.from({ length: chs }, (_, c) => buf.getChannelData(c));
  const count = Math.round(g.density * g.dur);
  const k = 1 / ((g.decayMs / 1000) * sr);
  const glen = Math.ceil(6 / k);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(Math.random() * n);
    const x = start / n;
    const amp = (0.25 + 0.75 * Math.random()) * (g.shape ? g.shape(x) : 1);
    if (amp <= 0.001) continue;
    const f = g.freq[0] * Math.pow(g.freq[1] / g.freq[0], Math.random());
    const w = (2 * Math.PI * f) / sr;
    const a1 = 2 * g.res * Math.cos(w);
    const a2 = -g.res * g.res;
    const pan = g.stereo ? Math.random() : 0.5;
    const gl = chs === 2 ? Math.cos(pan * Math.PI * 0.5) * 1.4 : 1;
    const gr = chs === 2 ? Math.sin(pan * Math.PI * 0.5) * 1.4 : 1;
    let y1 = 0, y2 = 0;
    const norm = 1 - g.res;
    for (let j = 0; j < glen && start + j < n; j++) {
      const exc = (Math.random() * 2 - 1) * Math.exp(-j * k);
      const y = exc * norm + a1 * y1 + a2 * y2;
      y2 = y1;
      y1 = y;
      const s = amp * (g.res > 0.05 ? y : exc);
      data[0][start + j] += s * gl;
      if (chs === 2) data[1][start + j] += s * gr;
    }
  }
  let peak = 0;
  for (const d of data) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (const d of data) for (let i = 0; i < n; i++) d[i] *= 0.9 / peak;
  return buf;
}

/**
 * Karplus-Strong plucked string with an allpass fractional delay for accurate tuning.
 * `t60` is the decay time, `bright` (0..1) the pluck brightness, `damp` (0..1) extra loop damping.
 */
function karplusStrong(sr: number, freq: number, dur: number, t60: number, bright: number, damp: number, pickPos: number): Float32Array<ArrayBuffer> {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const P = sr / freq;
  let N = Math.floor(P - 0.5);
  let frac = P - 0.5 - N;
  if (frac < 0.2) {
    N -= 1;
    frac += 1;
  }
  const C = (1 - frac) / (1 + frac);
  const rho = Math.pow(10, -3 / (freq * t60));
  // Excitation: low-passed noise burst, combed at the pluck position, DC removed.
  const exc = new Float32Array(N);
  let s = 0;
  for (let i = 0; i < N; i++) {
    s += bright * (Math.random() * 2 - 1 - s);
    exc[i] = s;
  }
  const pp = Math.max(1, Math.round(pickPos * N));
  for (let i = N - 1; i >= pp; i--) exc[i] -= exc[i - pp];
  let mean = 0;
  for (let i = 0; i < N; i++) mean += exc[i];
  mean /= N;
  for (let i = 0; i < N; i++) exc[i] -= mean;
  let apx = 0, apy = 0, lp = 0;
  const lpk = 1 - damp;
  for (let i = 0; i < n; i++) {
    const a = i >= N ? out[i - N] : 0;
    const b = i >= N + 1 ? out[i - N - 1] : 0;
    let u = 0.5 * (a + b) * rho;
    lp += lpk * (u - lp);
    u = damp > 0 ? lp : u;
    const ap = C * u + apx - C * apy;
    apx = u;
    apy = ap;
    out[i] = (i < N ? exc[i] : 0) + ap;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.9 / peak;
  // Gentle fade so the buffer never ends in a click.
  const fade = Math.floor(sr * 0.05);
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

const ksCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
function pluckBuffer(ctx: BaseAudioContext, kind: 'guitar' | 'bass', m: number): AudioBuffer {
  let c = ksCache.get(ctx);
  if (!c) ksCache.set(ctx, (c = new Map()));
  const key = kind + m;
  let b = c.get(key);
  if (!b) {
    const sr = 22050;
    const f = mtof(m);
    const data = kind === 'guitar'
      ? karplusStrong(sr, f, 1.6, clamp(3.2 * Math.sqrt(196 / f), 0.8, 4), 0.55, 0, 0.17)
      : karplusStrong(sr, f, 1.5, 2.2, 0.3, 0.45, 0.28);
    b = ctx.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    c.set(key, b);
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Voice: a disposable group of nodes for one sound event
// ---------------------------------------------------------------------------------------------

class Voice implements SoundHandle {
  readonly out: GainNode;
  private readonly tail: AudioNode;
  private readonly extra: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private pending = 0;
  private disposed = false;
  end: number;

  constructor(readonly e: AudioEngine, readonly t: number, dest: AudioNode, gain = 1, pan = 0) {
    const ctx = e.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = gain;
    let tail: AudioNode = this.out;
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      this.out.connect(p);
      tail = p;
    }
    tail.connect(dest);
    this.tail = tail;
    this.end = t;
  }

  get ctx(): BaseAudioContext {
    return this.e.ctx;
  }

  /** Post-fader send, e.g. into a reverb. */
  send(dest: AudioNode, amount: number) {
    if (amount <= 0) return;
    const g = this.gain(amount);
    this.tail.connect(g);
    g.connect(dest);
    this.extra.push(g);
  }

  private track(s: AudioScheduledSourceNode, stopAt: number) {
    this.sources.push(s);
    this.pending++;
    s.onended = () => {
      if (--this.pending <= 0) this.dispose();
    };
    this.end = Math.max(this.end, stopAt);
  }

  osc(type: OscillatorType | PeriodicWave, freq: number, t: number, dur: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (type instanceof PeriodicWave) o.setPeriodicWave(type);
    else o.type = type;
    o.frequency.value = freq;
    o.start(t);
    o.stop(t + dur);
    this.track(o, t + dur);
    return o;
  }

  noise(t: number, dur: number, color: NoiseColor = 'white'): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = noiseBuffers(this.ctx)[color];
    s.loop = true;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur);
    this.track(s, t + dur);
    return s;
  }

  /** Plays `dur` seconds of buffer content (or loops it for `dur` seconds of output). */
  buffer(buf: AudioBuffer, t: number, rate = 1, offset = 0, dur?: number, loop = false): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const d = dur ?? buf.duration - offset;
    if (loop) {
      s.loop = true;
      s.start(t, offset);
      s.stop(t + d);
      this.track(s, t + d);
    } else {
      s.start(t, offset, d);
      this.track(s, t + d / rate);
    }
    return s;
  }

  wave(h: readonly number[]): PeriodicWave {
    return periodicWave(this.ctx, h);
  }

  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707, gain = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freq, this.ctx.sampleRate * 0.45);
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  }

  shaper(curve: Float32Array<ArrayBuffer>): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = curve;
    w.oversample = '2x';
    return w;
  }

  panner(p: number): StereoPannerNode {
    const n = this.ctx.createStereoPanner();
    n.pan.value = clamp(p, -1, 1);
    return n;
  }

  /** Connects nodes in series and returns the last one. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Connects nodes in series into `param` (audio-rate modulation). */
  mod(param: AudioParam, ...nodes: AudioNode[]) {
    this.chain(...nodes).connect(param);
  }

  stop(fade = 0.06) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const s of this.sources) {
      try {
        s.stop(now + fade + 0.02);
      } catch {
        /* already stopped */
      }
    }
  }

  private dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.tail.disconnect();
    if (this.tail !== this.out) this.out.disconnect();
    for (const n of this.extra) n.disconnect();
  }
}

/** Calls `fn(until)` so it can schedule events up to `until`: once for offline renders, else on a timer. */
class Driver {
  private timer = 0;
  constructor(e: AudioEngine, fn: (until: number) => void) {
    fn(e.horizon);
    if (!e.offline) this.timer = window.setInterval(() => fn(e.horizon), TICK_MS);
  }
  stop() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Recorded dog samples
// ---------------------------------------------------------------------------------------------

interface SampleClip {
  buffer: AudioBuffer;
  /** Offset of the first audible sample (skips decoder padding). */
  start: number;
  dur: number;
}

const SAMPLE_NAMES = ['bark1', 'bark2', 'bark3', 'whine1', 'whine2', 'whine3', 'pup1', 'pup2', 'pup3', 'pup4', 'pup5'] as const;
type ClipGroup = 'bark' | 'whine' | 'pup' | 'pupShort';
const CLIP_GROUPS: Record<ClipGroup, readonly string[]> = {
  bark: ['bark1', 'bark2', 'bark3'],
  whine: ['whine1', 'whine2', 'whine3'],
  pup: ['pup1', 'pup2', 'pup3'],
  pupShort: ['pup4', 'pup5'],
};

function trimClip(buffer: AudioBuffer): SampleClip {
  const d = buffer.getChannelData(0);
  const thr = 0.004;
  let a = 0;
  while (a < d.length && Math.abs(d[a]) < thr) a++;
  let b = d.length - 1;
  while (b > a && Math.abs(d[b]) < thr * 0.5) b--;
  const start = Math.max(0, a / buffer.sampleRate - 0.003);
  const end = Math.min(buffer.duration, b / buffer.sampleRate + 0.01);
  return { buffer, start, dur: Math.max(0.01, end - start) };
}

// ---------------------------------------------------------------------------------------------
// Dog voices
// ---------------------------------------------------------------------------------------------

interface DogCtx {
  e: AudioEngine;
  v: Voice;
  t: number;
  /** Voice pitch (size): 0.8 big .. 1.8 tiny. */
  p: number;
  /** Roughness 0..1. */
  r: number;
}

/**
 * Size EQ plus "gravel": low shelf for chest on big dogs, a little air on tiny ones, and for rough
 * voices an irregular amplitude flutter and band-limited saturation.
 */
function dogBody(d: DogCtx, input: AudioNode, dur: number): AudioNode {
  const { v, p, r, t } = d;
  const lo = v.filter('lowshelf', 260, 0.7, clamp((1.1 - p) * 10, -5, 5));
  const hi = v.filter('highshelf', 3800, 0.7, clamp((p - 1.2) * 5, -3, 3));
  input.connect(lo);
  lo.connect(hi);
  if (r < 0.04) return hi;
  const out = v.gain(1);
  const am = v.gain(1 - r * 0.32);
  const lfo = v.osc('triangle', rand(34, 56), t, dur);
  const depth = v.gain(r * 0.32);
  lfo.connect(depth);
  depth.connect(am.gain);
  const wob = v.osc('sine', rand(5, 9), t, dur);
  const wobAmt = v.gain(14);
  wob.connect(wobAmt);
  wobAmt.connect(lfo.frequency);
  hi.connect(am);
  am.connect(out);
  const sat = v.shaper(driveCurve(2 + r * 8));
  const bp = v.filter('bandpass', 1500 * p, 0.9);
  const grit = v.gain(r * 0.5);
  v.chain(hi, sat, bp, grit, out);
  return out;
}

/** Recorded bark, shifted to the dog's size; yips are faster, truncated and thinner, woofs slower and darker. */
function barkSample(d: DogCtx, kind: 'bark' | 'yip' | 'woof', dest: AudioNode): boolean {
  const clip = d.e.pickClip('bark');
  if (!clip) return false;
  const { v, t, p } = d;
  let rate = (p / 1.15) * rand(0.95, 1.05);
  let len = clip.dur;
  const pre = v.gain(1);
  let tail: AudioNode = pre;
  let level = 0.95;
  if (kind === 'yip') {
    rate *= rand(1.35, 1.5);
    len = Math.min(len, rand(0.13, 0.16) * rate);
    tail = v.chain(pre, v.filter('highpass', 380 * p, 0.7));
    level = 0.8;
  } else if (kind === 'woof') {
    rate *= rand(0.76, 0.84);
    tail = v.chain(pre, v.filter('lowpass', 1900 * Math.pow(p, 0.8), 0.6), v.filter('lowshelf', 180, 0.7, 4));
    level = 1.05;
  }
  const outDur = len / rate;
  const src = v.buffer(clip.buffer, t, rate, clip.start, len);
  const env = v.gain(level);
  if (kind === 'yip') ramp(env.gain, t, [[0, level], [outDur * 0.6, level], [outDur, 0]]);
  src.connect(env);
  env.connect(pre);
  dogBody(d, tail, outDur + 0.1).connect(dest);
  return true;
}

/** Synthesised bark: noisy harmonic burst with a fast pitch drop through moving formants. */
function barkSynth(d: DogCtx, kind: 'bark' | 'yip' | 'woof', dest: AudioNode) {
  const { v, t, p, r } = d;
  const len = ((kind === 'yip' ? 0.085 : kind === 'woof' ? 0.22 : 0.15) * rand(0.9, 1.12)) / Math.pow(p, 0.25);
  const f0 = (kind === 'yip' ? 700 : kind === 'woof' ? 250 : 420) * p * rand(0.94, 1.06);
  const src = v.osc('sawtooth', f0, t, len + 0.03);
  glide(src.frequency, t, [[0, f0 * 0.8], [len * 0.2, f0 * 1.15], [len, f0 * 0.6]]);
  const mix = v.gain(1);
  v.chain(src, v.gain(0.5), mix);
  v.chain(v.noise(t, len + 0.03), v.gain(0.5 + r * 0.4), mix);
  const sum = v.gain(1);
  const formants = [[620, 3, 1], [1250, 4, 0.7], [2600, 5, 0.35]] as const;
  for (const [f, q, g] of formants) {
    const bp = v.filter('bandpass', f * p, q);
    glide(bp.frequency, t, [[0, f * p * 0.6], [len * 0.3, f * p], [len, f * p * 0.75]]);
    v.chain(mix, bp, v.gain(g * 3.2), sum);
  }
  const env = v.gain(0);
  ramp(env.gain, t, [[0, 0], [0.006, 1], [len * 0.4, 0.7], [len, 0]]);
  const body = v.gain(1);
  v.chain(sum, env, body);
  const click = v.gain(0);
  perc(click.gain, t, 0.25, 0.001, 0.012);
  v.chain(v.noise(t, 0.02), v.filter('highpass', 1800), click, body);
  dogBody(d, body, len + 0.1).connect(dest);
}

/** Recorded whine: basset-hound whines for bigger voices, puppy cries for small ones; sometimes a pair. */
function whineSample(d: DogCtx, dest: AudioNode): boolean {
  const { e, v, p } = d;
  const pup = Math.random() < smoothstep(1.05, 1.45, p);
  const group: ClipGroup = pup ? 'pup' : 'whine';
  const first = e.pickClip(group);
  if (!first) return false;
  const count = pup ? (Math.random() < 0.4 ? 2 : 1) : Math.random() < 0.3 ? 3 : 2;
  const parts: { clip: SampleClip; rate: number; at: number }[] = [];
  let at = d.t;
  for (let i = 0; i < count; i++) {
    const clip = i === 0 ? first : e.pickClip(group) ?? first;
    const rate = (pup ? p / 1.55 : p * 1.45) * rand(0.94, 1.06) * (i ? rand(1.0, 1.08) : 1);
    parts.push({ clip, rate, at });
    at += clip.dur / rate + rand(0.05, 0.14);
  }
  const bus = v.gain(1);
  dogBody(d, bus, at - d.t + 0.1).connect(dest);
  parts.forEach(({ clip, rate, at: t0 }, i) => {
    v.chain(v.buffer(clip.buffer, t0, rate, clip.start, clip.dur), v.gain((i ? 0.8 : 1) * (pup ? 0.6 : 0.75)), bus);
  });
  return true;
}

/** Synthesised whine: gliding nasal tone with vibrato and a breath of noise. */
function whineTone(v: Voice, dest: AudioNode, t: number, p: number, dur: number, level: number) {
  const f0 = 640 * Math.pow(p, 1.1) * rand(0.93, 1.07);
  const o = v.osc(v.wave([1, 0.5, 0.22, 0.1, 0.05]), f0, t, dur + 0.05);
  glide(o.frequency, t, [[0, f0 * 0.86], [dur * 0.35, f0 * 1.12], [dur, f0 * 0.93]]);
  v.mod(o.frequency, v.osc('sine', rand(5.5, 7.5), t, dur + 0.05), v.gain(f0 * 0.025));
  const lp = v.filter('lowpass', f0 * 4, 0.7);
  v.chain(o, v.filter('bandpass', f0 * 2.1, 1.6), v.gain(1.6), lp);
  v.chain(o, v.gain(0.35), lp);
  const g = v.gain(0);
  ramp(g.gain, t, [[0, 0], [0.04, level], [Math.max(0.05, dur - 0.08), level * 0.85], [dur, 0]]);
  v.chain(lp, g, dest);
  const ng = v.gain(0);
  ramp(ng.gain, t, [[0, 0], [0.05, level * 0.6], [dur, 0]]);
  v.chain(v.noise(t, dur), v.filter('bandpass', f0 * 2, 3), ng, dest);
}

function whineSynth(d: DogCtx, dest: AudioNode) {
  const bus = d.v.gain(1);
  let t = d.t;
  const n = Math.random() < 0.4 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const dur = rand(0.4, 0.75);
    whineTone(d.v, bus, t, d.p * (i ? 1.05 : 1), dur, i ? 0.16 : 0.2);
    t += dur + rand(0.06, 0.14);
  }
  dogBody(d, bus, t - d.t + 0.1).connect(dest);
}

/** Short nasal exhale ("hff"). */
function huff(v: Voice, dest: AudioNode, t: number, p: number, level: number) {
  const g = v.gain(0);
  ramp(g.gain, t, [[0, 0], [0.012, level], [0.05, level * 0.6], [0.13, 0]]);
  v.chain(v.noise(t, 0.14, 'pink'), v.filter('bandpass', 900 * p * rand(0.9, 1.1), 1.2), v.filter('lowpass', 2000 * p), g, dest);
}

/** Excited little huff-huff and a short rising whimper, as when petted. */
function happy(d: DogCtx, dest: AudioNode) {
  const { e, v, t, p } = d;
  const bus = v.gain(1);
  dogBody(d, bus, 1.1).connect(dest);
  huff(v, bus, t, p, 1.1);
  const t2 = t + rand(0.11, 0.15);
  if (Math.random() < 0.7) huff(v, bus, t2, p, 0.9);
  const tw = t2 + rand(0.1, 0.14);
  const pup = Math.random() < smoothstep(0.95, 1.35, p);
  const clip = e.pickClip(pup ? 'pupShort' : 'whine');
  let end = tw + 0.3;
  if (clip) {
    const rate = (pup ? p / 1.5 : p * 1.3) * rand(1.0, 1.1);
    const len = Math.min(clip.dur, 0.3 * rate);
    const od = len / rate;
    const src = v.buffer(clip.buffer, tw, rate, clip.start, len);
    src.playbackRate.setValueAtTime(rate, tw);
    src.playbackRate.linearRampToValueAtTime(rate * 1.08, tw + od);
    const g = v.gain(0);
    ramp(g.gain, tw, [[0, 0.55], [od * 0.75, 0.55], [od, 0]]);
    v.chain(src, g, bus);
    end = tw + od;
  } else {
    whineTone(v, bus, tw, p * 1.1, 0.24, 0.22);
  }
  if (Math.random() < 0.5) huff(v, bus, end + 0.03, p, 0.8);
}

/** Howl: an "a-woooo" with a rising onset, vibrato, a formant that closes and a falling tail. */
function howl(d: DogCtx, dest: AudioNode) {
  const { v, t, p, r } = d;
  const dur = rand(1.7, 2.4);
  const f0 = 430 * Math.pow(p, 0.9) * rand(0.94, 1.06);
  const o = v.osc(v.wave([1, 0.42, 0.2, 0.1, 0.05, 0.025]), f0, t, dur + 0.1);
  glide(o.frequency, t, [
    [0, f0 * 0.72], [0.32, f0], [dur * 0.6, f0 * rand(1.02, 1.07)], [dur * 0.85, f0 * 0.95], [dur, f0 * 0.72],
  ]);
  const vg = v.gain(0);
  ramp(vg.gain, t, [[0, 0], [0.5, 0], [1.0, f0 * 0.012], [dur, f0 * 0.018]]);
  v.mod(o.frequency, v.osc('sine', rand(4.5, 5.8), t, dur + 0.1), vg);
  const sum = v.gain(1);
  const f1 = v.filter('bandpass', 800 * p, 2.2);
  glide(f1.frequency, t, [[0, 850 * p], [0.35, 700 * p], [dur, 420 * p]]);
  const f2 = v.filter('bandpass', 1300 * p, 3);
  glide(f2.frequency, t, [[0, 1350 * p], [0.4, 1150 * p], [dur, 850 * p]]);
  v.chain(o, f1, v.gain(1.6), sum);
  v.chain(o, f2, v.gain(0.8), sum);
  v.chain(o, v.gain(0.45), sum);
  const env = v.gain(0);
  ramp(env.gain, t, [[0, 0], [0.12, 0.25], [0.35, 0.36], [dur - 0.35, 0.32], [dur, 0]]);
  const body = v.gain(1);
  v.chain(sum, env, body);
  const ng = v.gain(0);
  ramp(ng.gain, t, [[0, 0], [0.1, 0.15 + r * 0.25], [dur, 0]]);
  v.chain(v.noise(t, dur), v.filter('bandpass', f0 * 2, 1), ng, body);
  dogBody(d, body, dur + 0.1).connect(dest);
}

/** Growl: low jittery pulse train with pulse-synchronous breath, formants and a rolling "rrr" flutter. */
function growl(d: DogCtx, dest: AudioNode) {
  const { v, t, p, r } = d;
  const dur = rand(0.9, 1.5);
  const f0 = 92 * Math.pow(p, 1.1) * rand(0.92, 1.08);
  const o = v.osc('sawtooth', f0, t, dur + 0.05);
  glide(o.frequency, t, [[0, f0 * 0.9], [dur * 0.4, f0 * 1.08], [dur, f0 * 0.92]]);
  v.mod(o.frequency, v.noise(t, dur + 0.05, 'brown'), v.filter('lowpass', 40), v.gain(f0 * (0.25 + r * 0.25)));
  const mix = v.gain(1);
  v.chain(o, v.gain(0.7), mix);
  const breath = v.gain(0);
  v.mod(breath.gain, o, v.gain(0.4 + r * 0.3));
  v.chain(v.noise(t, dur + 0.05, 'pink'), breath, v.gain(1.4), mix);
  const sum = v.gain(1);
  for (const [f, q, g] of [[380, 2.2, 1.6], [1000, 2.5, 1.0], [2300, 3, 0.25]] as const) {
    v.chain(mix, v.filter('bandpass', f * p, q), v.gain(g), sum);
  }
  v.chain(mix, v.filter('lowpass', 420 * p), v.gain(0.6), sum);
  // Rolling "rrr" plus a slower breathing swell.
  const roll = v.gain(0.72);
  v.mod(roll.gain, v.osc('sine', rand(19, 27), t, dur + 0.05), v.gain(0.26));
  v.mod(roll.gain, v.osc('sine', rand(1.5, 3), t, dur + 0.05), v.gain(0.1));
  const env = v.gain(0);
  ramp(env.gain, t, [[0, 0], [0.18, 0.75], [dur * 0.5, 0.95], [dur - 0.25, 0.8], [dur, 0]]);
  const body = v.gain(1);
  v.chain(sum, v.filter('lowpass', 2600 * p, 0.7), roll, env, body);
  dogBody(d, body, dur + 0.1).connect(dest);
}

/** Sneeze: optional quick inhale, then a sharp "tchff" with a nasal snort. */
function sneeze(d: DogCtx, dest: AudioNode) {
  const { v, t, p } = d;
  let tb = t;
  if (Math.random() < 0.6) {
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.14, 0.5], [0.18, 0]]);
    v.chain(v.noise(t, 0.2), v.filter('bandpass', 2200 * p, 1.2), g, dest);
    tb = t + 0.2;
  }
  const burst = (at: number, level: number) => {
    const g1 = v.gain(0);
    perc(g1.gain, at, 1.4 * level, 0.003, 0.16);
    v.chain(v.noise(at, 0.2), v.filter('highpass', 1000), v.filter('bandpass', 2800 * Math.sqrt(p), 0.8), g1, dest);
    const g2 = v.gain(0);
    perc(g2.gain, at, 1.2 * level, 0.002, 0.07);
    v.chain(v.noise(at, 0.1, 'pink'), v.filter('lowpass', 900 * p), g2, dest);
    const g3 = v.gain(0);
    perc(g3.gain, at, 0.35 * level, 0.004, 0.06);
    v.chain(v.osc('sawtooth', 75 * p, at, 0.1), v.filter('lowpass', 700 * p), g3, dest);
  };
  burst(tb, 1);
  if (Math.random() < 0.25) burst(tb + rand(0.3, 0.4), 0.7);
}

/** Two to five quick sniffs, sometimes followed by a soft exhale. */
function sniff(d: DogCtx, dest: AudioNode) {
  const { v, t, p } = d;
  const n = 2 + Math.floor(Math.random() * 4);
  let tt = t;
  for (let i = 0; i < n; i++) {
    const dur = rand(0.045, 0.075);
    const a = rand(0.8, 1.3) * (i === n - 1 ? 1.15 : 1);
    const g = v.gain(0);
    ramp(g.gain, tt, [[0, 0], [0.012, a], [dur * 0.6, a * 0.8], [dur, 0]]);
    v.chain(v.noise(tt, dur + 0.01), v.filter('highpass', 900), v.filter('bandpass', 2600 * Math.sqrt(p) * rand(0.9, 1.1), 1.3), g, dest);
    tt += dur + rand(0.035, 0.07);
  }
  if (Math.random() < 0.5) {
    const g = v.gain(0);
    ramp(g.gain, tt + 0.05, [[0, 0], [0.02, 0.7], [0.14, 0]]);
    v.chain(v.noise(tt + 0.05, 0.15, 'pink'), v.filter('bandpass', 800 * p, 0.9), g, dest);
  }
}

/** Yawn: airflow through an opening then closing mouth, a squeaky rising "eee-oo" and a jaw click. */
function yawn(d: DogCtx, dest: AudioNode) {
  const { v, t, p } = d;
  const D = rand(1.1, 1.5) / Math.pow(p, 0.25);
  const bus = v.gain(1);
  const nf = v.filter('bandpass', 500 * p, 1.5);
  glide(nf.frequency, t, [[0, 500 * p], [0.4 * D, 950 * p], [0.8 * D, 600 * p], [D, 350 * p]]);
  const ng = v.gain(0);
  ramp(ng.gain, t, [[0, 0], [0.25 * D, 0.5], [0.7 * D, 0.4], [D, 0]]);
  v.chain(v.noise(t, D, 'pink'), nf, v.filter('lowpass', 2800 * p), ng, bus);
  const f0 = 520 * p * rand(0.93, 1.07);
  const o = v.osc(v.wave([1, 0.4, 0.15, 0.06]), f0, t + 0.1 * D, D * 0.8);
  glide(o.frequency, t, [[0.1 * D, f0], [0.38 * D, f0 * 1.9], [0.55 * D, f0 * 1.75], [0.85 * D, f0 * 0.8]]);
  v.mod(o.frequency, v.osc('sine', 6, t + 0.1 * D, D * 0.8), v.gain(f0 * 0.02));
  const og = v.gain(0);
  ramp(og.gain, t, [[0.1 * D, 0], [0.3 * D, 0.4], [0.6 * D, 0.36], [0.85 * D, 0]]);
  v.chain(o, v.filter('lowpass', f0 * 5), og, bus);
  const cg = v.gain(0);
  perc(cg.gain, t + D, 0.5, 0.001, 0.02);
  v.chain(v.noise(t + D, 0.03), v.filter('bandpass', 2500, 2), cg, bus);
  dogBody(d, bus, D + 0.1).connect(dest);
}

/** Water droplet: a sine "plip" whose pitch rises quickly (bubble resonance). */
function plip(v: Voice, dest: AudioNode, t: number, f: number, level: number, dur = 0.05) {
  const o = v.osc('sine', f, t, dur + 0.02);
  glide(o.frequency, t, [[0, f], [dur * 0.7, f * 2.3]]);
  const g = v.gain(0);
  perc(g.gain, t, level, 0.001, dur);
  v.chain(o, g, dest);
}

/** Lapping water: rhythmic tongue splashes with bubbly plips. */
function lap(d: DogCtx, dest: AudioNode) {
  const { v, t, p } = d;
  const n = 6 + Math.floor(Math.random() * 4);
  const T = 0.22 / Math.pow(p, 0.25);
  let tl = t;
  for (let i = 0; i < n; i++) {
    const g = v.gain(0);
    perc(g.gain, tl, 1.1, 0.003, 0.05);
    v.chain(v.noise(tl, 0.07), v.filter('bandpass', 1700 * rand(0.8, 1.2), 0.9), g, dest);
    const k = 1 + Math.floor(Math.random() * 3);
    for (let j = 0; j < k; j++) plip(v, dest, tl + 0.008 + j * rand(0.018, 0.03), rand(350, 1200) * Math.sqrt(p), rand(0.25, 0.4), rand(0.03, 0.055));
    const s = v.gain(0);
    perc(s.gain, tl, 0.5, 0.005, 0.06);
    v.chain(v.noise(tl, 0.08, 'pink'), v.filter('lowpass', 700), s, dest);
    tl += T * rand(0.92, 1.08);
  }
}

/** Kibble crunching: bursts of grainy crackle with a jaw thud per chew. */
function crunch(d: DogCtx, dest: AudioNode, chews = 4 + Math.floor(Math.random() * 3)) {
  const { v, t, p } = d;
  let tc = t;
  for (let i = 0; i < chews; i++) {
    const buf = grainBuffer(v.ctx, { dur: rand(0.07, 0.11), density: rand(160, 260), decayMs: 1.2, freq: [1500, 5000], res: 0.35, shape: (x) => 1 - x * 0.6 });
    const g = v.gain(0);
    perc(g.gain, tc, rand(0.5, 0.75) * (1 - i * 0.1), 0.002, 0.12);
    v.chain(v.buffer(buf, tc), v.filter('highpass', 900), g, dest);
    const o = v.osc('sine', 130 * p, tc, 0.08);
    glide(o.frequency, tc, [[0, 130 * p], [0.06, 80 * p]]);
    const og = v.gain(0);
    perc(og.gain, tc, 0.3, 0.002, 0.05);
    v.chain(o, og, dest);
    tc += 0.27 * rand(0.88, 1.12);
  }
}

/** One panting breath cycle (a punchy exhaled "hah" and a softer inhale); returns the cycle length. */
function pantBreath(v: Voice, dest: AudioNode, t: number, p: number, r: number): number {
  const T = (0.3 / Math.pow(p, 0.4)) * rand(0.93, 1.07);
  const ex = T * 0.38;
  const a = rand(0.85, 1.1);
  const eg = v.gain(0);
  ramp(eg.gain, t, [[0, 0], [0.012, a], [ex * 0.45, a * 0.55], [ex, 0]]);
  const exSum = v.gain(1);
  v.chain(v.noise(t, ex + 0.02), v.filter('bandpass', 1250 * p, 1.2), v.filter('lowpass', 3500 * p), v.gain(1.6), exSum);
  v.chain(v.noise(t, ex + 0.02), v.filter('bandpass', 2400 * p, 2.5), v.filter('bandpass', 2400 * p, 2.5), v.gain(1.2), exSum);
  v.chain(v.osc('sawtooth', 150 * p * rand(0.95, 1.05), t, ex + 0.02), v.filter('lowpass', 900 * p), v.gain(0.06 + r * 0.1), exSum);
  v.chain(exSum, eg, dest);
  const ti = t + T * 0.5;
  const ig = v.gain(0);
  ramp(ig.gain, ti, [[0, 0], [T * 0.1, 0.4], [T * 0.3, 0]]);
  v.chain(v.noise(ti, T * 0.32), v.filter('bandpass', 1900 * p, 1.5), v.filter('lowpass', 4500), ig, dest);
  return T;
}

// ---------------------------------------------------------------------------------------------
// Synth building blocks for SFX
// ---------------------------------------------------------------------------------------------

/** Glassy chime: sine plus a few inharmonic partials that decay faster. */
function chime(v: Voice, dest: AudioNode, t: number, f: number, level: number, decay = 0.6, bright = 1) {
  const parts = [[1, 1, 1], [2.0, 0.28 * bright, 0.5], [2.76, 0.16 * bright, 0.3], [5.4, 0.06 * bright, 0.15]] as const;
  for (const [ratio, amp, dk] of parts) {
    if (f * ratio > 16000) continue;
    const g = v.gain(0);
    perc(g.gain, t, level * amp, 0.002, decay * dk);
    v.chain(v.osc('sine', f * ratio, t, decay * dk + 0.05), g, dest);
  }
}

/** Soft bell (FM with a non-integer ratio). */
function fmBell(v: Voice, dest: AudioNode, t: number, f: number, level: number, decay = 1.2, ratio = 3.5, index = 1.4) {
  const car = v.osc('sine', f, t, decay + 0.05);
  const mod = v.osc('sine', f * ratio, t, decay + 0.05);
  const mg = v.gain(0);
  perc(mg.gain, t, f * index, 0.001, decay * 0.6);
  v.mod(car.frequency, mod, mg);
  const g = v.gain(0);
  perc(g.gain, t, level, 0.002, decay);
  v.chain(car, g, dest);
}

/** Short tone with an attack/release envelope (beeps, blips). */
function tone(v: Voice, dest: AudioNode, t: number, type: OscillatorType | PeriodicWave, f: number, dur: number, level: number, attack = 0.005, release = 0.04) {
  const o = v.osc(type, f, t, dur + release + 0.02);
  const g = v.gain(0);
  ramp(g.gain, t, [[0, 0], [attack, level], [Math.max(attack, dur), level], [dur + release, 0]]);
  v.chain(o, g, dest);
  return o;
}

/** Filtered-noise burst with a percussive envelope. */
function noiseHit(v: Voice, dest: AudioNode, t: number, type: BiquadFilterType, f: number, q: number, level: number, attack: number, decay: number, color: NoiseColor = 'white') {
  const g = v.gain(0);
  perc(g.gain, t, level, attack, decay);
  v.chain(v.noise(t, attack + decay + 0.02, color), v.filter(type, f, q), g, dest);
}

/** Brassy note: detuned saws through an enveloped lowpass. */
function brassTone(v: Voice, dest: AudioNode, t: number, f: number, dur: number, level: number) {
  const lp = v.filter('lowpass', f * 1.2, 1.2);
  ramp(lp.frequency, t, [[0, f * 1.2], [0.04, f * 7], [0.25, f * 3.5], [dur, f * 3], [dur + 0.12, f * 1.5]]);
  for (const det of [-7, 7]) {
    const o = v.osc('sawtooth', f, t, dur + 0.15);
    o.detune.value = det;
    glide(o.frequency, t, [[0, f * 0.985], [0.04, f]]);
    o.connect(lp);
  }
  const g = v.gain(0);
  ramp(g.gain, t, [[0, 0], [0.025, level], [0.2, level * 0.8], [dur, level * 0.75], [dur + 0.12, 0]]);
  v.chain(lp, g, dest);
}

/** Crash/ride-like metallic noise: square partials at inharmonic ratios plus hiss. */
function metal(v: Voice, dest: AudioNode, t: number, level: number, decay: number, base = 420) {
  const hp = v.filter('highpass', 5500, 0.7);
  for (const ratio of [1, 1.4983, 2.2345, 2.9]) v.chain(v.osc('square', base * ratio, t, decay + 0.05), v.gain(0.25), hp);
  v.chain(v.noise(t, decay + 0.05), v.gain(0.5), hp);
  const g = v.gain(0);
  perc(g.gain, t, level, 0.001, decay);
  v.chain(hp, v.filter('peaking', 9000, 0.8, 4), g, dest);
}

/** One lathering stroke: a squishy filtered-noise sweep with bubbly crackle. */
function scrubStroke(v: Voice, dest: AudioNode, t: number, level: number, up: boolean) {
  const dur = rand(0.18, 0.26);
  const bp = v.filter('bandpass', 1000, 1.5);
  glide(bp.frequency, t, up ? [[0, 700], [dur, 1700]] : [[0, 1600], [dur, 750]]);
  const g = v.gain(0);
  ramp(g.gain, t, [[0, 0], [dur * 0.3, level * 1.6], [dur, 0]]);
  v.chain(v.noise(t, dur + 0.02, 'pink'), bp, g, dest);
  const buf = grainBuffer(v.ctx, { dur, density: 220, decayMs: 0.8, freq: [2500, 7000], res: 0.8 });
  const bg = v.gain(0);
  ramp(bg.gain, t, [[0, 0], [dur * 0.3, level * 0.35], [dur, 0]]);
  v.chain(v.buffer(buf, t), bg, dest);
  if (Math.random() < 0.5) plip(v, dest, t + rand(0.02, dur), rand(2000, 3500), level * 0.12, 0.02);
  return dur;
}

// ---------------------------------------------------------------------------------------------
// SFX
// ---------------------------------------------------------------------------------------------

type SfxFn = (v: Voice, t: number, o: SfxOpts) => void;

const PENTA_HIGH = [2093, 2349.3, 2637, 3136, 3520, 4186];

const SFX: Record<SfxName, SfxFn> = {
  click(v, t) {
    const o = tone(v, v.out, t, 'triangle', 1600 * rand(0.97, 1.03), 0.012, 0.35, 0.002, 0.04);
    glide(o.frequency, t, [[0, 1650], [0.03, 1200]]);
    noiseHit(v, v.out, t, 'highpass', 3000, 0.7, 0.12, 0.001, 0.006);
  },
  select(v, t) {
    chime(v, v.out, t, 1318.5, 0.2, 0.25, 0.6);
    chime(v, v.out, t + 0.065, 1975.5, 0.2, 0.35, 0.6);
  },
  back(v, t) {
    chime(v, v.out, t, 1318.5, 0.16, 0.2, 0.5);
    chime(v, v.out, t + 0.06, 987.8, 0.16, 0.3, 0.5);
  },
  open(v, t) {
    [1046.5, 1318.5, 1568].forEach((f, i) => chime(v, v.out, t + i * 0.045, f, 0.13, 0.3, 0.4));
    const bp = v.filter('bandpass', 1000, 1.2);
    glide(bp.frequency, t, [[0, 900], [0.18, 4000]]);
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.08, 0.12], [0.2, 0]]);
    v.chain(v.noise(t, 0.22), bp, v.filter('bandpass', 2000, 0.8), g, v.out);
  },
  coin(v, t) {
    const lp = v.filter('lowpass', 6000);
    lp.connect(v.out);
    tone(v, lp, t, 'square', 987.77, 0.07, 0.07, 0.002, 0.01);
    tone(v, lp, t + 0.075, 'square', 1318.5, 0.05, 0.07, 0.002, 0.35);
    chime(v, v.out, t + 0.075, 2637, 0.06, 0.4, 0.5);
  },
  buy(v, t) {
    noiseHit(v, v.out, t, 'lowpass', 500, 0.7, 0.9, 0.002, 0.08, 'pink');
    tone(v, v.out, t, 'sine', 90, 0.03, 0.3, 0.002, 0.06);
    noiseHit(v, v.out, t + 0.02, 'bandpass', 3500, 3, 0.4, 0.001, 0.02);
    fmBell(v, v.out, t + 0.09, 2093, 0.16, 1.1, 3.01, 1.1);
    [2637, 3136, 4186].forEach((f, i) => chime(v, v.out, t + 0.14 + i * 0.05, f, 0.07, 0.35));
  },
  squeak(v, t) {
    const one = (at: number, f0: number, dur: number, level: number) => {
      const o = v.osc('sawtooth', f0, at, dur + 0.05);
      glide(o.frequency, at, [[0, f0 * 0.8], [dur * 0.4, f0 * 1.25], [dur, f0 * 0.92]]);
      const lfo = v.osc('square', rand(35, 50), at, dur + 0.05);
      v.mod(o.frequency, lfo, v.filter('lowpass', 200), v.gain(f0 * 0.03));
      const am = v.gain(0.75);
      v.mod(am.gain, lfo, v.gain(0.25));
      const g = v.gain(0);
      ramp(g.gain, at, [[0, 0], [0.02, level], [dur - 0.04, level], [dur, 0]]);
      v.chain(o, v.filter('bandpass', f0 * 2, 1.2), v.filter('lowpass', 4500), am, g, v.out);
      const ng = v.gain(0);
      ramp(ng.gain, at, [[0, 0], [0.02, level * 0.3], [dur, 0]]);
      v.chain(v.noise(at, dur), v.filter('bandpass', 3000, 1), ng, v.out);
    };
    const f0 = rand(950, 1300);
    const d1 = rand(0.18, 0.3);
    one(t, f0, d1, 0.5);
    if (Math.random() < 0.4) one(t + d1 + rand(0.06, 0.1), f0 * rand(1.1, 1.25), rand(0.12, 0.2), 0.4);
  },
  bounce(v, t, o) {
    const k = clamp(o.volume ?? 1, 0.05, 1.5);
    const f = rand(150, 175);
    const th = v.osc('sine', f, t, 0.15);
    glide(th.frequency, t, [[0, f], [0.05, f * 0.45]]);
    const g = v.gain(0);
    perc(g.gain, t, 0.9, 0.002, 0.1);
    v.chain(th, g, v.out);
    noiseHit(v, v.out, t, 'bandpass', (900 + 900 * Math.min(1, k)) * rand(0.9, 1.1), 1, 0.9, 0.001, 0.025);
    tone(v, v.out, t, 'sine', 420 * rand(0.95, 1.05), 0.001, 0.12, 0.001, 0.06);
  },
  throw(v, t) {
    const dur = 0.36;
    const bp = v.filter('bandpass', 600, 2.5);
    const bp2 = v.filter('bandpass', 600, 2.5);
    for (const f of [bp, bp2]) glide(f.frequency, t, [[0, 600], [dur * 0.4, 2400], [dur, 900]]);
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [dur * 0.35, 3], [dur, 0]]);
    v.chain(v.noise(t, dur + 0.02), bp, bp2, g, v.panner(rand(-0.3, 0.3)), v.out);
  },
  catch(v, t) {
    noiseHit(v, v.out, t, 'bandpass', 2200, 2, 0.6, 0.001, 0.02);
    noiseHit(v, v.out, t + 0.005, 'lowpass', 500, 0.7, 1.2, 0.002, 0.07, 'pink');
    const th = v.osc('sine', 130, t, 0.1);
    glide(th.frequency, t, [[0, 130], [0.07, 85]]);
    const g = v.gain(0);
    perc(g.gain, t, 0.45, 0.002, 0.08);
    v.chain(th, g, v.out);
  },
  pop(v, t) {
    const o = v.osc('sine', 300, t, 0.08);
    glide(o.frequency, t, [[0, 300], [0.04, 1400]]);
    const g = v.gain(0);
    perc(g.gain, t, 0.4, 0.001, 0.06);
    v.chain(o, g, v.out);
    noiseHit(v, v.out, t, 'highpass', 2000, 0.7, 0.3, 0.0005, 0.004);
  },
  sparkle(v, t) {
    const n = 6 + Math.floor(Math.random() * 3);
    let tt = t;
    let idx = Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const f = PENTA_HIGH[clamp(idx, 0, PENTA_HIGH.length - 1)];
      const p = v.panner(rand(-0.6, 0.6));
      p.connect(v.out);
      chime(v, p, tt, f, 0.2 * (1 - (i / n) * 0.55), rand(0.25, 0.4), 0.7);
      idx += Math.random() < 0.75 ? 1 : -1;
      if (idx >= PENTA_HIGH.length) idx = PENTA_HIGH.length - 3;
      if (idx < 0) idx = 1;
      tt += rand(0.03, 0.055);
    }
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.1, 0.025], [0.45, 0]]);
    v.chain(v.noise(t, 0.46), v.filter('highpass', 7000), g, v.out);
  },
  heart(v, t) {
    const note = (at: number, f0: number, f1: number) => {
      const o = v.osc('sine', f0, at, 0.3);
      glide(o.frequency, at, [[0, f0], [0.08, f1]]);
      const o2 = v.osc('triangle', f0 * 2, at, 0.3);
      glide(o2.frequency, at, [[0, f0 * 2], [0.08, f1 * 2]]);
      const g = v.gain(0);
      perc(g.gain, at, 0.22, 0.01, 0.22);
      v.chain(o, g, v.out);
      v.chain(o2, v.gain(0.15), g);
    };
    note(t, 523.25, 784);
    note(t + 0.11, 784, 1046.5);
  },
  lightbulb(v, t) {
    chime(v, v.out, t, 1174.7, 0.16, 0.25, 0.8);
    fmBell(v, v.out, t + 0.06, 1760, 0.2, 1.3, 2.0, 0.9);
    const o1 = v.osc('sine', 1760 * 1.003, t + 0.06, 1.3);
    const g = v.gain(0);
    perc(g.gain, t + 0.06, 0.07, 0.01, 1.2);
    v.chain(o1, g, v.out);
    chime(v, v.out, t + 0.1, 3520, 0.05, 0.6, 0.5);
  },
  learned(v, t) {
    const lead = v.gain(1);
    lead.connect(v.out);
    [523.25, 659.25, 784].forEach((f, i) => brassTone(v, lead, t + i * 0.09, f, 0.08, 0.1));
    [1046.5, 1318.5, 1568, 2093].forEach((f) => brassTone(v, lead, t + 0.27, f / 2, 0.75, 0.07));
    [2093, 2637, 3136, 4186].forEach((f, i) => chime(v, v.out, t + 0.27 + i * 0.06, f, 0.06, 0.8, 0.6));
    noiseHit(v, v.out, t + 0.27, 'highpass', 6000, 0.7, 0.08, 0.005, 0.9);
  },
  whistle(v, t) {
    const base = rand(0.94, 1.06);
    const note = (at: number, f0: number, f1: number, dur: number) => {
      const o = v.osc('sine', f0, at, dur + 0.05);
      glide(o.frequency, at, [[0, f0], [dur * 0.8, f1]]);
      v.mod(o.frequency, v.osc('sine', 5.5, at, dur + 0.05), v.gain(f0 * 0.006));
      const g = v.gain(0);
      ramp(g.gain, at, [[0, 0], [0.03, 0.3], [dur - 0.05, 0.28], [dur, 0]]);
      v.chain(o, g, v.out);
      const bp = v.filter('bandpass', f0, 8);
      const bp2 = v.filter('bandpass', f0, 4);
      for (const f of [bp, bp2]) glide(f.frequency, at, [[0, f0], [dur * 0.8, f1]]);
      const ng = v.gain(0);
      ramp(ng.gain, at, [[0, 0], [0.02, 0.6], [dur, 0]]);
      v.chain(v.noise(at, dur), bp, bp2, ng, v.out);
    };
    if (Math.random() < 0.5) {
      note(t, 1500 * base, 2300 * base, 0.28);
      note(t + 0.34, 2300 * base, 1600 * base, 0.42);
    } else {
      note(t, 1400 * base, 2000 * base, 0.2);
      note(t + 0.26, 1500 * base, 2400 * base, 0.3);
    }
  },
  scrub(v, t) {
    let tt = t;
    for (let i = 0; i < 4; i++) tt += scrubStroke(v, v.out, tt, 0.5, i % 2 === 0) + rand(0.02, 0.06);
  },
  shower(v, t) {
    showerNoise(v, v.out, t, 1.3, 1);
  },
  splash(v, t) {
    const bp = v.filter('bandpass', 2500, 0.7);
    glide(bp.frequency, t, [[0, 2500], [0.45, 700]]);
    const g = v.gain(0);
    perc(g.gain, t, 1.6, 0.005, 0.45);
    v.chain(v.noise(t, 0.5), bp, g, v.out);
    noiseHit(v, v.out, t, 'lowpass', 500, 0.7, 0.9, 0.01, 0.2, 'brown');
    for (let i = 0; i < 8; i++) plip(v, v.out, t + rand(0.03, 0.6), rand(600, 1800), rand(0.05, 0.15), 0.04);
  },
  shake(v, t) {
    const dur = rand(0.8, 1.0);
    const env = v.gain(0);
    ramp(env.gain, t, [[0, 0], [0.15, 1], [dur - 0.3, 0.9], [dur, 0]]);
    env.connect(v.out);
    const am = v.gain(0.5);
    const lfo = v.osc('sine', 10, t, dur);
    glide(lfo.frequency, t, [[0, 10.5], [dur * 0.6, 9.5], [dur, 6.5]]);
    v.mod(am.gain, lfo, v.gain(0.48));
    v.chain(v.noise(t, dur, 'pink'), v.filter('bandpass', 700, 0.9), v.gain(2.2), am, env);
    const spray = grainBuffer(v.ctx, { dur, density: 260, decayMs: 0.6, freq: [3000, 8000], res: 0.7, stereo: true });
    v.chain(v.buffer(spray, t), v.gain(0.3), env);
  },
  brush(v, t) {
    const dur = rand(0.22, 0.3);
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.05, 1], [dur * 0.6, 0.7], [dur, 0]]);
    v.chain(v.noise(t, dur + 0.02, 'pink'), v.filter('bandpass', 4200, 1.2), v.filter('bandpass', 4200, 1.2), v.gain(2), g, v.out);
    const grit = grainBuffer(v.ctx, { dur, density: 900, decayMs: 0.4, freq: [2500, 8000], res: 0.6 });
    v.chain(v.buffer(grit, t), v.filter('highpass', 2000), v.gain(0.5), g);
  },
  rope(v, t) {
    const dur = rand(0.45, 0.65);
    const o = v.osc('sawtooth', 28, t, dur + 0.05);
    glide(o.frequency, t, [[0, rand(24, 30)], [dur, rand(40, 50)]]);
    v.mod(o.frequency, v.noise(t, dur, 'brown'), v.filter('lowpass', 15), v.gain(10));
    const sum = v.gain(1);
    v.chain(o, v.filter('bandpass', 650, 6), v.gain(1.5), sum);
    v.chain(o, v.filter('bandpass', 1400, 8), v.gain(1), sum);
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.05, 0.5], [dur - 0.1, 0.5], [dur, 0]]);
    v.chain(sum, v.filter('highpass', 200), g, v.out);
  },
  bag(v, t) {
    const dur = rand(0.4, 0.55);
    const buf = grainBuffer(v.ctx, { dur, density: 240, decayMs: 1.5, freq: [1800, 7000], res: 0.9, shape: (x) => Math.sin(Math.PI * x) });
    v.chain(v.buffer(buf, t), v.filter('highpass', 1500), v.gain(0.4), v.out);
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [dur * 0.4, 0.15], [dur, 0]]);
    v.chain(v.noise(t, dur), v.filter('bandpass', 3000, 0.8), g, v.out);
  },
  door(v, t) {
    noiseHit(v, v.out, t, 'bandpass', 2600, 3, 0.6, 0.001, 0.02);
    tone(v, v.out, t, 'sine', 1300, 0.001, 0.08, 0.001, 0.05);
    noiseHit(v, v.out, t + 0.05, 'bandpass', 1900, 4, 0.4, 0.001, 0.02);
    const o = v.osc('sawtooth', 55, t + 0.08, 0.55);
    glide(o.frequency, t + 0.08, [[0, 55], [0.45, 38]]);
    const g = v.gain(0);
    ramp(g.gain, t + 0.08, [[0, 0], [0.05, 0.3], [0.4, 0.25], [0.5, 0]]);
    v.chain(o, v.filter('bandpass', 900, 7), g, v.out);
  },
  bell(v, t) {
    const f = rand(2200, 2450);
    const strike = (at: number, ff: number, level: number) => {
      for (const [ratio, amp, dk] of [[1, 1, 1.2], [2.44, 0.5, 0.6], [4.12, 0.25, 0.35], [5.94, 0.15, 0.25]] as const) {
        const g = v.gain(0);
        perc(g.gain, at, level * amp, 0.001, dk);
        v.chain(v.osc('sine', ff * ratio, at, dk + 0.05), g, v.out);
      }
    };
    strike(t, f, 0.12);
    strike(t + 0.11, f * 1.12, 0.1);
    strike(t + 0.2, f, 0.08);
    strike(t + 0.3, f * 1.12, 0.05);
  },
  camera(v, t) {
    noiseHit(v, v.out, t, 'bandpass', 4000, 2, 0.8, 0.001, 0.012);
    noiseHit(v, v.out, t, 'bandpass', 900, 3, 0.6, 0.001, 0.02);
    noiseHit(v, v.out, t + 0.075, 'bandpass', 3500, 2, 0.6, 0.001, 0.015);
    noiseHit(v, v.out, t + 0.075, 'bandpass', 700, 3, 0.5, 0.001, 0.025);
  },
  fanfare(v, t) {
    const lead = v.gain(1);
    lead.connect(v.out);
    const G4 = 392, A4 = 440, B4 = 493.9, C5 = 523.25;
    const tri = 0.12;
    [0, 1, 2].forEach((i) => brassTone(v, lead, t + i * tri, G4, 0.09, 0.09));
    const chord = (at: number, notes: number[], dur: number, level: number) =>
      notes.forEach((f) => brassTone(v, lead, at, f, dur, level));
    chord(t + 0.36, [261.6, 329.6, 392, C5 * 1.26], 0.45, 0.055);
    chord(t + 0.9, [349.2, A4, C5], 0.13, 0.055);
    chord(t + 1.05, [392, B4, 587.3], 0.13, 0.055);
    chord(t + 1.2, [261.6, 329.6, 392, C5, 659.25], 1.1, 0.055);
    for (const [at, level] of [[0, 0.4], [0.36, 0.7], [1.2, 0.9]] as const) {
      const o = v.osc('sine', 110, t + at, 0.4);
      glide(o.frequency, t + at, [[0, 110], [0.12, 55]]);
      const g = v.gain(0);
      perc(g.gain, t + at, level * 0.6, 0.003, 0.3);
      v.chain(o, g, v.out);
    }
    metal(v, v.out, t + 1.2, 0.18, 1.6);
    [2093, 2637, 3136, 4186, 3136, 4186].forEach((f, i) => chime(v, v.out, t + 1.22 + i * 0.07, f, 0.05, 0.6, 0.5));
  },
  applause(v, t) {
    const buf = applauseBuffer(v.ctx);
    const rate = rand(0.95, 1.05);
    v.chain(v.buffer(buf, t, rate), v.gain(0.55), v.out);
    // Diffuse crowd bed under the individual claps.
    const d = buf.duration / rate;
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.25, 0.35], [d * 0.55, 0.3], [d, 0]]);
    v.chain(v.noise(t, d, 'pink'), v.filter('bandpass', 1600, 0.7), v.filter('highpass', 500), g, v.out);
  },
  drumroll(v, t) {
    const dur = 1.9;
    const rate = 26;
    const n = Math.floor(dur * rate);
    for (let i = 0; i < n; i++) {
      const at = t + i / rate + rand(-0.003, 0.003);
      const level = (0.12 + 0.5 * Math.pow(i / n, 1.6)) * (i % 2 ? 0.85 : 1);
      noiseHit(v, v.out, at, 'bandpass', 3200, 0.7, level * 1.3, 0.001, 0.05);
    }
    const end = t + dur + 0.02;
    noiseHit(v, v.out, end, 'bandpass', 2500, 0.7, 1.2, 0.001, 0.2);
    tone(v, v.out, end, 'sine', 190, 0.001, 0.3, 0.001, 0.12);
    metal(v, v.out, end, 0.22, 1.5);
  },
  countdown(v, t) {
    tone(v, v.out, t, v.wave([1, 0, 0.15]), 880, 0.14, 0.3);
  },
  start(v, t) {
    tone(v, v.out, t, v.wave([1, 0, 0.15]), 1760, 0.45, 0.25, 0.005, 0.08);
    tone(v, v.out, t, 'sine', 880, 0.45, 0.12, 0.005, 0.08);
  },
  dig(v, t) {
    const n = 5 + Math.floor(Math.random() * 3);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const g = v.gain(0);
      ramp(g.gain, tt, [[0, 0], [0.02, 1.4], [0.11, 0]]);
      v.chain(v.noise(tt, 0.12, 'pink'), v.filter('bandpass', rand(600, 1400), 1), g, v.out);
      const grit = grainBuffer(v.ctx, { dur: 0.1, density: 300, decayMs: 1, freq: [1500, 4000], res: 0.5 });
      v.chain(v.buffer(grit, tt), v.gain(0.25), v.out);
      tt += rand(0.12, 0.17);
    }
    const fall = grainBuffer(v.ctx, { dur: 0.4, density: 40, decayMs: 1.5, freq: [800, 3000], res: 0.6, shape: (x) => 1 - x });
    v.chain(v.buffer(fall, tt), v.filter('lowpass', 3000), v.gain(0.15), v.out);
  },
  present(v, t) {
    const notes = [1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349.3, 2637, 3136];
    notes.forEach((f, i) => chime(v, v.out, t + i * 0.035, f, 0.09, 0.3, 0.6));
    const end = t + notes.length * 0.035 + 0.02;
    [2093, 2637, 3136].forEach((f) => fmBell(v, v.out, end, f, 0.07, 1.2, 2.0, 0.7));
    const g = v.gain(0);
    ramp(g.gain, end, [[0, 0], [0.1, 0.03], [0.9, 0]]);
    v.chain(v.noise(end, 0.9), v.filter('highpass', 7500), g, v.out);
  },
  footstep(v, t, o) {
    const surface = o.surface ?? 'wood';
    const k = rand(0.85, 1.15);
    if (surface === 'wood') {
      noiseHit(v, v.out, t, 'lowpass', 900 * k, 0.7, 0.5, 0.002, 0.04, 'pink');
      noiseHit(v, v.out, t, 'bandpass', 260 * k, 1.5, 0.9, 0.002, 0.05);
      noiseHit(v, v.out, t + rand(0.005, 0.015), 'highpass', 4000, 0.7, 0.12, 0.0005, 0.006);
    } else if (surface === 'grass') {
      noiseHit(v, v.out, t, 'bandpass', 4500 * k, 0.6, 0.35, 0.01, 0.07);
      const buf = grainBuffer(v.ctx, { dur: 0.08, density: 150, decayMs: 0.6, freq: [2500, 7000], res: 0.4 });
      v.chain(v.buffer(buf, t), v.gain(0.06), v.out);
    } else {
      noiseHit(v, v.out, t, 'lowpass', 600 * k, 0.7, 0.8, 0.002, 0.03, 'pink');
      noiseHit(v, v.out, t + 0.004, 'bandpass', 3500 * k, 3, 0.6, 0.0005, 0.004);
      if (Math.random() < 0.6) noiseHit(v, v.out, t + rand(0.012, 0.02), 'bandpass', 3800 * k, 3, 0.4, 0.0005, 0.004);
    }
  },
  eat(v, t) {
    crunch({ e: v.e, v, t, p: 1.2, r: 0 }, v.out, 3);
    const g = v.gain(0);
    ramp(g.gain, t, [[0, 0], [0.05, 0.25], [0.9, 0]]);
    v.chain(v.noise(t, 0.9, 'pink'), v.filter('lowpass', 800), g, v.out);
  },
  gulp(v, t) {
    const o = v.osc('sine', 260, t, 0.14);
    glide(o.frequency, t, [[0, 260], [0.05, 140], [0.09, 320]]);
    const g = v.gain(0);
    perc(g.gain, t, 0.45, 0.002, 0.12);
    v.chain(o, g, v.out);
    noiseHit(v, v.out, t, 'lowpass', 1500, 0.7, 0.4, 0.001, 0.02);
    plip(v, v.out, t + 0.07, 500, 0.12, 0.025);
  },
  error(v, t) {
    const lp = v.filter('lowpass', 1500);
    lp.connect(v.out);
    tone(v, lp, t, 'triangle', 329.6, 0.09, 0.3, 0.004, 0.03);
    tone(v, lp, t, 'square', 329.6, 0.09, 0.05, 0.004, 0.03);
    tone(v, lp, t + 0.11, 'triangle', 261.6, 0.16, 0.3, 0.004, 0.05);
    tone(v, lp, t + 0.11, 'square', 261.6, 0.16, 0.05, 0.004, 0.05);
  },
};

/** Per-sound output trims, balanced from offline renders (UI ~-12 dBFS peak, world SFX ~-8). */
const SFX_LEVEL: Partial<Record<SfxName, number>> = {
  click: 1.6, select: 1.1, back: 1.3, coin: 1.6, buy: 1.25, squeak: 0.8, bounce: 1.4, throw: 0.6, catch: 1.5,
  pop: 2.8, heart: 1.15, lightbulb: 1.2, learned: 0.9, whistle: 0.55, shower: 0.8, splash: 0.85, shake: 0.5,
  brush: 0.5, rope: 1.25, door: 3.5, bell: 1.2, camera: 1.8, fanfare: 0.8, drumroll: 0.7, countdown: 0.6,
  start: 0.58, dig: 0.65, present: 1.3, footstep: 1.7, eat: 0.55, gulp: 2.4, error: 0.6,
};

/** Water spray: bright hiss plus droplet texture, with a low splatter band. */
function showerNoise(v: Voice, dest: AudioNode, t: number, dur: number, level: number) {
  const env = v.gain(0);
  ramp(env.gain, t, [[0, 0], [0.12, level], [Math.max(0.13, dur - 0.25), level], [dur, 0]]);
  env.connect(dest);
  v.chain(v.noise(t, dur, 'white'), v.filter('highpass', 1500), v.filter('peaking', 6000, 0.6, 4), v.gain(0.06), env);
  // Splatter band with a slow, irregular swell so it doesn't sound like static.
  const swell = v.gain(0.3);
  v.mod(swell.gain, v.noise(t, dur, 'brown'), v.filter('lowpass', 3), v.gain(0.25));
  v.chain(v.noise(t, dur, 'pink'), v.filter('bandpass', 1000, 0.7), swell, env);
  const drops = dropletBuffer(v.ctx);
  v.chain(v.buffer(drops, t, 1, Math.random() * 1.5, dur, true), v.gain(0.55), env);
}

const dropCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function dropletBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = dropCache.get(ctx);
  if (!b) {
    b = grainBuffer(ctx, { dur: 3, density: 500, decayMs: 1.2, freq: [2000, 9000], res: 0.85, stereo: true });
    dropCache.set(ctx, b);
  }
  return b;
}

const applauseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
/** ~3.2 s of a small crowd clapping: many resonant noise claps, swelling in and dying away. */
function applauseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = applauseCache.get(ctx);
  if (!b) {
    b = grainBuffer(ctx, {
      dur: 3.2, density: 240, decayMs: 4, freq: [800, 2600], res: 0.93, stereo: true,
      shape: (x) => Math.min(1, x / 0.08) * (x < 0.55 ? 1 : Math.pow(1 - (x - 0.55) / 0.45, 1.5)),
    });
    applauseCache.set(ctx, b);
  }
  return b;
}

// ---------------------------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------------------------

const LOOP_LEVEL: Record<LoopName, number> = { scrub: 1, shower: 0.55, pant: 1, rain: 0.9 };

class LoopPlayer implements LoopHandle {
  private readonly out: GainNode;
  private readonly bed: Voice;
  private driver: Driver | null = null;
  private stopped = false;
  private level = 1;
  private readonly base: number;

  constructor(private readonly e: AudioEngine, name: LoopName, voice: DogVoice, opts: PlayOpts, dest: AudioNode) {
    const ctx = e.ctx;
    const t = ctx.currentTime + 0.01;
    this.base = LOOP_LEVEL[name];
    this.level = (opts.volume ?? 1) * this.base;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(this.level, t + 0.12);
    let tail: AudioNode = this.out;
    if (opts.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(opts.pan, -1, 1);
      this.out.connect(p);
      tail = p;
    }
    tail.connect(dest);
    // Long-lived continuous layers live on one Voice so stop() can end them together.
    this.bed = new Voice(e, t, this.out);
    const HOUR = 3600;
    const p = clamp(voice.pitch, 0.6, 2.2);
    const r = clamp(voice.rough, 0, 1);
    let next = t;
    const every = (fn: (at: number) => number) => {
      this.driver = new Driver(e, (until) => {
        while (next < until) next += fn(next);
      });
    };
    switch (name) {
      case 'shower':
        showerNoise(this.bed, this.bed.out, t, HOUR, 1);
        break;
      case 'rain': {
        const bed = this.bed;
        bed.chain(bed.noise(t, HOUR, 'pink'), bed.filter('highpass', 500), bed.filter('lowpass', 6500), bed.gain(0.11), bed.out);
        bed.chain(bed.buffer(dropletBuffer(ctx), t, 0.8, 0, HOUR, true), bed.filter('lowpass', 7000), bed.gain(0.22), bed.out);
        every((at) => {
          const v = new Voice(e, at, this.out, 1, rand(-0.8, 0.8));
          plip(v, v.out, at, rand(900, 2600), rand(0.03, 0.09), 0.03);
          return rand(0.05, 0.3);
        });
        break;
      }
      case 'scrub': {
        let up = true;
        every((at) => {
          const v = new Voice(e, at, this.out);
          up = !up;
          return scrubStroke(v, v.out, at, 0.5 * rand(0.8, 1.1), up) + rand(0.02, 0.07);
        });
        break;
      }
      case 'pant':
        every((at) => {
          const v = new Voice(e, at, this.out, 0.45);
          return pantBreath(v, v.out, at, p, r);
        });
        break;
    }
  }

  setVolume(v: number) {
    if (this.stopped) return;
    this.level = Math.max(0, v) * this.base;
    this.out.gain.setTargetAtTime(this.level, this.e.ctx.currentTime, 0.05);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.e.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + 0.25);
    this.driver?.stop();
    this.bed.stop(0.25);
    if (!this.e.offline) window.setTimeout(() => this.out.disconnect(), 1500);
  }
}

// ---------------------------------------------------------------------------------------------
// Music: theory helpers
// ---------------------------------------------------------------------------------------------

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

interface Quality {
  tones: number[];
  /** Voicing intervals for comping (rootless where idiomatic). */
  voicing: number[];
  /** Chord scale for melodic improvisation. */
  scale: number[];
}
const QUALITIES: Record<string, Quality> = {
  '': { tones: [0, 4, 7], voicing: [0, 4, 7, 12], scale: [0, 2, 4, 7, 9] },
  m: { tones: [0, 3, 7], voicing: [0, 3, 7, 12], scale: [0, 2, 3, 5, 7, 10] },
  '6': { tones: [0, 4, 7, 9], voicing: [4, 7, 9, 14], scale: [0, 2, 4, 7, 9] },
  maj7: { tones: [0, 4, 7, 11], voicing: [4, 7, 11, 14], scale: [0, 2, 4, 7, 9, 11] },
  m7: { tones: [0, 3, 7, 10], voicing: [3, 7, 10, 14], scale: [0, 2, 3, 5, 7, 9, 10] },
  m6: { tones: [0, 3, 7, 9], voicing: [3, 7, 9, 14], scale: [0, 2, 3, 5, 7, 9] },
  '7': { tones: [0, 4, 7, 10], voicing: [4, 9, 10, 14], scale: [0, 2, 4, 7, 9, 10] },
  '9': { tones: [0, 4, 7, 10], voicing: [4, 10, 14, 19], scale: [0, 2, 4, 7, 9, 10] },
  '7sus': { tones: [0, 5, 7, 10], voicing: [5, 7, 10, 14], scale: [0, 2, 5, 7, 9, 10] },
  m7b5: { tones: [0, 3, 6, 10], voicing: [3, 6, 10, 12], scale: [0, 3, 5, 6, 8, 10] },
  dim7: { tones: [0, 3, 6, 9], voicing: [0, 3, 6, 9], scale: [0, 2, 3, 5, 6, 8, 9, 11] },
};

interface Chord {
  root: number;
  bass: number;
  tones: number[];
  voicing: number[];
  scale: number[];
}

function pitchClass(letter: string, acc: string): number {
  return (PC[letter.toLowerCase()] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
}

function parseChord(sym: string): Chord {
  const m = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(sym);
  if (!m) throw new Error(`[audio] bad chord symbol ${sym}`);
  const q = QUALITIES[m[3]];
  if (!q) throw new Error(`[audio] unknown chord quality ${sym}`);
  const root = pitchClass(m[1], m[2]);
  return { root, bass: m[4] ? pitchClass(m[4], m[5] ?? '') : root, ...q };
}

interface Span {
  start: number;
  len: number;
  ch: Chord;
}

/** "Cmaj7 | Dm7 G7 | ..." -> chord spans in beats. */
function parseChart(chart: string, meter: number): Span[] {
  const spans: Span[] = [];
  chart.split('|').map((s) => s.trim()).filter(Boolean).forEach((bar, i) => {
    const syms = bar.split(/\s+/);
    const lens = syms.length === 1 ? [meter] : meter === 4 ? (syms.length === 2 ? [2, 2] : [1, 1, 1, 1]) : [2, 1];
    let b = i * meter;
    syms.forEach((s, k) => {
      spans.push({ start: b, len: lens[k], ch: parseChord(s) });
      b += lens[k];
    });
  });
  return spans;
}

function spanAt(spans: Span[], beat: number): Span {
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i].start <= beat + 1e-6) return spans[i];
  return spans[0];
}

function noteToMidi(n: string): number {
  const m = /^([a-g])([#b]?)(\d)$/.exec(n);
  if (!m) throw new Error(`[audio] bad note ${n}`);
  return 12 * (Number(m[3]) + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

interface MelNote {
  b: number;
  m: number;
  d: number;
}

/** "c5/2 e5/1 r/1 | ..." where /n is a length in eighth notes. */
function parseMelody(src: string, meter: number): MelNote[] {
  const out: MelNote[] = [];
  let pos = 0;
  src.split('|').forEach((bar, i) => {
    const start = pos;
    for (const tok of bar.trim().split(/\s+/)) {
      if (!tok) continue;
      const [n, len] = tok.split('/');
      const d = Number(len);
      if (n !== 'r') out.push({ b: pos / 2, m: noteToMidi(n), d: d / 2 });
      pos += d;
    }
    if (pos - start !== meter * 2) console.warn(`[audio] melody bar ${i + 1} has ${pos - start} eighths`);
  });
  return out;
}

/** Places a voicing near the previous one (smooth voice leading) within [lo, hi]. */
function voiceChord(ch: Chord, prev: number[] | null, lo: number, hi: number): number[] {
  const base = ch.voicing.map((i) => ch.root + i);
  const mid = (lo + hi) / 2;
  const center = prev ? prev.reduce((a, b) => a + b, 0) / prev.length : mid;
  let best: number[] | null = null;
  let bestScore = Infinity;
  for (let inv = 0; inv < base.length; inv++) {
    const v = base.map((n, i) => (i < inv ? n + 12 : n)).sort((a, b) => a - b);
    for (let oct = -1; oct <= 8; oct++) {
      const c = v.map((n) => n + oct * 12);
      if (c[0] < lo || c[c.length - 1] > hi) continue;
      const mean = c.reduce((a, b) => a + b, 0) / c.length;
      const score = Math.abs(mean - center) + 0.2 * Math.abs(mean - mid);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
  }
  return best ?? base.map((n) => n + 48);
}

/** Nearest MIDI note with pitch class `pc` to `near`, kept inside [lo, hi]. */
function nearest(pc: number, near: number, lo: number, hi: number): number {
  let best = lo;
  let d = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (((m % 12) + 12) % 12 !== pc) continue;
    const dd = Math.abs(m - near);
    if (dd < d) {
      d = dd;
      best = m;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Music: track definitions
// ---------------------------------------------------------------------------------------------

type Inst =
  | 'ep' | 'vibes' | 'marimba' | 'flute' | 'brass' | 'glock' | 'guitar' | 'bass' | 'pad'
  | 'kick' | 'snare' | 'brush' | 'swish' | 'ride' | 'hat' | 'rim' | 'shaker' | 'crash' | 'tom';
type DrumFeel = 'swing' | 'fast' | 'bossa' | 'pop' | 'waltz' | 'ballad' | 'march';
type CompStyle = 'ep' | 'guitar' | 'pop' | 'waltz' | 'ballad' | 'fast' | 'march';
type BassStyle = 'walk' | 'two' | 'bossa' | 'bounce' | 'waltz' | 'march';

interface TrackDef {
  bpm: number;
  meter: 3 | 4;
  /** Position of the off-beat eighth within the beat: 0.5 straight .. 0.67 triplet swing. */
  swing: number;
  drums: DrumFeel;
  comp: CompStyle;
  /** Bass style for the head and (optionally different) for the solo chorus. */
  bass: BassStyle | readonly [BassStyle, BassStyle];
  chords: string;
  melody: string;
  lead: Inst;
  leadVel?: number;
  /** Instrument doubling the head melody an octave up (quietly). */
  double?: Inst;
  /** Instrument improvising a second chorus; omit for a single-chorus loop. */
  solo?: Inst;
  verb?: number;
}

const TRACKS: Record<MusicTrack, TrackDef> = {
  // Signature theme: medium swing in F, vibes melody doubled softly by glockenspiel.
  title: {
    bpm: 108, meter: 4, swing: 0.6, drums: 'swing', comp: 'ep', bass: ['two', 'walk'],
    chords: 'Fmaj7 | Dm7 | Gm7 | C7 | Am7 | D7 | Gm7 | C7 | Fmaj7 | F7 | Bbmaj7 | Bbm6 | Am7 D7 | Gm7 C7 | F6 | Gm7 C7',
    melody:
      'c5/1 f5/1 a5/2 g5/1 f5/1 e5/1 f5/1 | a5/3 c6/1 r/2 a5/1 bb5/1 | c6/2 bb5/1 a5/1 g5/2 f5/1 g5/1 | e5/2 g5/1 e5/1 c5/3 r/1 |' +
      'c5/1 e5/1 a5/2 g5/1 e5/1 d5/1 e5/1 | f#5/3 a5/1 r/2 f#5/1 g5/1 | bb5/2 a5/1 g5/1 f5/2 d5/1 e5/1 | c6/3 bb5/1 g5/2 r/2 |' +
      'a5/2 c6/2 e6/3 d6/1 | c6/2 a5/1 f5/1 eb6/3 c6/1 | d6/3 c6/1 bb5/2 a5/1 f5/1 | g5/3 f5/1 db6/2 bb5/2 |' +
      'c6/2 a5/1 g5/1 f#5/2 a5/2 | bb5/2 g5/1 f5/1 e5/2 g5/2 | a5/1 g5/1 f5/5 r/1 | r/2 g5/1 a5/1 bb5/1 a5/1 g5/1 e5/1',
    lead: 'vibes', double: 'glock', solo: 'marimba',
  },
  // Relaxed bossa nova in G: nylon guitar comping, electric piano melody.
  home: {
    bpm: 92, meter: 4, swing: 0.5, drums: 'bossa', comp: 'guitar', bass: 'bossa',
    chords: 'Gmaj7 | Gmaj7 | Am7 | D7 | Bm7 | E7 | Am7 | D7 | Cmaj7 | Cm6 | Bm7 | E7 | Am7 | D7 | Gmaj7 | Am7 D7',
    melody:
      'b4/3 d5/3 f#5/2 | e5/6 d5/2 | c5/3 e5/3 g5/2 | f#5/6 r/2 | d5/3 f#5/3 a5/2 | g#5/4 f#5/2 e5/2 | a5/3 g5/3 e5/2 | f#5/4 r/2 d5/1 e5/1 |' +
      'e5/2 g5/1 b5/5 | a5/3 g5/3 eb5/2 | d5/3 f#5/3 a5/2 | g#5/6 e5/2 | c6/3 b5/3 a5/2 | c6/2 a5/2 f#5/2 d5/2 | g5/6 r/2 | r/4 a4/2 c5/2',
    lead: 'ep', leadVel: 0.9, solo: 'vibes',
  },
  // Upbeat stroll in C: whistly flute over walking bass and brushes.
  walk: {
    bpm: 126, meter: 4, swing: 0.62, drums: 'swing', comp: 'ep', bass: 'walk',
    chords: 'C6 A7 | Dm7 G7 | Em7 A7 | Dm7 G7 | C6 C7 | F6 F#dim7 | C6 A7 | Dm7 G7 | Em7 | A7 | Dm7 | G7 | Em7 A7 | Dm7 G7 | C6 | Dm7 G7',
    melody:
      'e5/1 g5/1 a5/1 g5/1 c#5/1 e5/1 g5/1 e5/1 | f5/1 a5/1 c6/1 a5/1 b5/2 g5/2 | g5/1 e5/1 b4/1 e5/1 g5/1 a5/1 c#6/2 | d6/2 c6/1 a5/1 g5/3 r/1 |' +
      'e5/1 g5/1 a5/1 c6/1 bb5/2 g5/2 | a5/2 f5/1 d5/1 c6/2 a5/2 | g5/3 e5/1 c#5/2 e5/2 | d5/2 f5/1 a5/1 g5/2 r/2 |' +
      'b5/3 g5/1 e5/2 g5/2 | c#6/4 b5/2 a5/2 | a5/3 f5/1 d5/2 f5/2 | b5/4 a5/2 g5/1 f5/1 |' +
      'e5/1 g5/1 b5/1 d6/1 c#6/2 a5/2 | d6/1 c6/1 a5/1 f5/1 f5/1 e5/1 d5/1 b4/1 | c5/2 e5/1 g5/1 a5/3 r/1 | r/2 a5/1 g5/1 f5/1 d5/1 b4/1 d5/1',
    lead: 'flute', solo: 'vibes',
  },
  // Breezy jazz waltz in D.
  park: {
    bpm: 150, meter: 3, swing: 0.6, drums: 'waltz', comp: 'waltz', bass: 'waltz',
    chords: 'Dmaj7 | Bm7 | Em7 | A7 | F#m7 | B7 | Em7 | A7 | Gmaj7 | Gm6 | F#m7 | B7 | Em7 | A7 | Dmaj7 | A7sus',
    melody:
      'f#5/2 a5/2 c#6/2 | d6/4 b5/2 | e5/2 g5/2 b5/2 | c#6/2 b5/2 a5/2 | a5/2 c#6/2 e6/2 | d#6/4 b5/2 | g5/2 b5/2 d6/2 | c#6/4 r/2 |' +
      'd6/2 b5/2 g5/2 | e6/2 d6/2 bb5/2 | c#6/4 a5/2 | b5/2 a5/2 f#5/2 | g5/4 e5/2 | c#6/2 b5/2 g5/2 | f#5/6 | r/2 e5/2 a5/2',
    lead: 'flute', solo: 'vibes',
  },
  // Bouncy straight-eighth lounge pop in Bb: staccato marimba.
  shop: {
    bpm: 128, meter: 4, swing: 0.5, drums: 'pop', comp: 'pop', bass: 'bounce',
    chords: 'Bb6 | Gm7 | Cm7 | F7 | Dm7 | G7 | Cm7 | F7 | Ebmaj7 | Edim7 | Bb6/F | G7 | Cm7 | F7 | Bb6 | Cm7 F7',
    melody:
      'f5/1 r/1 d5/1 f5/1 g5/1 r/1 f5/2 | d5/1 r/1 bb4/1 d5/1 f5/2 r/2 | eb5/1 r/1 g5/1 eb5/1 bb5/1 r/1 g5/2 | a5/1 g5/1 f5/1 eb5/1 c5/2 r/2 |' +
      'f5/1 r/1 a5/1 f5/1 c6/1 r/1 a5/2 | b5/1 a5/1 g5/1 f5/1 d5/2 r/2 | g5/1 r/1 eb5/1 g5/1 c6/2 bb5/2 | a5/3 g5/1 f5/2 r/2 |' +
      'g5/1 r/1 bb5/1 g5/1 d6/2 bb5/2 | db6/2 bb5/1 g5/1 e5/2 g5/2 | f5/1 r/1 d5/1 f5/1 bb5/2 g5/2 | b5/2 d6/1 b5/1 g5/2 f5/2 |' +
      'c6/1 r/1 bb5/1 g5/1 eb5/2 g5/2 | a5/1 r/1 c6/1 a5/1 eb6/2 c6/2 | bb5/1 r/1 f5/1 d5/1 bb4/2 r/2 | r/4 c5/1 d5/1 eb5/1 e5/1',
    lead: 'marimba', solo: 'vibes',
  },
  // Gentle ballad in Eb.
  kennel: {
    bpm: 80, meter: 4, swing: 0.56, drums: 'ballad', comp: 'ballad', bass: 'two',
    chords: 'Ebmaj7 | Cm7 | Fm7 | Bb7 | Gm7 | C7 | Fm7 | Bb7 | Abmaj7 | Abm6 | Gm7 | C7 | Fm7 | Bb7 | Ebmaj7 | Fm7 Bb7',
    melody:
      'g5/3 bb5/1 d6/4 | c6/6 bb5/2 | ab5/3 g5/1 f5/4 | ab5/4 f5/2 d5/2 | d5/3 f5/1 bb5/4 | bb5/4 g5/2 e5/2 | ab5/3 c6/1 eb6/2 c6/2 | d6/6 r/2 |' +
      'eb5/3 g5/1 c6/4 | cb6/4 ab5/2 f5/2 | bb5/3 g5/1 d5/4 | e5/4 g5/2 bb5/2 | ab5/3 g5/1 f5/2 c6/2 | bb5/2 ab5/2 f5/2 d5/2 | eb5/8 | r/4 f5/2 d5/2',
    lead: 'vibes', solo: 'flute', verb: 0.3,
  },
  // Energetic up-tempo swing in F with rhythm-changes bridge; brass lead doubled by vibes.
  contest: {
    bpm: 160, meter: 4, swing: 0.6, drums: 'fast', comp: 'fast', bass: 'walk',
    chords: 'F6 D7 | Gm7 C7 | F6 D7 | Gm7 C7 | F7 | Bb7 | F6 D7 | Gm7 C7 | A7 | A7 | D7 | D7 | G7 | G7 | Gm7 | C7',
    melody:
      'c6/1 a5/1 f5/1 a5/1 f#5/1 a5/1 c6/1 d6/1 | bb5/2 g5/1 d5/1 e5/1 g5/1 bb5/2 | a5/1 r/1 f5/1 a5/1 c6/2 a5/1 f#5/1 | g5/2 bb5/1 d6/1 c6/2 r/2 |' +
      'f5/1 a5/1 c6/1 eb6/1 d6/1 c6/1 a5/1 f5/1 | ab5/2 f5/1 d5/1 ab5/2 bb5/2 | a5/1 c6/1 d6/1 c6/1 a5/1 f#5/1 d5/2 | g5/1 bb5/1 d6/1 f6/1 e6/2 c6/2 |' +
      'e5/1 a5/1 c#6/1 e6/1 r/1 c#6/1 a5/2 | b5/2 a5/1 g5/1 e5/2 c#5/2 | d5/1 f#5/1 a5/1 c6/1 r/1 a5/1 f#5/2 | c6/2 b5/1 a5/1 f#5/2 d5/2 |' +
      'g5/1 b5/1 d6/1 f6/1 r/1 d6/1 b5/2 | a5/2 g5/1 f5/1 d5/2 b4/2 | d5/1 f5/1 bb5/1 d6/1 c6/2 bb5/2 | a5/1 g5/1 e5/1 c5/1 r/2 e5/1 f5/1',
    lead: 'brass', double: 'vibes', solo: 'vibes',
  },
  // Triumphant straight march-ballad in C with brass and glockenspiel.
  results: {
    bpm: 96, meter: 4, swing: 0.5, drums: 'march', comp: 'march', bass: 'march',
    chords: 'C | F/C | G/B | C | Am | F | Dm7 | G7 | C | E7/B | Am | C7/G | F | G | C | C',
    melody:
      'c5/2 e5/2 g5/3 c6/1 | a5/4 c6/2 a5/2 | g5/4 f5/2 d5/2 | e5/6 r/2 | e5/2 a5/2 c6/3 b5/1 | a5/4 f5/2 a5/2 | d6/3 c6/1 a5/2 f5/2 | g5/4 r/2 g5/1 g5/1 |' +
      'c6/4 g5/2 e5/2 | b5/3 g#5/1 e5/4 | a5/3 c6/1 e6/4 | bb5/4 g5/2 e5/2 | f5/2 a5/2 c6/4 | d6/4 b5/2 g5/2 | c6/8 | r/8',
    lead: 'brass', double: 'glock', verb: 0.3,
  },
};

const SOLO_RANGE: Partial<Record<Inst, readonly [number, number]>> = {
  vibes: [65, 86], marimba: [62, 86], ep: [64, 84], flute: [67, 88], brass: [60, 81],
};

// ---------------------------------------------------------------------------------------------
// Music: arrangement (per loop, seeded so each pass varies a little)
// ---------------------------------------------------------------------------------------------

interface BeatNote {
  b: number;
  inst: Inst;
  m: number;
  d: number;
  v: number;
  /** Extra delay in seconds (strums, rolls). */
  dt?: number;
}

function strum(out: BeatNote[], inst: Inst, notes: number[], b: number, d: number, v: number, spread: number, rng: () => number) {
  notes.forEach((m, i) => out.push({ b, inst, m, d, v: v * (0.9 + rng() * 0.2), dt: i * spread }));
}

function arrangeComp(style: CompStyle, spans: Span[], off: number, meter: number, rng: () => number, out: BeatNote[]) {
  let prev: number[] | null = null;
  spans.forEach((s, i) => {
    const lo = style === 'guitar' ? 50 : 52;
    const hi = style === 'guitar' ? 69 : 75;
    const vc = voiceChord(s.ch, prev, lo, hi);
    prev = vc;
    const b0 = off + s.start;
    switch (style) {
      case 'ep': {
        const pats = s.len >= 4 ? [[0, 1.5], [1.5, 3], [-0.5, 2.5], [0, 2.5], [1, 2.5], [-0.5, 1.5]] : [[0], [-0.5], [0.5], [1]];
        const pat = pats[Math.floor(rng() * pats.length)];
        pat.forEach((x, k) => {
          if (i === 0 && x < 0 && off === 0) x = 0;
          const next = k + 1 < pat.length ? pat[k + 1] : s.len;
          strum(out, 'ep', vc, b0 + x, Math.min(1.3, next - x) * 0.9, 0.42 + rng() * 0.1, 0.006, rng);
        });
        break;
      }
      case 'fast': {
        const pats = s.len >= 4 ? [[0, 1.5], [-0.5, 2.5], [1.5, 3.5], [0, 2.5]] : [[0], [-0.5], [0.5]];
        const pat = pats[Math.floor(rng() * pats.length)];
        pat.forEach((x) => strum(out, 'ep', vc, b0 + (i === 0 && x < 0 && off === 0 ? 0 : x), 0.45, 0.45 + rng() * 0.1, 0.004, rng));
        if (s.start % 8 === 0 && rng() < 0.5) strum(out, 'brass', vc.map((n) => n + 12), b0 + 1.5, 0.3, 0.5, 0, rng);
        break;
      }
      case 'guitar': {
        const bar = Math.floor(s.start / meter);
        const hits = bar % 2 === 0 ? [0, 1.5, 2.5] : [0.5, 1.5, 3];
        hits.filter((h) => h < s.len).forEach((h) => strum(out, 'guitar', vc, b0 + h, 0.7, 0.55 + rng() * 0.1, 0.012, rng));
        break;
      }
      case 'pop':
        for (let x = 0.5; x < s.len; x += 1) {
          if (rng() < 0.15) continue;
          strum(out, 'ep', vc, b0 + x, 0.22, 0.32 + rng() * 0.08, 0.003, rng);
        }
        break;
      case 'waltz':
        for (const x of [1, 2]) if (x < s.len) strum(out, 'ep', vc, b0 + x, 0.7, 0.3 + rng() * 0.08, 0.005, rng);
        if (rng() < 0.3) vc.forEach((m, k) => out.push({ b: b0 + 0.5 + k * 0.5, inst: 'vibes', m: m + 12, d: 0.5, v: 0.25 }));
        break;
      case 'ballad':
        strum(out, 'ep', vc, b0, Math.min(2, s.len) * 0.95, 0.4, 0.05, rng);
        if (s.len >= 4) strum(out, 'ep', vc, b0 + 2.5, 1.4, 0.3, 0.02, rng);
        break;
      case 'march':
        vc.forEach((m) => out.push({ b: b0, inst: 'pad', m, d: s.len, v: 0.7 }));
        for (let x = 0; x < s.len; x++) strum(out, 'ep', vc, b0 + x, 0.6, x === 0 ? 0.4 : 0.3, 0.004, rng);
        break;
    }
  });
}

function arrangeBass(style: BassStyle, spans: Span[], off: number, rng: () => number, out: BeatNote[]) {
  const LO = 28, HI = 48;
  let prev = 38;
  const push = (b: number, m: number, d: number, v: number) => {
    out.push({ b: off + b, inst: 'bass', m, d, v });
    prev = m;
  };
  spans.forEach((s, i) => {
    const next = spans[(i + 1) % spans.length];
    const root = nearest(s.ch.bass, prev, LO, 45);
    const fifth = nearest((s.ch.root + 7) % 12, root + 5, LO, HI);
    switch (style) {
      case 'walk': {
        for (let b = 0; b < s.len; b++) {
          let m: number;
          if (b === 0) m = root;
          else if (b === s.len - 1) {
            const target = nearest(next.ch.bass, prev, LO, 45);
            const r = rng();
            m = r < 0.45 ? target + (rng() < 0.5 ? 1 : -1) : r < 0.7 ? nearest((next.ch.root + 7) % 12, target - 5, LO, HI) : target + (prev > target ? 2 : -2);
          } else {
            const tones = s.ch.tones.concat(s.ch.scale).map((t) => nearest((s.ch.root + t) % 12, prev + (rng() < 0.5 ? 2 : -2), LO, HI));
            const cands = tones.filter((n) => n !== prev && Math.abs(n - prev) <= 5);
            m = cands.length ? cands[Math.floor(rng() * cands.length)] : fifth;
          }
          push(s.start + b, clamp(m, LO, HI), 0.95, b === 0 ? 0.85 : 0.72 + rng() * 0.1);
          if (b > 0 && b < s.len - 1 && rng() < 0.06) out.push({ b: off + s.start + b + 0.5, inst: 'bass', m: prev, d: 0.4, v: 0.45 });
        }
        break;
      }
      case 'two':
        push(s.start, root, Math.min(2, s.len) * 0.95, 0.8);
        if (s.len >= 4) push(s.start + 2, rng() < 0.7 ? fifth : nearest(next.ch.bass, root, LO, 45) + 1, 1.9, 0.7);
        break;
      case 'bossa':
        push(s.start, root, 1.4, 0.8);
        push(s.start + 1.5, fifth, 0.45, 0.6);
        if (s.len >= 4) {
          push(s.start + 2, fifth, 1.4, 0.7);
          push(s.start + 3.5, nearest(next.ch.bass, fifth, LO, 45), 0.45, 0.6);
        }
        break;
      case 'bounce':
        push(s.start, root, 0.7, 0.8);
        push(s.start + 1.5, root, 0.35, 0.55);
        if (s.len >= 4) {
          push(s.start + 2, fifth, 0.7, 0.75);
          push(s.start + 3, root + 12 <= HI + 7 ? root + 12 : root, 0.35, 0.6);
          if (rng() < 0.5) push(s.start + 3.5, fifth, 0.35, 0.5);
        }
        break;
      case 'waltz':
        push(s.start, root, 1.9, 0.8);
        if (rng() < 0.6) push(s.start + 2, fifth, 0.9, 0.6);
        break;
      case 'march':
        push(s.start, root, 1.9, 0.85);
        push(s.start + 2, fifth, 1.9, 0.7);
        break;
    }
  });
}

function arrangeDrums(feel: DrumFeel, bars: number, meter: number, off: number, chorus: number, rng: () => number, out: BeatNote[]) {
  const hit = (b: number, inst: Inst, v: number, m = 0, d = 0.5) => out.push({ b: off + b, inst, m, d, v });
  for (let bar = 0; bar < bars; bar++) {
    const b0 = bar * meter;
    const fill = bar % 8 === 7;
    const last = bar === bars - 1;
    switch (feel) {
      case 'swing':
      case 'fast': {
        const fast = feel === 'fast';
        for (let k = 0; k < 4; k++) hit(b0 + k, 'swish', fast ? 0.35 : 0.5, k % 2 ? 1 : -1, 1);
        for (const [x, v] of [[0, 0.6], [1, 0.85], [1.5, 0.45], [2, 0.6], [3, 0.85], [3.5, 0.45]] as const) hit(b0 + x, 'ride', v * (fast ? 1.1 : 1));
        hit(b0 + 1, 'hat', 0.6);
        hit(b0 + 3, 'hat', 0.6);
        hit(b0 + 1, 'brush', fast ? 0.3 : 0.4);
        hit(b0 + 3, 'brush', fast ? 0.3 : 0.4);
        hit(b0, 'kick', fast ? 0.4 : 0.28);
        hit(b0 + 2, 'kick', fast ? 0.35 : 0.22);
        for (const x of [0.5, 1.5, 2.5, 3.5]) if (rng() < (fast ? 0.25 : 0.12)) hit(b0 + x, 'snare', 0.2 + rng() * 0.15);
        if (fast && bar % 8 === 0) hit(b0, 'crash', chorus === 0 && bar === 0 ? 0.55 : 0.4);
        if (fill) {
          if (fast) [2, 2.5, 3, 3.5].forEach((x, k) => hit(b0 + x, k < 2 ? 'snare' : 'tom', 0.45 + k * 0.08, 45 - k * 3));
          else [2.5, 3, 3.5].forEach((x) => hit(b0 + x, 'snare', 0.35));
        }
        break;
      }
      case 'bossa': {
        const clave = bar % 2 === 0 ? [0, 1.5, 3] : [1, 2.5];
        clave.forEach((x) => hit(b0 + x, 'rim', 0.5));
        for (let x = 0; x < 4; x += 0.5) hit(b0 + x, 'shaker', x % 1 ? 0.5 : 0.3);
        for (const [x, v] of [[0, 0.45], [1.5, 0.22], [2, 0.4], [3.5, 0.22]] as const) hit(b0 + x, 'kick', v);
        if (fill && rng() < 0.7) hit(b0 + 3.5, 'rim', 0.4);
        break;
      }
      case 'pop': {
        hit(b0, 'kick', 0.55);
        hit(b0 + 2, 'kick', 0.5);
        if (rng() < 0.35) hit(b0 + 2.5, 'kick', 0.35);
        hit(b0 + 1, 'snare', 0.32);
        hit(b0 + 3, 'snare', 0.32);
        for (let x = 0; x < 4; x += 0.5) hit(b0 + x, 'hat', x % 1 ? 0.5 : 0.32);
        if (fill) [3, 3.25, 3.5, 3.75].forEach((x) => hit(b0 + x, 'snare', 0.25));
        if (bar % 8 === 0) hit(b0, 'crash', 0.25);
        break;
      }
      case 'waltz':
        for (let k = 0; k < 3; k++) hit(b0 + k, 'swish', 0.4, k % 2 ? 1 : -1, 1);
        for (const [x, v] of [[0, 0.6], [1, 0.5], [1.5, 0.35], [2, 0.55]] as const) hit(b0 + x, 'ride', v);
        hit(b0, 'kick', 0.3);
        hit(b0 + 1, 'hat', 0.4);
        hit(b0 + 2, 'hat', 0.4);
        if (fill) hit(b0 + 2, 'brush', 0.35);
        break;
      case 'ballad':
        hit(b0, 'swish', 0.55, -1, 2);
        hit(b0 + 2, 'swish', 0.55, 1, 2);
        hit(b0 + 3, 'brush', 0.25);
        hit(b0, 'kick', 0.2);
        hit(b0 + 1, 'hat', 0.25);
        hit(b0 + 3, 'hat', 0.25);
        break;
      case 'march':
        hit(b0, 'kick', 0.55);
        hit(b0 + 2, 'kick', 0.5);
        hit(b0 + 1, 'snare', 0.4);
        hit(b0 + 3, 'snare', 0.4);
        if (rng() < 0.4) [2.75].forEach((x) => hit(b0 + x, 'snare', 0.2));
        for (let x = 0; x < 4; x += 0.5) hit(b0 + x, 'hat', 0.28);
        if (bar % 8 === 0) hit(b0, 'crash', 0.5);
        if (last) {
          for (let x = 0; x < 3.5; x += 0.125) hit(b0 + x, 'snare', 0.15 + x * 0.08);
          hit(b0, 'tom', 0.6, 36);
          hit(b0 + 2, 'tom', 0.6, 43);
        }
        break;
    }
  }
}

function improvise(spans: Span[], bars: number, meter: number, lo: number, hi: number, rng: () => number): MelNote[] {
  const motifs4: [number, number][][] = [
    [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 1.5]],
    [[0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 1.5]],
    [[0, 1.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 1], [4.5, 0.5], [5, 1.5]],
    [[1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5], [4, 2]],
    [[0, 2], [2, 0.5], [2.5, 0.5], [3, 2]],
    [[0.5, 1], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 1.5]],
  ];
  const motifs3: [number, number][][] = [
    [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1]],
    [[0, 2], [2, 1], [3, 2]],
    [[0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 2]],
    [[0, 1], [1, 1], [2, 1], [3, 1.5]],
  ];
  const motifs = meter === 4 ? motifs4 : motifs3;
  const out: MelNote[] = [];
  let prev = Math.round((lo + hi) / 2);
  let dir = 1;
  for (let bar = 0; bar < bars; bar += 2) {
    if (rng() < 0.06) continue;
    let motif = motifs[Math.floor(rng() * motifs.length)];
    // Short motifs get an answering phrase with the same rhythm in the second bar.
    const reach = Math.max(...motif.map(([o, d]) => o + d));
    if (reach <= meter * 1.25 && rng() < 0.65) motif = motif.concat(motif.map(([o, d]) => [o + meter, d] as [number, number]));
    for (const [o, d] of motif) {
      const b = bar * meter + o;
      if (b >= bars * meter) break;
      const s = spanAt(spans, b);
      const strong = o % 1 === 0;
      const pcs = (strong ? s.ch.tones : s.ch.scale).map((x) => (s.ch.root + x) % 12);
      const target = prev + dir * (1 + Math.floor(rng() * 3)) * 1.5;
      let best = prev;
      let bestScore = Infinity;
      for (let m = lo; m <= hi; m++) {
        if (!pcs.includes(m % 12)) continue;
        if (m === prev && rng() < 0.7) continue;
        const sc = Math.abs(m - target) + rng() * 1.5;
        if (sc < bestScore) {
          bestScore = sc;
          best = m;
        }
      }
      prev = best;
      if (prev > hi - 4) dir = -1;
      else if (prev < lo + 4) dir = 1;
      else if (rng() < 0.25) dir = -dir;
      out.push({ b, m: best, d });
    }
  }
  return out;
}

interface TimedNote {
  time: number;
  inst: Inst;
  m: number;
  dur: number;
  vel: number;
}

const DRUMS = new Set<Inst>(['kick', 'snare', 'brush', 'swish', 'ride', 'hat', 'rim', 'shaker', 'crash', 'tom']);

/** Mix group of an instrument (used by the debug solo filter). */
export type MusicGroup = 'lead' | 'comp' | 'bass' | 'drums';
function instGroup(i: Inst): MusicGroup {
  if (DRUMS.has(i)) return 'drums';
  if (i === 'bass') return 'bass';
  if (i === 'ep' || i === 'guitar' || i === 'pad') return 'comp';
  return 'lead';
}

function compileTrack(name: MusicTrack, def: TrackDef, loop: number): { notes: TimedNote[]; length: number } {
  const rng = mulberry32(hashString(name) + loop * 7919);
  const spans = parseChart(def.chords, def.meter);
  const bars = Math.round((spans[spans.length - 1].start + spans[spans.length - 1].len) / def.meter);
  const head = parseMelody(def.melody, def.meter);
  const choruses = def.solo ? 2 : 1;
  const beatsPerChorus = bars * def.meter;
  const out: BeatNote[] = [];
  for (let c = 0; c < choruses; c++) {
    const off = c * beatsPerChorus;
    const lead = c === 0 ? def.lead : def.solo!;
    const range = SOLO_RANGE[lead] ?? [64, 84];
    const mel = c === 0 ? head : improvise(spans, bars, def.meter, range[0], range[1], rng);
    const lv = def.leadVel ?? 0.8;
    for (const n of mel) {
      out.push({ b: off + n.b, inst: lead, m: n.m, d: n.d, v: (c === 0 ? lv : 0.65) * (0.9 + rng() * 0.2) });
      if (c === 0 && def.double) out.push({ b: off + n.b, inst: def.double, m: n.m + (def.double === 'vibes' ? 0 : 12), d: n.d, v: 0.45 });
    }
    arrangeComp(def.comp, spans, off, def.meter, rng, out);
    const bs = typeof def.bass === 'string' ? def.bass : def.bass[c];
    arrangeBass(bs, spans, off, rng, out);
    arrangeDrums(def.drums, bars, def.meter, off, c, rng, out);
  }
  const spb = 60 / def.bpm;
  const s = def.swing;
  const swing = (b: number) => {
    const beat = Math.floor(b);
    const f = b - beat;
    return beat + (f < 0.5 ? (f / 0.5) * s : s + ((f - 0.5) / 0.5) * (1 - s));
  };
  const total = choruses * beatsPerChorus;
  const notes: TimedNote[] = out.map((n) => {
    const b = ((n.b % total) + total) % total;
    const start = swing(b);
    const jitter = DRUMS.has(n.inst) ? (rng() - 0.5) * 0.004 : (rng() - 0.5) * 0.01;
    return {
      time: start * spb + (n.dt ?? 0) + jitter,
      inst: n.inst,
      m: n.m,
      dur: Math.max(0.05, (swing(b + n.d) - start) * spb),
      vel: clamp(n.v, 0, 1),
    };
  });
  notes.sort((a, b) => a.time - b.time);
  return { notes, length: total * spb };
}

// ---------------------------------------------------------------------------------------------
// Music: instruments
// ---------------------------------------------------------------------------------------------

interface Buses {
  lead: AudioNode;
  comp: AudioNode;
  vibes: AudioNode;
  bass: AudioNode;
  drums: AudioNode;
}

/** FM electric piano: 1:1 FM with a decaying index plus a short tine "ping". */
function epNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const f = mtof(m);
  const v = new Voice(e, t, dest);
  const len = dur + 0.4;
  const car = v.osc('sine', f, t, len);
  const mod = v.osc('sine', f, t, len);
  const idx = v.gain(0);
  idx.gain.setValueAtTime(f * (0.6 + vel * 1.6), t);
  idx.gain.setTargetAtTime(f * 0.22, t, 0.18);
  v.mod(car.frequency, mod, idx);
  const amp = v.gain(0);
  const peak = 0.16 * vel;
  const tc = clamp(1.6 - (m - 48) * 0.03, 0.45, 1.8);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(peak, t + 0.004);
  amp.gain.setTargetAtTime(0, t + 0.004, tc);
  amp.gain.setTargetAtTime(0, t + dur, 0.07);
  v.chain(car, amp, v.out);
  if (f * 14 < 16000) {
    const tg = v.gain(0);
    perc(tg.gain, t, peak * 0.1 * vel, 0.001, 0.05);
    v.chain(v.osc('sine', f * 14, t, 0.08), tg, v.out);
  }
}

/** Vibraphone: fundamental + 4th-mode partial, soft mallet, pedal-damped release (motor tremolo is on the bus). */
function vibesNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const f = mtof(m);
  const v = new Voice(e, t, dest);
  const damp = t + dur + 0.4;
  const a1 = v.gain(0);
  a1.gain.setValueAtTime(0, t);
  a1.gain.linearRampToValueAtTime(0.2 * vel, t + 0.002);
  a1.gain.setTargetAtTime(0, t + 0.002, 0.9);
  a1.gain.setTargetAtTime(0, damp, 0.12);
  v.chain(v.osc('sine', f, t, dur + 1.2), a1, v.out);
  const a2 = v.gain(0);
  perc(a2.gain, t, 0.05 * vel, 0.001, 0.35);
  v.chain(v.osc('sine', f * 4, t, 0.4), a2, v.out);
  const mg = v.gain(0);
  perc(mg.gain, t, 0.05 * vel, 0.001, 0.015);
  v.chain(v.noise(t, 0.03), v.filter('bandpass', Math.min(f * 2, 8000), 1), mg, v.out);
}

function marimbaNote(e: AudioEngine, dest: AudioNode, t: number, m: number, _dur: number, vel: number) {
  const f = mtof(m);
  const v = new Voice(e, t, dest);
  const dk = 0.55 * Math.pow(440 / f, 0.3);
  const a1 = v.gain(0);
  perc(a1.gain, t, 0.32 * vel, 0.002, dk);
  v.chain(v.osc('sine', f, t, dk + 0.05), a1, v.out);
  const a2 = v.gain(0);
  perc(a2.gain, t, 0.07 * vel, 0.001, 0.07);
  v.chain(v.osc('sine', f * 3.93, t, 0.1), a2, v.out);
  const mg = v.gain(0);
  perc(mg.gain, t, 0.08 * vel, 0.001, 0.012);
  v.chain(v.noise(t, 0.02), v.filter('lowpass', 1200), mg, v.out);
}

function glockNote(e: AudioEngine, dest: AudioNode, t: number, m: number, _dur: number, vel: number) {
  const f = mtof(m);
  const v = new Voice(e, t, dest);
  for (const [ratio, amp, dk] of [[1, 0.06, 1.4], [2.76, 0.025, 0.4], [5.4, 0.01, 0.15]] as const) {
    if (f * ratio > 16000) continue;
    const g = v.gain(0);
    perc(g.gain, t, amp * vel, 0.001, dk);
    v.chain(v.osc('sine', f * ratio, t, dk + 0.05), g, v.out);
  }
}

/** Breathy flute / whistle lead with delayed vibrato and a chiff on the attack. */
function fluteNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const f = mtof(m);
  const v = new Voice(e, t, dest);
  const len = dur + 0.12;
  const o = v.osc('sine', f, t, len);
  const vg = v.gain(0);
  if (dur > 0.3) ramp(vg.gain, t, [[0, 0], [0.2, 0], [0.45, f * 0.007]]);
  v.mod(o.frequency, v.osc('sine', 5.2, t, len), vg);
  const peak = 0.14 * vel;
  const amp = v.gain(0);
  ramp(amp.gain, t, [[0, 0], [0.035, peak], [Math.min(0.15, dur), peak * 0.85], [Math.max(0.15, dur), peak * 0.8], [dur + 0.08, 0]]);
  const mix = v.gain(1);
  o.connect(mix);
  v.chain(v.osc('triangle', f * 2, t, len), v.gain(0.08), mix);
  v.chain(mix, amp, v.out);
  const br = v.gain(0);
  ramp(br.gain, t, [[0, 0], [0.02, peak * 1.3], [0.08, peak * 0.4], [dur, peak * 0.3], [dur + 0.08, 0]]);
  v.chain(v.noise(t, len), v.filter('bandpass', Math.min(f * 2, 9000), 2.5), br, v.out);
}

function brassNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const v = new Voice(e, t, dest);
  brassTone(v, v.out, t, mtof(m), dur, 0.1 * vel);
}

function guitarNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const v = new Voice(e, t, dest);
  const buf = pluckBuffer(e.ctx, 'guitar', m);
  const g = v.gain(0.32 * vel);
  g.gain.setTargetAtTime(0, t + dur + 0.25, 0.08);
  v.chain(v.buffer(buf, t, 1, 0, Math.min(buf.duration, dur + 0.9)), v.filter('lowpass', 3000, 0.5), g, v.out);
}

function bassNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const v = new Voice(e, t, dest);
  const buf = pluckBuffer(e.ctx, 'bass', m);
  const g = v.gain(0.6 * vel);
  g.gain.setTargetAtTime(0, t + dur, 0.03);
  v.chain(v.buffer(buf, t, 1, 0, Math.min(buf.duration, dur + 0.2)), g, v.out);
  const sg = v.gain(0);
  sg.gain.setValueAtTime(0, t);
  sg.gain.linearRampToValueAtTime(0.28 * vel, t + 0.006);
  sg.gain.setTargetAtTime(0.1 * vel, t + 0.006, 0.25);
  sg.gain.setTargetAtTime(0, t + dur, 0.03);
  v.chain(v.osc('sine', mtof(m), t, dur + 0.2), sg, v.out);
}

function padNote(e: AudioEngine, dest: AudioNode, t: number, m: number, dur: number, vel: number) {
  const f = mtof(m);
  const v = new Voice(e, t, dest);
  const lp = v.filter('lowpass', 1400, 0.5);
  for (const det of [-8, 8]) {
    const o = v.osc('sawtooth', f, t, dur + 0.8);
    o.detune.value = det;
    o.connect(lp);
  }
  const g = v.gain(0);
  ramp(g.gain, t, [[0, 0], [0.35, 0.03 * vel], [dur, 0.03 * vel], [dur + 0.7, 0]]);
  v.chain(lp, g, v.out);
}

function drumHit(e: AudioEngine, dest: AudioNode, t: number, inst: Inst, m: number, dur: number, vel: number) {
  const v = new Voice(e, t, dest);
  switch (inst) {
    case 'kick': {
      const o = v.osc('sine', 110, t, 0.3);
      glide(o.frequency, t, [[0, 110], [0.08, 50]]);
      const g = v.gain(0);
      perc(g.gain, t, 0.55 * vel, 0.002, 0.25);
      v.chain(o, g, v.out);
      noiseHit(v, v.out, t, 'lowpass', 2000, 0.7, 0.06 * vel, 0.001, 0.005);
      break;
    }
    case 'snare':
      noiseHit(v, v.out, t, 'bandpass', 2200, 0.7, 0.5 * vel, 0.002, 0.12);
      tone(v, v.out, t, 'sine', 190, 0.001, 0.12 * vel, 0.001, 0.06);
      break;
    case 'brush':
      noiseHit(v, v.out, t, 'bandpass', 1800, 0.6, 0.45 * vel, 0.004, 0.18);
      break;
    case 'swish': {
      const g = v.gain(0);
      ramp(g.gain, t, [[0, 0], [dur * 0.35, 0.1 * vel], [dur, 0]]);
      v.chain(v.noise(t, dur + 0.02, 'pink'), v.filter('bandpass', 3000, 0.9), v.filter('lowpass', 7000), g, v.panner(m * 0.3), v.out);
      break;
    }
    case 'ride':
      metal(v, v.out, t, 0.05 * vel, 0.6, 470);
      break;
    case 'hat':
      noiseHit(v, v.out, t, 'highpass', 7000, 0.7, 0.12 * vel, 0.001, 0.04);
      break;
    case 'rim':
      tone(v, v.out, t, 'triangle', 820, 0.001, 0.12 * vel, 0.001, 0.025);
      noiseHit(v, v.out, t, 'bandpass', 3500, 4, 0.5 * vel, 0.001, 0.015);
      break;
    case 'shaker': {
      const g = v.gain(0);
      ramp(g.gain, t, [[0, 0], [0.012, 0.1 * vel], [0.07, 0]]);
      v.chain(v.noise(t, 0.08), v.filter('bandpass', 6000, 1), g, v.out);
      break;
    }
    case 'crash':
      metal(v, v.out, t, 0.12 * vel, 1.6, 400);
      break;
    case 'tom': {
      const f = mtof(m || 45);
      const o = v.osc('sine', f * 1.3, t, 0.4);
      glide(o.frequency, t, [[0, f * 1.3], [0.1, f]]);
      const g = v.gain(0);
      perc(g.gain, t, 0.4 * vel, 0.002, 0.35);
      v.chain(o, g, v.out);
      noiseHit(v, v.out, t, 'bandpass', 500, 1, 0.2 * vel, 0.001, 0.05);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// Music: scheduler / crossfading player
// ---------------------------------------------------------------------------------------------

class TrackPlayer {
  private readonly out: GainNode;
  private readonly buses: Buses;
  private readonly lfos: AudioScheduledSourceNode[] = [];
  private readonly driver: Driver;
  private notes: TimedNote[];
  private length: number;
  private idx = 0;
  private loop = 0;
  private loopStart: number;
  private done = false;

  constructor(private readonly e: AudioEngine, readonly name: MusicTrack, fadeIn: number) {
    const ctx = e.ctx;
    const def = TRACKS[name];
    const t0 = ctx.currentTime + 0.08;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, ctx.currentTime);
    this.out.gain.linearRampToValueAtTime(1, t0 + fadeIn);
    this.out.connect(e.musicBus);
    const send = ctx.createGain();
    send.gain.value = def.verb ?? 0.22;
    this.out.connect(send);
    send.connect(e.musicVerb);
    const bus = (g: number) => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(this.out);
      return n;
    };
    const lfo = (freq: number, depth: number, target: AudioParam) => {
      const o = ctx.createOscillator();
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g);
      g.connect(target);
      o.start(t0);
      this.lfos.push(o);
    };
    // Group levels balanced from offline renders: lead on top, comping and bass just under it,
    // brushes as texture. Electric piano gets autopan, vibraphone its motor tremolo.
    const comp = ctx.createStereoPanner();
    comp.connect(bus(1.35));
    lfo(2.6, 0.35, comp.pan);
    const vibes = ctx.createGain();
    vibes.gain.value = 0.82;
    vibes.connect(bus(1.2));
    lfo(5.4, 0.18, vibes.gain);
    this.buses = { lead: bus(1.5), comp, vibes, bass: bus(0.68), drums: bus(1.7) };
    const first = compileTrack(name, def, 0);
    this.notes = first.notes;
    this.length = first.length;
    this.loopStart = t0;
    this.driver = new Driver(e, (until) => this.schedule(until));
  }

  private schedule(until: number) {
    if (this.done || !this.notes.length) return;
    const now = this.e.ctx.currentTime;
    for (;;) {
      const n = this.notes[this.idx];
      const at = this.loopStart + n.time;
      if (at >= until) break;
      if (at >= now - 0.02) this.play(n, Math.max(at, now));
      if (++this.idx >= this.notes.length) {
        this.idx = 0;
        this.loopStart += this.length;
        this.loop++;
        const next = compileTrack(this.name, TRACKS[this.name], this.loop);
        this.notes = next.notes;
        this.length = next.length;
      }
    }
  }

  private play(n: TimedNote, t: number) {
    const b = this.buses;
    const e = this.e;
    if (e.musicOnly && !e.musicOnly.has(instGroup(n.inst))) return;
    switch (n.inst) {
      case 'ep':
        return epNote(e, b.comp, t, n.m, n.dur, n.vel);
      case 'vibes':
        return vibesNote(e, b.vibes, t, n.m, n.dur, n.vel);
      case 'marimba':
        return marimbaNote(e, b.lead, t, n.m, n.dur, n.vel);
      case 'glock':
        return glockNote(e, b.lead, t, n.m, n.dur, n.vel);
      case 'flute':
        return fluteNote(e, b.lead, t, n.m, n.dur, n.vel);
      case 'brass':
        return brassNote(e, b.lead, t, n.m, n.dur, n.vel);
      case 'guitar':
        return guitarNote(e, b.comp, t, n.m, n.dur, n.vel);
      case 'bass':
        return bassNote(e, b.bass, t, n.m, n.dur, n.vel);
      case 'pad':
        return padNote(e, b.comp, t, n.m, n.dur, n.vel);
      default:
        return drumHit(e, b.drums, t, n.inst, n.m, n.dur, n.vel);
    }
  }

  fadeOut(seconds: number) {
    if (this.done) return;
    this.done = true;
    const now = this.e.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + seconds);
    this.driver.stop();
    for (const o of this.lfos) o.stop(now + seconds + 3);
    if (!this.e.offline) window.setTimeout(() => this.out.disconnect(), (seconds + 3) * 1000);
  }
}

// ---------------------------------------------------------------------------------------------
// Engine: the graph for one AudioContext (realtime or offline)
// ---------------------------------------------------------------------------------------------

const DOG_LEVEL = 0.85;
/** Per-kind trims so recorded and synthesised voices sit at similar loudness. */
const DOG_TRIM: Partial<Record<DogSound, number>> = {
  woof: 0.8, growl: 0.7, whine: 0.85, howl: 0.55, sneeze: 0.45, sniff: 0.6, yawn: 0.6, lap: 0.85, crunch: 1.6, happy: 0.9,
};
const MUSIC_TRIM = 0.75;

export class AudioEngine {
  readonly master: GainNode;
  readonly musicBus: GainNode;
  readonly sfxBus: GainNode;
  /** Reverb inputs (their outputs return into the music / sfx buses). */
  readonly musicVerb: ConvolverNode;
  readonly roomVerb: ConvolverNode;
  readonly offline: boolean;
  /** Debug: ignore recordings and use the synthesised dog voices. */
  forceSynth = false;
  /** Debug: only play these music groups (null = all). */
  musicOnly: Set<MusicGroup> | null = null;
  private track: TrackPlayer | null = null;
  private readonly lastClip = new Map<ClipGroup, SampleClip>();

  constructor(readonly ctx: BaseAudioContext, private readonly clips: Map<string, SampleClip>) {
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = '4x';
    this.master.connect(limiter);
    limiter.connect(clip);
    clip.connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);

    this.musicVerb = ctx.createConvolver();
    this.musicVerb.buffer = impulseResponse(ctx, 2.4, 0.7);
    this.musicVerb.connect(this.musicBus);
    this.roomVerb = ctx.createConvolver();
    this.roomVerb.buffer = impulseResponse(ctx, 0.7, 0.8);
    this.roomVerb.connect(this.sfxBus);
  }

  /** Scheduling horizon: the whole render for offline contexts, else a short look-ahead. */
  get horizon(): number {
    return this.offline ? (this.ctx as OfflineAudioContext).length / this.ctx.sampleRate : this.ctx.currentTime + LOOKAHEAD;
  }

  setLevels(master: number, music: number, sfx: number, muted: boolean) {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(muted ? 0 : master, t, 0.03);
    this.musicBus.gain.setTargetAtTime(music * MUSIC_TRIM, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(sfx, t, 0.03);
  }

  pickClip(group: ClipGroup): SampleClip | null {
    if (this.forceSynth) return null;
    const list = CLIP_GROUPS[group].map((n) => this.clips.get(n)).filter((c): c is SampleClip => !!c);
    if (!list.length) return null;
    const last = this.lastClip.get(group);
    let c = pick(list);
    for (let i = 0; i < 4 && list.length > 1 && c === last; i++) c = pick(list);
    this.lastClip.set(group, c);
    return c;
  }

  dog(kind: DogSound, voice: DogVoice, opts: PlayOpts = {}, at?: number): SoundHandle {
    if (kind === 'pant') return this.loop('pant', voice, opts);
    const t = at ?? this.ctx.currentTime + 0.01;
    const v = new Voice(this, t, this.sfxBus, (opts.volume ?? 1) * DOG_LEVEL * (DOG_TRIM[kind] ?? 1), opts.pan ?? 0);
    v.send(this.roomVerb, kind === 'howl' ? 0.35 : 0.1);
    const d: DogCtx = { e: this, v, t, p: clamp(voice.pitch, 0.6, 2.2), r: clamp(voice.rough, 0, 1) };
    const out = v.out;
    switch (kind) {
      case 'bark':
      case 'yip':
      case 'woof':
        if (!barkSample(d, kind, out)) barkSynth(d, kind, out);
        break;
      case 'whine':
        if (!whineSample(d, out)) whineSynth(d, out);
        break;
      case 'happy':
        happy(d, out);
        break;
      case 'howl':
        howl(d, out);
        break;
      case 'growl':
        growl(d, out);
        break;
      case 'sneeze':
        sneeze(d, out);
        break;
      case 'sniff':
        sniff(d, out);
        break;
      case 'yawn':
        yawn(d, out);
        break;
      case 'lap':
        lap(d, out);
        break;
      case 'crunch':
        crunch(d, out);
        break;
    }
    return v;
  }

  sfx(name: SfxName, opts: SfxOpts = {}, at?: number): SoundHandle {
    const fn = SFX[name];
    if (!fn) return NOOP;
    const t = at ?? this.ctx.currentTime + 0.005;
    const level = clamp(opts.volume ?? 1, 0, 1.5) * (SFX_LEVEL[name] ?? 1);
    const v = new Voice(this, t, this.sfxBus, level, opts.pan ?? 0);
    v.send(this.roomVerb, name === 'applause' || name === 'fanfare' ? 0.3 : 0.06);
    fn(v, t, opts);
    return v;
  }

  loop(name: LoopName, voice: DogVoice = { pitch: 1.2, rough: 0.2 }, opts: PlayOpts = {}): LoopHandle {
    return new LoopPlayer(this, name, voice, opts, this.sfxBus);
  }

  music(track: MusicTrack | null, fade = 1.2) {
    if ((this.track?.name ?? null) === track) return;
    const had = !!this.track;
    this.track?.fadeOut(fade);
    this.track = track ? new TrackPlayer(this, track, had ? fade * 0.8 : 0.4) : null;
  }

  get currentTrack(): MusicTrack | null {
    return this.track?.name ?? null;
  }
}

const NOOP: SoundHandle & LoopHandle = { stop() {}, setVolume() {} };

// ---------------------------------------------------------------------------------------------
// Public singleton
// ---------------------------------------------------------------------------------------------

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private eng: AudioEngine | null = null;
  private readonly clips = new Map<string, SampleClip>();
  private loading: Promise<void> | null = null;
  private readonly vol = { master: 0.9, music: 0.6, sfx: 1 };
  private isMuted = false;
  private wantTrack: MusicTrack | null = null;
  private synthOnly = false;

  /** Creates/resumes the AudioContext. Call from a user gesture (safe to call repeatedly). */
  async init(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.eng = new AudioEngine(this.ctx, this.clips);
      this.eng.forceSynth = this.synthOnly;
      this.applyLevels();
      // A silent blip inside the gesture unlocks output on iOS.
      const s = this.ctx.createBufferSource();
      s.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      s.connect(this.ctx.destination);
      s.start();
      document.addEventListener('visibilitychange', this.onVisibility);
      void this.loadSamples();
      if (this.wantTrack) this.eng.music(this.wantTrack);
    }
    if (this.ctx.state !== 'running' && !document.hidden) {
      try {
        await this.ctx.resume();
      } catch {
        /* resumed on a later gesture */
      }
    }
  }

  get ready(): boolean {
    return !!this.eng;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  setVolume(master: number) {
    this.vol.master = clamp(master, 0, 1);
    this.applyLevels();
  }

  setMusicVolume(v: number) {
    this.vol.music = clamp(v, 0, 1);
    this.applyLevels();
  }

  setSfxVolume(v: number) {
    this.vol.sfx = clamp(v, 0, 1);
    this.applyLevels();
  }

  mute(on: boolean) {
    this.isMuted = on;
    this.applyLevels();
  }

  get muted(): boolean {
    return this.isMuted;
  }

  dog(kind: DogSound, voice: DogVoice, opts?: PlayOpts): SoundHandle {
    if (!this.live()) return NOOP;
    return this.eng!.dog(kind, voice, opts);
  }

  sfx(name: SfxName, opts?: SfxOpts): SoundHandle {
    if (!this.live()) return NOOP;
    return this.eng!.sfx(name, opts);
  }

  startLoop(name: LoopName, opts?: PlayOpts & { voice?: DogVoice }): LoopHandle {
    if (!this.live()) return NOOP;
    return this.eng!.loop(name, opts?.voice, opts);
  }

  /** Crossfades to `track` (null fades out). Remembered if called before init. */
  music(track: MusicTrack | null) {
    this.wantTrack = track;
    this.eng?.music(track);
  }

  get currentTrack(): MusicTrack | null {
    return this.wantTrack;
  }

  /** Debug: bypass the recordings and use synthesised dog voices. */
  get forceSynth(): boolean {
    return this.synthOnly;
  }

  set forceSynth(on: boolean) {
    this.synthOnly = on;
    if (this.eng) this.eng.forceSynth = on;
  }

  /** Fetches and decodes the dog recordings (done automatically by init). */
  loadSamples(): Promise<void> {
    if (!this.loading) {
      const decoder: BaseAudioContext = this.ctx ?? new OfflineAudioContext(1, 1, 44100);
      const base = import.meta.env.BASE_URL ?? '/';
      this.loading = Promise.all(
        SAMPLE_NAMES.map(async (name) => {
          try {
            const res = await fetch(`${base}sfx/${name}.mp3`);
            if (!res.ok) throw new Error(`${res.status}`);
            const buf = await decoder.decodeAudioData(await res.arrayBuffer());
            this.clips.set(name, trimClip(buf));
          } catch (err) {
            console.warn(`[audio] sample ${name} unavailable, using synthesis`, err);
          }
        }),
      ).then(() => undefined);
    }
    return this.loading;
  }

  /**
   * Test support: renders whatever `play` schedules on a fresh engine bound to an
   * OfflineAudioContext (same graph, limiter and levels) and returns the stereo buffer.
   */
  async renderOffline(seconds: number, play: (e: AudioEngine) => void, sampleRate = 44100): Promise<AudioBuffer> {
    await this.loadSamples();
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = new AudioEngine(ctx, this.clips);
    eng.forceSynth = this.synthOnly;
    eng.setLevels(this.vol.master, this.vol.music, this.vol.sfx, false);
    play(eng);
    return ctx.startRendering();
  }

  private live(): boolean {
    return !!this.eng && !!this.ctx && this.ctx.state !== 'closed';
  }

  private applyLevels() {
    this.eng?.setLevels(this.vol.master, this.vol.music, this.vol.sfx, this.isMuted);
  }

  private readonly onVisibility = () => {
    if (!this.ctx) return;
    if (document.hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  };
}

export const audio = new AudioSystem();
