import * as THREE from 'three';
import { Brain } from '../../dog/brain';
import { BREEDS } from '../../dog/breeds';
import { touchUI } from '../../ui/device';
import { h } from '../../ui/dom';
import { SayBox } from '../../ui/hud';
import { loadAgility, loadDiscArena, loadObedience } from '../../world/loaders';
import type { AgilityObstacle, Place } from '../../world/types';
import { FollowCamera } from '../cameraRig';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { PlayController, PlayDog } from '../play';
import { sound } from '../sound';
import { clamp } from '../state';
import { ToyWorld, holdToy } from '../toyPhysics';
import { TRICKS, TrickId, getTrick, normalizeWords, similarity } from '../tricks';
import { CLASSES, ContestKind, PRIZES } from './gym';

const NPC_NAMES = ['Max', 'Bella', 'Coco', 'Rocky', 'Luna', 'Teddy', 'Mochi', 'Daisy', 'Bruno', 'Ruby', 'Pepper', 'Hachi', 'Nala', 'Ollie', 'Kuma', 'Maple'];

interface Result { name: string; breed: string; score: number; you?: boolean }

export async function createContest(game: Game, args: { kind: ContestKind; cls: number }): Promise<GameScene> {
  if (args.kind === 'disc') return discContest(game, args.cls);
  if (args.kind === 'obedience') return obedienceContest(game, args.cls);
  return agilityContest(game, args.cls);
}

function npcs(n: number, scoreFn: () => number): Result[] {
  const names = [...NPC_NAMES].sort(() => Math.random() - 0.5);
  return Array.from({ length: n }, (_, i) => ({ name: names[i], breed: BREEDS[Math.floor(Math.random() * BREEDS.length)].name, score: scoreFn() }));
}

function setupPlace(scene: THREE.Scene, p: Place) {
  scene.add(p.group);
  scene.environment = p.environment ?? null;
  scene.background = p.background ?? new THREE.Color('#a9d7f5');
  if (p.fog) scene.fog = p.fog;
}

