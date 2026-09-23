// Bathroom test page: ?test=bathroom  (optional &nodog, &dog=x,z,yaw, &cam=x,y,z&target=x,y,z)
import { buildBathroom } from '../world/bathroom';
import { runPlaceTest } from './room';

export default function (params: URLSearchParams) {
  let center = { x: 0, y: 0, z: 0 };
  runPlaceTest(
    params,
    (r) => {
      const bath = buildBathroom(r);
      center = { x: bath.tubCenter.x, y: bath.tubCenter.y, z: bath.tubCenter.z };
      return bath;
    },
    {
      title: 'bathroom',
      get dog() {
        return { x: center.x, y: center.y, z: center.z, yaw: 0.5 };
      },
    },
  );
}
