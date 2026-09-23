import * as THREE from 'three';
import { RetroPass } from './retro';

export interface GameScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  enter?(): void | Promise<void>;
  exit?(): void;
  update(dt: number, t: number): void;
  /** optional custom render; defaults to renderer.render(scene, camera) */
  render?(renderer: THREE.WebGLRenderer): void;
}

/** Shared renderer defaults for the game and all test pages. */
export function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  // The fur uses alpha-to-coverage, so the drawing buffer must have no alpha
  // channel or the page background glitters through the coat. three.js always
  // asks for an alpha channel, so we create the context ourselves.
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', {
    alpha: false, antialias: true, depth: true, stencil: false, premultipliedAlpha: true,
    preserveDrawingBuffer: true, powerPreference: 'high-performance',
  })!;
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);
  return renderer;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly timer = new THREE.Timer();
  current: GameScene | null = null;
  private running = false;
  time = 0;
  /** debug: speed up simulated time (?timescale=3) */
  timeScale = Number(new URLSearchParams(location.search).get('timescale') || 1);
  onFrame: ((dt: number) => void) | null = null;
  /** DS-style dithered output */
  readonly retro = new RetroPass();

  constructor(readonly container: HTMLElement) {
    this.renderer = createRenderer(container);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get width() { return this.container.clientWidth || window.innerWidth; }
  get height() { return this.container.clientHeight || window.innerHeight; }

  private lastSize = '';
  resize() {
    // setting a canvas's size clears it, even to the same value, so only do it on a real change
    const key = `${this.width}x${this.height}@${this.renderer.getPixelRatio()}`;
    if (key !== this.lastSize) {
      this.lastSize = key;
      this.renderer.setSize(this.width, this.height, false);
    }
    if (this.current) {
      this.current.camera.aspect = this.width / this.height;
      this.current.camera.updateProjectionMatrix();
    }
  }

  async setScene(s: GameScene) {
    if (this.current?.exit) this.current.exit();
    this.current = s;
    this.resize();
    if (s.enter) await s.enter();
    this.resize();
  }

  // Fur is fill-rate heavy, so on slower GPUs / Retina screens drop the pixel
  // ratio a notch at a time until frames are comfortably fast.
  private frameAcc = 0;
  private frameCount = 0;
  private pendingRatio = 0;
  /** off for deterministic recordings (?fixedres) */
  adaptive = !new URLSearchParams(location.search).has('fixedres');
  private adaptResolution(rawDt: number) {
    if (!this.adaptive) return;
    if (!(rawDt > 0) || rawDt > 0.25) return; // ignore tab switches and loading hitches
    this.frameAcc += rawDt;
    this.frameCount++;
    if (this.frameAcc < 3) return;
    const avg = this.frameAcc / this.frameCount;
    this.frameAcc = 0;
    this.frameCount = 0;
    // only ever step down (never bounce back up), so there's no oscillation
    const r = this.renderer.getPixelRatio();
    if (avg > 1 / 40 && r > 1) this.pendingRatio = Math.max(1, r - 0.25);
  }
  /** Resizing clears the canvas, so only do it right before a render. */
  private applyPendingRatio() {
    if (!this.pendingRatio) return;
    this.renderer.setPixelRatio(this.pendingRatio);
    this.pendingRatio = 0;
    this.resize();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (ts: number) => {
      if (!this.running) return;
      this.timer.update(ts);
      const dt = Math.min(0.05, this.timer.getDelta()) * this.timeScale;
      this.time += dt;
      if (this.current) {
        this.applyPendingRatio();
        this.current.update(dt, this.time);
        if (this.current.render) this.current.render(this.renderer);
        else if (this.retro.enabled) this.retro.render(this.renderer, this.current.scene, this.current.camera);
        else this.renderer.render(this.current.scene, this.current.camera);
      }
      this.onFrame?.(dt);
      this.adaptResolution(this.timer.getDelta());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
