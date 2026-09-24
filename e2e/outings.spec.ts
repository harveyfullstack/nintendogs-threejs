import { expect, test, type Page } from '@playwright/test';
import { Player } from './helpers';

// Leaving the house: walks, shops, contests, the bath, the park and the kennel.
// Each one must be playable by touch and must always have a way back.

const hud = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function goOut(player: Player, page: Page, where: string, scene: string) {
  await player.tap(hud(page, 'Go Out'));
  await player.tap(page.locator('.option-grid .card').filter({ has: page.locator('.name').getByText(where, { exact: true }) }));
  await player.scene(scene);
}

test('walk: tap streets to plan a route, walk it, stop at the shop and buy', async ({ page }, testInfo) => {
  const player = await Player.open(page, testInfo, '/?quickstart=corgi');
  await player.scene('home');
  await goOut(player, page, 'Walk', 'walkmap');

  // the map is 5×4 blocks; corner (i, j) sits at these fractions of the canvas
  const map = page.locator('.walkmap canvas');
  const box = (await map.boundingBox())!;
  const corner = (i: number, j: number) => ({ x: box.x + (box.width * (85 + 270 * i)) / 1520, y: box.y + (box.height * (60 + 270 * j)) / 1200 });
  const info = page.locator('.walkmap .info');

  // one tap two blocks away: the route follows the streets there (and back home)
  await player.tapAt(corner(3, 2).x, corner(3, 2).y);
  await expect(info).toContainText('Route: 5/14');
  // tapping back along the route shortens it
  await player.tapAt(corner(2, 2).x, corner(2, 2).y);
  await expect(info).toContainText('Route: 3/14');
  await player.tap(page.getByRole('button', { name: "Let's go!", exact: true }));
  await player.scene('walk');

  // walk on until we pass Pet Supply, then pop in
  const prompt = page.locator('.backdrop', { hasText: 'Pet Supply' });
  for (let i = 0; i < 30 && !(await prompt.isVisible()); i++) await player.advance(4);
  const progress = await page.locator('.walk-bar .bar > i').evaluate((el) => parseFloat((el as HTMLElement).style.width));
  expect(progress).toBeGreaterThan(0);
  await player.tap(prompt.getByRole('button', { name: 'Go in', exact: true }));
  await player.scene('shop');
  expect(await player.state(() => (window as any).game.dog.walks)).toBe(1);

  // buy food (a consumable) and a toy (one-off: then it shows as owned)
  const money0 = await player.state(() => (window as any).game.save.money);
  await player.tap(page.locator('.shop-panel .card', { hasText: 'Premium Food' }).getByRole('button'));
  await player.tap(page.locator('.shop-panel .tab', { hasText: 'Toys' }));
  const teddy = page.locator('.shop-panel .card', { hasText: 'Teddy Bear' });
  await player.tap(teddy.getByRole('button'));
  await expect(teddy.getByRole('button')).toHaveText('Owned');
  const save = await player.state(() => { const s = (window as any).game.save; return { money: s.money, premium: s.inventory.premiumFood, teddy: s.inventory.plushie }; });
  expect(save).toEqual({ money: money0 - 40 - 35, premium: 1, teddy: 1 });
  await player.tap(page.getByRole('button', { name: 'Leave', exact: true }));
  await player.scene('home');
  player.expectNoErrors();
});

