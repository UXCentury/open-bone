import type { AudioAsset } from "@openbone/core";
import { createSignal } from "solid-js";
import { resolveAudioUrl } from "./audio.ts";

/**
 * Decoded audio for the editor: waveform peaks for the timeline's audio lane, and the raw samples for lip sync.
 * Decoding uses an OfflineAudioContext, so it works before the user has clicked anything.
 */

export const PEAK_RATE = 200; // peak buckets per second

export interface Decoded {
  /** Mono samples (channels averaged). */
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  /** Max |sample| per 1/PEAK_RATE s bucket, 0..1. */
  peaks: Float32Array;
}

const cache = new Map<string, Promise<Decoded | null>>();
// Bumped when a decode finishes, so components re-render.
const [decodedTick, setDecodedTick] = createSignal(0);
export { decodedTick };
const ready = new Map<string, Decoded | null>();

async function decode(asset: AudioAsset): Promise<Decoded | null> {
  try {
    const res = await fetch(resolveAudioUrl(asset));
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(bytes);
    const n = buf.length;
    const samples = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) samples[i] += ch[i] / buf.numberOfChannels;
    }
    const per = Math.max(1, Math.round(buf.sampleRate / PEAK_RATE));
    const peaks = new Float32Array(Math.ceil(n / per));
    for (let b = 0; b < peaks.length; b++) {
      let m = 0;
      const end = Math.min(n, (b + 1) * per);
      for (let i = b * per; i < end; i++) {
        const v = Math.abs(samples[i]);
        if (v > m) m = v;
      }
      peaks[b] = m;
    }
    return { samples, sampleRate: buf.sampleRate, duration: buf.duration, peaks };
  } catch {
    return null;
  }
}

/** Start (or reuse) decoding an asset. */
export function decodeAudio(asset: AudioAsset): Promise<Decoded | null> {
  const key = `${asset.id}:${asset.src.length}:${asset.src.slice(-32)}`;
  let p = cache.get(key);
  if (!p) {
    p = decode(asset).then((d) => {
      ready.set(asset.id, d);
      setDecodedTick((t) => t + 1);
      return d;
    });
    cache.set(key, p);
  }
  return p;
}

/** Decoded audio if it is ready (call inside a reactive scope to update when it arrives). */
export function decodedNow(asset: AudioAsset | undefined): Decoded | null {
  decodedTick();
  if (!asset) return null;
  if (!ready.has(asset.id)) void decodeAudio(asset);
  return ready.get(asset.id) ?? null;
}

/** Draw a waveform (peaks from `start` s, at `pps` pixels per second, `rate` playback speed) into a canvas. */
export function drawWaveform(canvas: HTMLCanvasElement, d: Decoded, opts: { pps: number; rate: number; seconds: number; color: string }) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(opts.seconds * opts.pps));
  const h = canvas.clientHeight || 36;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = opts.color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    // Time in the sound for this pixel column (a faster rate plays more of the sound per second).
    const t0 = ((x / opts.pps) * opts.rate) % d.duration;
    const t1 = (((x + 1) / opts.pps) * opts.rate) % d.duration;
    const b0 = Math.floor(t0 * PEAK_RATE);
    const b1 = Math.max(b0 + 1, Math.floor(t1 * PEAK_RATE));
    let m = 0;
    for (let b = b0; b < b1 && b < d.peaks.length; b++) m = Math.max(m, d.peaks[b]);
    const a = Math.max(0.5, m * (h / 2 - 1));
    g.fillRect(x, mid - a, 1, a * 2);
  }
}