/** Results podium and prizes. `lowerIsBetter` for agility times. */
function showResults(game: Game, kind: ContestKind, cls: number, you: Result, others: Result[], unit: string, lowerIsBetter = false) {
  const d = game.dog!;
  const all = [...others, you].sort((a, b) => (lowerIsBetter ? a.score - b.score : b.score - a.score));
  const place = all.indexOf(you) + 1;
  const prize = place <= 3 ? PRIZES[cls][place - 1] : 0;
  if (prize) game.earn(prize);
  d.trainerPoints += [30, 20, 10][place - 1] ?? 5;
  d.energy = clamp(d.energy - 15);
  d.mood = clamp(d.mood + (place === 1 ? 15 : 5));
  let unlocked = '';
  if (place === 1 && d.contests[kind] === cls) {
    d.contests[kind] = cls + 1;
    unlocked = cls + 1 < CLASSES.length ? `${CLASSES[cls + 1]} class unlocked!` : 'You are the Champion!';
  }
  game.ownerPoints(place === 1 ? 50 : 20);
  game.persist();
  sound.music('results');
  sound.sfx(place === 1 ? 'fanfare' : 'applause');
  const medal = ['🥇', '🥈', '🥉'][place - 1] ?? '🎗️';
  game.overlay.modal(h('div', { class: 'panel', style: { width: 'min(520px, 92vw)', textAlign: 'center' } },
    h('div', { style: { fontSize: '64px' } }, medal),
    h('h2', null, place === 1 ? `${d.name} wins!` : `${d.name} placed #${place}`),
    h('p', null, `${CLASSES[cls]} class`),
    h('div', { style: { textAlign: 'left', margin: '12px 0' } }, ...all.map((r, i) =>
      h('div', { class: 'trick-row' + (r.you ? ' you' : '') },
        h('span', { class: 'tname' }, `${i + 1}. ${r.name}`),
        h('span', { class: 'how' }, r.breed),
        h('b', null, `${lowerIsBetter ? r.score.toFixed(1) : Math.round(r.score)} ${unit}`)))),
    prize ? h('p', { class: 'price', style: { fontSize: '22px', color: '#2c9b4a', fontFamily: 'var(--round)' } }, `Prize: $${prize}`) : null,
    unlocked ? h('p', null, h('b', null, unlocked)) : null,
    h('div', { class: 'actions', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', onclick: () => game.go('gym') }, 'Back to Gym'),
      h('button', { class: 'btn primary', onclick: () => game.go('home') }, 'Go home'))), { dismiss: false });
}

function banner(game: Game) {
  const el = h('div', { class: 'mode-banner top show' });
  const score = h('div', { class: 'panel score-box' });
  // you can always walk away from a contest (no prize, no penalty)
  const leave = h('button', { class: 'btn small corner-tl', onclick: () => game.go('gym') }, 'Leave');
  game.overlay.layer.append(el, score, leave);
  return { el, score };
}

// ------------------------------------------------------------------ disc

async function discContest(game: Game, cls: number): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  const arena = await loadDiscArena(game.renderer);
  setupPlace(scene, arena);
  const d = game.dog!;
  const actor = await game.actorFor(d);
  game.resetActor(actor);
  actor.bounds = arena.bounds;
  actor.obstacles = arena.obstacles;
  const line = arena.throwLine.clone();
  actor.place(line.x + 0.4, line.z + 0.6, 0);
  scene.add(actor.group);
  const camBase = { position: line.clone().add(new THREE.Vector3(0, 1.35, -1.6)), target: line.clone().add(new THREE.Vector3(0, 0.3, 4)), fov: 55 };
  const cam = new FollowCamera(camera, camBase);
  cam.follow = 0.5;
  cam.lateral = 0.5;
  const toys = new ToyWorld(scene, arena.bounds, arena.obstacles);
  toys.onBounce = (_t, i) => sound.sfx('bounce', { volume: Math.min(1, i / 3), surface: 'grass' });
  let throws = 0;
  let total = 0;
  let waiting = false;
  /** where the current throw is at, timed so the contest can never wait forever */
  let phase: 'aim' | 'flight' | 'return' | 'over' = 'aim';
  let phaseT = 0;
  const setPhase = (p: typeof phase) => { phase = p; phaseT = 0; };
  const ui = banner(game);
  const discKind = game.save.inventory.goldDisc > 0 ? 'goldDisc' : 'frisbee';
  const brain = new Brain(actor, d, {
    roam: false,
    playerSpot: () => line.clone().add(new THREE.Vector3(0.3, 0, 0.7)),
    cameraPos: () => camera.position,
    toys: () => toys.list,
    sound: (_a, k) => sound.dog(k, game.voiceOf(d)),
    emote: (a, k) => game.overlay.emote(k, a.headWorld().add(new THREE.Vector3(0, 0.1, 0)), 24),
    pickUpToy: (toy, a) => {
      const p = toy.object.getWorldPosition(new THREE.Vector3());
      const air = !toy.resting && p.y > 0.12;
      toy.carrier = a;
      toy.resting = false;
      holdToy(a, toy);
      if (!waiting) return;
      waiting = false;
      const dist = Math.max(0, p.z - line.z);
      const pts = Math.round(dist * (air ? 2 : 1));
      total += pts;
      throws++;
      sound.sfx(air ? 'catch' : 'pop');
      sound.sfx('applause', { volume: air ? 0.8 : 0.3 });
      game.overlay.toast(air ? `Great catch! ${dist.toFixed(1)} m × 2 = ${pts}` : `${dist.toFixed(1)} m = ${pts}`, air);
      updateUi();
      setPhase('return');
    },
    releaseToy: (toy, a) => {
      const at = a.mouthWorld();
      a.drop();
      toys.dropAt(toy as any, at);
      if (phase === 'return') afterThrow();
    },
  });
  brain.enabled = false;
  const pd: PlayDog = { save: d, actor, brain };
  const play = new PlayController(game, camera, [pd], toys, scene);
  play.throwScale = discKind === 'goldDisc' ? 5.5 : 4.6;
  const origThrown = brain.toyThrown.bind(brain);
  brain.toyThrown = (toy) => { waiting = true; setPhase('flight'); origThrown(toy); };
  const afterThrow = () => {
    if (phase === 'over') return;
    if (throws >= 3) { setPhase('over'); setTimeout(finish, 800); }
    else { setPhase('aim'); setTimeout(nextThrow, 600); }
  };
  const updateUi = () => {
    ui.el.textContent = throws < 3 ? `Throw ${throws + 1} of 3 — flick the disc down the field!` : 'Finished!';
    ui.score.textContent = `Score: ${total}`;
  };
  const nextThrow = () => {
    if (phase === 'over') return;
    setPhase('aim');
    for (const t of [...toys.list]) toys.remove(t);
    play.holdToy(discKind as any);
    actor.rig.setPose('stand', 6);
    actor.face(new THREE.Vector3(line.x, 0, line.z + 10));
    updateUi();
  };
  const finish = () => {
    const ranges = [[18, 50], [40, 80], [65, 115], [95, 160]][cls];
    const others = npcs(4, () => ranges[0] + Math.random() * (ranges[1] - ranges[0]));
    showResults(game, 'disc', cls, { name: d.name, breed: 'You', score: total, you: true }, others, 'pts');
  };
  setTimeout(nextThrow, 800);
  sound.music('contest');
  sound.sfx('start');
  return {
    scene,
    camera,
    update(dt, t) {
      brain.update(dt);
      actor.update(dt);
      actor.model.uniforms.uGravity.value.set(0, -actor.model.gravity, 0);
      toys.update(dt);
      play.update(dt);
      const disc = toys.list[0];
      phaseT += dt;
      if (phase === 'aim' && phaseT > 1 && disc && !disc.inHand && !disc.carrier && disc.resting) {
        // let go without a flick: back into your hand rather than left lying on the grass
        play.holdToy(discKind as any);
        game.overlay.toast('Flick the disc up the screen to throw it!');
        phaseT = 0;
      } else if (phase === 'flight' && (phaseT > 16 || (phaseT > 2 && brain.activity !== 'chase'))) {
        // the pup never got to it (or gave up): a miss, and on to the next throw
        waiting = false;
        throws++;
        brain.call();
        game.overlay.toast('The disc got away! No points this time.');
        updateUi();
        afterThrow();
      } else if (phase === 'return' && phaseT > 16) {
        // caught it but won't bring it back: call the pup off and carry on
        brain.call();
        actor.drop();
        afterThrow();
      }
      const focus = disc && !disc.inHand ? disc.object.getWorldPosition(new THREE.Vector3()).lerp(actor.headWorld(), 0.5) : actor.headWorld();
      // move the camera down the field to keep the action in view
      const ahead = Math.max(0, focus.z - line.z - 6);
      camBase.position.z = line.z - 1.6 + ahead * 0.6;
      camBase.position.y = 1.35 + ahead * 0.05;
      cam.update(dt, focus);
      arena.update?.(dt, t, actor.position);
    },
    exit() {
      play.dispose();
      actor.drop();
      actor.group.removeFromParent();
      for (const t of [...toys.list]) toys.remove(t);
      arena.dispose();
    },
  };
}

