import * as THREE from 'three';
import { budget } from '../game/quality';

// Procedural textures are painted on canvases. Once a texture is on the GPU its
// canvas is dead weight, and phones cap the canvas memory a page may hold (iOS
// Safari fails to create further canvases past it: blank or broken textures). So:
//
// - large canvases are scaled down to the device's texture budget before upload
//   (phones render far fewer pixels than a desktop; they don't need 2048² floors)
// - a canvas's backing store is released once every texture using it is uploaded.
//
// Released textures can't be re-uploaded from their canvas; if the WebGL context
// is lost, the game rebuilds the scene (see Game), which paints them anew.

const shrunk = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
const pending = new WeakMap<HTMLCanvasElement, number>();

/** Largest canvas side kept as is; bigger ones are scaled by the tier's texture scale. */
const KEEP = 512;

/** The canvas at the device's texture budget (the same canvas when it already fits). */
export function deviceCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const k = budget().textureScale;
  if (k >= 1 || Math.max(c.width, c.height) <= KEEP) return c;
  const cached = shrunk.get(c);
  if (cached) return cached;
  const w = Math.max(1, Math.round(c.width * k));
  const h = Math.max(1, Math.round(c.height * k));
  const s = document.createElement('canvas');
  s.width = w;
  s.height = h;
  const g = s.getContext('2d');
  if (!g) return c;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, w, h);
  shrunk.set(c, s);
  return s;
}

/**
 * Fit a canvas texture to the device and free its canvas once it's on the GPU.
 * Call before the texture is first rendered. Returns the texture.
 */
export function manageCanvasTexture<T extends THREE.Texture>(t: T, opts: { shrink?: boolean; release?: boolean } = {}): T {
  let img = t.image as HTMLCanvasElement | undefined;
  if (typeof HTMLCanvasElement === 'undefined' || !(img instanceof HTMLCanvasElement)) return t;
  // already handled (a texture can pass through more than one helper)
  if (t.userData.released !== undefined) return t;
  if (opts.shrink !== false) {
    const small = deviceCanvas(img);
    if (small !== img) {
      t.image = small;
      t.needsUpdate = true;
      img = small;
    }
  }
  if (opts.release === false) { t.userData.released = null; return t; }
  const canvas = img;
  t.userData.released = false;
  pending.set(canvas, (pending.get(canvas) ?? 0) + 1);
  const prev = t.onUpdate;
  t.onUpdate = (tex: THREE.Texture) => {
    prev?.(tex);
    t.onUpdate = prev ?? null;
    if (t.userData.released) return;
    t.userData.released = true;
    const left = (pending.get(canvas) ?? 1) - 1;
    pending.set(canvas, left);
    if (left <= 0 && tex.image === canvas) {
      // shrinking a canvas to nothing frees its pixels; the GPU copy stays
      canvas.width = 0;
      canvas.height = 0;
    }
  };
  return t;
}

/** Cap anisotropic filtering at what the device's budget allows (applies to every texture). */
export function capAnisotropy(renderer: THREE.WebGLRenderer) {
  const caps = renderer.capabilities as THREE.WebGLCapabilities & { getMaxAnisotropy: () => number; __capped?: boolean };
  if (caps.__capped) return;
  caps.__capped = true;
  const real = caps.getMaxAnisotropy.bind(caps);
  caps.getMaxAnisotropy = () => Math.min(real(), budget().anisotropy);
}

function dropArray(this: THREE.BufferAttribute) {
  (this as unknown as { array: ArrayLike<number> | null }).array = null;
}

/**
 * Static scenery: once its buffers are on the GPU, three.js doesn't need the arrays
 * again (bounds must be computed first; nothing may raycast it). A town's merged
 * geometry is tens of megabytes of JS heap otherwise. Like released textures, it
 * can't be re-uploaded after a lost context: the scene is rebuilt instead.
 */
export function freeGeometryAfterUpload<T extends THREE.BufferGeometry>(g: T): T {
  if (!g.boundingSphere) g.computeBoundingSphere();
  if (!g.boundingBox) g.computeBoundingBox();
  for (const a of Object.values(g.attributes)) if ((a as THREE.BufferAttribute).isBufferAttribute) (a as THREE.BufferAttribute).onUpload(dropArray);
  g.index?.onUpload(dropArray);
  return g;
}
