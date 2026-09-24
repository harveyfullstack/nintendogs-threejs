import { expect, test } from '@playwright/test';
import { Player } from './helpers';

// A brand new player: title screen → name → kennel → pick a puppy → name it → home.
// This is the path that used to dead-end on phones (picking a breed showed no way on).

test('a new player can pick a puppy and take it home', async ({ page }, testInfo) => {
  const player = await Player.open(page, testInfo);
  await player.scene('title');

  await player.tap(page.locator('.press'));
  await player.tap(page.getByRole('button', { name: 'Start', exact: true }));
  const ownerName = page.locator('.backdrop .textfield');
  await player.tap(ownerName);
  await page.keyboard.type('Sam');
  await player.tap(page.getByRole('button', { name: 'OK', exact: true }));
  await player.scene('kennel');

  // the first breed's puppies come out and the first puppy is picked for you
  const chips = page.locator('.pup-chip');
  const takeHome = page.locator('.adopt-btn');
  await expect(page.locator('.pup-chip:not(.pending)')).toHaveCount(3, { timeout: 240_000 });
  await expect(chips.nth(0)).toHaveClass(/selected/);
  await expect(takeHome).toBeEnabled();
  await expect(takeHome).toHaveText(/Take me home! · \$\d+/);

  // pick with the puppy buttons…
  await player.tap(chips.nth(1));
  await expect(chips.nth(1)).toHaveClass(/selected/);
  const secondPrice = (await chips.nth(1).locator('.pup-meta').innerText()).match(/\$\d+/)![0];
  await expect(takeHome).toContainText(secondPrice);

  // …or by tapping a puppy in the pen (the frame is held so the pup is where it's drawn)
  await player.pause();
  const pup = await player.dogOnScreen(2);
  await player.tapAt(pup.x, pup.y);
  await player.resume();
  await expect(chips.nth(2)).toHaveClass(/selected/);

  // changing your mind while puppies are still arriving leaves just the new breed's litter
  await player.tap(page.locator('.kennel-breeds .card', { hasText: 'Shiba Inu' }));
  await player.tap(page.locator('.kennel-breeds .card', { hasText: 'Pug' }));
  await expect(page.locator('.kennel-info h2')).toHaveText('Pug');
  await expect(page.locator('.pup-chip:not(.pending)')).toHaveCount(3, { timeout: 240_000 });
  expect(await player.state(() => (window as any).game.engine.current.scene.children.filter((o: any) => o.userData.actor).length)).toBe(3);
  await expect(takeHome).toBeEnabled();

  // adopting asks for a name, and says so if you forget one
  const price = Number((await takeHome.innerText()).match(/\$(\d+)/)![1]);
  await player.tap(takeHome);
  const pupName = page.locator('.backdrop .textfield');
  await expect(pupName).toBeVisible();
  const adopt = page.getByRole('button', { name: /^Adopt for \$/ });
  await player.tap(adopt);
  await expect(page.locator('.form-error')).toHaveText(/name/i);
  await player.tap(pupName);
  await page.keyboard.type('Mochi');
  await player.tap(adopt);

  await player.scene('home');
  const save = await player.state(() => { const s = (window as any).game.save; return { dogs: s.dogs.map((d: any) => [d.name, d.breedId]), money: s.money }; });
  expect(save.dogs).toEqual([['Mochi', 'pug']]);
  expect(save.money).toBe(1000 - price);

  // the name lesson greets the new pup; answer it by typing (works without a microphone)
  await player.tap(page.getByRole('button', { name: 'OK!', exact: true }));
  for (let i = 0; i < 3; i++) {
    if (player.touch) await player.tap(page.locator('.say .kbd'));
    else await player.tap(page.locator('.say input'));
    await page.keyboard.type('Mochi');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }
  expect(await player.state(() => (window as any).game.dog.nameLearned)).toBeGreaterThanOrEqual(1);
  if (player.touch) await expect(page.locator('.say.typing')).toHaveCount(0);
  player.expectNoErrors();
});
