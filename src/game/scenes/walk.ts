import * as THREE from 'three';
import { DogActor } from '../../dog/actor';
import { BREEDS, getBreed } from '../../dog/breeds';
import { Tap, isCompact, safeInsets, tap } from '../../ui/device';
import { h } from '../../ui/dom';
import { loadTown, props } from '../../world/loaders';
import { TOWN, blockRect, findPoi, intersection, pitch, poiEdge, poiEntrance } from '../../world/townLayout';
import type { PoiKind, TownPoi } from '../../world/types';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { randomCollectible } from '../items';
import { sound } from '../sound';
import { clamp } from '../state';

// ------------------------------------------------------------------ route model

type Node = [number, number];

interface WalkPlan {
  nodes: Node[]; // intersections visited in order (without the home entrance)
  presents: { a: Node; b: Node }[]; // street edges with a present
}

const MAX_EDGES = 14;

function edgeKey(a: Node, b: Node) {
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
  return `${p[0]},${p[1]}-${q[0]},${q[1]}`;
}

function neighbors(n: Node): Node[] {
  const out: Node[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = n[0] + dx, z = n[1] + dz;
    if (x >= 0 && x <= TOWN.cols && z >= 0 && z <= TOWN.rows) out.push([x, z]);
  }
  return out;
}

function shortestPath(from: Node, to: Node): Node[] {
  const key = (n: Node) => n[0] + ',' + n[1];
  const prev = new Map<string, Node | null>([[key(from), null]]);
  const q: Node[] = [from];
  while (q.length) {
    const n = q.shift()!;
    if (n[0] === to[0] && n[1] === to[1]) break;
    for (const m of neighbors(n)) if (!prev.has(key(m))) { prev.set(key(m), n); q.push(m); }
  }
  const path: Node[] = [];
  let c: Node | null | undefined = to;
  while (c) { path.unshift(c); c = prev.get(key(c)); }
  return path;
}

// ------------------------------------------------------------------ map screen

