import * as THREE from 'three';
import { reportError } from '../ui/errors';
import { capAnisotropy } from '../world/texmem';
import { AdaptiveQuality, budget, refineTier } from './quality';
import { RetroPass } from './retro';
import { installShadowTweaks } from './shadows';

export interface GameScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  enter?(): void | Promise<void>;
  exit?(): void;
  update(dt: number, t: number): void;
  /** optional custom render; defaults to renderer.render(scene, camera) */
  render?(renderer: THREE.WebGLRenderer): void;
  /** Screen edges (CSS px) hidden behind opaque UI; the view is re-centred on what's left. */
  viewInset?(): { left?: number; right?: number; top?: number; bottom?: number } | null;
  /** Nothing moves in 3D (menus over a backdrop): draw once, not every frame. */
  still?: boolean;
}

// Portrait screens: scenes are framed for landscape, so widen the vertical field
// of view until the horizontal one is about the scene's own, up to a limit.
const PORTRAIT_REF_ASPECT = 1;
const MAX_PORTRAIT_FOV = 80;

function fitFov(camera: THREE.PerspectiveCamera) {
  const base: number = (camera.userData.baseFov ??= camera.fov);
  let fov = base;
  if (camera.aspect < PORTRAIT_REF_ASPECT) {
    const t = Math.tan(THREE.MathUtils.degToRad(base / 2)) * (PORTRAIT_REF_ASPECT / camera.aspect);
    fov = Math.min(MAX_PORTRAIT_FOV, Math.max(base, THREE.MathUtils.radToDeg(2 * Math.atan(t))));
  }
  camera.fov = fov;
}

function applyRendererDefaults(renderer: THREE.WebGLRenderer, container: HTMLElement) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const s = renderer.domElement.style;
  s.display = 'block';
  s.width = '100%';
  s.height = '100%';
  s.touchAction = 'none';
  container.appendChild(renderer.domElement);
}

/**
 * Renderer for the test pages and the model viewer: draws straight to the canvas.
 * The fur uses alpha-to-coverage, so the drawing buffer must have no alpha
 * channel or the page background glitters through the coat. three.js always
 * asks for an alpha channel, so we create the context ourselves.
 */
export function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', {
    alpha: false, antialias: true, depth: true, stencil: false, premultipliedAlpha: true,
    preserveDrawingBuffer: true, powerPreference: 'high-performance',
  })!;
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  applyRendererDefaults(renderer, container);
  return renderer;
}

/**
 * The game's renderer. Everything is drawn into an offscreen multisampled target
 * the size of the canvas (see retro.ts), so the canvas itself needs no depth,
 * no multisampling and no preserved buffer: the cheapest thing a phone can show.
 */
function createGameRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
    preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!context) throw new Error('WebGL 2 is not available');
  const renderer = new THREE.WebGLRenderer({ canvas, context });
  renderer.setPixelRatio(1);
  refineTier(context);
  applyRendererDefaults(renderer, container);
  tuneRenderer(renderer);
  return renderer;
}

/**
 * The game's adjustments to three's renderer internals. three.js rebuilds those
 * internals when a lost context is restored, so this runs again then.
 */
