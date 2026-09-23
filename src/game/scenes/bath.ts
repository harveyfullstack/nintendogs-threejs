import * as THREE from 'three';
import type { DogHit } from '../../dog/actor';
import { Brain } from '../../dog/brain';
import { touchUI } from '../../ui/device';
import { h } from '../../ui/dom';
import { loadBathroom, props } from '../../world/loaders';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { sound } from '../sound';
import { clamp } from '../state';

// Bath time: lather with shampoo, rinse with the shower, let your pup shake
// off, then towel it dry.

type Stage = 'lather' | 'rinse' | 'shake' | 'towel' | 'done';

interface Bubble { bone: THREE.Object3D; local: THREE.Vector3; size: number; born: number }

export async function createBath(game: Game, args?: { dogId?: string }): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.02, 40);
  const bath = await loadBathroom(game.renderer);
  scene.add(bath.group);
  scene.environment = bath.environment ?? null;
  scene.background = bath.background ?? new THREE.Color('#dfeff3');
  if (bath.fog) scene.fog = bath.fog;

  const d = game.save.dogs.find((x) => x.id === args?.dogId) ?? game.dog!;
  const actor = game.actorFor(d);
  game.resetActor(actor);
  actor.floorY = bath.tubCenter.y;
  actor.bounds = { minX: bath.tubCenter.x - bath.tubHalf.x, maxX: bath.tubCenter.x + bath.tubHalf.x, minZ: bath.tubCenter.z - bath.tubHalf.z, maxZ: bath.tubCenter.z + bath.tubHalf.z };
  actor.place(bath.tubCenter.x, bath.tubCenter.z, Math.atan2(bath.camera.position.x - bath.tubCenter.x, bath.camera.position.z - bath.tubCenter.z) + 0.9);
  scene.add(actor.group);
  const u = actor.model.uniforms;
  const voice = game.voiceOf(d);
  const brain = new Brain(actor, d, {
    roam: false, playerSpot: () => bath.tubCenter, cameraPos: () => camera.position, toys: () => [],
    sound: (_a, k) => sound.dog(k, voice), emote: (a, k) => game.overlay.emote(k, a.headWorld().add(new THREE.Vector3(0, 0.1, 0)), 20),
  });
  brain.enabled = false;
  actor.rig.setPose('stand', 50);

  camera.position.copy(bath.camera.position);
  camera.lookAt(bath.camera.target);
  camera.fov = bath.camera.fov ?? 48;
  const camBase = bath.camera.position.clone();

  // bubbles
  const maxBubbles = 420;
  const bubbleGeo = new THREE.SphereGeometry(1, 10, 8);
  const bubbleMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.15, transparent: true, opacity: 0.85, clearcoat: 1, iridescence: 0.6, iridescenceIOR: 1.3 });
  const bubbleMesh = new THREE.InstancedMesh(bubbleGeo, bubbleMat, maxBubbles);
  bubbleMesh.count = 0;
  bubbleMesh.frustumCulled = false;
  scene.add(bubbleMesh);
  const bubbles: Bubble[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();

  // tools
  const P = props();
  const shampoo = P.makeItem('shampoo');
  const shower = P.makeItem('showerHead');
  const towel = P.makeItem('towel');
  for (const o of [shampoo, shower, towel]) { o.visible = false; scene.add(o); }
  const drops = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: '#bfe6ff', size: 0.012, transparent: true, opacity: 0.8, depthWrite: false }));
  scene.add(drops);
  const dropData: { p: THREE.Vector3; v: THREE.Vector3; life: number }[] = [];

  let stage: Stage = 'lather';
  let soap = 0, wet = 0;
  let spraying = false;
  let pointerDown = false;
  let lastHit: DogHit | null = null;
  let t = 0;
  let loopScrub: { stop(): void; setVolume(v: number): void } | null = null;
  let loopShower: { stop(): void; setVolume(v: number): void } | null = null;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // UI
  const layer = game.overlay.layer;
  const title = h('div', { class: 'mode-banner top show' });
  const meter = h('div', { class: 'bar' }, h('i', { style: { width: '0%', background: '#45b4e4' } }));
  const next = h('button', { class: 'btn primary', style: { display: 'none' } });
  const box = h('div', { class: 'panel hud-box' }, meter, next);
  const leave = h('button', { class: 'btn small corner-tr', onclick: () => game.go('home') }, 'Stop');
  layer.append(title, box, leave);

  const setStage = (s: Stage) => {
    stage = s;
    next.style.display = 'none';
    shampoo.visible = shower.visible = towel.visible = false;
    if (s === 'lather') title.textContent = '🧴 Rub the shampoo all over!';
    if (s === 'rinse') { title.textContent = touchUI ? '🚿 Touch and hold to rinse off the suds' : '🚿 Hold the mouse button to rinse off the suds'; loopScrub?.stop(); loopScrub = null; }
    if (s === 'shake') {
      title.textContent = 'Shake shake shake!';
      loopShower?.stop(); loopShower = null;
      brain.shakeOff();
      sound.sfx('shake');
      for (let i = 0; i < 160; i++) {
        const p = actor.position.clone().add(new THREE.Vector3(0, actor.size * (0.5 + Math.random() * 0.5), 0));
        const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize();
        dropData.push({ p, v: dir.multiplyScalar(1.5 + Math.random() * 2), life: 0.6 + Math.random() * 0.5 });
      }
      wet = Math.max(0.55, wet * 0.6);
      setTimeout(() => setStage('towel'), 1800);
    }
    if (s === 'towel') title.textContent = '🧺 Dry your pup off with the towel';
    if (s === 'done') {
      title.textContent = `${d.name} is squeaky clean!`;
      d.clean = 100;
      d.mood = clamp(d.mood + 10);
      d.affection = clamp(d.affection + 2);
      game.save.inventory.shampoo = Math.max(0, (game.save.inventory.shampoo ?? 0) - 1);
      game.ownerPoints(15);
      game.persist();
      u.uFluff.value = 1;
      sound.sfx('sparkle');
      sound.sfx('learned');
      for (let i = 0; i < 10; i++) setTimeout(() => game.overlay.emote('sparkle', actor.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, actor.size * Math.random(), (Math.random() - 0.5) * 0.3)), 30), i * 120);
      next.textContent = 'All done!';
      next.style.display = '';
      next.onclick = () => game.go('home');
      actor.rig.setPose('stand', 5);
      actor.rig.wagAmp = 0.5;
    }
  };
  setStage('lather');

  const onMove = (e: PointerEvent) => {
    const r = game.renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = actor.raycast(ray.ray);
    const tool = stage === 'lather' ? shampoo : stage === 'rinse' ? shower : stage === 'towel' ? towel : null;
    if (tool) {
      tool.visible = true;
      const p = hit ? hit.point.clone().addScaledVector(hit.normal, stage === 'rinse' ? 0.22 : 0.04) : ray.ray.at(0.6, new THREE.Vector3());
      tool.position.lerp(p, 0.6);
      tool.lookAt(camera.position);
      if (stage === 'rinse') tool.rotation.x += 0.9;
    }
    if (pointerDown && hit) rub(hit, lastHit);
    lastHit = hit;
  };
  const rub = (hit: DogHit, prev: DogHit | null) => {
    const dist = prev ? hit.point.distanceTo(prev.point) : 0;
    if (stage === 'lather') {
      soap = Math.min(1, soap + dist * 1.4);
      if (bubbles.length < maxBubbles && Math.random() < 0.9) addBubble(hit);
      if (!loopScrub) loopScrub = sound.loop('scrub');
      loopScrub.setVolume(Math.min(1, dist * 40));
      actor.rig.earPerk = -0.6;
      if (soap >= 1 && stage === 'lather') {
        next.textContent = 'Rinse!';
        next.style.display = '';
        next.onclick = () => setStage('rinse');
      }
    } else if (stage === 'towel') {
      wet = Math.max(0, wet - dist * 1.6);
      u.uFluff.value = Math.min(1, u.uFluff.value + dist);
      if (Math.random() < 0.2) sound.sfx('brush', { volume: 0.4 });
      if (wet <= 0.02) setStage('done');
    }
  };
  const addBubble = (hit: DogHit) => {
    // attach to the nearest bone so bubbles ride along with the animation
    let best: THREE.Object3D = actor.model.bones.body, bd = Infinity;
    for (const b of Object.values(actor.model.bones)) {
      b.getWorldPosition(v);
      const dd = v.distanceTo(hit.point);
      if (dd < bd) { bd = dd; best = b; }
    }
    best.updateWorldMatrix(true, false);
    const local = hit.point.clone().addScaledVector(hit.normal, 0.004 + Math.random() * 0.006).applyMatrix4(m4.copy(best.matrixWorld).invert());
    bubbles.push({ bone: best, local, size: 0.006 + Math.random() * 0.014 * actor.model.design.dims.hs, born: t });
  };
  const onDown = (e: PointerEvent) => {
    pointerDown = true;
    // a new stroke: without this, a finger landing somewhere new counts as one huge rub
    lastHit = null;
    onMove(e);
    if (stage === 'rinse') { spraying = true; if (!loopShower) loopShower = sound.loop('shower'); }
  };
  const onUp = () => {
    pointerDown = false;
    spraying = false;
    loopScrub?.setVolume(0);
    loopShower?.stop(); loopShower = null;
    actor.rig.earPerk = 0;
  };
  const el = game.renderer.domElement;
  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  sound.music('home');

  return {
    scene,
    camera,
    update(dt, time) {
      t += dt;
      // spraying water
      if (stage === 'rinse' && spraying) {
        const head = shower.position;
        for (let i = 0; i < 6; i++) {
          dropData.push({ p: head.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 0.4, -2.2, (Math.random() - 0.5) * 0.4).applyQuaternion(q.setFromEuler(new THREE.Euler(0, 0, 0))), life: 0.45 });
        }
        if (lastHit) {
          wet = Math.min(1, wet + dt * 0.7);
          soap = Math.max(0, soap - dt * 0.25);
          // wash away bubbles near the spray
          for (let i = bubbles.length - 1; i >= 0; i--) {
            const b = bubbles[i];
            v.copy(b.local).applyMatrix4(b.bone.matrixWorld);
            if (v.distanceTo(lastHit.point) < 0.09 || Math.random() < dt * 0.3) bubbles.splice(i, 1);
          }
          actor.rig.eyesClosed = 0.7;
        }
        if (soap <= 0.01 && bubbles.length < 5) { bubbles.length = 0; actor.rig.eyesClosed = 0; setStage('shake'); }
      } else if (stage !== 'shake') actor.rig.eyesClosed = 0;
      // bubbles
      bubbleMesh.count = bubbles.length;
      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        v.copy(b.local).applyMatrix4(b.bone.matrixWorld);
        const s = b.size * Math.min(1, (t - b.born) * 6) * (1 + Math.sin(t * 3 + i) * 0.05);
        m4.compose(v, q.identity(), new THREE.Vector3(s, s, s));
        bubbleMesh.setMatrixAt(i, m4);
      }
      bubbleMesh.instanceMatrix.needsUpdate = true;
      // droplets
      for (let i = dropData.length - 1; i >= 0; i--) {
        const dd = dropData[i];
        dd.v.y -= 9.8 * dt;
        dd.p.addScaledVector(dd.v, dt);
        dd.life -= dt;
        if (dd.life <= 0 || dd.p.y < bath.tubCenter.y) dropData.splice(i, 1);
      }
      const arr = new Float32Array(dropData.length * 3);
      dropData.forEach((dd, i) => dd.p.toArray(arr, i * 3));
      drops.geometry.dispose();
      drops.geometry = new THREE.BufferGeometry();
      drops.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      // coat state
      u.uSoap.value = soap * 0.6;
      u.uWet.value = wet;
      u.uDirt.value = stage === 'lather' ? Math.max(0, (60 - d.clean) / 60 * (1 - soap)) : 0;
      (meter.firstChild as HTMLElement).style.width = (stage === 'lather' ? soap : stage === 'rinse' ? 1 - soap : stage === 'towel' ? 1 - wet : 1) * 100 + '%';
      // the dog fidgets and watches you
      actor.rig.look = { point: camera.position, weight: 0.6 };
      actor.rig.wagAmp = stage === 'done' ? 0.5 : 0.08;
      brain.update(dt);
      actor.update(dt);
      u.uGravity.value.set(0, -actor.model.gravity, 0);
      camera.position.lerp(camBase, dt);
      bath.update?.(dt, time, actor.position);
    },
    exit() {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      loopScrub?.stop();
      loopShower?.stop();
      u.uWet.value = 0;
      u.uSoap.value = 0;
      actor.group.removeFromParent();
      bubbleGeo.dispose();
      bubbleMat.dispose();
      bath.dispose();
      game.persist();
    },
  };
}
