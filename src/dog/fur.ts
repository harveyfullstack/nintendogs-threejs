import * as THREE from 'three';

// Shell-textured fur. The base skin is drawn with FUR_SHELL off; the shells are
// one instanced draw where gl_InstanceID selects the shell height. The strand
// pattern is evaluated triplanar in bind space so it sticks to the skin while
// the skeleton animates.

export interface FurUniforms {
  [k: string]: THREE.IUniform;
  uShellCount: { value: number };
  uFurScale: { value: number };
  uDensity: { value: number };
  uComb: { value: number };
  uGravity: { value: THREE.Vector3 };
  uCurl: { value: number };
  uClump: { value: number };
  uWet: { value: number };
  uDirt: { value: number };
  uFluff: { value: number };
  uSoap: { value: number };
  uTime: { value: number };
  uShadowPush: { value: number };
}

export function makeFurUniforms(): FurUniforms {
  return {
    uShellCount: { value: 12 },
    uFurScale: { value: 1 },
    uDensity: { value: 900 },
    uComb: { value: 0.6 },
    uGravity: { value: new THREE.Vector3(0, -0.1, 0) },
    uCurl: { value: 0 },
    uClump: { value: 0 },
    uWet: { value: 0 },
    uDirt: { value: 0 },
    uFluff: { value: 0 },
    uSoap: { value: 0 },
    uTime: { value: 0 },
    uShadowPush: { value: 0.015 },
  };
}

const COMMON = /* glsl */ `
uniform float uShellCount;
uniform float uFurScale;
uniform float uDensity;
uniform float uComb;
uniform vec3 uGravity;
uniform float uCurl;
uniform float uClump;
uniform float uWet;
uniform float uDirt;
uniform float uFluff;
uniform float uSoap;
uniform float uTime;
varying vec3 vRestPos;
varying vec3 vRestNrm;
varying vec4 vFurData;
varying float vShellT;
`;

const VERT_PARS = /* glsl */ `
attribute vec4 furData;
attribute vec3 furDir;
uniform float uShadowPush;
${COMMON}
`;

const VERT_MAIN = /* glsl */ `
#include <skinning_vertex>
#ifdef FUR_SHELL
  float shellT = (float(gl_InstanceID) + 1.0) / uShellCount;
#else
  float shellT = 0.0;
#endif
vShellT = shellT;
vFurData = furData;
vRestPos = position;
vRestNrm = normal;
#ifdef FUR_SHELL
  float furL = furData.x * uFurScale * (1.0 - 0.55 * uWet) * (1.0 + 0.25 * uFluff);
  vec3 fdir = furDir;
  #ifdef USE_SKINNING
    fdir = (skinMatrix * vec4(furDir, 0.0)).xyz;
  #endif
  vec3 sn = normalize(objectNormal);
  vec3 disp = sn * furL * shellT;
  float bend = shellT * shellT;
  disp += (fdir * uComb * (1.0 - 0.5 * uFluff) + uGravity * (1.0 + 3.0 * uWet)) * furL * bend;
  transformed += disp;
#endif
`;

