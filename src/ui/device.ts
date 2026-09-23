// Touch vs mouse: lets the UI say "tap" instead of "click", size itself for
// fingers, and keep the browser from treating game gestures as page gestures.

const mq = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** The primary input is a finger (phones, and tablets without a mouse). */
export const touchUI = mq('(hover: none) and (pointer: coarse)') || (mq('(pointer: coarse)') && navigator.maxTouchPoints > 0);

export const tap = touchUI ? 'tap' : 'click';
export const Tap = touchUI ? 'Tap' : 'Click';

/** Same breakpoint as the phone layout in ui.css. */
const COMPACT = '(max-width: 760px), (max-height: 540px)';
export function isCompact() {
  return mq(COMPACT);
}

/** Screen size relative to a desktop window (1 on desktop, ~0.55 on a phone), for scaling swipe distances and speeds. */
export function screenScale() {
  return Math.min(1, Math.max(0.4, Math.min(window.innerWidth, window.innerHeight) / 700));
}

let probe: HTMLElement | null = null;
/** Safe-area insets (notch, home indicator) in CSS pixels. */
export function safeInsets() {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;'
      + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

export const canFullscreen =typeof document !== 'undefined' && !!document.fullscreenEnabled;

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

/** Running from the home screen (no browser toolbars). */
export const standalone = mq('(display-mode: standalone), (display-mode: fullscreen)') || !!(navigator as any).standalone;

let installed = false;
export function installTouchGuards() {
  if (installed) return;
  installed = true;
  document.documentElement.classList.toggle('touch', touchUI);
  // iOS Safari ignores user-scalable=no, so cancel its pinch gesture directly
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  // iOS Safari only shows :active (button press) styles when a touch listener exists
  document.addEventListener('touchstart', () => {}, { passive: true });
  // long-pressing the 3D view or an icon would pop up a context menu or image callout
  document.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, [data-menu]')) return;
    if (touchUI || (e as PointerEvent).pointerType === 'touch') e.preventDefault();
  });
  // iOS scrolls the page to reveal a focused text field and can leave it there when the keyboard closes
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) window.scrollTo(0, 0);
    }, 60);
  });
}
