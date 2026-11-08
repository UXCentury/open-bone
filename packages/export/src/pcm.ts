/** Interleaved signed 16-bit PCM: the sound track of a video export. */
export interface PcmAudio {
  sampleRate: number;
  channels: number;
  /** Interleaved samples (frames x channels). */
  samples: Int16Array;
}

/** Number of sample frames (one sample per channel). */
export const pcmFrames = (a: PcmAudio) => Math.floor(a.samples.length / a.channels);

/** Convert planar float channels (-1..1) to interleaved 16-bit PCM. */
export function floatToPcm(channels: Float32Array[], sampleRate: number): PcmAudio {
  const n = channels[0]?.length ?? 0;
  const c = channels.length;
  const samples = new Int16Array(n * c);
  for (let ch = 0; ch < c; ch++) {
    const src = channels[ch];
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, src[i]));
      samples[i * c + ch] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
    }
  }
  return { sampleRate, channels: c, samples };
}

/** Little-endian bytes of the samples from frame `start` to `end`. */
export function pcmBytes(a: PcmAudio, start: number, end: number): Uint8Array {
  const out = new Uint8Array((end - start) * a.channels * 2);
  const view = new DataView(out.buffer);
  for (let i = start * a.channels, o = 0; i < end * a.channels; i++, o += 2) view.setInt16(o, a.samples[i], true);
  return out;
}

/** Audio frames that belong with video frame `i` (frame i covers [i/fps, (i+1)/fps)); the last frame takes the rest. */
export function audioSpan(a: PcmAudio, i: number, nFrames: number, fps: number): [number, number] {
  const total = pcmFrames(a);
  const at = (k: number) => Math.min(total, Math.round((k * a.sampleRate) / fps));
  return [at(i), i === nFrames - 1 ? total : at(i + 1)];
}