export async function createWalkMap(game: Game): Promise<GameScene> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#bfe3c4');
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const home = findPoi('home');
  const [ha, hb] = poiEdge(home);
  const plan: WalkPlan = { nodes: [], presents: [] };
  // random presents on a few streets
  const allEdges: [Node, Node][] = [];
  for (let i = 0; i <= TOWN.cols; i++) for (let j = 0; j <= TOWN.rows; j++) {
    if (i < TOWN.cols) allEdges.push([[i, j], [i + 1, j]]);
    if (j < TOWN.rows) allEdges.push([[i, j], [i, j + 1]]);
  }
  const nPresents = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < nPresents; i++) {
    const e = allEdges[Math.floor(Math.random() * allEdges.length)];
    if (edgeKey(e[0], e[1]) === edgeKey(ha, hb)) continue;
    plan.presents.push({ a: e[0], b: e[1] });
  }

  const W = 760, H = 600;
  const cv = h('canvas', { width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' } }) as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  const P = pitch();
  const pad = 30;
  const sx = (W * 2 - pad * 4) / (TOWN.cols * P), sz = (H * 2 - pad * 4) / (TOWN.rows * P);
  const sc = Math.min(sx, sz);
  const ox = (W * 2 - TOWN.cols * P * sc) / 2, oz = (H * 2 - TOWN.rows * P * sc) / 2;
  const toC = (x: number, z: number) => [ox + x * sc, oz + z * sc];
  /** canvas pixels -> town coordinates */
  const fromC = (cx: number, cy: number) => [(cx - ox) / sc, (cy - oz) / sc];
  const dog = game.dog!;
  const info = h('div', { class: 'info' });
  const icons: Record<PoiKind, string> = { home: '🏠', park: '🌳', shop: '🛍️', gym: '🏆', kennel: '🐶', secondhand: '💰' };

  const draw = () => {
    ctx.clearRect(0, 0, W * 2, H * 2);
    ctx.fillStyle = '#a7d49a';
    ctx.fillRect(0, 0, W * 2, H * 2);
    // blocks
    for (let c = 0; c < TOWN.cols; c++) for (let r = 0; r < TOWN.rows; r++) {
      const b = blockRect(c, r);
      const [x0, z0] = toC(b.minX, b.minZ), [x1, z1] = toC(b.maxX, b.maxZ);
      const poi = TOWN.pois.find((p) => p.col === c && p.row === r);
      ctx.fillStyle = poi?.kind === 'park' ? '#6fbf5e' : '#efe6d2';
      roundRect(ctx, x0, z0, x1 - x0, z1 - z0, 16);
      ctx.fill();
      if (!poi) {
        ctx.fillStyle = '#e2d3b5';
        for (let k = 0; k < 4; k++) {
          const hx = x0 + 18 + (k % 2) * (x1 - x0) / 2, hz = z0 + 18 + Math.floor(k / 2) * (z1 - z0) / 2;
          roundRect(ctx, hx, hz, (x1 - x0) / 2 - 36, (z1 - z0) / 2 - 36, 8);
          ctx.fill();
        }
      }
    }
    // streets
    ctx.strokeStyle = '#8e939b';
    ctx.lineWidth = TOWN.street * sc * 0.55;
    ctx.lineCap = 'round';
    for (let i = 0; i <= TOWN.cols; i++) { const [x, z0] = toC(i * P, 0), [, z1] = toC(i * P, TOWN.rows * P); line(x, z0, x, z1); }
    for (let j = 0; j <= TOWN.rows; j++) { const [x0, z] = toC(0, j * P), [x1] = toC(TOWN.cols * P, j * P); line(x0, z, x1, z); }
    // presents
    ctx.font = 'bold 44px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const pr of plan.presents) {
      const a = intersection(...pr.a), b = intersection(...pr.b);
      const [x, z] = toC((a.x + b.x) / 2, (a.z + b.z) / 2);
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath(); ctx.arc(x, z, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6b4b00';
      ctx.fillText('?', x, z + 2);
    }
    // POIs
    ctx.font = '64px sans-serif';
    for (const p of TOWN.pois) {
      const b = blockRect(p.col, p.row);
      const [x, z] = toC((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
      ctx.fillText(icons[p.kind], x, z - 10);
      ctx.font = 'bold 26px Fredoka, sans-serif';
      ctx.fillStyle = '#3a3a48';
      ctx.fillText(p.name, x, z + 46);
      ctx.font = '64px sans-serif';
    }
    // route
    const pts = routePoints();
    ctx.strokeStyle = '#ff7a2f';
    ctx.lineWidth = 14;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([x, z], i) => { const [cx, cz] = toC(x, z); if (i) ctx.lineTo(cx, cz); else ctx.moveTo(cx, cz); });
    ctx.stroke();
    // dashed return
    const ret = returnPoints();
    if (ret.length > 1) {
      ctx.setLineDash([18, 16]);
      ctx.strokeStyle = 'rgba(255,122,47,.55)';
      ctx.beginPath();
      ret.forEach(([x, z], i) => { const [cx, cz] = toC(x, z); if (i) ctx.lineTo(cx, cz); else ctx.moveTo(cx, cz); });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // dog marker
    const last = pts[pts.length - 1];
    const [dx, dz] = toC(last[0], last[1]);
    ctx.font = '52px sans-serif';
    ctx.fillText('🐕', dx, dz);
    const used = plan.nodes.length + Math.max(0, returnNodes().length - 1);
    info.textContent = plan.nodes.length
      ? `Route: ${used}/${MAX_EDGES} blocks · ${tap} streets to extend, then press Go!`
      : `${Tap} the streets next to your house to plan a walk for ${dog.name}.`;
  };
  function line(x0: number, y0: number, x1: number, y1: number) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }

  const entrance = poiEntrance(home);
  const routePoints = (): [number, number][] => {
    const pts: [number, number][] = [[entrance.x, entrance.z]];
    for (const n of plan.nodes) { const p = intersection(...n); pts.push([p.x, p.z]); }
    return pts;
  };
  const returnNodes = (): Node[] => {
    if (!plan.nodes.length) return [];
    const last = plan.nodes[plan.nodes.length - 1];
    const a = shortestPath(last, ha), b = shortestPath(last, hb);
    return a.length <= b.length ? a : b;
  };
  const returnPoints = (): [number, number][] => {
    const r = returnNodes();
    if (!r.length) return [];
    const pts: [number, number][] = r.map((n) => { const p = intersection(...n); return [p.x, p.z]; });
    pts.push([entrance.x, entrance.z]);
    return pts;
  };

  const addNear = (wx: number, wz: number) => {
    const last: Node | null = plan.nodes.length ? plan.nodes[plan.nodes.length - 1] : null;
    const cands: Node[] = last ? neighbors(last) : [ha, hb];
    let best: Node | null = null, bd = Infinity;
    for (const c of cands) {
      const p = intersection(...c);
      const d = Math.hypot(p.x - wx, p.z - wz);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best || bd > P * 0.75) return;
    // undo when going back to the previous node
    if (plan.nodes.length >= 2) {
      const prev = plan.nodes[plan.nodes.length - 2];
      if (prev[0] === best[0] && prev[1] === best[1]) { plan.nodes.pop(); sound.sfx('back'); draw(); return; }
    }
    const used = plan.nodes.length + 1 + Math.max(0, shortestPath(best, ha).length - 1);
    if (used > MAX_EDGES) { game.overlay.toast("That's too far for today!"); return; }
    plan.nodes.push(best);
    sound.sfx('click');
    draw();
  };
  let dragging = false;
  // the canvas is scaled to fit the screen, so map through its displayed size
  const pos = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return fromC(((e.clientX - r.left) / r.width) * cv.width, ((e.clientY - r.top) / r.height) * cv.height);
  };
  cv.addEventListener('pointerdown', (e) => { dragging = true; const [x, z] = pos(e); addNear(x, z); });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const [x, z] = pos(e);
    const last = plan.nodes[plan.nodes.length - 1];
    if (!last) { addNear(x, z); return; }
    const p = intersection(...last);
    if (Math.hypot(p.x - x, p.z - z) > P * 0.55) addNear(x, z);
  });
  const stopDrag = () => (dragging = false);
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);

  const go = () => {
    if (!plan.nodes.length) { game.overlay.toast('Draw a route first!'); return; }
    const full = [...plan.nodes, ...returnNodes().slice(1)];
    sound.sfx('select');
    game.go('walk', { nodes: full, presents: plan.presents });
  };
  const panel = h('div', { class: 'panel centered walkmap' },
    h('div', { class: 'head' }, h('h2', null, 'Walk'), info),
    cv,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => game.go('home') }, 'Cancel'),
      h('button', { class: 'btn', onclick: () => { plan.nodes.length = 0; draw(); } }, 'Clear'),
      h('button', { class: 'btn primary', onclick: go }, "Let's go!")));
  game.overlay.layer.append(panel);

  // Size the map to the screen: everything else in the panel keeps its size and the map
  // takes what's left (beside the buttons on short landscape screens, above them otherwise).
  const fit = () => {
    const inset = safeInsets();
    const margin = isCompact() ? 16 : 40;
    const availW = window.innerWidth - inset.left - inset.right - margin;
    const availH = window.innerHeight - inset.top - inset.bottom - margin;
    const cs = getComputedStyle(panel);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const beside = cs.gridTemplateAreas.startsWith('"map');
    const size = (k: number) => {
      cv.style.width = Math.max(120, Math.floor(W * k)) + 'px';
      cv.style.height = Math.max(95, Math.floor(H * k)) + 'px';
    };
    // start small so the panel isn't clamped while we measure, then refine once the text has re-wrapped
    size(0.25);
    for (let pass = 0; pass < 2; pass++) {
      const p = panel.getBoundingClientRect(), c = cv.getBoundingClientRect();
      const chromeW = beside ? p.width - c.width : padX;
      const chromeH = beside ? padY : p.height - c.height;
      size(Math.min(1, (availW - chromeW) / W, (availH - chromeH) / H));
    }
  };
  window.addEventListener('resize', fit);
  draw();
  fit();
  sound.music('walk');
  return {
    scene,
    camera,
    update() {},
    exit() {
      window.removeEventListener('resize', fit);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, hh), r);
}

