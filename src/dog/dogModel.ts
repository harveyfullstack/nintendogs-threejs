import * as THREE from 'three';
import { physicalMaterial } from '../world/materials';
import { live } from '../game/quality';
import { shadowCasters } from '../game/shadows';
import type { Breed, CoatDef } from './breeds';
import { designDog, DogDesign } from './design';
import { FurUniforms, makeFurMaterial, makeFurUniforms } from './fur';
import { buildDogMesh, type DogMeshData } from './meshData';
import type { V3 } from './sdf';

export interface EyeRig {
  pivot: THREE.Object3D; // oriented to rest gaze, child of head bone
  ball: THREE.Mesh;
  lidUpper: THREE.Object3D;
  lidLower: THREE.Object3D;
  restDir: THREE.Vector3;
}

export interface ContactPoint {
  bone: THREE.Bone;
  local: THREE.Vector3;
  name: string;
}

export interface DogModelOptions {
  quality?: number; // 0.5 .. 1.5 scales shell count and mesh density
  /** the skin mesh, if it was already built (e.g. in a worker) */
  mesh?: DogMeshData;
}

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

/** Fewest fur shells drawn, however small the dog is on screen. */
const MIN_SHELLS = 4;
/** Screen-space error (pixels) allowed for the skin and for the fur shells when picking a level of detail. */
const SKIN_ERROR_PX = 0.5;
const SHELL_ERROR_PX = 1;

