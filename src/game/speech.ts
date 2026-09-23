// Push-to-talk voice commands via the Web Speech API, like shouting into the
// DS microphone. Typed input is the fallback everywhere.

type Listener = (text: string, final: boolean) => void;
type StateListener = (listening: boolean) => void;
type ErrorListener = (error: string) => void;

/** Errors that mean voice won't work here at all (no permission, no mic, insecure page). */
const FATAL = ['not-allowed', 'service-not-allowed', 'audio-capture'];

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
}

export class Voice {
  readonly supported: boolean;
  /** supported and not blocked (turns false after a permission error) */
  available: boolean;
  listening = false;
  private rec: RecognitionLike | null = null;
  private listeners: Listener[] = [];
  private stateListeners: StateListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private finalSent = false;
  private lastInterim = '';
  lastError = '';

  constructor() {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.supported = this.available = !!Ctor;
    if (!Ctor) return;
    const rec: RecognitionLike = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.onresult = (e: any) => {
      let text = '';
      let final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        text += r[0].transcript;
        if (r.isFinal) final = true;
      }
      text = text.trim();
      if (!text) return;
      if (final) {
        this.finalSent = true;
        this.emit(text, true);
      } else {
        this.lastInterim = text;
        this.emit(text, false);
      }
    };
    rec.onerror = (e: any) => {
      this.lastError = e.error || 'error';
      if (FATAL.includes(this.lastError)) this.available = false;
      for (const l of this.errorListeners) l(this.lastError);
    };
    rec.onend = () => {
      // if the user let go before a final result, use the last interim guess
      if (!this.finalSent && this.lastInterim) this.emit(this.lastInterim, true);
      this.setListening(false);
    };
    this.rec = rec;
  }

  on(fn: Listener) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  /** Called when listening starts and stops (tap-to-talk sessions end by themselves). */
  onState(fn: StateListener) {
    this.stateListeners.push(fn);
    return () => { this.stateListeners = this.stateListeners.filter((l) => l !== fn); };
  }

  onError(fn: ErrorListener) {
    this.errorListeners.push(fn);
    return () => { this.errorListeners = this.errorListeners.filter((l) => l !== fn); };
  }

  private emit(text: string, final: boolean) {
    for (const l of this.listeners) l(text, final);
  }

  private setListening(on: boolean) {
    if (this.listening === on) return;
    this.listening = on;
    for (const l of this.stateListeners) l(on);
  }

  start() {
    if (!this.rec || this.listening) return;
    this.finalSent = false;
    this.lastInterim = '';
    this.lastError = '';
    try {
      this.rec.start();
      this.setListening(true);
    } catch {
      this.setListening(false);
    }
  }

  stop() {
    if (!this.rec || !this.listening) return;
    try { this.rec.stop(); } catch { /* ignore */ }
  }

  /** Feed typed text through the same pipeline. */
  say(text: string) {
    const t = text.trim();
    if (t) this.emit(t, true);
  }
}

export const voice = new Voice();
