// Last line of defence. Anything that throws gets logged and briefly shown on
// screen instead of silently freezing the game, which matters on phones where
// there are no dev tools to look at.

const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];
const REPEAT_MS = 30_000;

let show: ((text: string) => void) | null = null;
const lastShown = new Map<string, number>();

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Log an error and tell the player (the same message at most every 30 s). */
export function reportError(e: unknown, context = 'error') {
  console.error(context, e);
  const msg = describeError(e).slice(0, 140);
  if (!msg || IGNORED.some((r) => r.test(msg))) return;
  const now = Date.now();
  if (now - (lastShown.get(msg) ?? -Infinity) < REPEAT_MS) return;
  lastShown.set(msg, now);
  show?.(msg);
}

export function installErrorReporting(toast: (text: string) => void) {
  show = (msg) => toast(`⚠️ Something went wrong: ${msg}`);
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'uncaught'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'unhandled rejection'));
}
