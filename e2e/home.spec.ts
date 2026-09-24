import { expect, test } from '@playwright/test';
import { Player } from './helpers';

// Everything on the home screen, done with fingers on phones (mouse on desktop).

test('home: feed, play, pet, talk, photos and menus', async ({ page }, testInfo) => {
  const player = await Player.open(page, testInfo, '/?quickstart=corgi');
  await player.scene('home');
  const game = <T,>(fn: () => T) => player.state(fn);
  const hud = (name: string) => page.getByRole('button', { name, exact: true });

  // feed: Supplies → Dog Food fills the bowl and closes the drawer
  await player.tap(hud('Supplies'));
  await expect(page.locator('.drawer')).toBeVisible();
  await player.tap(page.locator('.drawer .card', { hasText: 'Dog Food' }));
  await expect(page.locator('.drawer')).toHaveCount(0);
  expect(await game(() => (window as any).game.save.bowls.food)).toBe(1);

  // tapping outside the drawer closes it, and doesn't also press what's underneath
  await player.tap(hud('Supplies'));
  await expect(page.locator('.drawer')).toBeVisible();
  const train = await hud('Training').boundingBox();
  await player.tapAt(train!.x + train!.width / 2, train!.y + train!.height / 2);
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect(page.locator('.mode-banner.show')).toHaveCount(0);

  // play: pick the ball from Supplies and flick it; the pup chases it
  await player.tap(hud('Supplies'));
  await player.tap(page.locator('.drawer .tab', { hasText: 'Toys' }));
  await player.tap(page.locator('.drawer .card', { hasText: 'Tennis Ball' }));
  expect(await game(() => (window as any).__play.handToy?.kind)).toBe('tennisBall');
  const vp = page.viewportSize()!;
  await player.pause();
  await player.flick({ x: vp.width / 2, y: vp.height * 0.7 }, -Math.min(260, vp.height * 0.4));
  expect(await game(() => (window as any).__play.handToy)).toBeNull();
  expect(await game(() => (window as any).__play.focus.brain.activity)).toBe('chase');
  await player.resume();
  await player.advance(8);

  // pet: stroke the pup
  await player.pause();
  const pup = await player.dogOnScreen(0);
  await player.drag([0, 1, 2, 3, 4, 5, 6].map((i) => ({ x: pup.x - 18 + i * 6, y: pup.y + (i % 2) * 3 })), 40);
  expect(await game(() => (window as any).__play.focus.brain.activity)).toBe('petted');
  await player.resume();

  // zoom: pinch on phones, wheel on desktop
  const zoom0 = await game(() => (window as any).game.engine.current.cam.zoom);
  if (player.touch) await player.pinch({ x: vp.width / 2, y: vp.height * 0.45 }, 60, 200);
  else { await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, -400); }
  expect(await game(() => (window as any).game.engine.current.cam.zoom)).toBeLessThan(zoom0);

  // talk: type a command (the keyboard button on phones), see it heard
  if (player.touch) {
    await player.tap(page.locator('.say .kbd'));
    await expect(page.locator('.say.typing input')).toBeFocused();
  } else await player.tap(page.locator('.say input'));
  await page.keyboard.type('good boy');
  await page.keyboard.press('Enter');
  await expect(page.locator('.heard.show')).toContainText('good boy');
  if (player.touch) await expect(page.locator('.say.typing')).toHaveCount(0);

  // training mode on and off
  await player.tap(hud('Training'));
  await expect(page.locator('.mode-banner.show')).toContainText('Training');
  await player.tap(hud('Training'));
  await expect(page.locator('.mode-banner.show')).toHaveCount(0);

  // photo → it's in the album, and opens big
  await player.tap(hud('Photo'));
  await expect.poll(() => game(() => (window as any).game.save.photos.length)).toBe(1);
  await player.tap(hud('Status'));
  await player.tap(page.locator('.photo-grid .card').first());
  await expect(page.locator('.lightbox img')).toBeVisible();
  await player.tap(page.locator('.lightbox').getByRole('button', { name: 'Close', exact: true }));
  await player.tap(page.locator('.panel .close'));
  await expect(page.locator('.backdrop')).toHaveCount(0);

  // settings and the go-out menu open and close
  await player.tap(hud('Settings'));
  await player.tap(page.getByRole('button', { name: 'Done', exact: true }));
  await player.tap(hud('Go Out'));
  await expect(page.locator('.option-grid .card')).toHaveCount(5);
  await player.tap(page.getByRole('button', { name: 'Stay Home', exact: true }));
  await expect(page.locator('.backdrop')).toHaveCount(0);
  player.expectNoErrors();
});
