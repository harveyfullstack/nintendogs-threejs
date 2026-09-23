import * as THREE from 'three';

// Nintendo DS flavoured output: the 3D view renders at a lower "virtual"
// resolution, then is upscaled with hard pixel edges and ordered-dithered down
// to 5 bits per channel, like the DS's 15-bit screens.

export type RetroMode = 'off' | 'subtle' | 'ds';

export const RETRO_MODES: { id: RetroMode; label: string; pixel: number; levels: number }[] = [
  { id: 'off', label: 'Modern', pixel: 1, levels: 256 },
  { id: 'subtle', label: 'DS dither', pixel: 2, levels: 20 },
  { id: 'ds', label: 'Chunky DS', pixel: 3, levels: 24 },
];

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 lowRes;
uniform float levels;
varying vec2 vUv;

// 4x4 Bayer matrix, the pattern the DS's 3D engine dithered with
float bayer4(vec2 p) {
  vec2 q = mod(p, 4.0);
  int i = int(q.x) + int(q.y) * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}

void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // quantise in display space so the steps are perceptually even
  vec2 px = floor(vUv * lowRes);
  float threshold = bayer4(px);
  float n = levels - 1.0;
  vec3 c = clamp(gl_FragColor.rgb, 0.0, 1.0) * n;
  gl_FragColor.rgb = (floor(c) + step(threshold, fract(c))) / n;
  gl_FragColor.a = 1.0;
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export class RetroPass {
  mode: RetroMode = 'subtle';
  private rt: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      samples: 4,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        lowRes: { value: new THREE.Vector2(1, 1) },
        levels: { value: 32 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get enabled() {
    return this.mode !== 'off';
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const cfg = RETRO_MODES.find((m) => m.id === this.mode) ?? RETRO_MODES[1];
    // virtual resolution: one "DS pixel" is `cfg.pixel` CSS pixels
    const css = renderer.getSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(css.x / cfg.pixel));
    const h = Math.max(1, Math.round(css.y / cfg.pixel));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.material.uniforms.lowRes.value.set(w, h);
    this.material.uniforms.levels.value = cfg.levels;

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.rt.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