// ------------------------------------------------------------------ obedience

async function obedienceContest(game: Game, cls: number): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  const ring = await loadObedience(game.renderer);
  setupPlace(scene, ring);
  const d = game.dog!;
  const actor = await game.actorFor(d);
  game.resetActor(actor);
  actor.bounds = ring.bounds;
  actor.obstacles = ring.obstacles;
  const start = ring.start.clone();
  const cam = new FollowCamera(camera, ring.camera);
  const playerSpot = cam.playerSpot(0, 0.9);
  actor.place(start.x, start.z, Math.atan2(camera.position.x - start.x, camera.position.z - start.z));
  scene.add(actor.group);
  const brain = new Brain(actor, d, {
    roam: false,
    playerSpot: () => playerSpot,
    cameraPos: () => camera.position,
    toys: () => [],
    sound: (_a, k) => sound.dog(k, game.voiceOf(d)),
    emote: (a, k) => game.overlay.emote(k, a.headWorld().add(new THREE.Vector3(0, 0.1, 0)), 24),
  });
  brain.enabled = false;
  // commands by class
  const pools: (TrickId | 'come')[][] = [
    ['sit', 'down', 'come', 'sit', 'shake'],
    ['sit', 'down', 'shake', 'beg', 'come', 'rollover'],
    ['sit', 'down', 'rollover', 'spin', 'beg', 'playdead', 'come'],
    ['down', 'rollover', 'playdead', 'standup', 'spin', 'jump', 'bow', 'come'],
  ];
  const list = [...pools[cls]].sort(() => Math.random() - 0.5);
  let idx = -1;
  let timeLeft = 0;
  let score = 0;
  let awaiting: TrickId | 'come' | null = null;
  /** judge's command number, so a late callback can't score a command twice */
  let round = 0;
  let settled = true;
  /** seconds the pup has been busy answering (-1: not answering); a stalled answer times out */
  let answerT = -1;
  const ui = banner(game);
  const timer = h('div', { class: 'bar contest-timer' }, h('i', { style: { width: '100%', background: '#ff9b30' } }));
  game.overlay.layer.append(timer);
  const max = list.length * 15;

  const next = () => {
    idx++;
    if (idx >= list.length) return finish();
    const c = list[idx];
    round++;
    settled = false;
    answerT = -1;
    awaiting = c;
    timeLeft = 9;
    if (c === 'come') {
      // send the pup to the far side first
      const far = start.clone().add(new THREE.Vector3(0, 0, -2.2));
      actor.goTo(far, { speed: 0.6, arrive: 0.1, faceAfter: camera.position, onArrive: () => { actor.rig.setPose('sit', 5); brain.posture = 'sit'; } });
      ui.el.textContent = `Judge: “Call your dog!” (say ${d.name})`;
    } else {
      const def = getTrick(c)!;
      ui.el.textContent = `Judge: “${def.name}!”`;
    }
    sound.sfx('countdown');
  };
  const award = (ok: boolean, r = round) => {
    if (r !== round || settled) return;
    settled = true;
    answerT = -1;
    const bonus = Math.round(timeLeft * 0.6);
    if (ok) { score += 10 + bonus; sound.sfx('applause', { volume: 0.5 }); game.overlay.toast(`Well done! +${10 + bonus}`); }
    else { sound.sfx('error'); game.overlay.toast('No points…'); }
    awaiting = null;
    ui.score.textContent = `Score: ${score}`;
    setTimeout(next, 2600);
  };
  const say = new SayBox((text) => {
    game.overlay.heard(text);
    if (!awaiting) return;
    const t = normalizeWords(text);
    if (awaiting === 'come') {
      if (similarity(t, d.name) > 0.62 && Math.random() < 0.4 + d.nameLearned * 0.6) {
        const r = round;
        actor.goTo(playerSpot, { speed: actor.size * 4, arrive: 0.12, faceAfter: camera.position, onArrive: () => { actor.rig.setPose('sit', 5); brain.posture = 'sit'; award(true, r); } });
        awaiting = null;
        answerT = 0;
      } else brain.confused();
      return;
    }
    // which learned trick did the owner say?
    let best: TrickId | null = null, bs = 0;
    for (const [id, p] of Object.entries(d.tricks)) {
      if (!p?.learned) continue;
      const s = similarity(t, p.command);
      if (s > bs) { bs = s; best = id as TrickId; }
    }
    if (!best || bs < 0.62) { brain.confused(); return; }
    const p = d.tricks[best]!;
    const want = awaiting;
    if (Math.random() > 0.6 + p.mastery * 0.38) { brain.confused(); return; }
    awaiting = null;
    answerT = 0;
    const r = round;
    brain.performTrick(best, () => {
      p.mastery = Math.min(1, p.mastery + 0.04);
      award(best === want, r);
    });
  }, { solo: true, notify: (t) => game.overlay.toast(t) });
  game.overlay.layer.append(say.el);
  const finish = () => {
    ui.el.textContent = 'All done!';
    const rng = [[0.3, 0.6], [0.45, 0.72], [0.6, 0.85], [0.72, 0.95]][cls];
    const others = npcs(4, () => Math.round(max * (rng[0] + Math.random() * (rng[1] - rng[0]))));
    setTimeout(() => showResults(game, 'obedience', cls, { name: d.name, breed: 'You', score, you: true }, others, 'pts'), 800);
  };
  const known = TRICKS.filter((t) => d.tricks[t.id]?.learned).length;
  game.overlay.toast(known ? `${CLASSES[cls]} Obedience Trial — listen to the judge!` : `${d.name} doesn't know any tricks yet… this could be tough!`);
  setTimeout(next, 2000);
  ui.score.textContent = 'Score: 0';
  sound.music('contest');
  return {
    scene,
    camera,
    update(dt, t) {
      if (awaiting) {
        timeLeft -= dt;
        (timer.firstChild as HTMLElement).style.width = Math.max(0, timeLeft / 9) * 100 + '%';
        if (timeLeft <= 0) award(false);
      } else if (answerT >= 0) {
        // the pup's answer got interrupted (or it never made it over): no points, next command
        answerT += dt;
        if (answerT > 10) award(false);
      }
      brain.update(dt);
      actor.update(dt);
      actor.model.uniforms.uGravity.value.set(0, -actor.model.gravity, 0);
      cam.update(dt, actor.headWorld());
      ring.update?.(dt, t, actor.position);
    },
    exit() {
      say.dispose();
      actor.group.removeFromParent();
      ring.dispose();
    },
  };
}

