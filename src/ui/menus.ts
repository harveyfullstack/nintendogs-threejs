import { getBreed } from '../dog/breeds';
import type { Game } from '../game/game';
import { COLLECTIBLES, ITEMS, ItemCategory, ItemDef, getItem } from '../game/items';
import { sound } from '../game/sound';
import { DOG_SLOTS, DogSave, deleteSave, maxDogs } from '../game/state';
import { TRICKS } from '../game/tricks';
import { RETRO_MODES } from '../game/retro';
import { icon, props } from '../world/loaders';
import { Tap, canFullscreen, standalone, toggleFullscreen, touchUI } from './device';
import { ICONS, clear, h, svg } from './dom';

const EMOJI: Record<string, string> = {
  dryFood: '🥣', cannedFood: '🥫', premiumFood: '🍖', jerky: '🥓', milk: '🥛', waterBottle: '💧',
  tennisBall: '🎾', rubberBall: '🔴', frisbee: '🥏', goldDisc: '🏅', rope: '🪢', squeaky: '🦆', plushie: '🧸', bone: '🦴',
  brush: '🪮', shampoo: '🧴', collarRed: '⭕', collarBlue: '🔵', bandana: '🧣', ribbon: '🎀', bowtie: '🎩', cap: '🧢', sunglasses: '🕶️', flowerCrown: '🌸',
  emptyCan: '🥫', oldBoot: '🥾', feather: '🪶', flower: '🌼', seashell: '🐚', marble: '🔮', toyCar: '🚗', glasses: '👓', pocketWatch: '⌚', trophy: '🏆', gem: '💎', goldNugget: '🪙',
};

/** Icon image (rendered prop) or emoji fallback for an item id. */
export function itemVisual(game: Game, id: string): HTMLElement {
  const def = getItem(id);
  let url = '';
  const p = props();
  try {
    if (def?.prop?.toy) url = icon(game.renderer, 'toy:' + def.prop.toy, () => p.makeToy(def.prop!.toy!).object);
    else if (def?.prop?.item) url = icon(game.renderer, 'item:' + def.prop.item, () => p.makeItem(def.prop!.item!));
    else if (!def && COLLECTIBLES.some((c) => c.id === id)) url = icon(game.renderer, 'col:' + id, () => p.makeCollectible(id as any));
  } catch { url = ''; }
  if (url) return h('img', { src: url, alt: id });
  return h('div', { class: 'emoji' }, EMOJI[id] ?? '📦');
}

const TABS: { id: ItemCategory | 'treasure'; label: string }[] = [
  { id: 'food', label: 'Food' },
  { id: 'drink', label: 'Drinks' },
  { id: 'toy', label: 'Toys' },
  { id: 'care', label: 'Care' },
  { id: 'accessory', label: 'Style' },
  { id: 'treasure', label: 'Treasures' },
];

export function suppliesDrawer(game: Game, onUse: (item: ItemDef) => void) {
  let tab: (typeof TABS)[number]['id'] = 'food';
  const tabs = h('div', { class: 'tabs' });
  const grid = h('div', { class: 'grid' });
  const body = h('div', null, h('h2', null, 'Supplies'), tabs, grid);
  const d = game.overlay.drawer(body);
  const render = () => {
    clear(tabs);
    for (const t of TABS) tabs.append(h('button', { class: 'tab' + (t.id === tab ? ' active' : ''), onclick: () => { tab = t.id; sound.sfx('select'); render(); } }, t.label));
    clear(grid);
    const inv = game.save.inventory;
    if (tab === 'treasure') {
      const owned = Object.entries(game.save.collectibles).filter(([, n]) => n > 0);
      if (!owned.length) grid.append(h('p', { style: { gridColumn: '1 / -1', color: '#7b8193' } }, 'Nothing yet. Presents turn up on walks!'));
      for (const [id, n] of owned) {
        const c = COLLECTIBLES.find((x) => x.id === id);
        grid.append(h('div', { class: 'card' }, h('span', { class: 'count' }, '×' + n), itemVisual(game, id), h('div', { class: 'name' }, c?.name ?? id), h('div', { class: 'meta' }, 'Sell at the Secondhand Shop')));
      }
      return;
    }
    const items = ITEMS.filter((i) => i.category === tab && (inv[i.id] ?? 0) > 0);
    if (!items.length) grid.append(h('p', { style: { gridColumn: '1 / -1', color: '#7b8193' } }, 'You have none. Visit the Pet Supply shop!'));
    for (const it of items) {
      const n = inv[it.id] ?? 0;
      const worn = it.category === 'accessory' && game.dog?.accessory === it.prop?.accessory;
      const card = h('div', { class: 'card' + (worn ? ' selected' : '') },
        it.consumable ? h('span', { class: 'count' }, '×' + n) : null,
        itemVisual(game, it.id),
        h('div', { class: 'name' }, it.name),
        worn ? h('div', { class: 'meta' }, 'Wearing') : null,
      );
      card.addEventListener('click', () => { sound.sfx('select'); d.close(); onUse(it); });
      grid.append(card);
    }
  };
  render();
  sound.sfx('open');
  return d;
}

