/**
 * Audio audition page: ?test=audio
 * Buttons for every dog sound, SFX, loop and music track, voice sliders, and an offline analyser
 * (duration, peak, RMS, spectral centroid, clipping) rendered through the real master chain.
 */
import {
  audio, DOG_SOUNDS, SFX_NAMES, LOOP_NAMES, MUSIC_TRACKS,
  type AudioEngine, type MusicGroup, type DogSound, type SfxName, type LoopName, type MusicTrack, type LoopHandle, type SoundHandle, type Surface,
} from '../game/audio';

type Spec =
  | { type: 'dog'; name: DogSound; pitch?: number; rough?: number }
  | { type: 'sfx'; name: SfxName; surface?: Surface; volume?: number }
  | { type: 'loop'; name: LoopName }
  | { type: 'music'; name: MusicTrack; only?: MusicGroup[] };

interface Stats {
  name: string;
  duration: number;
  peakDb: number;
  rmsDb: number;
  centroid: number;
  clipped: number;
}

const DEFAULT_SECONDS: Partial<Record<string, number>> = {
  howl: 3, growl: 2, yawn: 2, lap: 3, crunch: 2.2, pant: 3, whine: 2, fanfare: 3.2, applause: 3.6,
  drumroll: 3.6, learned: 2, present: 2, lightbulb: 1.8, splash: 1.2, shake: 1.4, dig: 1.6, eat: 1.6,
  scrub: 1.6, shower: 1.6, rain: 3, whistle: 1.2,
};

function play(e: AudioEngine, s: Spec) {
  if (s.type === 'dog') e.dog(s.name, { pitch: s.pitch ?? 1.2, rough: s.rough ?? 0.2 });
  else if (s.type === 'sfx') e.sfx(s.name, { surface: s.surface, volume: s.volume });
  else if (s.type === 'loop') e.loop(s.name);
  else {
    e.musicOnly = s.only ? new Set(s.only) : null;
    e.music(s.name);
  }
}

function stats(name: string, buf: AudioBuffer): Stats {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  const n = buf.length;
  let peak = 0;
  let clipped = 0;
  let first = -1;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    if (a > 0.00316) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) first = 0;
  let sum = 0;
  for (let i = first; i <= last; i++) sum += (L[i] * L[i] + R[i] * R[i]) / 2;
  const rms = Math.sqrt(sum / Math.max(1, last - first + 1));
  // Spectral centroid of the average magnitude spectrum (2048-point Hann frames).
  const N = 2048;
  const mag = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let s = first; s + N <= last + 1; s += N) {
    for (let i = 0; i < N; i++) {
      re[i] = ((L[s + i] + R[s + i]) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  let num = 0;
  let den = 0;
  for (let k = 1; k < N / 2; k++) {
    num += ((k * buf.sampleRate) / N) * mag[k];
    den += mag[k];
  }
  const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);
  return {
    name,
    duration: (last - first) / buf.sampleRate,
    peakDb: db(peak),
    rmsDb: db(rms),
    centroid: frames && den ? num / den : 0,
    clipped,
  };
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** 16-bit PCM WAV (mono mix) as base64, for pulling renders out of a headless browser. */
function wavBase64(buf: AudioBuffer): string {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, (L[i] + R[i]) / 2)) * 32767), true);
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function secondsFor(s: Spec): number {
  if (s.type === 'music') return 12;
  return DEFAULT_SECONDS[s.name] ?? 1;
}

async function render(s: Spec, seconds = secondsFor(s)): Promise<AudioBuffer> {
  return audio.renderOffline(seconds, (e) => play(e, s));
}

async function analyse(s: Spec, seconds?: number): Promise<Stats> {
  return stats(`${s.type}:${s.name}`, await render(s, seconds));
}

