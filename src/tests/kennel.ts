// Kennel test page: ?test=kennel  (optional &nodog, &dog=x,z,yaw, &cam=x,y,z&target=x,y,z)
import { buildKennel } from '../world/kennel';
import { runPlaceTest } from './room';

export default function (params: URLSearchParams) {
  let at = { x: 0, y: 0, z: 0 };
  runPlaceTest(
    params,
    (r) => {
      const k = buildKennel(r);
      at = { x: k.penCenter.x + 0.2, y: k.penCenter.y, z: k.penCenter.z + 0.2 };
      return k;
    },
    {
      title: 'kennel (pen 2.4 x 1.6 m)',
      get dog() {
        return { ...at, yaw: 0.4 };
      },
    },
  );
}