// ------------------------------------------------------------------ agility

async function agilityContest(game: Game, cls: number): Promise<GameScene> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  const course = await loadAgility(game.renderer);
  const d = game.dog!;
  if (!course) {
    game.overlay.modal(h('div', { class: 'panel' }, h('h2', null, 'Agility'), h('p', null, 'The agility course is being built. Check back soon!'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => game.go('gym') }, 'OK'))), { dismiss: false });
    return { scene, camera, update() {} };
  }
  setupPlace(scene, course);
  const actor = await game.actorFor(d);
  game.resetActor(actor);
  actor.bounds = course.bounds;
  const obs = course.course;
  const startO = obs[0];
  actor.place(startO.position.x - startO.dir.x * 1.2, startO.position.z - startO.dir.z * 1.2, Math.atan2(startO.dir.x, startO.dir.z));
  scene.add(actor.group);
  actor.rig.setPose('stand', 50);
  const baseSpeed = actor.size * 7.5 * (0.8 + d.energy / 500);

  let k = 0; // next obstacle index
  let running = false;
  let done = false;
  let time = 0;
  let faults = 0;
  let busy = false;
  /** seconds on the current obstacle, and which attempt it is (so a late callback can't count twice) */
  let busyT = 0;
  let attempt = 0;
  const pointer = new THREE.Vector3();
  let holding = false;
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ui = banner(game);
  ui.el.textContent = touchUI
    ? 'Touch and hold where your pup should run. Go through the obstacles in order!'
    : 'Hold the mouse where your pup should run. Go through the obstacles in order!';

  // marker over the next obstacle
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 16), new THREE.MeshStandardMaterial({ color: '#ffb400', emissive: '#ff8a00', emissiveIntensity: 0.6 }));
  marker.rotation.x = Math.PI;
  scene.add(marker);

  const el = game.renderer.domElement;
  const setP = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    ray.ray.intersectPlane(plane, pointer);
  };
  const down = (e: PointerEvent) => { holding = true; setP(e); if (!running && !done) { running = true; sound.sfx('start'); } };
  const move = (e: PointerEvent) => { if (holding) setP(e); };
  const up = () => { holding = false; };
  el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  const entry = (o: AgilityObstacle) => o.position.clone().addScaledVector(o.dir, -o.length / 2 - 0.25);
  const exit = (o: AgilityObstacle) => o.position.clone().addScaledVector(o.dir, o.length / 2 + 0.35);

  const perform = (o: AgilityObstacle) => {
    busy = true;
    busyT = 0;
    const mine = ++attempt;
    const done1 = () => { if (mine !== attempt || !busy) return; busy = false; k++; sound.sfx('pop'); if (k >= obs.length) finish(); };
    const ex = exit(o);
    switch (o.kind) {
      case 'hurdle':
      case 'tire':
        actor.jumpTo(ex, o.kind === 'tire' ? 0.32 : 0.22, 0.55, done1);
        sound.dog('yip', game.voiceOf(d));
        break;
      case 'weave': {
        const n = Math.max(4, Math.round(o.length / 0.5));
        const side = new THREE.Vector3(-o.dir.z, 0, o.dir.x);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= n; i++) {
          const p = o.position.clone().addScaledVector(o.dir, -o.length / 2 + (i / n) * o.length).addScaledVector(side, (i % 2 ? 1 : -1) * 0.18);
          pts.push(p);
        }
        pts.push(ex);
        let i = 0;
        const step = () => {
          if (i >= pts.length) { done1(); return; }
          actor.goTo(pts[i++], { speed: baseSpeed * 0.55, arrive: 0.08, onArrive: step });
        };
        step();
        break;
      }
      case 'aframe': {
        const startP = actor.position.clone();
        const len = startP.distanceTo(ex);
        actor.goTo(ex, { speed: baseSpeed * 0.6, arrive: 0.1, onArrive: () => { actor.rig.rootLift = 0; done1(); } });
        const lift = () => {
          if (!busy) return;
          const f = THREE.MathUtils.clamp(actor.position.distanceTo(startP) / len, 0, 1);
          actor.rig.rootLift = (1 - Math.abs(f * 2 - 1)) * 0.8;
          requestAnimationFrame(lift);
        };
        lift();
        break;
      }
      default:
        actor.goTo(ex, { speed: baseSpeed * (o.kind === 'tunnel' ? 0.7 : 1), arrive: 0.1, onArrive: done1 });
    }
  };

  const finish = () => {
    done = true;
    running = false;
    const total = time + faults * 5;
    ui.el.textContent = `Finished in ${total.toFixed(1)} s!`;
    const pace = [[1.25, 1.7], [1.05, 1.4], [0.9, 1.2], [0.78, 1.02]][cls];
    const par = obs.reduce((s, o, i) => s + (i ? o.position.distanceTo(obs[i - 1].position) : 0), 0) / (actor.size * 6.5);
    const others = npcs(4, () => par * (pace[0] + Math.random() * (pace[1] - pace[0])) + 3);
    setTimeout(() => showResults(game, 'agility', cls, { name: d.name, breed: 'You', score: total, you: true }, others, 's', true), 900);
  };

  sound.music('contest');
  const camPos = new THREE.Vector3();
  let first = true;
  return {
    scene,
    camera,
    update(dt, t) {
      if (running && !done) time += dt;
      ui.score.textContent = `${time.toFixed(1)} s${faults ? ` +${faults * 5}` : ''}`;
      const o = obs[Math.min(k, obs.length - 1)];
      marker.position.copy(o.position).add(new THREE.Vector3(0, 0.9 + Math.sin(t * 4) * 0.08, 0));
      marker.visible = !done;
      if (busy && !done) {
        busyT += dt;
        if (busyT > 8) {
          // stuck on an obstacle: pop the pup out the far side and carry on
          attempt++;
          busy = false;
          actor.jump = null;
          actor.stop();
          actor.rig.rootLift = 0;
          const ex = exit(obs[Math.min(k, obs.length - 1)]);
          actor.place(ex.x, ex.z, actor.heading);
          k++;
          if (k >= obs.length) finish();
        }
      }
      if (!busy && !done) {
        if (holding) actor.goTo(pointer, { speed: baseSpeed, arrive: 0.15 });
        else actor.stop();
        // auto-take the next obstacle when lined up with its entry
        const en = entry(o);
        const toEntry = actor.distanceTo(en);
        const fwd = actor.forward.clone();
        if (toEntry < 0.55 && fwd.dot(o.dir) > 0.3) {
          if (o.kind === 'start' && !running) { running = true; sound.sfx('start'); }
          perform(o);
        } else {
          // passing through a later obstacle out of order is a fault
          for (let j = k + 1; j < obs.length; j++) {
            if (actor.distanceTo(obs[j].position) < 0.3 && obs[j].kind !== 'start' && obs[j].kind !== 'finish') {
              faults++;
              game.overlay.toast('Wrong obstacle! +5 s');
              sound.sfx('error');
              actor.position.addScaledVector(actor.forward, -0.6);
              break;
            }
          }
        }
      }
      actor.update(dt);
      actor.model.uniforms.uGravity.value.set(0, -actor.model.gravity, 0);
      // high chase camera
      const back = new THREE.Vector3(Math.sin(actor.heading), 0, Math.cos(actor.heading)).multiplyScalar(-3.2);
      camPos.copy(actor.position).add(back).add(new THREE.Vector3(0, 2.6, 0));
      if (first) { camera.position.copy(camPos); first = false; }
      camera.position.lerp(camPos, 1 - Math.exp(-dt * 2));
      camera.lookAt(actor.position.clone().add(new THREE.Vector3(0, 0.2, 0)).addScaledVector(back, -0.5));
      course.update?.(dt, t, actor.position);
    },
    exit() {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      actor.group.removeFromParent();
      course.dispose();
    },
  };
}