export interface GoOutChoice { id: 'walk' | 'shop' | 'kennel' | 'gym' | 'secondhand' | 'park'; }

export function goOutMenu(game: Game, onPick: (id: GoOutChoice['id']) => void) {
  const dog = game.dog;
  const opt = (id: GoOutChoice['id'], title: string, desc: string, ico: keyof typeof ICONS, color: string) =>
    h('div', { class: 'card option', onclick: () => { sound.sfx('select'); m.close(); onPick(id); } },
      h('div', { class: 'icon-btn ' + color }, svg(ICONS[ico])),
      h('div', null, h('div', { class: 'name' }, title), h('div', { class: 'meta' }, desc)));
  const tired = dog && dog.energy < 20;
  const body = h('div', { class: 'panel', style: { width: 'min(640px, 92vw)' } },
    h('h2', null, 'Go Out'),
    h('div', { class: 'option-grid' },
      opt('walk', 'Walk', tired ? `${dog!.name} is tired… maybe later.` : `Take ${dog?.name ?? 'your pup'} for a walk around town.`, 'paw', 'green'),
      opt('shop', 'Pet Supply', 'Food, toys and accessories.', 'shop', 'orange'),
      opt('gym', 'Gym', 'Enter contests and win prizes.', 'trophy', 'pink'),
      opt('kennel', 'Kennel', 'Meet puppies looking for a home.', 'heart', ''),
      opt('secondhand', 'Secondhand Shop', 'Sell the treasures you found on walks.', 'star', 'orange'),
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Stay Home')),
  );
  const m = game.overlay.modal(body);
  sound.sfx('open');
  return m;
}

export function statusPanel(game: Game, onSwitch: (d: DogSave) => void) {
  const s = game.save;
  let current = game.dog!;
  const content = h('div');
  const body = h('div', { class: 'panel', style: { width: 'min(780px, 94vw)' } },
    h('button', { class: 'btn small close', onclick: () => m.close() }, '✕'), content);
  const m = game.overlay.modal(body);
  const render = () => {
    clear(content);
    const d = current;
    const breed = getBreed(d.breedId);
    const coat = breed.coats.find((c) => c.id === d.coatId);
    const days = Math.max(1, Math.floor((Date.now() - d.adoptedAt) / 86400000) + 1);
    content.append(
      h('h2', null, `${d.name} `, h('span', { style: { color: d.sex === 'male' ? '#3d8fe0' : '#f0609a' } }, d.sex === 'male' ? '♂' : '♀')),
      h('p', null, `${breed.name} · ${coat?.name ?? ''} · with you for ${days} day${days > 1 ? 's' : ''}`),
      h('p', null, `Knows its name: ${Math.round(d.nameLearned * 100)}% · Walks: ${d.walks} (${(d.walkDistance / 1000).toFixed(2)} km) · Trainer points: ${d.trainerPoints}`),
      h('p', null, `Contests — Disc: ${classLabel(d.contests.disc)} · Obedience: ${classLabel(d.contests.obedience)} · Agility: ${classLabel(d.contests.agility)}`),
      h('h3', null, 'Tricks'),
      ...TRICKS.map((t) => {
        const p = d.tricks[t.id];
        return h('div', { class: 'trick-row' },
          h('span', { class: 'tname' }, t.name),
          p?.learned ? h('span', { class: 'cmd' }, `“${p.command}”`) : p?.reps ? h('span', { class: 'pill' }, `learning “${p.command}” ${p.reps}/${t.reps}`) : h('span', { class: 'pill' }, 'not learned'),
          p?.learned ? h('span', { class: 'pill done' }, `mastery ${Math.round(p.mastery * 100)}%`) : null,
          h('span', { class: 'how' }, t.how));
      }),
    );
    if (s.dogs.length > 1) {
      content.append(h('h3', null, 'Your dogs'), h('div', { class: 'row' }, ...s.dogs.map((x) =>
        h('button', { class: 'btn small' + (x.id === s.activeDog ? ' primary' : ''), onclick: () => { current = x; if (x.id !== s.activeDog) { onSwitch(x); } render(); } }, x.name))));
    }
    const next = DOG_SLOTS[maxDogs(s)];
    content.append(h('p', { style: { color: '#7b8193', fontSize: '13px', marginTop: '12px' } },
      next !== undefined ? `Earn ${next.toLocaleString()} Owner Points to be able to keep another dog (${s.dogs.length}/${maxDogs(s)}).` : `You can keep up to ${maxDogs(s)} dogs.`));
    if (s.photos.length) {
      content.append(h('h3', null, 'Photo album'), h('div', { class: 'grid photo-grid' },
        ...s.photos.slice().reverse().map((p) => h('div', { class: 'card', onclick: () => showPhoto(game, p) },
          h('img', { src: p.dataUrl, alt: p.dogName }),
          h('div', { class: 'meta' }, `${p.dogName} · ${new Date(p.date).toLocaleDateString()}`)))));
    }
  };
  render();
  sound.sfx('open');
  return m;
}

/** A photo, big, with a way to keep it (long-press on phones, a download elsewhere). */
function showPhoto(game: Game, p: { dataUrl: string; date: number; dogName: string }) {
  const name = `${p.dogName || 'puppy'}-${new Date(p.date).toISOString().slice(0, 10)}.jpg`;
  const m = game.overlay.modal(h('div', { class: 'panel lightbox' },
    h('img', { src: p.dataUrl, alt: p.dogName, 'data-menu': '' }),
    h('div', { class: 'meta' }, `${p.dogName} · ${new Date(p.date).toLocaleDateString()}`),
    touchUI ? h('p', { style: { fontSize: '13px', color: '#7b8193' } }, 'Press and hold the photo to save it.') : null,
    h('div', { class: 'actions', style: { justifyContent: 'center' } },
      h('a', { class: 'btn', href: p.dataUrl, download: name }, 'Save'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'))));
}

export function classLabel(n: number) {
  return ['—', 'Beginner ✓', 'Open ✓', 'Expert ✓', 'Champion 🏆'][n] ?? '—';
}

export function settingsPanel(game: Game, onChange: () => void) {
  const s = game.save.settings;
  const slider = (label: string, key: 'music' | 'sfx' | 'quality', min: number, max: number, step: number) => {
    const input = h('input', { type: 'range', min, max, step, value: s[key], 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('input', () => { (s as any)[key] = Number(input.value); onChange(); game.persist(); });
    return h('div', { class: 'row slider-row' }, h('b', null, label), input);
  };
  const looks = h('div', { class: 'row', style: { gap: '6px' } });
  const renderLooks = () => {
    clear(looks);
    for (const m of RETRO_MODES) {
      looks.append(h('button', {
        class: 'tab' + (game.engine.retro.mode === m.id ? ' active' : ''),
        onclick: () => { game.engine.retro.mode = m.id; s.retro = m.id; game.persist(); sound.sfx('select'); renderLooks(); },
      }, m.label));
    }
  };
  renderLooks();
  const body = h('div', { class: 'panel', style: { width: 'min(480px, 92vw)' } },
    h('h2', null, 'Settings'),
    slider('Music', 'music', 0, 1, 0.05),
    slider('Sound effects', 'sfx', 0, 1, 0.05),
    slider('Fur quality', 'quality', 0.6, 1.3, 0.1),
    h('div', { class: 'row slider-row' }, h('b', null, 'Look'), looks),
    canFullscreen && !standalone ? h('div', { class: 'row slider-row' }, h('b', null, 'Full screen'),
      h('button', { class: 'tab', onclick: () => { sound.sfx('select'); toggleFullscreen(); } }, 'Toggle')) : null,
    h('p', { style: { fontSize: '13px', color: '#7b8193' } }, 'Fur quality applies the next time a scene loads.'),
    touchUI && !standalone && !canFullscreen ? h('p', { style: { fontSize: '13px', color: '#7b8193' } }, 'Tip: add this page to your Home Screen to play full screen.') : null,
    h('h3', null, 'How to play'),
    h('ul', { class: 'help-list' },
      touchUI
        ? h('li', null, 'Stroke your puppy with your finger to pet it. It loves chin and back rubs!')
        : h('li', null, 'Stroke your puppy with the mouse to pet it. It loves chin and back rubs!'),
      h('li', null, `${Tap} and hold on the floor and your pup will follow your hand.`),
      touchUI
        ? h('li', null, 'Tap 🎤 and say its name to call it, or tap ⌨️ to type.')
        : h('li', null, 'Hold the 🎤 button (or Space) and say its name to call it, or type in the box.'),
      h('li', null, 'Pick a toy from Supplies, then flick it to throw.'),
      h('li', null, 'Press Training (💡), guide your pup into a pose, then say a word when the light bulb appears.'),
      touchUI ? h('li', null, 'Pinch with two fingers to zoom in and out.') : null,
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn small danger', onclick: () => {
        if (confirm('Delete your save and start over?')) { deleteSave(); location.reload(); }
      } }, 'Delete save'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')),
  );
  const m = game.overlay.modal(body);
  return m;
}
