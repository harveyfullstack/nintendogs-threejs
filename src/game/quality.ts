// How much this device can take, and how much it's taking right now.
//
// A device tier (from what the browser tells us about the screen, memory, cores and
// GPU) sets the fixed costs chosen when a scene is built: texture resolution,
// shadow map size, anisotropy, how finely dogs are sculpted. Then an adaptive
// controller watches the frame rate and moves a small ladder of per-frame costs
// (render resolution, fur shells, shadow refresh) up and down to hold 60 fps.

export type Tier = 'low' | 'mid' | 'high';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** An iPhone or iPad (iPads may call themselves Macs). */
const ios = typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));

/** A phone or tablet (touch first, no hover). */
export const mobile = typeof navigator !== 'undefined'
  && (ios || mq('(hover: none) and (pointer: coarse)') || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));

function guessTier(): Tier {
  const forced = params.get('tier');
  if (forced === 'low' || forced === 'mid' || forced === 'high') return forced;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 0; // Chrome only; 0 = unknown
  const cores = nav.hardwareConcurrency || 4;
  if (!mobile) return mem && mem <= 4 ? 'mid' : 'high';
  if (ios) {
    // Safari reports neither memory nor the real core count (always 2 or 4), so go by
    // the screen: the oldest iPhones still around are among the home-button ones
    return Math.max(screen.width, screen.height) <= 667 ? 'low' : 'mid';
  }
  if ((mem && mem <= 3) || cores <= 4) return 'low';
  // big-screen tablets and recent phones: still start in the middle and let the
  // adaptive controller climb if there's headroom
  return 'mid';
}

let tier: Tier = guessTier();

/** Refine the tier once the GPU is known (software renderers and old mobile GPUs drop a notch). */
export function refineTier(gl: WebGL2RenderingContext) {
  if (params.get('tier')) return;
  let name = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { /* not exposed */ }
  const slow = /SwiftShader|llvmpipe|softpipe|Software|Mali-(4|T[0-9])|Adreno \(TM\) [345]\d\d|PowerVR|Intel\(R\) (HD|UHD) Graphics [2-6]\d{2}\b/i;
  if (slow.test(name)) tier = tier === 'high' ? 'mid' : 'low';
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (maxTex < 4096) tier = 'low';
  gpuName = name;
}
let gpuName = '';

export function deviceTier(): Tier { return tier; }
export function gpu(): string { return gpuName; }

/** Fixed costs for the current tier, read when things are built. */
export function budget() {
  switch (tier) {
    case 'low': return { textureScale: 0.5, shadowMap: 1024, anisotropy: 2, furQuality: 0.7, shadowTaps: 1, physical: false, maxPixelRatio: 1.25, grass: 0.15, flowers: 0.25, nearTrees: false, crowd: 0.6 };
    case 'mid': return { textureScale: 0.5, shadowMap: 1024, anisotropy: 4, furQuality: 0.85, shadowTaps: 5, physical: false, maxPixelRatio: 1.5, grass: 0.3, flowers: 0.4, nearTrees: true, crowd: 1 };
    default: return { textureScale: 1, shadowMap: 2048, anisotropy: 8, furQuality: 1, shadowTaps: 5, physical: true, maxPixelRatio: 2, grass: 1, flowers: 1, nearTrees: true, crowd: 1 };
  }
}

/** Scale a procedural texture size (power of two in, power of two out, never below `min`). */
export function texSize(px: number, min = 64): number {
  const s = budget().textureScale;
  if (s >= 1) return px;
  return Math.max(Math.min(px, min), Math.round(px * s));
}

// ---------------------------------------------------------------- adaptive

/**
 * Per-frame costs, cheapest last. `scale` multiplies the render resolution,
 * `fur` the fur shell count, `shadowEvery` is how often (in frames) shadow maps
 * are redrawn.
 */