test('gym: disc, obedience and agility can all be played and left', async ({ page }, testInfo) => {
  const player = await Player.open(page, testInfo, '/?quickstart=corgi');
  await player.scene('home');
  await goOut(player, page, 'Gym', 'gym');
  const vp = page.viewportSize()!;
  const enter = (contest: string) => player.tap(page.locator('.gym-grid .card', { hasText: contest }).getByRole('button', { name: /Beginner/ }));
  const handToy = () => player.state(() => (window as any).__play?.handToy?.kind ?? null);

  // disc: the disc starts in your hand
  await enter('Disc');
  await player.scene('contest');
  await expect.poll(handToy, { timeout: 60_000 }).toBe('frisbee');
  // letting go without a flick puts it back in your hand instead of leaving it on the grass
  await player.tapAt(vp.width / 2, vp.height * 0.72);
  expect(await handToy()).toBeNull();
  await player.advance(2);
  expect(await handToy()).toBe('frisbee');
  // a flick throws it; caught or not, the contest moves on to the next throw
  await player.pause();
  await player.flick({ x: vp.width / 2, y: vp.height * 0.75 }, -Math.min(300, vp.height * 0.45));
  expect(await handToy()).toBeNull();
  await player.resume();
  const banner = page.locator('.mode-banner.top');
  for (let i = 0; i < 12 && !/Throw 2 of 3/.test(await banner.innerText()); i++) await player.advance(3);
  await expect(banner).toContainText('Throw 2 of 3');
  await player.tap(page.getByRole('button', { name: 'Leave', exact: true }));
  await player.scene('gym');

  // obedience: if you can't answer the judge, time runs out and the trial carries on
  await enter('Obedience');
  await player.scene('contest');
  await expect(page.locator('.mode-banner.top')).toContainText('Judge:', { timeout: 60_000 });
  await player.advance(10);
  await expect(page.locator('.toast', { hasText: 'No points' })).toBeVisible();
  await player.tap(page.getByRole('button', { name: 'Leave', exact: true }));
  await player.scene('gym');

  // agility: hold a finger where the pup should run
  await enter('Agility');
  await player.scene('contest');
  const pos0 = await player.state(() => (window as any).game.engine.current.scene.children.find((o: any) => o.userData.actor).position.toArray());
  await player.press({ x: vp.width / 2, y: vp.height * 0.3 });
  await player.advance(2);
  await player.release();
  const pos1 = await player.state(() => (window as any).game.engine.current.scene.children.find((o: any) => o.userData.actor).position.toArray());
  expect(Math.hypot(pos1[0] - pos0[0], pos1[2] - pos0[2])).toBeGreaterThan(0.3);
  await player.tap(page.getByRole('button', { name: 'Leave', exact: true }));
  await player.scene('gym');
  await player.tap(page.getByRole('button', { name: 'Leave', exact: true }));
  await player.scene('home');
  player.expectNoErrors();
});

test('bath, park and a kennel visit', async ({ page }, testInfo) => {
  const player = await Player.open(page, testInfo, '/?quickstart=corgi');
  await player.scene('home');

  // bath: Supplies → Care → Shampoo, then lather the pup with a finger
  await player.tap(hud(page, 'Supplies'));
  await player.tap(page.locator('.drawer .tab', { hasText: 'Care' }));
  await player.tap(page.locator('.drawer .card', { hasText: 'Shampoo' }));
  await player.scene('bath');
  await player.pause();
  const pup = await player.dogOnScreen(0);
  for (let k = 0; k < 4; k++) {
    await player.drag([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ x: pup.x - 40 + i * 10, y: pup.y + (k % 2 ? 8 : -8) })), 20);
  }
  await player.resume();
  await player.advance(0.1);
  const lather = await page.locator('.hud-box .bar > i').evaluate((el) => parseFloat((el as HTMLElement).style.width));
  expect(lather).toBeGreaterThan(10);
  await player.tap(page.getByRole('button', { name: 'Stop', exact: true }));
  await player.scene('home');

  // park (reached from walks): throw a toy from the toy bar, then go home
  await player.state(() => (window as any).game.go('park'));
  await player.scene('park');
  await player.tap(page.locator('.toy-btn').first());
  expect(await player.state(() => (window as any).__play.handToy)).not.toBeNull();
  const vp = page.viewportSize()!;
  await player.pause();
  await player.flick({ x: vp.width / 2, y: vp.height * 0.65 }, -Math.min(260, vp.height * 0.4));
  expect(await player.state(() => (window as any).__play.focus.brain.activity)).toBe('chase');
  await player.resume();
  await player.tap(hud(page, 'Go Home'));
  await player.scene('home');

  // kennel with a full house: you can meet puppies but not take one
  await goOut(player, page, 'Kennel', 'kennel');
  await expect(page.locator('.kennel-info h2')).toHaveText('Meet the puppies');
  await player.tap(page.locator('.kennel-breeds .card', { hasText: 'Beagle' }));
  await expect(page.locator('.pup-chip:not(.pending)')).toHaveCount(3, { timeout: 240_000 });
  await expect(page.locator('.adopt-btn')).toHaveText('Just visiting');
  await expect(page.locator('.adopt-btn')).toBeDisabled();
  await player.tap(page.getByRole('button', { name: 'Back home', exact: true }));
  await player.scene('home');
  player.expectNoErrors();
});
