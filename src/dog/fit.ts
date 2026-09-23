import * as THREE from 'three';
import type { AccessoryFit } from '../world/types';
import type { DogModel } from './dogModel';

/** Measurements for fitting collars, hats and glasses onto a generated dog. */
export function accessoryFit(model: DogModel): AccessoryFit {
  const d = model.design.dims;
  const s = model.breed.shape;
  const neckBase = model.boneWorldRest('neck');
  const head = model.boneWorldRest('head');
  const t = 0.42;
  const center = neckBase.clone().lerp(head, t);
  const axis = head.clone().sub(neckBase).normalize();
  const r0 = 0.066 * d.g * s.neckT, r1 = 0.047 * d.hs * s.neckT;
  const neckRadius = r0 + (r1 - r0) * t + model.breed.fur.len * 0.6;
  const eyes = model.design.eyes.pos;
  const eyeCenter = new THREE.Vector3((eyes[0][0] + eyes[1][0]) / 2, (eyes[0][1] + eyes[1][1]) / 2 + d.eyeR * 0.2, Math.max(eyes[0][2], eyes[1][2]) + d.eyeR * 0.9);
  return {
    neckRadius,
    collarCenter: center.sub(neckBase),
    neckAxis: axis,
    headScale: d.hs,
    headTop: new THREE.Vector3(0, d.headTop + model.breed.fur.len * 0.5, head.z + 0.03 * d.hs).sub(head),
    eyeCenter: eyeCenter.sub(head),
    eyeSpacing: Math.abs(eyes[0][0] - eyes[1][0]),
  };
}
