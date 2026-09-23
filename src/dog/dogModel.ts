import * as THREE from 'three';
import type { Breed, CoatDef } from './breeds';
import { designDog, DogDesign } from './design';
import { FurUniforms, makeFurMaterial, makeFurUniforms } from './fur';
import { paintVertex } from './patterns';
import { Prim, V3, evalField, sampleGrid } from './sdf';
import { surfaceNets } from './surfaceNets';

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
}

interface Component {
  prims: Prim[];
  voxel: number;
  name: string;
}

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

export class DogModel {
  readonly root = new THREE.Group();
  readonly bones: Record<string, THREE.Bone> = {};
  readonly restPos: Record<string, THREE.Vector3> = {};
  skeleton!: THREE.Skeleton;
  base!: THREE.SkinnedMesh;
  fur!: THREE.SkinnedMesh;
  readonly uniforms: FurUniforms;
  readonly eyes: EyeRig[] = [];
  tongue!: THREE.Mesh;
  tongueRest = new THREE.Vector3();
  readonly contacts: ContactPoint[] = [];
  readonly design: DogDesign;
  readonly materials: THREE.Material[] = [];
  buildMs = 0;

  constructor(readonly breed: Breed, readonly coat: CoatDef, opts: DogModelOptions = {}) {
    const t0 = performance.now();
    const q = opts.quality ?? 1;
    this.design = designDog(breed);
    this.uniforms = makeFurUniforms();
    this.buildSkeleton();
    this.buildSkin(q);
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

  private buildSkin(quality: number) {
    const d = this.design;
    const vox = d.dims.voxel / Math.sqrt(quality);
    const earVox = Math.min(vox * 0.55, this.breed.shape.ear.T * d.dims.hs * 0.34);
    const comps: Component[] = [
      { prims: d.body, voxel: vox, name: 'body' },
      { prims: d.jaw, voxel: vox * 0.6, name: 'jaw' },
      { prims: d.ears[0], voxel: earVox, name: 'earL' },
      { prims: d.ears[1], voxel: earVox, name: 'earR' },
    ];
    const allPrims = [d.body, d.jaw];
    const aoField = (x: number, y: number, z: number) => {
      let m = 1e3;
      for (const p of allPrims) m = Math.min(m, evalField(p, x, y, z));
      return m;
    };

    const boneIndex: Record<string, number> = {};
    d.bones.forEach((b, i) => (boneIndex[b.name] = i));

    const pos: number[] = [], nrm: number[] = [], col: number[] = [], skI: number[] = [], skW: number[] = [];
    const furData: number[] = [], furDir: number[] = [], idx: number[] = [];
    const tailPts = [0, 1, 2, 3, 4].map((i) => d.bones.find((b) => b.name === 'tail' + i)!.pos).concat([d.dims.tailTip]);
    const furLen = this.breed.fur.len;
    const eyeInfo = d.eyes;
    const A = d.dims.atlas;
    const hs = d.dims.hs;
    const aoStep = 0.005 * Math.max(0.5, d.dims.g);

    // lid colour sampling
    const lidAcc = [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)];
    const lidCnt = [0, 0];

    for (const comp of comps) {
      const grid = sampleGrid(comp.prims, comp.voxel);
      const raw = surfaceNets(grid, comp.prims, 3);
      const base = pos.length / 3;
      const vcount = raw.positions.length / 3;
      const weighed = comp.prims.filter((p) => p.weigh);
      const dists = new Float64Array(weighed.length);
      const sigma = comp.name === 'body' ? 0.009 * Math.max(0.55, d.dims.g) : 0.004 * hs;
      const tagSigma = 0.0028 * hs;
      for (let v = 0; v < vcount; v++) {
        const x = raw.positions[v * 3], y = raw.positions[v * 3 + 1], z = raw.positions[v * 3 + 2];
        const nx = raw.normals[v * 3], ny = raw.normals[v * 3 + 1], nz = raw.normals[v * 3 + 2];
        // influences
        let dmin = Infinity;
        for (let i = 0; i < weighed.length; i++) {
          const p = weighed[i];
          const m = p.k + sigma * 6;
          if (x < p.min[0] - m || y < p.min[1] - m || z < p.min[2] - m || x > p.max[0] + m || y > p.max[1] + m || z > p.max[2] + m) {
            dists[i] = Infinity;
            continue;
          }
          const dd = p.d(x, y, z);
          dists[i] = dd;
          if (dd < dmin) dmin = dd;
        }
        const bw: Record<string, number> = {};
        const tags: Record<string, number> = {};
        let fx = 0, fy = 0, fz = 0, wsum = 0, tsum = 0;
        for (let i = 0; i < weighed.length; i++) {
          if (dists[i] === Infinity) continue;
          const p = weighed[i];
          const tw = Math.exp(-(dists[i] - dmin) / tagSigma);
          if (tw > 0.01) { tags[p.tag] = (tags[p.tag] || 0) + tw; tsum += tw; }
          const w = Math.exp(-(dists[i] - dmin) / sigma);
          if (w < 0.01) continue;
          wsum += w;
          const f = typeof p.flow === 'function' ? p.flow(x, y, z) : p.flow;
          fx += f[0] * w; fy += f[1] * w; fz += f[2] * w;
          if (typeof p.bone === 'string') bw[p.bone] = (bw[p.bone] || 0) + w;
          else {
            const list = typeof p.bone === 'function' ? p.bone(x, y, z) : p.bone;
            for (const [bn, bwv] of list) if (bwv > 0) bw[bn] = (bw[bn] || 0) + w * bwv;
          }
        }
        for (const k in tags) tags[k] /= tsum || 1;
        // top 4 bones
        const sorted = Object.entries(bw).sort((a, b) => b[1] - a[1]).slice(0, 4);
        let tot = 0;
        for (const [, w] of sorted) tot += w;
        for (let i = 0; i < 4; i++) {
          const e = sorted[i];
          skI.push(e ? boneIndex[e[0]] : 0);
          skW.push(e ? e[1] / tot : 0);
        }
        // hair direction projected onto the tangent plane
        const dn = fx * nx + fy * ny + fz * nz;
        let tx = fx - nx * dn, ty = fy - ny * dn, tz = fz - nz * dn;
        let tl = Math.hypot(tx, ty, tz);
        if (tl < 1e-4) { tx = 0; ty = -1; tz = 0; const d2 = -ny; tx -= nx * d2; ty -= ny * d2; tz -= nz * d2; tl = Math.hypot(tx, ty, tz) || 1; }
        furDir.push(tx / tl, ty / tl, tz / tl);

        // ambient occlusion from the sculpt
        let occ = 0;
        for (let i = 1; i <= 5; i++) {
          const dist = aoStep * i;
          const f = aoField(x + nx * dist, y + ny * dist, z + nz * dist);
          occ += Math.max(0, dist - f) / dist / (1 << (i - 1));
        }
        const ao = Math.min(1, Math.max(0.45, 1 - occ * 0.5));

        // eye distance
        let eyeD = Infinity;
        for (const e of eyeInfo.pos) eyeD = Math.min(eyeD, Math.hypot(x - e[0], y - e[1], z - e[2]) / eyeInfo.r);
        // tail fraction
        let tailF = 0;
        if (tags.tail) {
          let best = Infinity;
          for (let i = 0; i < 5; i++) {
            const a = tailPts[i], b = tailPts[i + 1];
            const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
            const l2 = abx * abx + aby * aby + abz * abz;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / l2));
            const dd = Math.hypot(x - a[0] - abx * t, y - a[1] - aby * t, z - a[2] - abz * t);
            if (dd < best) { best = dd; tailF = (i + t) / 5; }
          }
        }
        const paint = paintVertex({
          p: [x, y, z], n: [nx, ny, nz], tags, design: d,
          hx: (x - A[0]) / hs, hy: (y - A[1]) / hs, hz: (z - A[2]) / hs,
          u: (z - d.dims.hipZ) / (d.dims.shZ - d.dims.hipZ), eyeD, tailF,
        }, this.coat, d.furRegions);

        if (comp.name === 'body' && eyeD > 1.5 && eyeD < 2.6) {
          for (let e = 0; e < 2; e++) {
            const ep = eyeInfo.pos[e];
            if (Math.hypot(x - ep[0], y - ep[1], z - ep[2]) / eyeInfo.r < 2.6 && y > ep[1]) {
              lidAcc[e].r += paint.color.r; lidAcc[e].g += paint.color.g; lidAcc[e].b += paint.color.b; lidCnt[e]++;
            }
          }
        }

        let furMul = paint.fur;
        if (comp.name === 'earL' || comp.name === 'earR') {
          // thin the coat towards the rim of the ear leather so shells don't stair-step
          const en = d.earNormals[comp.name === 'earL' ? 0 : 1];
          const k = Math.abs(nx * en[0] + ny * en[1] + nz * en[2]);
          furMul *= 0.15 + 0.85 * Math.min(1, Math.max(0, (k - 0.25) / 0.5));
        }
        pos.push(x, y, z);
        nrm.push(nx, ny, nz);
        col.push(paint.color.r, paint.color.g, paint.color.b);
        furData.push(furLen * furMul, paint.gloss, ao, 0);
      }
      for (let i = 0; i < raw.indices.length; i++) idx.push(raw.indices[i] + base);
    }
    this.lidColors = lidAcc.map((c, i) => (lidCnt[i] ? c.multiplyScalar(1 / lidCnt[i]) : new THREE.Color(0.3, 0.2, 0.1)));

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skI, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skW, 4));
    geo.setAttribute('furData', new THREE.Float32BufferAttribute(furData, 4));
    geo.setAttribute('furDir', new THREE.Float32BufferAttribute(furDir, 3));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.vertexCount = pos.length / 3;
    this.triangleCount = idx.length / 3;

    const fur = this.breed.fur;
    const u = this.uniforms;
    const shells = Math.max(4, Math.round(fur.shells * Math.min(1.3, quality)));
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

    this.base = new THREE.SkinnedMesh(geo, baseMat);
    this.base.castShadow = true;
    this.base.receiveShadow = true;
    this.base.frustumCulled = false;

    const ig = new THREE.InstancedBufferGeometry();
    ig.index = geo.index;
    for (const [k, a] of Object.entries(geo.attributes)) ig.setAttribute(k, a);
    ig.instanceCount = shells;
    ig.boundingSphere = geo.boundingSphere!.clone();
    this.fur = new THREE.SkinnedMesh(ig as unknown as THREE.BufferGeometry, shellMat);
    this.fur.receiveShadow = true;
    this.fur.castShadow = false;
    this.fur.frustumCulled = false;
    this.fur.renderOrder = 1;

    this.root.add(this.base, this.fur);
    this.root.updateMatrixWorld(true);
    this.base.bind(this.skeleton, this.base.matrixWorld);
    this.fur.bind(this.skeleton, this.fur.matrixWorld);
    this.geometry = geo;
  }

  geometry!: THREE.BufferGeometry;
  vertexCount = 0;
  triangleCount = 0;
  gravity = 0.1;
  lidColors: THREE.Color[] = [];

  private buildEyes() {
    const d = this.design;
    const tex = makeEyeTexture(this.coat.eye);
    const mat = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4,
    });
    this.materials.push(mat);
    const r = d.eyes.r;
    const geo = new THREE.SphereGeometry(r, 36, 24);
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
      upper.add(new THREE.Mesh(makeLidGeometry(r * 1.07, true, this.lidColors[i]), lidMat));
      lower.add(new THREE.Mesh(makeLidGeometry(r * 1.06, false, this.lidColors[i]), lidMat));
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
    const geo = new THREE.SphereGeometry(1, 28, 16);
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
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xd9616f, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.2 });
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
    this.geometry.dispose();
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
