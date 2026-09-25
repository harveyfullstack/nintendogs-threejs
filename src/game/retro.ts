import * as THREE from 'three';

// Output stage. The 3D view renders into an offscreen multisampled target that is
// exactly the size of the canvas, then one cheap full-screen pass copies it to the
// canvas: ordered-dithered down to 5 bits per channel for the DS looks (like the
// DS's 15-bit screens), straight for Modern. The browser scales the canvas up to
// the page (with hard pixel edges for the DS looks), so nothing on the GPU ever
// runs at the phone's full native resolution unless there's budget for it.
//
// Materials tone map and sRGB-encode as they would drawing to the canvas (see
// sceneTarget), so the target can be plain 8-bit RGBA: half the memory and
// bandwidth of a float buffer, and it works on GPUs that can't render to floats.

export type RetroMode = 'off' | 'subtle' | 'ds';

export const RETRO_MODES: { id: RetroMode; label: string; pixel: number; levels: number }[] = [
  { id: 'off', label: 'Modern', pixel: 1, levels: 256 },
  { id: 'subtle', label: 'DS dither', pixel: 2, levels: 20 },
  { id: 'ds', label: 'Chunky DS', pixel: 3, levels: 24 },
];

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
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
  // already tone mapped and in display space (see sceneTarget)
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  if (levels < 255.0) {
    // quantise in display space so the steps are perceptually even
    float threshold = bayer4(floor(gl_FragCoord.xy));
    float n = levels - 1.0;
    c = clamp(c, 0.0, 1.0) * n;
    c = (floor(c) + step(threshold, fract(c))) / n;
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * An offscreen target that materials render into exactly as they would into the
 * canvas: tone mapped and sRGB encoded in the shader (three.js only does that for
 * the canvas and for XR targets, hence the flag), stored as raw RGBA8.
 */
export function sceneTarget(w: number, h: number, samples = 4): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    samples,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
  });
  // store the encoded values as they are: no hardware sRGB conversion on write or read
  rt.texture.internalFormat = 'RGBA8';
  (rt as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  // only colour is needed after the multisample resolve
  rt.resolveDepthBuffer = false;
  rt.resolveStencilBuffer = false;
  return rt;
}

/**
 * Tell the GPU the multisampled buffers of `rt` won't be read again: tile-based
 * (phone) GPUs can then resolve on-chip instead of writing every sample out to memory.
 */
export function discardSamples(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget) {
  const fb = (renderer.properties.get(rt) as { __webglMultisampledFramebuffer?: WebGLFramebuffer }).__webglMultisampledFramebuffer;
  if (!fb) return;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0, gl.DEPTH_ATTACHMENT]);
  renderer.state.bindFramebuffer(gl.FRAMEBUFFER, null);
}

export class RetroPass {
  mode: RetroMode = 'subtle';
  readonly target: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.target = sceneTarget(1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        levels: { value: 256 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    // one triangle covering the screen
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(g, this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get config() {
    return RETRO_MODES.find((m) => m.id === this.mode) ?? RETRO_MODES[1];
  }

  get enabled() {
    return this.mode !== 'off';
  }

  /** Match the offscreen target to the canvas size. */
  setSize(w: number, h: number) {
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    discardSamples(renderer, this.target);
    this.material.uniforms.levels.value = this.config.levels;
    renderer.setRenderTarget(prev);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
