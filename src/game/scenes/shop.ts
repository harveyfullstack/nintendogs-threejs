import * as THREE from 'three';
import { clear, h } from '../../ui/dom';
import { itemVisual } from '../../ui/menus';
import { loadRoomThemes } from '../../world/loaders';
import type { GameScene } from '../engine';
import type { Game } from '../game';
import { COLLECTIBLES, ITEMS, ItemCategory } from '../items';
import { sound } from '../sound';

// Pet Supply and the Secondhand Shop.

export async function createShop(game: Game, args?: { kind?: 'pet' | 'secondhand' }): Promise<GameScene> {
  const kind = args?.kind ?? 'pet';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(kind === 'pet' ? '#ffe9c8' : '#e5dcf5');
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const themes = await loadRoomThemes();
  const save = game.save;

  const bg = h('div', {
    class: 'passthrough',
    style: {
      position: 'absolute', inset: '0',
      background: kind === 'pet'
        ? 'repeating-linear-gradient(45deg, #fff4e0 0 40px, #ffeccd 40px 80px)'
        : 'repeating-linear-gradient(-45deg, #efe8fb 0 40px, #e6dcf8 40px 80px)',
    },
  });
  const money = h('div', { class: 'money', style: { fontSize: '26px' } });
  const content = h('div');
  const keeper = h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '8px' } },
    h('div', { style: { fontSize: '56px' } }, kind === 'pet' ? '🧑‍🍳' : '🧙'),
    h('div', { class: 'panel', style: { padding: '10px 16px', borderRadius: '18px', animation: 'none', boxShadow: 'none', border: '3px solid #f1e3c7' } },
      kind === 'pet' ? 'Welcome to Pet Supply! Everything your pup needs.' : "Heh heh… got any treasures for me? I'll pay good money."));
  const panel = h('div', { class: 'panel', style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(920px, 94vw)', height: 'min(760px, 90vh)', display: 'flex', flexDirection: 'column', animation: 'none' } },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('h2', { style: { margin: 0 } }, kind === 'pet' ? '🛍️ Pet Supply' : '💰 Secondhand Shop'),
      money,
      h('button', { class: 'btn', onclick: () => game.go('home') }, 'Leave')),
    keeper,
    h('div', { style: { overflow: 'auto', flex: '1' } }, content));
  game.overlay.layer.append(bg, panel);

  let tab: ItemCategory | 'sell' | 'rooms' = kind === 'pet' ? 'food' : 'sell';
  const tabs = kind === 'pet'
    ? [['food', 'Food'], ['drink', 'Drinks'], ['toy', 'Toys'], ['care', 'Care'], ['accessory', 'Accessories']] as const
    : [['sell', 'Sell treasures'], ['rooms', 'Room makeovers']] as const;

  const render = () => {
    money.textContent = '$' + save.money.toLocaleString();
    clear(content);
    const tabRow = h('div', { class: 'tabs' });
    for (const [id, label] of tabs) tabRow.append(h('button', { class: 'tab' + (tab === id ? ' active' : ''), onclick: () => { tab = id; sound.sfx('select'); render(); } }, label));
    content.append(tabRow);
    const grid = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } });
    content.append(grid);
    if (tab === 'sell') {
      const owned = Object.entries(save.collectibles).filter(([, n]) => n > 0);
      if (!owned.length) grid.append(h('p', { style: { gridColumn: '1 / -1' } }, 'You have no treasures to sell. Walk your dog to find presents!'));
      for (const [id, n] of owned) {
        const c = COLLECTIBLES.find((x) => x.id === id);
        if (!c) continue;
        grid.append(h('div', { class: 'card' },
          h('span', { class: 'count' }, '×' + n),
          itemVisual(game, id),
          h('div', { class: 'name' }, c.name),
          h('div', { class: 'price' }, `$${c.value}`),
          h('button', { class: 'btn small primary', style: { marginTop: '6px' }, onclick: () => {
            save.collectibles[id] = n - 1;
            game.earn(c.value);
            sound.sfx('buy');
            render();
          } }, 'Sell')));
      }
      return;
    }
    if (tab === 'rooms') {
      for (const t of themes) {
        const owned = save.ownedRooms.includes(t.id);
        const active = save.roomTheme === t.id;
        grid.append(h('div', { class: 'card' + (active ? ' selected' : '') },
          h('div', { class: 'emoji' }, t.id === 'japanese' ? '🎍' : t.id === 'modern' ? '🏙️' : '🛋️'),
          h('div', { class: 'name' }, t.name),
          h('div', { class: 'meta', style: { fontWeight: '600' } }, t.blurb),
          owned
            ? h('button', { class: 'btn small', style: { marginTop: '6px' }, disabled: active ? true : undefined, onclick: () => { save.roomTheme = t.id; game.persist(); sound.sfx('select'); render(); } }, active ? 'Current room' : 'Use this room')
            : h('button', { class: 'btn small primary', style: { marginTop: '6px' }, onclick: () => {
              if (!game.spend(t.price)) { sound.sfx('error'); game.overlay.toast("You can't afford that."); return; }
              save.ownedRooms.push(t.id);
              save.roomTheme = t.id;
              sound.sfx('buy');
              game.overlay.toast(`Your room has been redecorated: ${t.name}!`);
              render();
            } }, `$${t.price.toLocaleString()}`)));
      }
      return;
    }
    for (const it of ITEMS.filter((i) => i.category === tab && i.price > 0)) {
      const have = save.inventory[it.id] ?? 0;
      const ownedTool = !it.consumable && have > 0;
      grid.append(h('div', { class: 'card' },
        have ? h('span', { class: 'count' }, it.consumable ? '×' + have : '✓') : null,
        itemVisual(game, it.id),
        h('div', { class: 'name' }, it.name),
        h('div', { style: { fontSize: '12px', color: '#7b8193', minHeight: '32px' } }, it.desc),
        h('button', { class: 'btn small primary', style: { marginTop: '6px' }, disabled: ownedTool ? true : undefined, onclick: () => {
          if (!game.spend(it.price)) { sound.sfx('error'); game.overlay.toast("You don't have enough money."); return; }
          save.inventory[it.id] = have + (it.id === 'shampoo' ? 3 : 1);
          sound.sfx('buy');
          game.overlay.toast(`Bought ${it.name}!`);
          render();
        } }, ownedTool ? 'Owned' : `$${it.price}`)));
    }
  };
  render();
  sound.sfx('bell');
  sound.music('shop');
  return { scene, camera, update() {} };
}
