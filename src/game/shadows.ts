import * as THREE from 'three';
import { budget } from './quality';

// Shadow costs, which every lit pixel pays (every fur shell too):
//
// - three's soft PCF evaluates five disk samples, each with its own sin/cos and
//   sqrt. The disk is fixed and only its rotation varies per pixel, so the same
//   samples come from five constant offsets and one rotation. On the lowest tier a
//   single hardware-filtered tap does.
// - Dogs cast their shadow from a coarse proxy mesh rather than the skin: the
//   proxy is hidden from the camera and only shown while shadow maps are drawn.

/** Shadow-only meshes (see DogModel): visible only while shadow maps render. */
export const shadowCasters = new Set<THREE.Object3D>();

const FIVE_TAPS = `
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				vec2 cs = vec2( cos( phi ), sin( phi ) ) * radius;
				mat2 rot = mat2( cs.x, cs.y, -cs.y, cs.x );
				shadow = (
					texture( shadowMap, vec3( shadowCoord.xy + rot * vec2( 0.316228, 0.0 ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + rot * vec2( -0.403874, 0.369981 ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + rot * vec2( 0.061819, -0.704399 ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + rot * vec2( 0.509056, 0.663974 ), shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + rot * vec2( -0.934181, -0.165244 ), shadowCoord.z ) )
				) * 0.2;
`;

const ONE_TAP = `
				shadow = texture( shadowMap, vec3( shadowCoord.xy, shadowCoord.z ) );
`;

function patchPcf(taps: number) {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  // the 2D (directional / spot) PCF block in three r186
  const start = chunk.indexOf('float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;');
  const end = chunk.indexOf(') * 0.2;', start);
  if (start < 0 || end < 0) return; // a different three.js: leave its shadows alone
  const lineStart = chunk.lastIndexOf('\n', start) + 1;
  const lineEnd = chunk.indexOf('\n', end) + 1;
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.slice(0, lineStart) + (taps > 1 ? FIVE_TAPS : ONE_TAP) + chunk.slice(lineEnd);
}

let patched = false;

export function installShadowTweaks(renderer: THREE.WebGLRenderer) {
  if (!patched) {
    patched = true;
    patchPcf(budget().shadowTaps);
  }
  const sm = renderer.shadowMap as THREE.WebGLShadowMap & { render: (lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera) => void; __tuned?: boolean };
  if (sm.__tuned) return;
  sm.__tuned = true;
  const render = sm.render.bind(sm);
  sm.render = (lights, scene, camera) => {
    // Shadow maps are refreshed on the engine's schedule, but a light that has never had
    // one (a scene being built, an environment capture) must get it now: otherwise its
    // shadow sampler is bound to a placeholder texture and the draw calls fail.
    if (!sm.autoUpdate && !sm.needsUpdate) {
      for (const l of lights) if ((l as THREE.DirectionalLight).shadow?.map == null) { sm.needsUpdate = true; break; }
    }
    if (!shadowCasters.size) { render(lights, scene, camera); return; }
    for (const o of shadowCasters) o.visible = true;
    try {
      render(lights, scene, camera);
    } finally {
      for (const o of shadowCasters) o.visible = false;
    }
  };
}

/** Shadow map size for a light that wanted `size` (smaller on phones). */
export function shadowMapSize(size: number) {
  return Math.min(size, budget().shadowMap);
}
