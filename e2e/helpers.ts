import { expect, type CDPSession, type Locator, type Page, type TestInfo } from '@playwright/test';

export type Point = { x: number; y: number };

/**
 * Plays the game like a person would: real touch events on phones (so the game sees
 * pointerType "touch", taps, drags and pinches), mouse clicks on desktop.
 *
 * Without a GPU the game renders at ~1 fps, which would make puppies take minutes to
 * cross a room. So the player can also pause the frame loop (for exact taps and clean
 * flicks) and fast-forward the simulation without rendering.
 */
export class Player {
  readonly errors: string[] = [];
  private cdp: CDPSession | null = null;

  private constructor(readonly page: Page, readonly touch: boolean) {}

  static async open(page: Page, testInfo: TestInfo, url = '/') {
    const player = new Player(page, !!testInfo.project.use.hasTouch);
    if (player.touch) player.cdp = await page.context().newCDPSession(page);
    page.on('pageerror', (e) => player.errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') player.errors.push(m.text()); });
    await page.addInitScript(() => {
      // let tests hold the game loop still
      const raf = window.requestAnimationFrame.bind(window);
      const w = window as any;
      w.__frames = { paused: false, queue: [] as FrameRequestCallback[] };
      window.requestAnimationFrame = (cb) => {
        if (w.__frames.paused) { w.__frames.queue.push(cb); return 0; }
        return raf(cb);
      };
      w.__resumeFrames = () => { w.__frames.paused = false; for (const cb of w.__frames.queue.splice(0)) raf(cb); };
    });
    await page.goto(url);
    return player;
  }

  // ------------------------------------------------------------------ input

  async tapAt(x: number, y: number) {
    if (!this.cdp) { await this.page.mouse.click(x, y); return; }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /**
   * Tap the middle of an element, scrolling its list to it first if needed.
   * The game loop is held meanwhile: a 1 s software-rendered frame landing between finger
   * down and up would apply pending layout (pop-in animations, scrolling) mid-tap, and the
   * browser then sends the click to the parent instead. Real phones don't have 1 s frames.
   */
  async tap(target: Locator) {
    await expect(target).toBeVisible();
    const held = await this.page.evaluate(() => (window as any).__frames.paused as boolean);
    if (!held) await this.pause();
    try {
      await target.scrollIntoViewIfNeeded();
      // wait for animations and smooth scrolling to settle so the finger lands on the element
      let box = await target.boundingBox();
      for (let i = 0; i < 25; i++) {
        await this.page.waitForTimeout(120);
        const next = await target.boundingBox();
        if (box && next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5 && Math.abs(next.width - box.width) < 0.5) break;
        box = next;
      }
      if (!box) throw new Error('nothing to tap');
      await this.tapAt(box.x + box.width / 2, box.y + box.height / 2);
      await this.page.waitForTimeout(150);
    } finally {
      if (!held) await this.resume();
    }
  }

  /** Press, move along a path and let go (a stroke, drag or flick). */
  async drag(path: Point[], stepMs = 16) {
    const [first, ...rest] = path;
    if (!this.cdp) {
      await this.page.mouse.move(first.x, first.y);
      await this.page.mouse.down();
      for (const p of rest) { await this.page.mouse.move(p.x, p.y); await this.page.waitForTimeout(stepMs); }
      await this.page.mouse.up();
      return;
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
    for (const p of rest) {
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
      await this.page.waitForTimeout(stepMs);
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** Put a finger (or the mouse button) down and keep it there. */
  async press(p: Point) {
    if (!this.cdp) { await this.page.mouse.move(p.x, p.y); await this.page.mouse.down(); return; }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  }

  async release() {
    if (!this.cdp) { await this.page.mouse.up(); return; }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** Two fingers moving apart (spread > 1) or together. */
  async pinch(center: Point, from: number, to: number, steps = 6) {
    if (!this.cdp) throw new Error('pinch needs touch');
    const at = (d: number) => [{ x: center.x - d / 2, y: center.y, id: 0 }, { x: center.x + d / 2, y: center.y, id: 1 }];
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(from)[0]] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
    for (let i = 1; i <= steps; i++) {
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + ((to - from) * i) / steps) });
      await this.page.waitForTimeout(30);
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /** A quick upward flick from a point (throwing a toy). */
  async flick(from: Point, dy = -260, dx = 0) {
    const path: Point[] = [];
    for (let i = 0; i <= 6; i++) path.push({ x: from.x + (dx * i) / 6, y: from.y + (dy * i) / 6 });
    await this.drag(path, 16);
    // To the browser a flick is a fling, and Chromium swallows a tap that comes within
    // about a second of one (it takes it for the tap that stops the fling). Let it pass,
    // or a quick tap afterwards (say, on Go Home) silently does nothing.
    if (this.cdp) await this.page.waitForTimeout(1200);
  }

  // ------------------------------------------------------------------ game time

  /** Hold the game loop still: what's on screen stays exactly where it is. */
  async pause() {
    await this.page.evaluate(() => { (window as any).__frames.paused = true; });
  }

  async resume() {
    await this.page.evaluate(() => (window as any).__resumeFrames());
  }

  /** Run the simulation forward without rendering (the game renders at ~1 fps here). */
  async advance(seconds: number, step = 1 / 20) {
    await this.page.evaluate(({ seconds, step }) => {
      const g = (window as any).game;
      const e = g.engine;
      for (let t = 0; t < seconds; t += step) {
        e.time += step;
        e.current?.update(step, e.time);
      }
      e.current?.scene.updateMatrixWorld();
      e.current?.camera.updateMatrixWorld();
      g.overlay.update();
    }, { seconds, step });
  }

  // ------------------------------------------------------------------ state

  async scene(name: string, timeout = 240_000) {
    await this.page.waitForFunction(
      (n) => { const g = (window as any).game; return g?.sceneName === n && !g.busy && !document.querySelector('.boot-loading'); },
      name, { timeout, polling: 250 },
    );
  }

  state<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn);
  }

  /** Screen position of a puppy in the current scene (0 = first one added). */
  async dogOnScreen(index = 0): Promise<Point> {
    const p = await this.page.evaluate((i) => {
      const g = (window as any).game;
      const actors = g.engine.current.scene.children.map((o: any) => o.userData.actor).filter(Boolean);
      const a = actors[i];
      return a ? g.overlay.project(a.position.clone().lerp(a.headWorld(), 0.5)) : null;
    }, index);
    if (!p) throw new Error(`no dog ${index} on screen`);
    return p;
  }

  /** Nothing went wrong on the page (uncaught errors, console.error). */
  expectNoErrors() {
    expect(this.errors, this.errors.join('\n')).toEqual([]);
  }
}

export const button = (page: Page, name: string | RegExp) => page.locator('#ui button:visible, #ui [role=button]:visible').filter({ hasText: name }).first();