const FRAG_PARS = /* glsl */ `
${COMMON}
vec3 furHash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float furHash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float furNoise3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(furHash13(i + vec3(0,0,0)), furHash13(i + vec3(1,0,0)), f.x),
                 mix(furHash13(i + vec3(0,1,0)), furHash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(furHash13(i + vec3(0,0,1)), furHash13(i + vec3(1,0,1)), f.x),
                 mix(furHash13(i + vec3(0,1,1)), furHash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// returns coverage and writes a per strand tint
float furLayer(vec2 uv, float t, inout float tint) {
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  vec3 h = furHash32(cell);
  vec2 c = 0.22 + 0.56 * h.xy;
  float len = 0.45 + 0.55 * h.z;
  float r = 0.7 * (1.0 - t / len);
  float d = length(f - c);
  float cov = t >= len ? 0.0 : 1.0 - smoothstep(r * 0.55, r, d);
  tint = mix(tint, 0.92 + 0.16 * h.x, cov);
  return cov;
}
float furStrands(vec3 P, vec3 N, float t, inout float tint) {
  vec3 w = pow(abs(N), vec3(4.0));
  w /= (w.x + w.y + w.z);
  float a = 0.0;
  float tt = 1.0;
  if (w.x > 0.05) a += w.x * max(furLayer(P.yz, t, tt), furLayer(P.yz * 1.7 + 11.3, t * 1.25, tt));
  if (w.y > 0.05) a += w.y * max(furLayer(P.zx + 5.7, t, tt), furLayer(P.zx * 1.7 + 3.1, t * 1.25, tt));
  if (w.z > 0.05) a += w.z * max(furLayer(P.xy + 9.2, t, tt), furLayer(P.xy * 1.7 + 7.7, t * 1.25, tt));
  tint = tt;
  return a;
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
float furT = vShellT;
float strandTint = 1.0;
float furLod = 0.0;
// How close-up we are: strand-level shading contrast only when strands span
// several pixels; otherwise every layer shades the same so nothing sparkles.
vec3 furFw = fwidth(vRestPos * uDensity);
float furCpp = max(max(furFw.x, max(furFw.y, furFw.z)), 1e-4);
float furContrast = 1.0 - 0.75 * smoothstep(0.3, 1.2, furCpp);
#ifdef FUR_SHELL
  // shells on very short fur are nearly coplanar and would z-fight into glitter
  if (vFurData.x * uFurScale < 0.0016) discard;
  vec3 fp = vRestPos * uDensity;
  if (uClump > 0.0) {
    vec3 q = vRestPos * uDensity * 0.08;
    fp += (vec3(furNoise3(q), furNoise3(q + 19.1), furNoise3(q + 41.7)) - 0.5) * uClump * 6.0 * furT;
  }
  if (uCurl > 0.0) {
    float a = furT * 14.0 + furHash13(floor(fp)) * 6.28;
    fp += vec3(cos(a), sin(a), cos(a * 0.7)) * uCurl * 0.45 * furT;
  }
  // Mip-style strand LOD: as strands shrink towards a pixel, draw coarser tufts
  // instead (which read as fur rather than glitter), then fade to a smooth coat far away.
  vec3 fwp = fwidth(fp);
  float cellsPerPixel = max(max(fwp.x, max(fwp.y, fwp.z)), 1e-4);
  float level = clamp(log2(cellsPerPixel / 0.3), 0.0, 1.999);
  float l0 = floor(level);
  float lf = smoothstep(0.25, 0.75, fract(level));
  vec3 furN = normalize(vRestNrm);
  float tint0 = 1.0, tint1 = 1.0;
  float c0 = furStrands(fp * exp2(-l0), furN, furT, tint0);
  float c1 = furStrands(fp * exp2(-l0 - 1.0), furN, furT, tint1);
  float cov = mix(c0, c1, lf);
  strandTint = mix(tint0, tint1, lf);
  float lod = smoothstep(1.6, 2.6, log2(cellsPerPixel / 0.3));
  furLod = lod;
  float expected = clamp(1.05 - furT * 1.15, 0.0, 1.0);
  cov = mix(cov, expected, lod);
  strandTint = mix(1.0, mix(strandTint, 1.0, lod), furContrast);
  diffuseColor.a = cov;
#endif
float furAO = vFurData.z;
float rootShade = mix(1.0, mix(0.8, 1.0, pow(furT, 0.7)), furContrast);
diffuseColor.rgb *= mix(1.0, rootShade, step(0.0004, vFurData.x));
diffuseColor.rgb *= strandTint * furAO;
diffuseColor.rgb *= mix(1.0, 0.62, uWet * step(0.0004, vFurData.x));
if (uDirt > 0.0) {
  float dn = furNoise3(vRestPos * 55.0) * 0.6 + furNoise3(vRestPos * 140.0) * 0.4;
  float low = clamp(1.2 - vRestPos.y * 4.0, 0.2, 1.0);
  float dm = smoothstep(0.55, 0.75, dn + uDirt * 0.45 * low) * uDirt;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.19, 0.14, 0.09), dm * 0.8);
}
if (uSoap > 0.0) {
  float sn = furNoise3(vRestPos * 90.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.96, 1.0), smoothstep(0.35, 0.6, sn) * uSoap * 0.7);
}
`;

const FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.22, vFurData.y);
roughnessFactor = mix(roughnessFactor, 0.4, uWet * 0.7);
`;

export function makeFurMaterial(uniforms: FurUniforms, shell: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.0,
    alphaTest: shell ? 0.5 : 0,
  });
  if (shell) {
    mat.alphaToCoverage = true;
    mat.defines = { FUR_SHELL: '' };
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <skinning_vertex>', VERT_MAIN)
      // look shadows up a little outside the coat so shells don't self-shadow into speckles
      .replace('#include <shadowmap_vertex>', `
        vec4 furWorldPos = worldPosition;
        worldPosition.xyz += normalize(transformNormalByInverseViewMatrix(transformedNormal, viewMatrix)) * uShadowPush;
        #include <shadowmap_vertex>
        worldPosition = furWorldPos;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH);
  };
  mat.customProgramCacheKey = () => (shell ? 'fur-shell-v1' : 'fur-base-v1');
  return mat;
}

/** Depth material for the base mesh so shadows use the skinned skin. */
export function makeFurDepthMaterial(): THREE.MeshDepthMaterial {
  return new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
}
