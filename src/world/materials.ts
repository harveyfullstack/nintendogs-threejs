import * as THREE from 'three';
import { budget } from '../game/quality';

// MeshPhysicalMaterial (clearcoat, sheen, iridescence) is the most expensive shader
// three.js has, and each combination of features compiles its own program: a
// visible hitch on a phone the first time a prop appears. Below the top tier those
// props use the standard material with the same colour, roughness and maps instead.

const PHYSICAL_ONLY = new Set([
  'clearcoat', 'clearcoatMap', 'clearcoatRoughness', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'clearcoatNormalScale',
  'sheen', 'sheenColor', 'sheenColorMap', 'sheenRoughness', 'sheenRoughnessMap',
  'iridescence', 'iridescenceMap', 'iridescenceIOR', 'iridescenceThicknessRange', 'iridescenceThicknessMap',
  'transmission', 'transmissionMap', 'thickness', 'thicknessMap', 'attenuationDistance', 'attenuationColor',
  'specularIntensity', 'specularIntensityMap', 'specularColor', 'specularColorMap', 'ior', 'reflectivity',
  'anisotropy', 'anisotropyRotation', 'anisotropyMap', 'dispersion',
]);

/**
 * A physical material on devices that can afford it, otherwise the standard one.
 * Typed as physical so callers stay simple (setting a physical-only property on the
 * fallback just does nothing).
 */
export function physicalMaterial(o: THREE.MeshPhysicalMaterialParameters = {}): THREE.MeshPhysicalMaterial {
  if (budget().physical) return new THREE.MeshPhysicalMaterial(o);
  const std: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!PHYSICAL_ONLY.has(k)) std[k] = v;
  // a clear coat reads as a sharper highlight: keep a hint of it
  if (o.clearcoat && typeof std.roughness === 'number') std.roughness = Math.max(0.05, (std.roughness as number) * (1 - 0.2 * o.clearcoat));
  return new THREE.MeshStandardMaterial(std as THREE.MeshStandardMaterialParameters) as unknown as THREE.MeshPhysicalMaterial;
}