export class DogModel {
  readonly root = new THREE.Group();
  readonly bones: Record<string, THREE.Bone> = {};
  readonly restPos: Record<string, THREE.Vector3> = {};
  skeleton!: THREE.Skeleton;
  /** the skin: bare-skin shading under the coat */
  base!: THREE.SkinnedMesh;
  /** the coat: one instanced draw, one instance per shell */
  fur!: THREE.SkinnedMesh;
  /** casts the dog's shadow (coarse, only drawn into shadow maps) */
  shadow!: THREE.SkinnedMesh;
  readonly uniforms: FurUniforms;
  readonly eyes: EyeRig[] = [];
  tongue!: THREE.Mesh;
  tongueRest = new THREE.Vector3();
  readonly contacts: ContactPoint[] = [];
  readonly design: DogDesign;
  readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];
  buildMs = 0;

  constructor(readonly breed: Breed, readonly coat: CoatDef, opts: DogModelOptions = {}) {
    const t0 = performance.now();
    const q = opts.quality ?? 1;
    this.design = designDog(breed);
    this.uniforms = makeFurUniforms();
    this.buildSkeleton();
    this.buildSkin(opts.mesh ?? buildDogMesh(breed, coat, { quality: q }, this.design), q);
    this.buildEyes();
    this.buildTongue();
    for (const c of this.design.contacts) {
      const b = this.bones[c.bone];
      const wp = this.boneWorldRest(c.bone);
      this.contacts.push({ bone: b, local: new THREE.Vector3(c.pos[0] - wp.x, c.pos[1] - wp.y, c.pos[2] - wp.z), name: c.name });
    }
    this.buildMs = performance.now() - t0;
  }

  /** bind-space position of a bone */
  boneWorldRest(name: string): THREE.Vector3 {
    const def = this.design.bones.find((b) => b.name === name)!;
    return new THREE.Vector3(...def.pos);
  }

  private buildSkeleton() {
    for (const def of this.design.bones) {
      const b = new THREE.Bone();
      b.name = def.name;
      this.bones[def.name] = b;
    }
    for (const def of this.design.bones) {
      const b = this.bones[def.name];
      if (def.parent) {
        const p = this.design.bones.find((x) => x.name === def.parent)!;
        b.position.set(def.pos[0] - p.pos[0], def.pos[1] - p.pos[1], def.pos[2] - p.pos[2]);
        this.bones[def.parent].add(b);
      } else {
        b.position.set(def.pos[0], def.pos[1], def.pos[2]);
        this.root.add(b);
      }
      this.restPos[def.name] = b.position.clone();
    }
    this.root.updateMatrixWorld(true);
    const list = this.design.bones.map((d) => this.bones[d.name]);
    this.skeleton = new THREE.Skeleton(list);
  }

  private buildSkin(mesh: DogMeshData, quality: number) {
    const d = this.design;
    this.lidColors = mesh.lidColors.map(([r, g, b]) => new THREE.Color(r, g, b));

    // one set of vertex buffers, shared by every level of detail
    const attrs: Record<string, THREE.BufferAttribute> = {
      position: new THREE.BufferAttribute(mesh.position, 3),
      normal: new THREE.BufferAttribute(mesh.normal, 3),
      color: new THREE.BufferAttribute(mesh.color, 3),
      skinIndex: new THREE.BufferAttribute(mesh.skinIndex, 4),
      skinWeight: new THREE.BufferAttribute(mesh.skinWeight, 4),
      furData: new THREE.BufferAttribute(mesh.furData, 4),
      furDir: new THREE.BufferAttribute(mesh.furDir, 3),
    };
    const sphere = new THREE.Box3().setFromBufferAttribute(attrs.position).getBoundingSphere(new THREE.Sphere());
    this.lodError = mesh.lodError;
    const indices = mesh.lods.map((ix) => new THREE.BufferAttribute(ix, 1));
    this.skinLods = indices.map((index) => {
      const g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
      g.setIndex(index);
      g.boundingSphere = sphere.clone();
      return g;
    });
    // shells never use the finest level: the coat hides the difference
    this.shellLods = indices.map((index, i) => {
      if (i === 0) return null;
      const g = new THREE.InstancedBufferGeometry();
      for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
      g.setIndex(index);
      g.boundingSphere = sphere.clone();
      return g;
    });
    this.geometry = this.skinLods[0];
    this.vertexCount = mesh.position.length / 3;
    this.triangleCount = mesh.lods[0].length / 3;

    const fur = this.breed.fur;
    const u = this.uniforms;
    const shells = Math.max(MIN_SHELLS, Math.round(fur.shells * Math.min(1.3, quality)));
    this.maxShells = shells;
    this.shellCount = shells;
    u.uShellCount.value = shells;
    u.uDensity.value = fur.density;
    u.uComb.value = fur.comb;
    u.uCurl.value = fur.curl;
    u.uClump.value = fur.clump;
    u.uShadowPush.value = 0.008 + fur.len * 1.2 + 0.008 * Math.max(0.5, d.dims.g);
    this.gravity = fur.gravity;

    const baseMat = makeFurMaterial(u, false);
    const shellMat = makeFurMaterial(u, true);
    this.materials.push(baseMat, shellMat);

    this.base = new THREE.SkinnedMesh(this.skinLods[0], baseMat);
    this.base.castShadow = false;
    this.base.receiveShadow = true;
    this.base.frustumCulled = false;

    const shellGeo = this.shellLods[1]!;
    shellGeo.instanceCount = shells;
    this.fur = new THREE.SkinnedMesh(shellGeo as unknown as THREE.BufferGeometry, shellMat);
    this.fur.receiveShadow = true;
    this.fur.castShadow = false;
    this.fur.frustumCulled = false;
    this.fur.renderOrder = 1;
    // pick the shell count (and next frame's levels of detail) for the camera actually drawing
    this.fur.onBeforeRender = (renderer, _scene, camera) => this.chooseDetail(renderer, camera);

    // the shadow comes from the coarsest level, drawn only into shadow maps
    const shadowMat = new THREE.MeshBasicMaterial();
    this.materials.push(shadowMat);
    this.shadow = new THREE.SkinnedMesh(this.skinLods[this.skinLods.length - 1], shadowMat);
    this.shadow.castShadow = true;
    this.shadow.receiveShadow = false;
    this.shadow.frustumCulled = false;
    this.shadow.visible = false;
    shadowCasters.add(this.shadow);

    this.root.add(this.base, this.fur, this.shadow);
    this.root.updateMatrixWorld(true);
    this.base.bind(this.skeleton, this.base.matrixWorld);
    this.fur.bind(this.skeleton, this.fur.matrixWorld);
    this.shadow.bind(this.skeleton, this.shadow.matrixWorld);
  }

  // ---------- level of detail ----------------------------------------------

  private skinLods: THREE.BufferGeometry[] = [];
  private shellLods: (THREE.InstancedBufferGeometry | null)[] = [];
  private lodError: number[] = [];
  /** shells for the breed at this quality, up close */
  maxShells = 12;
  /** shells drawn this frame */
  shellCount = 12;
  private shellTarget = -1;
  private wantSkin = 0;
  private wantShell = 1;

  /**
   * Runs right before the coat is drawn, with the camera drawing it: how many
   * pixels a millimetre covers decides the shell count (about one shell per pixel of
   * coat depth) and which mesh detail stays under a pixel of error.
   */
  private chooseDetail(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera) return;
    const rt = renderer.getRenderTarget();
    const heightPx = rt ? rt.height : renderer.domElement.height;
    tmpV.setFromMatrixPosition(this.bones.body.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
    const depth = Math.max(0.05, -tmpV.z);
    const pxPerM = (heightPx / 2) * cam.projectionMatrix.elements[5] / depth;
    // shells: enough that neighbouring layers are about a pixel apart
    const u = this.uniforms;
    const furPx = this.breed.fur.len * 1.4 * u.uFurScale.value * (1 + 0.25 * u.uFluff.value) * pxPerM;
    const want = Math.min(this.maxShells, Math.max(MIN_SHELLS, Math.round((Math.ceil(furPx * 1.1) + 2) * live.fur)));
    // a little hysteresis so a slowly moving camera doesn't flicker between counts
    if (this.shellTarget < 0 || Math.abs(want - this.shellTarget) >= 2 || (want > this.shellTarget && want === this.maxShells)) this.shellTarget = want;
    this.setShells(this.shellTarget);
    // levels of detail for the next frame (swapping geometry mid-draw isn't allowed)
    const e = this.lodError;
    let skin = 0;
    for (let i = e.length - 1; i > 0; i--) if (e[i] * pxPerM <= SKIN_ERROR_PX) { skin = i; break; }
    this.wantSkin = skin;
    this.wantShell = e.length > 2 && e[2] * pxPerM <= SHELL_ERROR_PX ? 2 : 1;
  }

  private setShells(n: number) {
    if (n === this.shellCount) return;
    this.shellCount = n;
    this.uniforms.uShellCount.value = n;
    for (const g of this.shellLods) if (g) g.instanceCount = n;
  }

  /** Apply the detail chosen while drawing the last frame (call once per frame, before drawing). */
  updateDetail() {
    const skin = this.skinLods[Math.min(this.wantSkin, this.skinLods.length - 1)];
    if (this.base.geometry !== skin) this.base.geometry = skin;
    const shell = this.shellLods[Math.min(this.wantShell, this.shellLods.length - 1)];
    if (shell && this.fur.geometry !== (shell as unknown as THREE.BufferGeometry)) this.fur.geometry = shell as unknown as THREE.BufferGeometry;
  }

  geometry!: THREE.BufferGeometry;
  vertexCount = 0;
  triangleCount = 0;
  gravity = 0.1;
  lidColors: THREE.Color[] = [];

  private buildEyes() {
    const d = this.design;
    const tex = makeEyeTexture(this.coat.eye);
    this.textures.push(tex);
    const mat = physicalMaterial({
      map: tex, roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4,
    });
    this.materials.push(mat);
    const r = d.eyes.r;
    const geo = new THREE.SphereGeometry(r, 24, 16);
    this.geometries.push(geo);
    geo.rotateX(Math.PI / 2);
    const head = this.bones.head;
    const headPos = this.boneWorldRest('head');
    for (let i = 0; i < 2; i++) {
      const p = d.eyes.pos[i];
      const dir = new THREE.Vector3(...d.eyes.dir[i]);
      const pivot = new THREE.Object3D();
      pivot.position.set(p[0] - headPos.x, p[1] - headPos.y, p[2] - headPos.z);
      pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      head.add(pivot);
      const ball = new THREE.Mesh(geo, mat);
      pivot.add(ball);

      const lidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
      this.materials.push(lidMat);
      const upper = new THREE.Object3D();
      const lower = new THREE.Object3D();
      const lidUp = makeLidGeometry(r * 1.07, true, this.lidColors[i]);
      const lidLow = makeLidGeometry(r * 1.06, false, this.lidColors[i]);
      this.geometries.push(lidUp, lidLow);
      upper.add(new THREE.Mesh(lidUp, lidMat));
      lower.add(new THREE.Mesh(lidLow, lidMat));
      pivot.add(upper, lower);
      this.eyes.push({ pivot, ball, lidUpper: upper, lidLower: lower, restDir: dir });
    }
    this.setLids(0, 0);
  }

  /** 0 = open, 1 = closed. squint raises the lower lid (happy face). */
  setLids(close: number, squint: number) {
    for (const e of this.eyes) {
      e.lidUpper.rotation.x = THREE.MathUtils.lerp(-0.95, 0.22, close);
      e.lidLower.rotation.x = THREE.MathUtils.lerp(1.15, 0.05, Math.max(close * 0.6, squint));
    }
  }

  private buildTongue() {
    const d = this.design;
    const geo = new THREE.SphereGeometry(1, 20, 12);
    this.geometries.push(geo);
    // flatten underside and add a centre groove
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i);
      const z = p.getZ(i);
      if (y > 0) y *= 1 - 0.5 * Math.exp(-(x * x) / 0.02);
      if (y < 0) y *= 0.6;
      p.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();
    geo.scale(d.tongue.r[0], d.tongue.r[1], d.tongue.r[2]);
    const mat = physicalMaterial({ color: 0xd9616f, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    this.materials.push(mat);
    this.tongue = new THREE.Mesh(geo, mat);
    const jp = this.boneWorldRest('jaw');
    this.tongue.position.set(d.tongue.pos[0] - jp.x, d.tongue.pos[1] - jp.y, d.tongue.pos[2] - jp.z);
    this.tongueRest.copy(this.tongue.position);
    this.bones.jaw.add(this.tongue);
  }

  /** Lowest y (in the dog group's space) over contact points, optionally filtered by name. */
  lowestContact(names?: string[]): number {
    let m = Infinity;
    this.root.updateMatrixWorld(true);
    const inv = tmpM.copy(this.root.matrixWorld).invert();
    for (const c of this.contacts) {
      if (names && !names.includes(c.name)) continue;
      tmpV.copy(c.local).applyMatrix4(c.bone.matrixWorld).applyMatrix4(inv);
      if (tmpV.y < m) m = tmpV.y;
    }
    return m;
  }

  dispose() {
    shadowCasters.delete(this.shadow);
    for (const g of this.skinLods) g.dispose();
    for (const g of this.shellLods) g?.dispose();
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.skeleton.dispose();
  }
}

