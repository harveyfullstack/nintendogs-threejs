// Menu icons: renders any prop in a small soft-lit studio onto a transparent
// background and returns a PNG data URL. Uses the game's renderer but leaves its
// state (render target, size, viewport, clear colour/alpha, tone mapping,
// shadow flags, info counters) exactly as it found it.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

interface Studio {
  scene: THREE.Scene;
  holder: THREE.Group;
  camera: THREE.PerspectiveCamera;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  ground: THREE.Mesh;
  blob: THREE.Mesh;
  env: THREE.Texture;
  post: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial };
  targets: Map<number, { hdr: THREE.WebGLRenderTarget; ldr: THREE.WebGLRenderTarget }>;
}

const studios = new WeakMap<THREE.WebGLRenderer, Studio>();
const cache = new Map<string, string>();

/** Where the camera looks from (front, slightly right and above). */
const VIEW_DIR = new THREE.Vector3(0.5, 0.52, 1).normalize();
const FOV = 22;
const MARGIN = 1.1;
const EXPOSURE = 1.05;

function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Straight-alpha output: un-premultiply, expose, ACES filmic (three's fit), sRGB encode.
const POST_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform float exposure;
  varying vec2 vUv;
  vec3 RRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 aces(vec3 color) {
    const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    color *= exposure / 0.6;
    color = ACESInputMat * color;
    color = RRTAndODTFit(color);
    color = ACESOutputMat * color;
    return clamp(color, 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - 0.055, step(0.0031308, c));
  }
  void main() {
    vec4 c = texture2D(tSrc, vUv);
    float a = clamp(c.a, 0.0, 1.0);
    vec3 rgb = a > 0.0001 ? c.rgb / a : vec3(0.0);
    gl_FragColor = vec4(toSRGB(aces(rgb)), a);
  }
`;

function getStudio(renderer: THREE.WebGLRenderer): Studio {
  let s = studios.get(renderer);
  if (s) return s;
  const scene = new THREE.Scene();
  scene.background = null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.75;

  const key = new THREE.DirectionalLight('#fff4e4', 2.3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0005;
  key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight('#e4eeff', 0.7);
  const rim = new THREE.DirectionalLight('#ffffff', 1.3);
  scene.add(key, key.target, fill, fill.target, rim, rim.target, new THREE.HemisphereLight('#ffffff', '#b8a894', 0.45));

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.16, depthWrite: false }));
  ground.receiveShadow = true;
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }));
  blob.renderOrder = -1;
  const holder = new THREE.Group();
  scene.add(ground, blob, holder);

  const material = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, exposure: { value: EXPOSURE } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: POST_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene().add(quad);

  s = {
    scene, holder, camera: new THREE.PerspectiveCamera(FOV, 1, 0.001, 100), key, fill, rim, ground, blob, env,
    post: { scene: postScene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material },
    targets: new Map(),
  };
  studios.set(renderer, s);
  return s;
}

function targetsFor(s: Studio, px: number) {
  let t = s.targets.get(px);
  if (!t) {
    t = {
      hdr: new THREE.WebGLRenderTarget(px, px, { type: THREE.HalfFloatType, samples: 4, colorSpace: THREE.LinearSRGBColorSpace }),
      ldr: new THREE.WebGLRenderTarget(px, px, { type: THREE.UnsignedByteType, depthBuffer: false }),
    };
    s.targets.set(px, t);
  }
  return t;
}

/** Bounds of the visible meshes under `root` (in root's parent space). */
function visibleBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const b = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if ((m as THREE.InstancedMesh).isInstancedMesh) {
      const im = m as THREE.InstancedMesh;
      if (im.count === 0) return;
      im.computeBoundingBox();
      b.copy(im.boundingBox!);
    } else {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      b.copy(m.geometry.boundingBox!);
    }
    if (!b.isEmpty()) box.union(b.applyMatrix4(m.matrixWorld));
  });
  return box;
}

/** Places camera, lights and the ground for a box, with a tight square frustum. */
function frame(s: Studio, box: THREE.Box3, viewDir = VIEW_DIR) {
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
  const cam = s.camera;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2)) * 1.05;
  cam.position.copy(center).addScaledVector(viewDir, dist);
  cam.up.set(0, 1, 0);
  cam.lookAt(center);
  cam.near = Math.max(1e-4, dist - radius * 1.6);
  cam.far = dist + radius * 3;
  cam.updateMatrixWorld(true);
  // project the box corners and fit an off-axis frustum around them
  const inv = cam.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    const z = Math.max(1e-5, -p.z);
    minX = Math.min(minX, p.x / z); maxX = Math.max(maxX, p.x / z);
    minY = Math.min(minY, p.y / z); maxY = Math.max(maxY, p.y / z);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const half = (Math.max(maxX - minX, maxY - minY) / 2) * MARGIN;
  const n = cam.near;
  cam.projectionMatrix.makePerspective(n * (cx - half), n * (cx + half), n * (cy + half), n * (cy - half), n, cam.far);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

  // lights relative to the camera: key upper-left, fill right, rim behind
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  const toCam = viewDir;
  const place = (l: THREE.DirectionalLight, d: THREE.Vector3) => {
    l.position.copy(center).addScaledVector(d.normalize(), radius * 6);
    l.target.position.copy(center);
    l.target.updateMatrixWorld();
  };
  place(s.key, right.clone().multiplyScalar(-0.6).addScaledVector(up, 1.1).addScaledVector(toCam, 0.8));
  place(s.fill, right.clone().multiplyScalar(1).addScaledVector(up, 0.2).addScaledVector(toCam, 0.7));
  place(s.rim, right.clone().multiplyScalar(0.3).addScaledVector(up, 0.8).addScaledVector(toCam, -1));
  const sc = s.key.shadow.camera;
  sc.left = -radius * 1.4; sc.right = radius * 1.4; sc.top = radius * 1.4; sc.bottom = -radius * 1.4;
  sc.near = radius * 3; sc.far = radius * 9;
  sc.updateProjectionMatrix();
  s.key.shadow.normalBias = radius * 0.01;

  // soft ground contact under the object
  const size = box.getSize(new THREE.Vector3());
  s.ground.position.set(center.x, box.min.y - radius * 0.002, center.z);
  s.ground.scale.setScalar(radius * 6);
  s.blob.position.set(center.x, box.min.y - radius * 0.001, center.z);
  s.blob.scale.set(size.x * 1.25 + radius * 0.1, 1, size.z * 1.25 + radius * 0.1);
}

/**
 * Renders `object` framed in a soft studio onto a transparent background and
 * returns a PNG data URL. Pass `key` to cache the result (per size).
 * Hints: `object.userData.iconDir` ([x, y, z] towards the camera) and
 * `userData.iconHidden = true` on parts to leave out.
 */
export function renderIcon(renderer: THREE.WebGLRenderer, object: THREE.Object3D, size = 128, key?: string): string {
  const cacheKey = key !== undefined ? `${key}@${size}` : '';
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;

  // --- save renderer state ---
  const prev = {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    mip: renderer.getActiveMipmapLevel(),
    clear: renderer.getClearColor(new THREE.Color()),
    alpha: renderer.getClearAlpha(),
    tone: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    output: renderer.outputColorSpace,
    autoClear: renderer.autoClear,
    shadowAuto: renderer.shadowMap.autoUpdate,
    shadowNeeds: renderer.shadowMap.needsUpdate,
    xr: renderer.xr.enabled,
    size: renderer.getSize(new THREE.Vector2()),
    ratio: renderer.getPixelRatio(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()),
    scissorTest: renderer.getScissorTest(),
    info: { ...renderer.info.render },
    infoReset: renderer.info.autoReset,
  };
  const parent = object.parent;
  const index = parent ? parent.children.indexOf(object) : -1;
  const visible = object.visible;
  const hidden: THREE.Object3D[] = [];

  const s = getStudio(renderer);
  let url = '';
  try {
    renderer.xr.enabled = false;
    renderer.info.autoReset = false;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = true;

    object.visible = true;
    s.holder.add(object);
    // optional hints set by the prop builders
    object.traverse((o) => { if (o.userData.iconHidden && o.visible) { o.visible = false; hidden.push(o); } });
    const hint = object.userData.iconDir as number[] | THREE.Vector3 | undefined;
    const dir = hint ? (Array.isArray(hint) ? new THREE.Vector3().fromArray(hint) : hint.clone()).normalize() : VIEW_DIR;
    const box = visibleBounds(s.holder);
    if (!box.isEmpty()) {
      frame(s, box, dir);
      const px = Math.min(1024, Math.round(size * 2));
      const t = targetsFor(s, px);
      renderer.setRenderTarget(t.hdr);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(s.scene, s.camera);

      s.post.material.uniforms.tSrc.value = t.hdr.texture;
      renderer.setRenderTarget(t.ldr);
      renderer.render(s.post.scene, s.post.camera);
      const buf = new Uint8Array(px * px * 4);
      renderer.readRenderTargetPixels(t.ldr, 0, 0, px, px, buf);

      // flip rows into a canvas, then downsample for smooth edges
      const big = document.createElement('canvas');
      big.width = big.height = px;
      const bctx = big.getContext('2d')!;
      const img = bctx.createImageData(px, px);
      const row = px * 4;
      for (let y = 0; y < px; y++) img.data.set(buf.subarray((px - 1 - y) * row, (px - y) * row), y * row);
      bctx.putImageData(img, 0, 0);
      const out = document.createElement('canvas');
      out.width = out.height = size;
      const octx = out.getContext('2d')!;
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(big, 0, 0, size, size);
      url = out.toDataURL('image/png');
    }
  } finally {
    // --- restore object and renderer state ---
    for (const o of hidden) o.visible = true;
    s.holder.remove(object);
    if (parent) {
      parent.add(object);
      const at = parent.children.indexOf(object);
      if (index >= 0 && at !== index) { parent.children.splice(at, 1); parent.children.splice(index, 0, object); }
      object.updateMatrixWorld(true);
    }
    object.visible = visible;
    renderer.setRenderTarget(prev.target, prev.face, prev.mip);
    renderer.setClearColor(prev.clear, prev.alpha);
    renderer.toneMapping = prev.tone;
    renderer.toneMappingExposure = prev.exposure;
    renderer.outputColorSpace = prev.output;
    renderer.autoClear = prev.autoClear;
    renderer.shadowMap.autoUpdate = prev.shadowAuto;
    renderer.shadowMap.needsUpdate = prev.shadowNeeds;
    renderer.xr.enabled = prev.xr;
    if (renderer.getPixelRatio() !== prev.ratio) renderer.setPixelRatio(prev.ratio);
    const sz = renderer.getSize(new THREE.Vector2());
    if (!sz.equals(prev.size)) renderer.setSize(prev.size.x, prev.size.y, false);
    renderer.setViewport(prev.viewport);
    renderer.setScissor(prev.scissor);
    renderer.setScissorTest(prev.scissorTest);
    Object.assign(renderer.info.render, prev.info);
    renderer.info.autoReset = prev.infoReset;
  }
  if (cacheKey && url) cache.set(cacheKey, url);
  return url;
}

/** Forget cached icons (e.g. after changing a prop's look). */
export function clearIconCache(key?: string) {
  if (key === undefined) cache.clear();
  else for (const k of [...cache.keys()]) if (k.startsWith(key + '@')) cache.delete(k);
}
