import * as THREE from 'three';

// Offscreen renders (portraits, previews) come out linear and un-tonemapped,
// so we apply the same ACES filmic curve and sRGB encoding three uses on screen.

function rrtOdt(v: number) {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

function srgb(c: number) {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function renderToDataURL(
  renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, w: number, h: number,
  opts: { transparent?: boolean; type?: string } = {},
): string {
  const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, type: THREE.FloatType });
  const prev = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  if (opts.transparent) renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const buf = new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevClear, prevAlpha);
  rt.dispose();
  // GPUs that can't read back float targets leave the buffer empty: report that, don't draw black
  if (!buf.some((v) => v !== 0)) return '';
  const exposure = renderer.toneMappingExposure / 0.6;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((h - 1 - y) * w + x) * 4;
      const di = (y * w + x) * 4;
      const r = buf[si] * exposure, g = buf[si + 1] * exposure, b = buf[si + 2] * exposure;
      const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
      const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
      const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
      const fr = rrtOdt(ir), fg = rrtOdt(ig), fb = rrtOdt(ib);
      const or = 1.60475 * fr - 0.53108 * fg - 0.07367 * fb;
      const og = -0.10208 * fr + 1.10813 * fg - 0.00605 * fb;
      const ob = -0.00327 * fr - 0.07276 * fg + 1.07602 * fb;
      img.data[di] = srgb(or) * 255;
      img.data[di + 1] = srgb(og) * 255;
      img.data[di + 2] = srgb(ob) * 255;
      img.data[di + 3] = opts.transparent ? Math.min(255, buf[si + 3] * 255) : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL(opts.type ?? (opts.transparent ? 'image/png' : 'image/jpeg'), 0.88);
}
