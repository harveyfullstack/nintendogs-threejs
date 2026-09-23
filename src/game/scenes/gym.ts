import * as THREE from 'three';
import { clear, h } from '../../ui/dom';
import { classLabel } from '../../ui/menus';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { sound } from '../sound';

// The Gym: pick a contest and class. Winning a class unlocks the next one.

export type ContestKind = 'disc' | 'obedience' | 'agility';
export const CLASSES = ['Beginner', 'Open', 'Expert', 'Championship'];
export const PRIZES = [[300, 150, 80], [600, 300, 150], [1000, 500, 250], [2000, 1000, 500]];

const INFO: Record<ContestKind, { title: string; emoji: string; desc: string; needs?: string }> = {
  disc: { title: 'Disc Competition', emoji: '🥏', desc: 'Throw the disc as far as your pup can catch it. Three throws; mid-air catches score double.', needs: 'frisbee' },
  obedience: { title: 'Obedience Trial', emoji: '🎓', desc: 'The judge calls out tricks. Say your commands and your pup must perform them.' },
  agility: { title: 'Agility Trial', emoji: '🏁', desc: 'Guide your pup through the course by holding the mouse where it should run. Fastest time wins!' },
};

export async function createGym(game: Game): Promise<GameScene> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d8ecff');
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const d = game.dog!;
  const bg = h('div', { class: 'passthrough', style: { position: 'absolute', inset: '0', background: 'radial-gradient(circle at 50% 30%, #fff 0, #d8ecff 60%, #b9dcf7 100%)' } });
  const content = h('div');
  const panel = h('div', { class: 'panel', style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(900px, 94vw)', animation: 'none' } },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h2', { style: { margin: 0 } }, '🏆 Gym'),
      h('button', { class: 'btn', onclick: () => game.go('home') }, 'Leave')),
    content);
  game.overlay.layer.append(bg, panel);

  const render = () => {
    clear(content);
    content.append(h('p', null, `Enter ${d.name} in a contest! Winning a class unlocks the next one. ${d.name}'s energy: ${Math.round(d.energy)}%`));
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', marginTop: '10px' } });
    for (const kind of ['disc', 'obedience', 'agility'] as ContestKind[]) {
      const info = INFO[kind];
      const won = d.contests[kind];
      const col = h('div', { class: 'card', style: { cursor: 'default', textAlign: 'left', padding: '14px' } },
        h('div', { style: { fontSize: '44px' } }, info.emoji),
        h('div', { class: 'name', style: { fontSize: '19px' } }, info.title),
        h('div', { style: { fontSize: '13px', color: '#7b8193', margin: '4px 0 10px', minHeight: '54px' } }, info.desc),
        h('div', { class: 'meta' }, `Best: ${classLabel(won)}`));
      CLASSES.forEach((c, i) => {
        const locked = i > won;
        col.append(h('button', {
          class: 'btn small' + (i === won ? ' primary' : ''), style: { width: '100%', marginTop: '8px', justifyContent: 'space-between' },
          disabled: locked ? true : undefined,
          onclick: () => {
            if (info.needs && !(game.save.inventory[info.needs] > 0) && !(game.save.inventory.goldDisc > 0)) { game.overlay.toast('You need a Flying Disc from Pet Supply!'); sound.sfx('error'); return; }
            if (d.energy < 15) { game.overlay.toast(`${d.name} is too tired. Let it rest first!`); return; }
            sound.sfx('select');
            game.go('contest', { kind, cls: i });
          },
        }, h('span', null, (locked ? '🔒 ' : '') + c), h('span', { style: { opacity: '.7', fontSize: '12px' } }, `$${PRIZES[i][0]}`)));
      });
      grid.append(col);
    }
    content.append(grid);
  };
  render();
  sound.music('contest');
  return { scene, camera, update() {} };
}
