// Agility course test page: ?test=agility. "Run course" sends the puppy through the obstacles in order.
import * as THREE from 'three';
import { buildAgilityCourse } from '../world/agility';
import type { AgilityCourse } from '../world/types';
import { runOutdoorTest, type TestCtx } from './town';

export default function (params: URLSearchParams) {
  let running = false;
  let s = 0;
  let curve: THREE.CatmullRomCurve3 | null = null;
  const view = (c: TestCtx, pos: [number, number, number], target: [number, number, number]) => {
    running = false;
    c.rig.speed = 0;
    c.rig.rootLift = 0;
    c.setView(new THREE.Vector3(...pos), new THREE.Vector3(...target));
  };
  const buildPath = (course: AgilityCourse) => {
    const pts: THREE.Vector3[] = [];
    for (const o of course.course) {
      const half = Math.max(0.3, o.length / 2 + 0.6);
      pts.push(o.position.clone().addScaledVector(o.dir, -half), o.position.clone(), o.position.clone().addScaledVector(o.dir, half));
    }
    return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  };
  const obstacleView = (c: TestCtx, i: number) => {
    const o = (c.place as AgilityCourse).course[i];
    const side = new THREE.Vector3(o.dir.z, 0, -o.dir.x);
    c.setDog(o.position.clone().addScaledVector(o.dir, -(o.length / 2 + 0.8)), Math.atan2(o.dir.x, o.dir.z));
    view(c, o.position.clone().addScaledVector(side, 2.6).addScaledVector(o.dir, -2.2).setY(1.1).toArray() as any, o.position.clone().setY(0.3).toArray() as any);
  };
  runOutdoorTest(params, {
    title: 'Agility course',
    build: (r) => buildAgilityCourse(r),
    dog: new THREE.Vector3(-8, 0, 10.2),
    dogYaw: Math.PI,
    buttons: [
      { label: 'Run course', action: (c) => { curve = buildPath(c.place as AgilityCourse); s = 0; running = true; } },
      { label: 'Overview', action: (c) => view(c, [0, 7.5, 21], [0, 0, 0]) },
      { label: 'High view', action: (c) => view(c, [16, 22, 20], [0, 0, 0]) },
      ...['Hurdle', 'Tire', 'Weave', 'A-frame', 'Tunnel'].map((label, k) => ({ label, action: (c: TestCtx) => obstacleView(c, [1, 2, 3, 5, 7][k]) })),
      { label: 'Stands', action: (c) => view(c, [4, 2, -4], [0, 2, -20]) },
    ],
    onFrame(c, dt) {
      if (!running || !curve) return;
      const course = c.place as AgilityCourse;
      const len = curve.getLength();
      s += dt * 3.2;
      if (s > len) s = 0;
      const u = s / len;
      const p = curve.getPointAt(u), t = curve.getTangentAt(u);
      // hop over bars, weave between poles, climb the A-frame
      let lift = 0;
      for (const o of course.course) {
        const d = p.clone().sub(o.position);
        const along = d.dot(o.dir);
        if ((o.kind === 'hurdle' || o.kind === 'tire') && Math.abs(along) < 0.55 && d.length() < 0.8) lift = Math.max(lift, (o.kind === 'tire' ? 0.3 : 0.22) * Math.cos((along / 0.55) * Math.PI * 0.5));
        if (o.kind === 'aframe' && Math.abs(along) < 1.5 && d.length() < 1.6) lift = Math.max(lift, 0.55 * (1 - Math.abs(along) / 1.5));
        if (o.kind === 'weave' && Math.abs(along) < 2.1 && d.length() < 2.3) p.addScaledVector(new THREE.Vector3(o.dir.z, 0, -o.dir.x), Math.sin((along / 0.6) * Math.PI) * 0.18);
      }
      c.dog.root.position.set(p.x, lift, p.z);
      c.dog.root.rotation.y = Math.atan2(t.x, t.z);
      c.rig.speed = 3.2;
      const f = new THREE.Vector3(t.x, 0, t.z).normalize();
      c.camera.position.lerp(new THREE.Vector3(p.x - f.x * 3.5, 1.6, p.z - f.z * 3.5), Math.min(1, dt * 2.5));
      c.controls.target.lerp(new THREE.Vector3(p.x + f.x * 2, 0.3, p.z + f.z * 2), Math.min(1, dt * 2.5));
    },
  });
}