async function analyseAll(): Promise<Stats[]> {
  const specs: Spec[] = [
    ...DOG_SOUNDS.map((name) => ({ type: 'dog', name }) as Spec),
    ...SFX_NAMES.map((name) => ({ type: 'sfx', name }) as Spec),
    ...LOOP_NAMES.map((name) => ({ type: 'loop', name }) as Spec),
  ];
  const out: Stats[] = [];
  for (const s of specs) out.push(await analyse(s));
  return out;
}

async function renderWav(s: Spec, seconds?: number): Promise<string> {
  return wavBase64(await render(s, seconds));
}

/**
 * Debug view: renders each spec offline and draws a labelled spectrogram (0..maxHz, dB colour)
 * with a waveform strip into a panel at the top of the page, for headless screenshots.
 */
async function spectro(specs: Spec[], opts: { seconds?: number; maxHz?: number; width?: number } = {}) {
  let panel = document.getElementById('spectro');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'spectro';
    panel.style.cssText = 'position:fixed;inset:0;z-index:10;background:#000;overflow:hidden;';
    document.body.appendChild(panel);
  }
  panel.innerHTML = '';
  const W = opts.width ?? 1380;
  const rowH = Math.floor((innerHeight - 4) / specs.length);
  const maxHz = opts.maxHz ?? 8000;
  for (const s of specs) {
    const buf = await render(s, opts.seconds);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = rowH;
    c.style.display = 'block';
    panel.appendChild(c);
    const g = c.getContext('2d')!;
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const N = 1024;
    const specH = rowH - 34;
    const hop = Math.max(64, Math.floor(buf.length / W));
    const cols = Math.floor((buf.length - N) / hop);
    const bins = Math.floor((maxHz / buf.sampleRate) * N);
    const img = g.createImageData(cols, specH);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let x = 0; x < cols; x++) {
      for (let i = 0; i < N; i++) {
        re[i] = ((L[x * hop + i] + R[x * hop + i]) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
        im[i] = 0;
      }
      fft(re, im);
      for (let y = 0; y < specH; y++) {
        const k = Math.max(1, Math.floor(((specH - 1 - y) / specH) * bins));
        const db = 20 * Math.log10(Math.hypot(re[k], im[k]) / (N / 4) + 1e-9);
        const v = Math.max(0, Math.min(1, (db + 90) / 90));
        const o = (y * cols + x) * 4;
        img.data[o] = 255 * Math.min(1, v * 1.8);
        img.data[o + 1] = 255 * Math.max(0, v * 1.6 - 0.6);
        img.data[o + 2] = 255 * (v < 0.35 ? v * 1.8 : Math.max(0, 0.63 - (v - 0.35) * 2) + Math.max(0, v - 0.85) * 5);
        img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = cols;
    tmp.height = specH;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, 0, 0, W, specH);
    // waveform strip
    g.fillStyle = '#111';
    g.fillRect(0, specH, W, 34);
    g.fillStyle = '#9fd';
    const per = buf.length / W;
    for (let x = 0; x < W; x++) {
      let mx = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
      g.fillRect(x, specH + 17 - mx * 16, 1, Math.max(1, mx * 32));
    }
    const st = stats('', buf);
    g.fillStyle = '#fff';
    g.font = '13px monospace';
    g.fillText(`${s.type}:${s.name} ${JSON.stringify(s).slice(0, 60)}  ${buf.duration.toFixed(2)}s  peak ${st.peakDb.toFixed(1)} rms ${st.rmsDb.toFixed(1)}  0-${maxHz}Hz`, 6, 14);
  }
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

export default function (_params: URLSearchParams) {
  document.body.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = `
    body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: #fdf7ee; color: #3b2f25; }
    main { max-width: 1100px; margin: 0 auto; padding: 18px 22px 60px; }
    h1 { font-size: 22px; margin: 4px 0 2px; } h2 { font-size: 15px; margin: 18px 0 8px; color: #8a5a2b; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    button { border: 1px solid #e0c9a8; background: #fff; color: #3b2f25; border-radius: 16px; padding: 6px 12px; cursor: pointer; font: inherit; }
    button:hover { background: #fff3df; } button.on { background: #ffcf7a; border-color: #e0a340; }
    button.big { background: #ff9f43; color: #fff; border-color: #e08a2e; font-weight: 600; padding: 8px 18px; }
    label { display: inline-flex; gap: 6px; align-items: center; margin-right: 14px; }
    input[type=range] { width: 140px; }
    table { border-collapse: collapse; margin-top: 8px; font: 12px ui-monospace, monospace; }
    td, th { padding: 2px 10px; border-bottom: 1px solid #eadcc6; text-align: right; } td:first-child, th:first-child { text-align: left; }
    .warn { color: #c0392b; font-weight: 600; } #status { color: #8a7a68; margin-left: 10px; }
  `;
  document.head.appendChild(style);
  const main = document.createElement('main');
  document.body.appendChild(main);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = '') => {
    const n = document.createElement(tag);
    n.textContent = text;
    parent.appendChild(n);
    return n;
  };
  el('h1', main, 'Nintendogs audio');
  const top = el('div', main);
  top.className = 'row';
  const initBtn = el('button', top, 'Start audio');
  initBtn.className = 'big';
  const status = el('span', top, 'not started (click to start)');
  status.id = 'status';
  const ensure = async () => {
    await audio.init();
    status.textContent = `context ${audio.context?.state} @ ${audio.context?.sampleRate} Hz`;
  };
  initBtn.onclick = ensure;

  const slider = (parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, on: (v: number) => void) => {
    const l = el('label', parent, label);
    const i = document.createElement('input');
    i.type = 'range';
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(value);
    const out = el('span', l, value.toFixed(2));
    l.insertBefore(i, out);
    i.oninput = () => {
      out.textContent = Number(i.value).toFixed(2);
      on(Number(i.value));
    };
    return i;
  };

  el('h2', main, 'Mix');
  const mix = el('div', main);
  mix.className = 'row';
  slider(mix, 'master', 0, 1, 0.01, 0.9, (v) => audio.setVolume(v));
  slider(mix, 'music', 0, 1, 0.01, 0.6, (v) => audio.setMusicVolume(v));
  slider(mix, 'sfx', 0, 1, 0.01, 1, (v) => audio.setSfxVolume(v));
  const muteBtn = el('button', mix, 'mute');
  muteBtn.onclick = () => {
    audio.mute(!audio.muted);
    muteBtn.classList.toggle('on', audio.muted);
  };

  el('h2', main, 'Dog voice');
  const vrow = el('div', main);
  vrow.className = 'row';
  const voice = { pitch: 1.2, rough: 0.2 };
  slider(vrow, 'pitch', 0.8, 1.8, 0.01, voice.pitch, (v) => (voice.pitch = v));
  slider(vrow, 'rough', 0, 1, 0.01, voice.rough, (v) => (voice.rough = v));
  const presets: [string, number, number][] = [['chihuahua', 1.8, 0.05], ['beagle', 1.25, 0.25], ['lab', 1.0, 0.2], ['husky', 0.95, 0.5], ['dane', 0.8, 0.6]];
  for (const [n, p, r] of presets) {
    const b = el('button', vrow, n);
    b.onclick = async () => {
      voice.pitch = p;
      voice.rough = r;
      const inputs = vrow.querySelectorAll('input');
      inputs[0].value = String(p);
      inputs[1].value = String(r);
      inputs[0].dispatchEvent(new Event('input'));
      inputs[1].dispatchEvent(new Event('input'));
      await ensure();
      audio.dog('bark', voice);
    };
  }
  const synthBtn = el('button', vrow, 'force synth voices');
  synthBtn.onclick = () => {
    audio.forceSynth = !audio.forceSynth;
    synthBtn.classList.toggle('on', audio.forceSynth);
  };

  el('h2', main, 'Dog sounds');
  const drow = el('div', main);
  drow.className = 'row';
  let pant: SoundHandle | null = null;
  for (const k of DOG_SOUNDS) {
    const b = el('button', drow, k);
    b.onclick = async () => {
      await ensure();
      if (k === 'pant') {
        if (pant) {
          pant.stop();
          pant = null;
        } else pant = audio.dog('pant', voice);
        b.classList.toggle('on', !!pant);
        return;
      }
      audio.dog(k, voice, { pan: (Math.random() - 0.5) * 0.4 });
    };
  }

  el('h2', main, 'SFX');
  const srow = el('div', main);
  srow.className = 'row';
  for (const k of SFX_NAMES) {
    if (k === 'footstep') {
      for (const surface of ['wood', 'grass', 'pavement'] as const) {
        const b = el('button', srow, `footstep:${surface}`);
        b.onclick = async () => {
          await ensure();
          for (let i = 0; i < 4; i++) setTimeout(() => audio.sfx('footstep', { surface, pan: i % 2 ? 0.2 : -0.2 }), i * 180);
        };
      }
      continue;
    }
    const b = el('button', srow, k);
    b.onclick = async () => {
      await ensure();
      if (k === 'bounce') {
        [1, 0.6, 0.35, 0.18].forEach((v, i) => setTimeout(() => audio.sfx('bounce', { volume: v }), [0, 420, 700, 880][i]));
      } else audio.sfx(k);
    };
  }

  el('h2', main, 'Loops');
  const lrow = el('div', main);
  lrow.className = 'row';
  const loops = new Map<LoopName, LoopHandle>();
  for (const k of LOOP_NAMES) {
    const b = el('button', lrow, k);
    b.onclick = async () => {
      await ensure();
      const h = loops.get(k);
      if (h) {
        h.stop();
        loops.delete(k);
      } else loops.set(k, audio.startLoop(k, k === 'pant' ? { voice } : undefined));
      b.classList.toggle('on', loops.has(k));
    };
  }

  el('h2', main, 'Music');
  const mrow = el('div', main);
  mrow.className = 'row';
  const mbtns = new Map<string, HTMLButtonElement>();
  for (const k of [...MUSIC_TRACKS, null]) {
    const b = el('button', mrow, k ?? 'stop');
    mbtns.set(String(k), b);
    b.onclick = async () => {
      await ensure();
      audio.music(k);
      mbtns.forEach((btn, key) => btn.classList.toggle('on', key === String(k) && k !== null));
    };
  }

  el('h2', main, 'Offline analysis');
  const arow = el('div', main);
  arow.className = 'row';
  const aBtn = el('button', arow, 'Analyse all one-shots');
  const mBtn = el('button', arow, 'Analyse music (12 s each)');
  const table = el('table', main);
  const show = (rows: Stats[]) => {
    table.innerHTML = '<tr><th>sound</th><th>dur s</th><th>peak dBFS</th><th>RMS dBFS</th><th>centroid Hz</th><th>clipped</th></tr>';
    for (const r of rows) {
      const tr = el('tr', table);
      tr.innerHTML = `<td>${r.name}</td><td>${r.duration.toFixed(2)}</td><td class="${r.peakDb > -0.3 ? 'warn' : ''}">${r.peakDb.toFixed(1)}</td><td>${r.rmsDb.toFixed(1)}</td><td>${r.centroid.toFixed(0)}</td><td class="${r.clipped ? 'warn' : ''}">${r.clipped}</td>`;
    }
  };
  aBtn.onclick = async () => show(await analyseAll());
  mBtn.onclick = async () => {
    const rows: Stats[] = [];
    for (const name of MUSIC_TRACKS) rows.push(await analyse({ type: 'music', name }));
    show(rows);
  };

  (window as unknown as Record<string, unknown>).audioTest = { audio, analyse, analyseAll, renderWav, stats, render, spectro };
}
