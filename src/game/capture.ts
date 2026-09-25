import * as THREE from 'three';
import { discardSamples, sceneTarget } from './retro';

// Offscreen renders (portraits) drawn exactly like the screen: materials tone map
// and sRGB encode into a plain 8-bit target (see sceneTarget), so the pixels read
// back are final. No float buffers, which some phone GPUs can't render to or read.

export function renderToDataURL(
  renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, w: number, h: number,
  opts: { type?: string } = {},
): string {
  const rt = sceneTarget(w, h);
  const prev = renderer.getRenderTarget();
  const buf = new Uint8Array(w * h * 4);
  try {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    discardSamples(renderer, rt);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  } finally {
    renderer.setRenderTarget(prev);
    rt.dispose();
  }
  // a lost context (or a GPU that refused) leaves nothing: report that, don't show black
  if (!buf.some((v) => v !== 0)) return '';
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(w, h);
  // rows come back bottom-up
  const row = w * 4;
  for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  const url = cv.toDataURL(opts.type ?? 'image/jpeg', 0.88);
  cv.width = cv.height = 0;
  return url;
}
