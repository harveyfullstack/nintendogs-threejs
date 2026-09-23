import * as THREE from 'three';

// Nintendogs style camera: you sit on the floor at the front of the room and
// the view turns and drifts to keep your puppy framed.

export class FollowCamera {
  zoom = 1;
  private pos = new THREE.Vector3();
  private tgt = new THREE.Vector3();
  private first = true;
  lateral = 0.4;
  /** how strongly the camera looks at the focus vs its base target */
  follow = 0.85;
  minDist = 0.45;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly base: { position: THREE.Vector3; target: THREE.Vector3; fov?: number },
  ) {
    camera.fov = base.fov ?? 50;
    camera.updateProjectionMatrix();
    camera.position.copy(base.position);
    camera.lookAt(base.target);
  }

  /** Mouse wheel and two-finger pinch zoom. Returns a function that detaches it. */
  attachZoom(el: HTMLElement) {
    const clampZoom = (z: number) => THREE.MathUtils.clamp(z, 0.55, 1.5);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.zoom = clampZoom(this.zoom * (1 + e.deltaY * 0.001));
    };
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { spread: number; zoom: number } | null = null;
    const spread = () => {
      const [a, b] = [...touches.values()];
      return Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      if (e.isPrimary) { touches.clear(); pinch = null; }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) pinch = { spread: spread(), zoom: this.zoom };
    };
    const move = (e: PointerEvent) => {
      const t = touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX;
      t.y = e.clientY;
      // fingers apart = closer
      if (pinch && touches.size >= 2) this.zoom = clampZoom(pinch.zoom * (pinch.spread / spread()));
    };
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }

  update(dt: number, focus: THREE.Vector3 | null, snap = false) {
    const b = this.base;
    const tgt = focus ? b.target.clone().lerp(focus, this.follow) : b.target.clone();
    // drift sideways to follow
    const fwd = b.target.clone().sub(b.position).setY(0).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const pos = b.position.clone();
    if (focus) {
      const rel = focus.clone().sub(b.position);
      const side = rel.dot(right);
      pos.addScaledVector(right, THREE.MathUtils.clamp(side * this.lateral, -1.2, 1.2));
      const ahead = rel.dot(fwd);
      if (ahead > 1.6) pos.addScaledVector(fwd, (ahead - 1.6) * 0.35);
    }
    // zoom: move along the view line
    const toT = tgt.clone().sub(pos);
    const dist = toT.length();
    const want = Math.max(this.minDist, dist * this.zoom);
    pos.copy(tgt).addScaledVector(toT.normalize(), -want);
    if (this.first || snap) {
      this.pos.copy(pos);
      this.tgt.copy(tgt);
      this.first = false;
    } else {
      const k = 1 - Math.exp(-3.2 * dt);
      this.pos.lerp(pos, k);
      this.tgt.lerp(tgt, 1 - Math.exp(-4 * dt));
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.tgt);
  }

  /** Floor point in front of the camera where the owner "is". */
  playerSpot(floorY = 0, dist = 0.8): THREE.Vector3 {
    const fwd = this.base.target.clone().sub(this.base.position).setY(0).normalize();
    return this.base.position.clone().setY(floorY).addScaledVector(fwd, dist + Math.max(0, this.base.position.y - 0.5) * 0.5);
  }
}