export const LEVELS = [
  { scale: 1, fur: 1, detail: 1, shadowEvery: 1 },
  { scale: 0.9, fur: 0.85, detail: 0.9, shadowEvery: 1 },
  { scale: 0.8, fur: 0.72, detail: 0.8, shadowEvery: 1 },
  { scale: 0.72, fur: 0.6, detail: 0.7, shadowEvery: 2 },
  { scale: 0.64, fur: 0.5, detail: 0.6, shadowEvery: 2 },
  { scale: 0.56, fur: 0.42, detail: 0.5, shadowEvery: 3 },
  { scale: 0.5, fur: 0.35, detail: 0.4, shadowEvery: 3 },
] as const;

const TARGET = 1 / 60;

/**
 * The costs in force right now, read every frame: `fur` scales shell counts, `detail`
 * scales optional scenery like grass blades.
 */
export const live = { fur: 1, detail: 1 };

export class AdaptiveQuality {
  /** index into LEVELS */
  level: number;
  enabled = !params.has('fixedres');
  /** called after the level changes (resize render targets etc.) */
  onChange: (() => void) | null = null;
  private acc = 0;
  private n = 0;
  private slow = 0;
  private stable = 0;
  private cooldown = 0;
  /** how long to wait before trying a better level again after one failed */
  private climbWait = 4;
  private lastDown = -1;
  /** frame time that made us step down, until the cheaper level has been measured */
  private probe = 0;
  /**
   * Frame time a cheaper level didn't improve on: the frame rate is capped by
   * something else (a battery saver running the screen at 30 Hz, the CPU), so
   * frames that slow aren't a reason to lower the quality.
   */
  private floor = 0;

  constructor() {
    const forced = params.get('level');
    this.level = forced !== null ? Math.min(LEVELS.length - 1, Math.max(0, Number(forced) | 0)) : tier === 'high' ? 0 : tier === 'mid' ? 1 : 3;
    live.fur = LEVELS[this.level].fur;
    live.detail = LEVELS[this.level].detail;
  }

  get current() { return LEVELS[this.level]; }

  /** Feed the real time between rendered frames (seconds). */
  frame(dt: number) {
    if (!this.enabled) return;
    // tab switches, loading hitches and the first frames of a scene say nothing
    if (!(dt > 0) || dt > 0.25) { this.acc = this.n = 0; return; }
    this.cooldown -= dt;
    this.acc += dt;
    this.n++;
    if (this.acc < 0.5) return;
    const avg = this.acc / this.n;
    this.acc = this.n = 0;
    if (this.cooldown > 0) return;
    // whatever capped the frame rate has gone (the battery saver was switched off)
    if (this.floor && avg < this.floor * 0.75) this.floor = 0;
    if (this.probe) {
      const before = this.probe;
      this.probe = 0;
      if (avg > before * 0.95) {
        // the cheaper level isn't faster: go back, and don't chase that frame rate again
        this.floor = Math.max(this.floor, before * 1.15);
        this.set(this.level - 1);
        return;
      }
    }
    const slowAt = Math.max(TARGET * 1.2, this.floor);
    if (avg > slowAt) {
      // under ~50 fps: step down after a second of it, straight away if far off
      this.stable = 0;
      this.slow += avg > slowAt * 1.5 ? 2 : 1;
      if (this.slow >= 2 && this.level < LEVELS.length - 1) {
        this.lastDown = this.level;
        this.probe = avg;
        this.set(this.level + 1);
        this.slow = 0;
      }
    } else {
      this.slow = 0;
      if (avg < TARGET * 1.08) this.stable += 0.5;
      // climb back slowly; each time a climb had to be undone, wait longer before the next
      if (this.stable >= this.climbWait && this.level > 0) {
        if (this.lastDown === this.level - 1) this.climbWait = Math.min(60, this.climbWait * 2);
        this.set(this.level - 1);
        this.stable = 0;
      }
    }
  }

  /** A new scene has started: its first second is loading noise. */
  reset() {
    this.acc = this.n = 0;
    this.slow = 0;
    this.stable = 0;
    this.probe = 0;
    this.cooldown = 1;
  }

  private set(level: number) {
    if (level === this.level) return;
    this.level = level;
    live.fur = LEVELS[level].fur;
    live.detail = LEVELS[level].detail;
    this.cooldown = 1.5;
    this.onChange?.();
  }
}
