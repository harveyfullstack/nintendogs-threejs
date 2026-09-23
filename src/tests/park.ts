// Park test page: ?test=park. Buttons move the camera; "Run" sends the puppy around the lawn.
import * as THREE from 'three';
import { buildPark } from '../world/park';
import { runOutdoorTest, type TestCtx } from './town';

export default function (params: URLSearchParams) {
  let running = params.has('run');
  let angle = 0;
  const follow = (c: TestCtx, dt: number) => {
    const d = c.dog.root;
    const f = new THREE.Vector3(Math.sin(d.rotation.y), 0, Math.cos(d.rotation.y));
    const want = d.position.clone().addScaledVector(f, -2.6).setY(0.9);
    c.camera.position.lerp(want, Math.min(1, dt * 3));
    c.controls.target.lerp(d.position.clone().addScaledVector(f, 1.5).setY(0.25), Math.min(1, dt * 3));
  };
  const view = (c: TestCtx, pos: [number, number, number], target: [number, number, number], dog?: [number, number, number]) => {
    running = false;
    c.rig.speed = 0;
    if (dog) c.setDog(new THREE.Vector3(dog[0], 0, dog[1]), dog[2]);
    c.setView(new THREE.Vector3(...pos), new THREE.Vector3(...target));
  };
  runOutdoorTest(params, {
    title: 'Park',
    build: (r) => buildPark(r),
    dog: new THREE.Vector3(0, 0, 0),
    dogYaw: 0.4,
    buttons: [
      { label: 'Run around', action: () => { running = true; } },
      { label: 'Dog view', action: (c) => view(c, [2.2, 0.9, 4.2], [0, 0.25, 0], [0, 0, 0.4]) },
      { label: 'Lawn', action: (c) => view(c, [-6, 2.2, 14], [0, 0.4, 0], [0, 0, 0.4]) },
      { label: 'Pond', action: (c) => view(c, [12, 1.6, -12], [25, 0, -25], [15, -14, 2.4]) },
      { label: 'Gate', action: (c) => view(c, [0, 1.6, 26], [0, 1.5, 40], [0, 30, Math.PI]) },
      { label: 'Path', action: (c) => view(c, [-22, 1.4, 6], [-24, 0.5, -6], [-23.5, 1, Math.PI]) },
      { label: 'Overview', action: (c) => view(c, [60, 45, 70], [0, 0, 0]) },
    ],
    onFrame(c, dt) {
      if (!running) return;
      angle += dt * 0.45;
      const R = 7;
      c.dog.root.position.set(Math.cos(angle) * R, 0, Math.sin(angle) * R);
      c.dog.root.rotation.y = Math.atan2(-Math.sin(angle), Math.cos(angle));
      c.rig.speed = R * 0.45;
      c.rig.turnRate = 0.45;
      follow(c, dt);
    },
  });
}
