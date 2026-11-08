/**
 * Automatic lip sync: turn speech audio into mouth-shape keys (pure; give it mono samples).
 *
 * No speech recognition: each ~16 ms frame is classified from its loudness and spectrum (an FFT split into low,
 * mid and high bands), the way animators read a waveform:
 *   - rest   silence before, after and between phrases
 *   - closed m / b / p: a short dip in loudness inside speech
 *   - small  quiet sounds and hissing consonants (s, f, sh, t…)
 *   - open   ordinary vowels
 *   - wide   loud, open vowels (a, e)
 *   - round  rounded vowels (o, u, w): energy low in the spectrum, little in the mids
 * The result is smoothed, short flickers are merged, and keys snap to the animation's frame rate.
 */

export type MouthShape = "rest" | "closed" | "small" | "open" | "wide" | "round";
export const MOUTH_SHAPES: MouthShape[] = ["rest", "closed", "small", "open", "wide", "round"];

export interface LipSyncOptions {
  /** Snap keys to this frame rate. Default 30. */
  fps?: number;
  /** Shortest time a shape is held, in frames (shorter blips merge into a neighbour). Default 2. */
  minHold?: number;
  /** Loudness (0..1 of the speech range) below which the mouth rests. Default 0.08. */
  silence?: number;
}

export interface MouthKey {
  /** Seconds from the start of the sound. */
  time: number;
  shape: MouthShape;
}

const HOP = 1 / 60;

/** Mouth shapes over time for mono `samples` at `sampleRate`. */
export function lipSync(samples: Float32Array, sampleRate: number, opts: LipSyncOptions = {}): MouthKey[] {
  const fps = opts.fps ?? 30;
  const minHold = Math.max(1, opts.minHold ?? 2);
  const hop = Math.max(1, Math.round(sampleRate * HOP));
  const win = 1 << Math.ceil(Math.log2(hop * 2));
  const frames = Math.max(0, Math.floor((samples.length - 1) / hop) + 1);
  if (!frames) return [];

  // Per-frame loudness and band energies.
  const rms = new Float32Array(frames);
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);
  const re = new Float32Array(win);
  const im = new Float32Array(win);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
  const binHz = sampleRate / win;
  const band = (hz: number) => Math.min(win / 2, Math.max(1, Math.round(hz / binHz)));
  const [l0, l1, m1, h1] = [band(150), band(900), band(2500), band(8000)];
  for (let f = 0; f < frames; f++) {
    const start = f * hop - Math.floor((win - hop) / 2);
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const s = samples[start + i] ?? 0;
      sum += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sum / win);
    fft(re, im);
    let a = 0;
    let b = 0;
    let c = 0;
    for (let k = l0; k < h1; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (k < l1) a += p;
      else if (k < m1) b += p;
      else c += p;
    }
    low[f] = a;
    mid[f] = b;
    high[f] = c;
  }

  // Normalise loudness between a noise floor and the speech peak (robust percentiles).
  const sorted = Array.from(rms).sort((x, y) => x - y);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  const floor = pct(0.1);
  const peak = Math.max(pct(0.97), floor + 1e-6);
  const level = (f: number) => Math.min(1, Math.max(0, (rms[f] - floor) / (peak - floor)));
  const silence = opts.silence ?? 0.08;
  if (peak < 1e-4) return [{ time: 0, shape: "rest" }];

  const shapes: MouthShape[] = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const lv = level(f);
    if (lv < silence) {
      shapes[f] = "rest";
      continue;
    }
    const total = low[f] + mid[f] + high[f] + 1e-12;
    const hiss = high[f] / total;
    const lowShare = low[f] / (low[f] + mid[f] + 1e-12);
    // Hissing consonants keep the teeth close however loud they are.
    if (hiss > 0.55) shapes[f] = "small";
    else if (lowShare > 0.85 && lv > 0.2 && hiss < 0.2) shapes[f] = "round";
    else if (lv < 0.3) shapes[f] = "small";
    else if (lv < 0.65) shapes[f] = "open";
    else shapes[f] = "wide";
  }

  // Short pauses inside speech are lips pressed together (m, b, p), not rest.
  const maxDip = Math.round(0.14 / HOP);
  for (let f = 0; f < frames; ) {
    if (shapes[f] !== "rest") {
      f++;
      continue;
    }
    let e = f;
    while (e < frames && shapes[e] === "rest") e++;
    if (f > 0 && e < frames && e - f <= maxDip) for (let k = f; k < e; k++) shapes[k] = "closed";
    f = e;
  }

  // Median-of-3 smoothing (one-frame blips), then collapse into keys at the target frame rate.
  const smooth = shapes.slice();
  for (let f = 1; f < frames - 1; f++) if (shapes[f - 1] === shapes[f + 1] && shapes[f] !== shapes[f - 1]) smooth[f] = shapes[f - 1];

  const keys: MouthKey[] = [];
  const frameOf = (f: number) => Math.round(f * HOP * fps);
  for (let f = 0; f < frames; f++) {
    const at = frameOf(f);
    const last = keys[keys.length - 1];
    if (last && last.shape === smooth[f]) continue;
    if (last && Math.round(last.time * fps) === at) {
      last.shape = smooth[f];
      continue;
    }
    keys.push({ time: at / fps, shape: smooth[f] });
  }
  // Merge shapes held for less than minHold frames into the previous one (rest and closed are kept: they read).
  const out: MouthKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const next = keys[i + 1];
    const held = next ? Math.round((next.time - k.time) * fps) : Infinity;
    if (held < minHold && out.length && k.shape !== "closed") continue;
    if (out.length && out[out.length - 1].shape === k.shape) continue;
    out.push(k);
  }
  if (!out.length || out[0].time > 0) out.unshift({ time: 0, shape: "rest" });
  // End at rest.
  const endTime = Math.round((samples.length / sampleRate) * fps) / fps;
  if (out[out.length - 1].shape !== "rest") out.push({ time: endTime, shape: "rest" });
  return out;
}

/** Guess which attachment plays which mouth shape from common names (Preston Blair / Rhubarb / plain words). */
export function guessMouthMapping(names: string[]): Partial<Record<MouthShape, string>> {
  const find = (...words: string[]) => {
    for (const w of words) {
      const re = new RegExp(`(^|[^a-z])${w}([^a-z]|$)`, "i");
      const hit = names.find((n) => re.test(n));
      if (hit) return hit;
    }
    return undefined;
  };
  const map: Partial<Record<MouthShape, string>> = {
    rest: find("rest", "idle", "neutral", "x", "closed"),
    closed: find("mbp", "m", "closed", "close", "a"),
    small: find("small", "etc", "b", "consonant", "e", "s"),
    open: find("open", "c", "ai", "eh"),
    wide: find("wide", "d", "aa", "ah", "big", "laugh"),
    round: find("round", "o", "u", "oo", "w", "f", "e"),
  };
  // Fill gaps sensibly so every shape plays something.
  map.closed ??= map.rest;
  map.small ??= map.open ?? map.closed;
  map.open ??= map.small ?? map.wide;
  map.wide ??= map.open;
  map.round ??= map.open;
  map.rest ??= map.closed ?? names[0];
  return map;
}

/** In-place radix-2 FFT (length must be a power of two). */
function fft(re: Float32Array, im: Float32Array) {
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
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}