// ------------------------------------------------------------------ the walk itself

interface WalkEvent { s: number; kind: 'present' | 'poi' | 'pee' | 'poop' | 'friend' | 'sniff'; poi?: TownPoi; done?: boolean }

export async function createWalk(game: Game, args: { nodes: Node[]; presents: WalkPlan['presents'] }): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  const town = await loadTown(TOWN, game.renderer);
  scene.add(town.group);
  scene.environment = town.environment ?? null;
  scene.background = town.background ?? new THREE.Color('#a9d7f5');
  scene.fog = town.fog ?? new THREE.Fog('#cfe6f5', 60, 180);

  const d = game.dog!;
  const actor = game.actorFor(d);
  game.resetActor(actor);
  scene.add(actor.group);
  game.applyCoatState(d, actor);
  const voice = game.voiceOf(d);

  // --- build the sidewalk path
  const home = findPoi('home');
  const ent = poiEntrance(home);
  const off = TOWN.street / 2 - TOWN.sidewalk / 2;
  // Street centre-line waypoints: home's street, the intersections, back to home's street.
  const [ha, hb] = poiEdge(home);
  const hA = intersection(...ha), hB = intersection(...hb);
  const onHomeStreet = new THREE.Vector3((hA.x + hB.x) / 2, 0, (hA.z + hB.z) / 2);
  const nodes = args.nodes;
  const centre: THREE.Vector3[] = [onHomeStreet, ...nodes.map((n) => { const p = intersection(...n); return new THREE.Vector3(p.x, 0, p.z); }), onHomeStreet.clone()];
  // Walk each street on whichever sidewalk the dog is already on, so it only crosses at corners.
  const pts: THREE.Vector3[] = [new THREE.Vector3(ent.x, 0, ent.z)];
  let at = pts[0].clone();
  for (let i = 0; i + 1 < centre.length; i++) {
    const a = centre[i], b = centre[i + 1];
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-3) continue;
    dir.divideScalar(len);
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const side = at.clone().sub(a).dot(perp) >= 0 ? 1 : -1;
    const startInset = i === 0 ? 0 : off;
    const endInset = i + 2 === centre.length ? 0 : off;
    const s0 = a.clone().addScaledVector(perp, side * off).addScaledVector(dir, startInset);
    const s1 = b.clone().addScaledVector(perp, side * off).addScaledVector(dir, -endInset);
    if (i > 0) {
      // at an intersection, cross at the crosswalks rather than diagonally
      const dx0 = Math.sign(at.x - a.x), dz0 = Math.sign(at.z - a.z);
      const dx1 = Math.sign(s0.x - a.x), dz1 = Math.sign(s0.z - a.z);
      if (dx0 !== dx1 && dz0 !== dz1) pts.push(new THREE.Vector3(at.x, 0, s0.z));
      pts.push(s0);
    }
    pts.push(s1);
    at = s1;
  }
  pts.push(new THREE.Vector3(ent.x, 0, ent.z));
  // a polyline, so the pup follows the sidewalks and crosswalks exactly
  const curve = new THREE.CurvePath<THREE.Vector3>();
  const route = dedupe(pts);
  for (let i = 0; i + 1 < route.length; i++) curve.add(new THREE.LineCurve3(route[i], route[i + 1]));
  const length = curve.getLength();

  // --- events along the way
  const events: WalkEvent[] = [];
  const sample = 400;
  const spaced = curve.getSpacedPoints(sample);
  const sAt = (p: { x: number; z: number }) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i <= sample; i++) {
      const q = spaced[i];
      const dd = Math.hypot(q.x - p.x, q.z - p.z);
      if (dd < bd) { bd = dd; best = i; }
    }
    return { s: (best / sample) * length, dist: bd };
  };
  for (const pr of args.presents) {
    const a = intersection(...pr.a), b = intersection(...pr.b);
    const r = sAt({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    if (r.dist < TOWN.street) events.push({ s: r.s, kind: 'present' });
  }
  for (const poi of TOWN.pois) {
    if (poi.kind === 'home') continue;
    const e = poiEntrance(poi);
    const r = sAt(e);
    if (r.dist < TOWN.street * 0.6 && r.s > 8 && r.s < length - 8) events.push({ s: r.s, kind: 'poi', poi });
  }
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  events.push({ s: rnd(0.25, 0.6) * length, kind: 'poop' });
  events.push({ s: rnd(0.15, 0.85) * length, kind: 'pee' });
  events.push({ s: rnd(0.2, 0.9) * length, kind: 'sniff' });
  events.push({ s: rnd(0.3, 0.8) * length, kind: 'friend' });
  events.sort((a, b) => a.s - b.s);

  // --- NPC dog for the "friend" encounter
  const npcBreed = BREEDS[Math.floor(Math.random() * BREEDS.length)];
  const npc = new DogActor(npcBreed, npcBreed.coats[Math.floor(Math.random() * npcBreed.coats.length)], 0.8);
  npc.group.visible = false;
  scene.add(npc.group);

  // --- leash
  const leashMat = new THREE.MeshStandardMaterial({ color: '#d2413a', roughness: 0.6 });
  let leashGeo: THREE.BufferGeometry | null = null;
  const leash = new THREE.Mesh(new THREE.BufferGeometry(), leashMat);
  leash.castShadow = true;
  scene.add(leash);
  const npcLeash = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: '#3a6fd2', roughness: 0.6 }));
  scene.add(npcLeash);

  // --- state
  let s = 1.5; // dog distance along the path
  let owner = 0; // owner distance along the path
  let pause = 0;
  let current: WalkEvent | null = null;
  let finished = false;
  let found: string[] = [];
  let poopObj: THREE.Object3D | null = null;
  let tug = 0;
  const speed = Math.min(1.35, 0.75 + d.energy / 200) * (0.95 + getBreed(d.breedId).shape.H * 0.6);
  const dogSize = actor.size;
  let t = 0;
  let prompt: { close: () => void } | null = null;
  const side = new THREE.Vector3();

  const pos = (u: number) => curve.getPointAt(THREE.MathUtils.clamp(u / length, 0, 1));
  const tan = (u: number) => curve.getTangentAt(THREE.MathUtils.clamp(u / length, 0, 1));

  actor.place(pos(s).x, pos(s).z, Math.atan2(tan(s).x, tan(s).z));
  owner = s - 2.2;
  const camTan = tan(s).clone();
  // start the camera where it will be, rather than swinging in from the origin
  {
    const op = pos(owner);
    camera.position.set(op.x, 1.45, op.z).addScaledVector(camTan, -0.6);
    camera.lookAt(actor.position.clone().addScaledVector(camTan, 1.2).setY(0.2));
  }

  // --- UI
  const layer = game.overlay.layer;
  const bar = h('div', { class: 'panel walk-bar' });
  const progress = h('div', { class: 'bar' }, h('i', { style: { width: '0%', background: '#ff9b30' } }));
  const label = h('div', { class: 'label' }, `Walking ${d.name}`);
  bar.append(label, progress);
  const tugBtn = h('button', { class: 'btn corner-br', onclick: () => { tug = 1; sound.sfx('rope'); } }, 'Tug leash');
  const homeBtn = h('button', { class: 'btn small corner-bl', onclick: () => endWalk(true) }, 'Head home');
  layer.append(bar, tugBtn, homeBtn);

  const raycaster = new THREE.Raycaster();
  const onDown = (e: PointerEvent) => {
    const r = game.renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    if (poopObj) {
      const c = poopObj.getWorldPosition(new THREE.Vector3());
      if (raycaster.ray.distanceToPoint(c) < 0.25) {
        sound.sfx('bag');
        poopObj.removeFromParent();
        poopObj = null;
        game.ownerPoints(10);
        game.overlay.toast('Good job cleaning up! +10 Owner Points');
        return;
      }
    }
    const hit = actor.raycast(raycaster.ray);
    if (hit) {
      d.mood = clamp(d.mood + 3);
      game.overlay.emote('heart', actor.headWorld().add(new THREE.Vector3(0, 0.08, 0)), 20);
      sound.dog('happy', voice);
    } else {
      tug = 1;
    }
  };
  game.renderer.domElement.addEventListener('pointerdown', onDown);

  const startEvent = (ev: WalkEvent) => {
    current = ev;
    ev.done = true;
    const rig = actor.rig;
    switch (ev.kind) {
      case 'present': {
        pause = 3.2;
        rig.setPose('sniff', 6);
        game.overlay.emote('exclaim', actor.headWorld().add(new THREE.Vector3(0, 0.1, 0)));
        sound.dog('sniff', voice);
        setTimeout(() => {
          if (finished) return;
          sound.sfx('dig');
          rig.setPose('bow', 8);
        }, 1200);
        setTimeout(() => {
          if (finished) return;
          const c = randomCollectible();
          game.save.collectibles[c.id] = (game.save.collectibles[c.id] ?? 0) + 1;
          found.push(c.name);
          sound.sfx('present');
          game.overlay.toast(`🎁 ${d.name} found a ${c.name}!`, true);
          const obj = props().makeCollectible(c.id);
          actor.hold(obj);
          setTimeout(() => { actor.drop(); obj.traverse((o: any) => o.geometry?.dispose?.()); }, 2500);
          rig.setPose('stand', 6);
        }, 2300);
        break;
      }
      case 'pee': {
        pause = 2.5;
        rig.setPose(d.sex === 'male' ? 'stand' : 'sit', 5);
        if (d.sex === 'male') rig.overlay['thigh_L'] = [-0.4, 0, -0.9];
        setTimeout(() => { delete rig.overlay['thigh_L']; rig.setPose('stand', 5); }, 2000);
        break;
      }
      case 'poop': {
        pause = 3;
        rig.setPose('sit', 5);
        rig.overlay.pelvis = [0.25, 0, 0];
        setTimeout(() => {
          delete rig.overlay.pelvis;
          rig.setPose('stand', 5);
          const p = props().makePoop();
          const behind = actor.position.clone().addScaledVector(actor.forward, -actor.model.design.dims.BL * 0.7);
          p.position.copy(behind);
          scene.add(p);
          poopObj = p;
          game.overlay.toast(`Oops! ${Tap} the poop to clean it up.`);
        }, 2400);
        break;
      }
      case 'sniff':
        pause = 2.5;
        rig.setPose('sniff', 5);
        sound.dog('sniff', voice);
        break;
      case 'friend': {
        pause = 5;
        npc.group.visible = true;
        const ahead = pos(s + 3.5);
        const tn = tan(s);
        side.set(-tn.z, 0, tn.x);
        npc.place(ahead.x + side.x * 0.5, ahead.z + side.z * 0.5, Math.atan2(-tn.x, -tn.z));
        npc.goTo(actor.position.clone().addScaledVector(actor.forward, actor.model.design.dims.BL * 0.9).addScaledVector(side, 0.25), { speed: 0.6, arrive: 0.1, faceAfter: actor.position });
        rig.look = { point: npc.headWorld(), weight: 1 };
        game.overlay.emote('exclaim', actor.headWorld().add(new THREE.Vector3(0, 0.1, 0)));
        sound.dog(dogSize < 0.2 ? 'yip' : 'bark', voice);
        setTimeout(() => {
          if (finished) return;
          game.overlay.toast(`${d.name} made a friend: a ${npcBreed.name}!`);
          d.mood = clamp(d.mood + 8);
          sound.dog('happy', voice);
          game.overlay.emote('heart', actor.headWorld().add(new THREE.Vector3(0, 0.1, 0)));
          game.overlay.emote('heart', npc.headWorld().add(new THREE.Vector3(0, 0.1, 0)));
        }, 2200);
        setTimeout(() => {
          const away = pos(s - 12);
          npc.goTo(new THREE.Vector3(away.x + side.x * 0.6, 0, away.z + side.z * 0.6), { speed: 0.7, arrive: 0.2, onArrive: () => (npc.group.visible = false) });
        }, 4200);
        break;
      }
      case 'poi': {
        pause = 1000;
        const poi = ev.poi!;
        const names: Record<string, string> = { park: 'Go into the park?', shop: 'Stop by the Pet Supply shop?', gym: 'Visit the Gym?', kennel: 'Pop into the Kennel?', secondhand: 'Visit the Secondhand Shop?' };
        prompt = game.overlay.modal(h('div', { class: 'panel', style: { textAlign: 'center', width: 'min(420px, 90vw)' } },
          h('h2', null, poi.name),
          h('p', null, names[poi.kind] ?? 'Go in?'),
          h('div', { class: 'actions', style: { justifyContent: 'center' } },
            h('button', { class: 'btn', onclick: () => { prompt?.close(); prompt = null; pause = 0.2; } }, 'Keep walking'),
            h('button', { class: 'btn primary', onclick: () => { prompt?.close(); prompt = null; enterPoi(poi); } }, 'Go in'))), { dismiss: false });
        rig.setPose('sit', 5);
        break;
      }
    }
  };

  const recordWalk = () => {
    d.walks++;
    d.walkDistance += Math.max(0, s);
    d.lastWalk = Date.now();
    d.energy = clamp(d.energy - Math.min(35, s * 0.12));
    d.clean = clamp(d.clean - 6);
    d.mood = clamp(d.mood + 12);
    d.affection = clamp(d.affection + 3);
    game.ownerPoints(Math.round(10 + s * 0.2));
    game.persist();
  };

  const enterPoi = (poi: TownPoi) => {
    finished = true;
    recordWalk();
    if (poi.kind === 'park') game.go('park');
    else if (poi.kind === 'shop') game.go('shop', { kind: 'pet', fromWalk: true });
    else if (poi.kind === 'secondhand') game.go('shop', { kind: 'secondhand', fromWalk: true });
    else if (poi.kind === 'gym') game.go('gym');
    else if (poi.kind === 'kennel') game.go('kennel', { adopting: false });
  };

  const endWalk = (early = false) => {
    if (finished) return;
    finished = true;
    recordWalk();
    const lines = [`Distance: ${Math.round(s)} m`];
    if (found.length) lines.push(`Found: ${found.join(', ')}`);
    sound.sfx('fanfare');
    game.overlay.modal(h('div', { class: 'panel', style: { textAlign: 'center', width: 'min(440px, 90vw)' } },
      h('h2', null, early ? 'Back home early' : 'Walk complete!'),
      ...lines.map((l) => h('p', null, l)),
      h('p', null, `${d.name} had a great time!`),
      h('div', { class: 'actions', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: () => game.go('home') }, 'Go inside'))), { dismiss: false });
  };

  sound.music('walk');

  return {
    scene,
    camera,
    update(dt, time) {
      t += dt;
      const rig = actor.rig;
      if (!finished) {
        if (pause > 0) {
          pause -= dt;
          if (tug > 0 && current?.kind !== 'poi') pause = Math.min(pause, 0.3);
          actor.stop();
          if (pause <= 0) {
            current = null;
            rig.setPose('stand', 6);
            rig.look = { point: null, weight: 0 };
          }
        } else {
          // walk along, trotting a little ahead of the owner
          s += speed * dt * (1 + tug * 0.3);
          const ev = events.find((e) => !e.done && e.s <= s);
          if (ev) startEvent(ev);
          const p = pos(s);
          // weave a little from side to side like an excited puppy
          const tn = tan(s);
          side.set(-tn.z, 0, tn.x);
          const weave = Math.sin(t * 0.7) * 0.25 + Math.sin(t * 1.9) * 0.08;
          actor.goTo(new THREE.Vector3(p.x + side.x * weave, 0, p.z + side.z * weave), { speed: speed * 1.4, arrive: 0.02 });
          if (s >= length - 0.5) endWalk();
        }
        tug = Math.max(0, tug - dt * 2);
        const lead = Math.max(0, s - 2.0);
        owner += (lead - owner) * Math.min(1, dt * 2);
      }
      actor.update(dt);
      actor.model.uniforms.uGravity.value.set(0, -actor.model.gravity, 0);
      if (npc.group.visible) { npc.update(dt); npc.model.uniforms.uGravity.value.set(0, -npc.model.gravity, 0); }

      // camera: owner's eyes, looking down at the dog
      const op = pos(owner);
      // turn the view smoothly at corners (the path itself has sharp bends)
      camTan.lerp(tan(owner), 1 - Math.exp(-dt * 2.2)).setY(0).normalize();
      const ot = camTan;
      const camPos = new THREE.Vector3(op.x, 1.45, op.z).addScaledVector(ot, -0.6);
      camera.position.lerp(camPos, 1 - Math.exp(-dt * 4));
      const look = actor.position.clone().addScaledVector(ot, 1.2).setY(0.2);
      camera.lookAt(look);

      // leash from the owner's hand to the collar
      const hand = camera.position.clone().add(new THREE.Vector3(0, -0.55, 0)).addScaledVector(new THREE.Vector3(-ot.z, 0, ot.x), 0.22).addScaledVector(ot, 0.35);
      const collar = actor.model.bones.neck.getWorldPosition(new THREE.Vector3());
      leashGeo?.dispose();
      leashGeo = leashGeometry(hand, collar, 0.006);
      leash.geometry = leashGeo;
      if (npc.group.visible) {
        const nc = npc.model.bones.neck.getWorldPosition(new THREE.Vector3());
        const nh = nc.clone().add(new THREE.Vector3(0, 1.1, 0)).addScaledVector(npc.forward, -0.6);
        npcLeash.geometry.dispose();
        npcLeash.geometry = leashGeometry(nh, nc, 0.005);
        npcLeash.visible = true;
      } else npcLeash.visible = false;

      (progress.firstChild as HTMLElement).style.width = Math.min(100, (s / length) * 100) + '%';
      town.update?.(dt, time, actor.position);
    },
    exit() {
      game.renderer.domElement.removeEventListener('pointerdown', onDown);
      prompt?.close();
      actor.drop();
      actor.group.removeFromParent();
      npc.group.removeFromParent();
      npc.dispose();
      leashGeo?.dispose();
      poopObj?.removeFromParent();
      town.dispose();
      game.persist();
    },
  };
}

function dedupe(pts: THREE.Vector3[]) {
  const out: THREE.Vector3[] = [];
  for (const p of pts) if (!out.length || out[out.length - 1].distanceTo(p) > 0.5) out.push(p);
  return out;
}

function leashGeometry(a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const mid = a.clone().lerp(b, 0.5);
  const sag = Math.max(0.05, 1.3 - a.distanceTo(b) * 0.45);
  mid.y -= sag * 0.35;
  const c = new THREE.QuadraticBezierCurve3(a, mid, b);
  return new THREE.TubeGeometry(c, 24, r, 5, false);
}

export { findPoi };
