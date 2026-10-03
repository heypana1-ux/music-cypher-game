// Generates the demo songs' audio in the browser (own material, no samples, no downloads).
// Each demo song gets its own key, tempo and pattern so they are distinguishable.

import { mulberry32 } from '../domain/rng';

const RATE = 22050;

function writeWav(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const SCALES = [
  [0, 2, 3, 5, 7, 8, 10], // minor
  [0, 2, 4, 5, 7, 9, 11], // major
  [0, 3, 5, 7, 10, 12, 15], // pentatonic minor
  [0, 2, 3, 5, 7, 9, 10], // dorian
];

const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export function renderDemo(tone: number, seconds = 30): Blob {
  const rand = mulberry32(tone * 7919);
  const out = new Float32Array(RATE * seconds);
  const bpm = 78 + Math.floor(rand() * 60);
  const beat = 60 / bpm;
  const root = 45 + Math.floor(rand() * 12);
  const scale = SCALES[tone % SCALES.length];
  const prog = [0, 5, 3, 4].map((d) => (d + Math.floor(rand() * 2)) % 7);
  const melody = Array.from({ length: 16 }, () => (rand() < 0.2 ? -1 : Math.floor(rand() * 7)));
  const swing = rand() * 0.15;
  const add = (start: number, dur: number, f: number, amp: number, shape: 'sine' | 'tri' | 'saw', decay = 3) => {
    const s0 = Math.floor(start * RATE);
    const n = Math.floor(dur * RATE);
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      const t = i / RATE;
      const ph = (t * f) % 1;
      let x = shape === 'sine' ? Math.sin(2 * Math.PI * ph) : shape === 'tri' ? 1 - 4 * Math.abs(ph - 0.5) : 2 * ph - 1;
      x *= Math.exp(-t * decay) * Math.min(1, t * 200);
      out[s0 + i] += x * amp;
    }
  };
  const bars = Math.ceil(seconds / (beat * 4));
  for (let bar = 0; bar < bars; bar++) {
    const chordDeg = prog[bar % 4];
    const barStart = bar * beat * 4;
    // pad chord
    for (const k of [0, 2, 4]) {
      const deg = chordDeg + k;
      const midi = root + 12 + scale[deg % 7] + 12 * Math.floor(deg / 7);
      add(barStart, beat * 4, freq(midi), 0.06, 'tri', 0.6);
    }
    // bass
    for (let b = 0; b < 4; b++) add(barStart + b * beat, beat * 0.9, freq(root + scale[chordDeg]), 0.18, 'sine', 2.5);
    // kick + hat
    for (let b = 0; b < 4; b++) {
      const t0 = barStart + b * beat;
      const s0 = Math.floor(t0 * RATE);
      for (let i = 0; i < RATE * 0.25 && s0 + i < out.length; i++) {
        const t = i / RATE;
        out[s0 + i] += Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14) * 0.35;
      }
      const h0 = Math.floor((t0 + beat * (0.5 + swing)) * RATE);
      for (let i = 0; i < RATE * 0.04 && h0 + i < out.length; i++) {
        out[h0 + i] += (rand() * 2 - 1) * Math.exp(-(i / RATE) * 120) * 0.06;
      }
    }
    // melody, 8th notes
    if (bar % 8 >= 2) {
      for (let s = 0; s < 8; s++) {
        const note = melody[(bar * 8 + s) % 16];
        if (note < 0) continue;
        const midi = root + 24 + scale[(note + chordDeg) % 7];
        add(barStart + s * beat * 0.5, beat * 0.45, freq(midi), 0.08, 'saw', 6);
      }
    }
  }
  // fade in/out
  const fade = RATE * 1.5;
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return writeWav(out);
}

const cache = new Map<number, string>();

export function demoUrl(tone: number): string {
  let url = cache.get(tone);
  if (!url) {
    url = URL.createObjectURL(renderDemo(tone));
    cache.set(tone, url);
  }
  return url;
}
