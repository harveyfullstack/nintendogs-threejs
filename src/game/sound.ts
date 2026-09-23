// Thin facade over the audio system so gameplay code never has to care
// whether audio is initialised yet.

type AudioMod = { audio: any };
const mods = import.meta.glob('./audio.ts');

let audioMod: AudioMod | null = null;
let loading: Promise<void> | null = null;

function load() {
  if (!loading) {
    const l = mods['./audio.ts'];
    loading = l ? (l() as Promise<AudioMod>).then((m) => { audioMod = m; }).catch(() => {}) : Promise.resolve();
  }
  return loading;
}
load();

type Voice = { pitch: number; rough: number };
type LoopHandle = { stop(): void; setVolume(v: number): void };
const noopLoop: LoopHandle = { stop() {}, setVolume() {} };

export const sound = {
  async init() {
    await load();
    try { await audioMod?.audio.init(); } catch { /* ignore */ }
  },
  dog(kind: string, voice: Voice, opts?: { volume?: number; pan?: number }) {
    try { return (audioMod?.audio as any)?.dog(kind, voice, opts); } catch { return undefined; }
  },
  sfx(name: string, opts?: Record<string, unknown>) {
    try { (audioMod?.audio as any)?.sfx(name, opts); } catch { /* ignore */ }
  },
  music(track: string | null) {
    try { (audioMod?.audio as any)?.music(track); } catch { /* ignore */ }
  },
  loop(name: string): LoopHandle {
    try { return (audioMod?.audio as any)?.startLoop(name) ?? noopLoop; } catch { return noopLoop; }
  },
  /** Offline render through the real audio graph (used to score gameplay recordings). */
  async renderOffline(seconds: number, play: (engine: any) => void): Promise<AudioBuffer | null> {
    await load();
    const a = audioMod?.audio as any;
    return a?.renderOffline ? a.renderOffline(seconds, play) : null;
  },
  setVolumes(music: number, sfx: number) {
    try {
      const a = audioMod?.audio as any;
      a?.setMusicVolume?.(music);
      a?.setSfxVolume?.(sfx);
    } catch { /* ignore */ }
  },
};
