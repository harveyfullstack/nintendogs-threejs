// Disc arena test page: ?test=disc. "Fetch run" sends the puppy down the field and back.
import * as THREE from 'three';
import { buildDiscArena } from '../world/discArena';
import type { DiscArena } from '../world/types';
import { runOutdoorTest, type TestCtx } from './town';

export default function (params: URLSearchParams) {
  let running = false;
  let t = 0;
  const view = (c: TestCtx, pos: [number, number, number], target: [number, number, number]) => {
    running = false;
    c.rig.speed = 0;
    c.setView(new THREE.Vector3(...pos), new THREE.Vector3(...target));
  };
  runOutdoorTest(params, {
    title: 'Disc arena',
    build: (r) => buildDiscArena(r),
    dog: new THREE.Vector3(0.6, 0, 0.4),
    dogYaw: 0,
    buttons: [
      { label: 'Fetch run', action: () => { running = true; t = 0; } },
      { label: 'Throw line', action: (c) => { const p = c.place as DiscArena; c.setDog(p.throwLine.clone().setX(0.6), 0); view(c, [0, 1.7, -6.5], [0, 0.4, 14]); } },
      { label: 'Low dog view', action: (c) => view(c, [1.8, 0.7, -1.6], [0.6, 0.3, 1.2]) },
      { label: 'Stands', action: (c) => view(c, [8, 2.5, 8], [-26, 2, 26]) },
      { label: 'Scoreboard', action: (c) => view(c, [0, 2.2, 46], [0, 5, 80]) },
      { label: 'Overview', action: (c) => view(c, [42, 30, -22], [0, 0, 30]) },
    ],
    onFrame(c, dt) {
      if (!running) return;
      t += dt;
      const L = 60, speed = 6;
      const phase = (t * speed) % (2 * L);
      const out = phase < L;
      const z = out ? phase : 2 * L - phase;
      c.dog.root.position.set(0.6, 0, z);
      c.dog.root.rotation.y = out ? 0 : Math.PI;
      c.rig.speed = speed;
      const f = out ? 1 : -1;
      c.camera.position.lerp(new THREE.Vector3(3, 1.6, z - f * 6), Math.min(1, dt * 3));
      c.controls.target.lerp(new THREE.Vector3(0.6, 0.4, z + f * 4), Math.min(1, dt * 3));
    },
  });
}
