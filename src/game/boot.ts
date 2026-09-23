import '../ui/ui.css';
import { BREEDS } from '../dog/breeds';
import { h } from '../ui/dom';
import { Game } from './game';
import { createBath } from './scenes/bath';
import { createGym } from './scenes/gym';
import { createHome } from './scenes/home';
import { createKennel } from './scenes/kennel';
import { createPark } from './scenes/park';
import { createShop } from './scenes/shop';
import { createTitle } from './scenes/title';
import { createWalk, createWalkMap } from './scenes/walk';
import { createContest } from './scenes/contest';
import { sound } from './sound';
import { loadSave, newDog, newSave, simulateTime, writeSave } from './state';
import { TRICKS } from './tricks';

export async function boot() {
  const app = document.getElementById('app')!;
  const loading = h('div', { class: 'loading' }, h('div', { class: 'paw' }, '🐾'), 'Loading…');
  document.body.append(loading);
  const game = new Game(app);
  (window as any).game = game;
  (window as any).__sound = sound;
  game.register('title', createTitle);
  game.register('kennel', createKennel);
  game.register('home', createHome);
  game.register('bath', createBath);
  game.register('shop', createShop);
  game.register('walkmap', createWalkMap);
  game.register('walk', createWalk);
  game.register('park', createPark);
  game.register('gym', createGym);
  game.register('contest', createContest);
  await game.preload();

  const params = new URLSearchParams(location.search);
  const quick = params.get('quickstart');
  let save = loadSave();
  if (quick) {
    const breed = BREEDS.find((b) => b.id === quick) ?? BREEDS[0];
    save = newSave('Player');
    const coat = breed.coats[Number(params.get('coat') || 0)] ?? breed.coats[0];
    const d = newDog(params.get('name') || 'Biscuit', breed.id, coat.id, 'male');
    d.nameLearned = params.has('lesson') ? 0 : 1;
    save.dogs.push(d);
    save.activeDog = d.id;
    // debug helpers: &tricks=all|sit,down  &dogs=shiba,pug  &op=1200
    const tricks = params.get('tricks');
    if (tricks) {
      for (const t of TRICKS) {
        if (tricks === 'all' || tricks.split(',').includes(t.id)) d.tricks[t.id] = { command: t.hint, reps: t.reps, learned: true, mastery: 0.8 };
      }
    }
    const extra = params.get('dogs');
    if (extra) {
      const names = ['Mochi', 'Pepper', 'Luna'];
      extra.split(',').forEach((id, i) => {
        const b = BREEDS.find((x) => x.id === id);
        if (b) save!.dogs.push({ ...newDog(names[i] ?? 'Pup' + i, b.id, b.coats[0].id, i % 2 ? 'male' : 'female'), nameLearned: 1 });
      });
    }
    if (params.get('op')) save.ownerPoints = Number(params.get('op'));
    save.inventory = { ...save.inventory, frisbee: 1, rope: 1, squeaky: 1, rubberBall: 1, collarRed: 1, bandana: 1, milk: 2, cannedFood: 2 };
    if (!params.has('persist')) (window as any).__noPersist = true;
  }
  if (save) simulateTime(save);
  game.save = save ?? newSave('');
  if (!(window as any).__noPersist) writeSave(game.save);
  const retro = params.get('retro') ?? game.save.settings.retro ?? 'subtle';
  game.engine.retro.mode = retro === 'off' || retro === 'ds' ? retro : 'subtle';
  game.engine.start();
  if (params.has('fps')) {
    const el = h('div', { style: { position: 'fixed', right: '8px', bottom: '8px', zIndex: '99', font: '12px monospace', color: '#fff', background: '#0009', padding: '4px 8px', borderRadius: '6px', whiteSpace: 'pre' } });
    document.body.append(el);
    let frames = 0, last = performance.now();
    const prev = game.engine.onFrame;
    game.engine.renderer.info.autoReset = true;
    game.engine.onFrame = (dt) => {
      prev?.(dt);
      frames++;
      const now = performance.now();
      if (now - last > 1000) {
        const i = game.engine.renderer.info;
        el.textContent = `${Math.round((frames * 1000) / (now - last))} fps  ${i.render.calls} calls  ${(i.render.triangles / 1e6).toFixed(2)}M tris`;
        (window as any).__fps = Math.round((frames * 1000) / (now - last));
        frames = 0;
        last = now;
      }
    };
  }
  sound.setVolumes(game.save.settings.music, game.save.settings.sfx);
  const start = params.get('scene');
  if (quick) await game.go(start || 'home', start === 'shop' ? { kind: 'pet' } : undefined);
  else await game.go('title');
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 400);
  // unlock audio on first gesture
  const unlock = () => { sound.init().then(() => sound.setVolumes(game.save.settings.music, game.save.settings.sfx)); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}
