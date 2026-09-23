// Obedience ring test page: ?test=obedience  (optional &nodog, &dog=x,z,yaw, &cam=x,y,z&target=x,y,z)
import { buildObedienceRing } from '../world/obedience';
import { runPlaceTest } from './room';

export default function (params: URLSearchParams) {
  let at = { x: 0, z: 0 };
  runPlaceTest(
    params,
    (r) => {
      const ring = buildObedienceRing(r);
      at = { x: ring.start.x, z: ring.start.z };
      return ring;
    },
    {
      title: 'obedience ring',
      get dog() {
        return { ...at, yaw: 0 };
      },
    },
  );
}