function makeLidGeometry(r: number, upper: boolean, coat: THREE.Color): THREE.BufferGeometry {
  const geo = upper
    ? new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2)
    : new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const rim = new THREE.Color('#1c1412');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = Math.abs(p.getY(i)) / r;
    c.copy(rim).lerp(coat, Math.min(1, Math.max(0, (y - 0.08) / 0.2)));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

export function makeEyeTexture(iris: string): THREE.CanvasTexture {
  const W = 256, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const ic = new THREE.Color(iris);
  // work in sRGB bytes
  const ir = Math.round(Math.pow(ic.r, 1 / 2.2) * 255), ig = Math.round(Math.pow(ic.g, 1 / 2.2) * 255), ib = Math.round(Math.pow(ic.b, 1 / 2.2) * 255);
  const pupil = 0.4, irisEdge = 0.86;
  for (let y = 0; y < H; y++) {
    const th = ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const ang = (x / W) * Math.PI * 2;
      let r = 0, g = 0, b = 0;
      if (th < pupil) {
        r = g = b = 6;
      } else if (th < irisEdge) {
        const f = (th - pupil) / (irisEdge - pupil);
        const streak = 0.75 + 0.25 * Math.sin(ang * 37 + Math.sin(ang * 11) * 2) * Math.sin(ang * 13 + 1.3);
        const ring = 1.15 - 0.45 * Math.pow(f, 2.2);
        const k = streak * ring;
        r = ir * k; g = ig * k; b = ib * k;
        if (f < 0.12) { const t = f / 0.12; r *= t; g *= t; b *= t; }
      } else {
        const f = Math.min(1, (th - irisEdge) / 0.25);
        r = 28 + 60 * f; g = 20 + 45 * f; b = 18 + 38 * f;
      }
      const o = (y * W + x) * 4;
      img.data[o] = Math.min(255, r); img.data[o + 1] = Math.min(255, g); img.data[o + 2] = Math.min(255, b); img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export type { V3 };