function tuneRenderer(renderer: THREE.WebGLRenderer) {
  // shadow maps are redrawn on the engine's schedule (see Engine.start)
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  installShadowTweaks(renderer);
  capAnisotropy(renderer);
  // counts cover a whole frame (scene and output pass): reset by the engine
  renderer.info.autoReset = false;
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
  /** offscreen target + output pass (DS dither or straight) */
  readonly retro = new RetroPass();
  /** frame-rate driven quality ladder */
  readonly adaptive = new AdaptiveQuality();
  /** the GPU went away (memory pressure, driver reset): nothing is drawn until it's back */
  contextLost = false;
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;
  /** size of what's being rendered, in pixels (the canvas's backing size) */
  readonly renderSize = new THREE.Vector2(1, 1);
  private captures: ((canvas: HTMLCanvasElement) => void)[] = [];
  private drawn = false;

  constructor(readonly container: HTMLElement) {
    this.renderer = createGameRenderer(container);
    const resize = () => this.resize();
    window.addEventListener('resize', resize);
    // phones: browser bars, the on-screen keyboard and rotation don't always fire a (timely) window resize
    window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 300));
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
    this.adaptive.onChange = () => { this.pendingResize = true; };
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      // allow the browser to give the context back
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    // (three.js's own restore handler runs first: it was registered when the renderer was made)
    canvas.addEventListener('webglcontextrestored', () => {
      tuneRenderer(this.renderer);
      this.contextLost = false;
      this.lastSize = '';
      this.resize();
      this.onContextRestored?.();
    });
    this.resize();
  }

  get width() { return this.container.clientWidth || window.innerWidth; }
  get height() { return this.container.clientHeight || window.innerHeight; }

  /** How many device pixels per CSS pixel the view is rendered at. */
  get renderRatio() {
    const cfg = this.retro.config;
    const scale = this.adaptive.current.scale;
    if (cfg.id !== 'off') {
      // the DS looks are low resolution already: per-pixel cost is small there, so
      // shrink them less (and never below 3/4) when frames are slow
      return (1 / cfg.pixel) * (0.5 + 0.5 * scale);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, budget().maxPixelRatio);
    return Math.max(0.5, dpr * scale);
  }

  private lastSize = '';
  private pendingResize = false;
  resize() {
    this.pendingResize = false;
    const cssW = this.width, cssH = this.height;
    const ratio = this.renderRatio;
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    const pixelated = this.retro.enabled;
    // setting a canvas's size clears it, even to the same value, so only do it on a real change
    const key = `${w}x${h}:${pixelated}`;
    if (key !== this.lastSize) {
      this.lastSize = key;
      this.renderer.setSize(w, h, false);
      this.renderSize.set(w, h);
      this.retro.setSize(w, h);
      const style = this.renderer.domElement.style;
      // (browsers ignore values they don't know: older Firefox takes crisp-edges only)
      style.imageRendering = pixelated ? 'crisp-edges' : 'auto';
      if (pixelated) style.imageRendering = 'pixelated';
      this.drawn = false;
    }
    if (this.current) {
      const cam = this.current.camera;
      cam.aspect = cssW / cssH;
      fitFov(cam);
      cam.updateProjectionMatrix();
      this.viewKey = '';
    }
  }

  /** The look changed (settings): re-layout before the next frame. */
  setRetroMode(mode: RetroPass['mode']) {
    this.retro.mode = mode;
    this.pendingResize = true;
  }

  // Shift the projection (not the camera) so the scene centres in the part of the
  // screen that isn't covered by panels, easing over when the panels change.
  private view = { x: 0, y: 0 };
  private viewKey = '';
  private viewCam: THREE.Camera | null = null;
  private applyViewInset(dt: number) {
    const s = this.current;
    if (!s) return;
    const cam = s.camera;
    const i = s.viewInset?.() ?? null;
    const tx = i ? ((i.right ?? 0) - (i.left ?? 0)) / 2 : 0;
    const ty = i ? ((i.bottom ?? 0) - (i.top ?? 0)) / 2 : 0;
    if (this.viewCam !== cam) {
      this.viewCam = cam;
      this.view.x = tx;
      this.view.y = ty;
      this.viewKey = '';
    } else {
      const k = 1 - Math.exp(-dt * 8);
      this.view.x += (tx - this.view.x) * k;
      this.view.y += (ty - this.view.y) * k;
      if (Math.abs(tx - this.view.x) < 0.5) this.view.x = tx;
      if (Math.abs(ty - this.view.y) < 0.5) this.view.y = ty;
    }
    const w = this.width, h = this.height;
    const key = `${this.view.x.toFixed(1)},${this.view.y.toFixed(1)},${w},${h}`;
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.drawn = false;
    if (this.view.x || this.view.y) cam.setViewOffset(w, h, this.view.x, this.view.y, w, h);
    else if (cam.view) cam.clearViewOffset();
  }

  /**
   * Tear a scene down: its own exit(), then what it may have left on the GPU that
   * three.js never frees by itself: light shadow maps (several MB each) and the
   * per-instance buffers of instanced meshes (disposing geometry doesn't free those).
   */
  retire(s: GameScene) {
    try {
      s.exit?.();
    } finally {
      const lights: THREE.Light[] = [];
      const instanced: THREE.InstancedMesh[] = [];
      s.scene.traverse((o) => {
        if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
        else if ((o as THREE.InstancedMesh).isInstancedMesh) instanced.push(o as THREE.InstancedMesh);
      });
      for (const l of lights) (l as THREE.DirectionalLight).shadow?.dispose();
      for (const m of instanced) m.dispose();
      if (this.current === s) this.current = null;
    }
  }

  async setScene(s: GameScene) {
    if (this.current) this.retire(this.current);
    this.current = s;
    this.drawn = false;
    this.frames = 0;
    this.adaptive.reset();
    this.resize();
    if (s.enter) await s.enter();
    this.resize();
    await this.precompile(s);
  }

  /**
   * Compile the scene's shaders before it's shown. Browsers with parallel shader
   * compilation do it off the main thread; otherwise it at least happens behind the
   * loading fade instead of as a stall in the first frames.
   */
  private async precompile(s: GameScene) {
    if (s.still || this.contextLost) return;
    try {
      if (this.renderer.extensions.has('KHR_parallel_shader_compile')) {
        await Promise.race([
          this.renderer.compileAsync(s.scene, s.camera),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } else {
        this.renderer.compile(s.scene, s.camera);
      }
    } catch (e) {
      reportError(e, 'shader compile');
    }
  }

  /** Call `fn` with the canvas right after the next frame is drawn (it can be read then). */
  capture(fn: (canvas: HTMLCanvasElement) => void) {
    this.captures.push(fn);
    this.drawn = false;
  }

  // High refresh screens (120 Hz and up) would draw twice as many frames as a
  // 60 Hz one for no visible gain, heating the phone until it throttles. Draw
  // every other refresh there instead. The refresh rate is followed continuously:
  // phones switch between rates, and skipping on a 60 Hz screen would halve it.
  private rafMs = 1000 / 60;
  private skip = 0;
  private tick = 0;
  private lastTs = 0;
  private measureRefresh(ts: number) {
    if (this.lastTs) {
      const d = ts - this.lastTs;
      if (d > 1 && d < 100) this.rafMs += (d - this.rafMs) * 0.05;
    }
    this.lastTs = ts;
    this.skip = this.rafMs < 9.5 ? Math.max(1, Math.round(1000 / 60 / this.rafMs) - 1) : 0;
  }

  private renderFrame() {
    const s = this.current!;
    const r = this.renderer;
    r.info.reset();
    if (s.render) s.render(r);
    else this.retro.render(r, s.scene, s.camera);
    this.drawn = true;
    if (this.captures.length) {
      for (const fn of this.captures.splice(0)) {
        try { fn(r.domElement); } catch (e) { reportError(e, 'capture'); }
      }
    }
  }

  /** Frames drawn so far (shadow maps may be refreshed less often than every frame). */
  private frames = 0;

  start() {
    if (this.running) return;
    this.running = true;
    let lastDrawn = 0;
    const loop = (ts: number) => {
      if (!this.running) return;
      // schedule the next frame first: one frame that throws must never stop the game
      requestAnimationFrame(loop);
      this.measureRefresh(ts);
      if (this.skip && this.tick++ % (this.skip + 1) !== 0) return;
      try {
        this.timer.update(ts);
        const dt = Math.min(0.05, this.timer.getDelta()) * this.timeScale;
        this.time += dt;
        let drew = false;
        const s = this.current;
        if (s && !this.contextLost) {
          if (this.pendingResize) this.resize();
          this.applyViewInset(dt);
          s.update(dt, this.time);
          if (!s.still || !this.drawn) {
            const every = this.adaptive.current.shadowEvery;
            this.renderer.shadowMap.needsUpdate = this.frames++ % every === 0;
            this.renderFrame();
            drew = !s.still;
          }
        }
        this.onFrame?.(dt);
        // only frames that were actually drawn say anything about the GPU
        if (drew) {
          this.adaptive.frame(lastDrawn ? (ts - lastDrawn) / 1000 : 0);
          lastDrawn = ts;
        } else lastDrawn = 0;
      } catch (e) {
        reportError(e, 'frame');
      }
    };
    requestAnimationFrame(loop);
  }
}
