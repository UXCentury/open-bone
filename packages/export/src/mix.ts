import type { OpenBoneDocument } from "@openbone/core";

/**
 * Offline sound mixing for video exports: the runtime's audio commands (play / stop / fade / mix), recorded with the
 * time they were emitted while the frames were rendered, mixed into a stereo track the way the players play them.
 * Gain = command volume (the sound's volume x the play's) x bus volume x master, 0 while the bus or the master is
 * muted (by the document or by a mix command); fade-in, stop fades and fade commands ramp linearly; looping sounds
 * wrap; the playback rate resamples (linear interpolation). Pure: decoding the audio files is the caller's job.
 */

/** The runtime's AudioCommand (structural, so this package does not depend on the runtime). */
export type MixCommand =
  | { type: "play"; id: string; asset: string; bus: string | null; volume: number; rate: number; loop: boolean; fadeIn: number }
  | { type: "stop"; id: string; fade: number }
  | { type: "fade"; id: string; volume: number; duration: number }
  | { type: "mix"; bus: string | null; muted: boolean };

export interface TimedMixCommand {
  /** Seconds from the start of the video. */
  time: number;
  command: MixCommand;
}

/** A decoded audio file: planar float channels (-1..1), mono or stereo. */
export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export interface MixedAudio {
  sampleRate: number;
  /** Left and right. */
  channels: [Float32Array, Float32Array];
}

/** A linear gain envelope: (sample, gain) points; constant before the first and after the last. */
class Envelope {
  pts: { s: number; g: number }[] = [];
  at(s: number): number {
    const p = this.pts;
    if (!p.length) return 0;
    if (s <= p[0].s) return p[0].g;
    for (let i = 1; i < p.length; i++)
      if (s < p[i].s) {
        const a = p[i - 1];
        const b = p[i];
        return a.g + ((b.g - a.g) * (s - a.s)) / (b.s - a.s);
      }
    return p[p.length - 1].g;
  }
  /** Ramp from the current value at `s` to `g` over `n` samples (n = 0: jump). Later points are dropped. */
  rampTo(s: number, g: number, n: number) {
    const now = this.at(s);
    this.pts = this.pts.filter((q) => q.s < s);
    this.pts.push({ s, g: now });
    this.pts.push({ s: s + Math.max(1, n), g });
  }
}

interface Voice {
  src: DecodedAudio;
  bus: string | null;
  start: number;
  end: number;
  step: number;
  loop: boolean;
  env: Envelope;
}

/**
 * Mix `commands` over `duration` seconds. `decode(assetId)` gives an asset's samples, or null to leave it out (its
 * name goes to `missing`). Returns null when nothing is played.
 */
export function mixAudioCommands(
  doc: OpenBoneDocument,
  commands: TimedMixCommand[],
  duration: number,
  decode: (assetId: string) => DecodedAudio | null,
  o: { sampleRate?: number; missing?: Set<string> } = {},
): MixedAudio | null {
  const sr = o.sampleRate ?? 48000;
  const total = Math.max(1, Math.round(duration * sr));
  const audio = doc.audio;
  // Mute overrides over time (bus id, "" = master): [sample, muted] in order.
  const mutes = new Map<string, { s: number; muted: boolean }[]>();
  const voices = new Map<string, Voice>();
  const all: Voice[] = [];
  const sorted = [...commands].sort((a, b) => a.time - b.time);
  for (const { time, command: c } of sorted) {
    const s = Math.max(0, Math.round(time * sr));
    if (c.type === "mix") {
      const key = c.bus ?? "";
      if (!mutes.has(key)) mutes.set(key, []);
      mutes.get(key)!.push({ s, muted: c.muted });
      continue;
    }
    if (c.type === "play") {
      const src = decode(c.asset);
      if (!src || !src.channels.length || !src.channels[0].length) {
        o.missing?.add(c.asset);
        continue;
      }
      const env = new Envelope();
      if (c.fadeIn > 0) env.pts.push({ s, g: 0 }, { s: s + Math.round(c.fadeIn * sr), g: c.volume });
      else env.pts.push({ s, g: c.volume });
      const v: Voice = { src, bus: c.bus, start: s, end: total, step: ((c.rate > 0 ? c.rate : 0.01) * src.sampleRate) / sr, loop: c.loop, env };
      if (!c.loop) v.end = Math.min(total, s + Math.ceil(src.channels[0].length / v.step));
      voices.set(c.id, v);
      all.push(v);
      continue;
    }
    const v = voices.get(c.id);
    if (!v) continue;
    if (c.type === "stop") {
      const n = Math.round(Math.max(0, c.fade) * sr);
      v.env.rampTo(s, 0, n);
      v.end = Math.min(v.end, s + Math.max(1, n));
      voices.delete(c.id);
    } else v.env.rampTo(s, c.volume, Math.round(Math.max(0, c.duration) * sr));
  }
  if (!all.length) return null;

  const docMuted = (key: string) => (key === "" ? !!audio?.muted : !!audio?.buses.find((b) => b.id === key)?.muted);
  const mutedAt = (key: string, s: number) => {
    let m = docMuted(key);
    for (const e of mutes.get(key) ?? []) if (e.s <= s) m = e.muted;
    return m;
  };
  const busVolume = (bus: string | null) => (bus ? (audio?.buses.find((b) => b.id === bus)?.volume ?? 1) : 1);
  const master = audio ? audio.master : 1;
  // Bus gain is piecewise constant between mute changes: precompute the change points.
  const changes = [...new Set([0, ...[...mutes.values()].flat().map((e) => e.s)])].sort((a, b) => a - b);
  const gainOf = (bus: string | null, s: number) =>
    mutedAt("", s) || (bus !== null && mutedAt(bus, s)) ? 0 : master * (bus !== null && audio?.buses.some((b) => b.id === bus) ? busVolume(bus) : 1);

  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (const v of all) {
    const l = v.src.channels[0];
    const r = v.src.channels[1] ?? l;
    const len = l.length;
    let ci = 0;
    let bus = gainOf(v.bus, v.start);
    for (let i = v.start; i < v.end; i++) {
      while (ci + 1 < changes.length && changes[ci + 1] <= i) {
        ci++;
        bus = gainOf(v.bus, i);
      }
      let pos = (i - v.start) * v.step;
      if (pos >= len) {
        if (!v.loop) break;
        pos %= len;
      }
      const k = Math.floor(pos);
      const f = pos - k;
      const k2 = k + 1 < len ? k + 1 : v.loop ? 0 : k;
      const g = v.env.at(i) * bus;
      if (g === 0) continue;
      left[i] += (l[k] + (l[k2] - l[k]) * f) * g;
      right[i] += (r[k] + (r[k2] - r[k]) * f) * g;
    }
  }
  return { sampleRate: sr, channels: [left, right] };
}

/** Decode a RIFF WAV (PCM 8/16/24/32-bit or 32/64-bit float) to planar floats; null for anything else. */
export function decodeWav(bytes: Uint8Array): DecodedAudio | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || str(0) !== "RIFF" || str(8) !== "WAVE") return null;
  let fmt = { format: 1, channels: 1, rate: 44100, bits: 16 };
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = str(p);
    const size = v.getUint32(p + 4, true);
    if (id === "fmt ") fmt = { format: v.getUint16(p + 8, true), channels: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
    else if (id === "data") {
      if (fmt.format === 0xfffe) fmt.format = 1; // WAVE_FORMAT_EXTENSIBLE: integer PCM in practice
      const bytesPer = fmt.bits / 8;
      const n = Math.floor(Math.min(size, bytes.length - p - 8) / bytesPer / fmt.channels);
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(n));
      let o = p + 8;
      for (let i = 0; i < n; i++)
        for (let c = 0; c < fmt.channels; c++, o += bytesPer) {
          let x: number;
          if (fmt.format === 3) x = fmt.bits === 64 ? v.getFloat64(o, true) : v.getFloat32(o, true);
          else if (fmt.bits === 8) x = (bytes[o] - 128) / 128;
          else if (fmt.bits === 16) x = v.getInt16(o, true) / 32768;
          else if (fmt.bits === 24) x = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8) / 8388608;
          else x = v.getInt32(o, true) / 2147483648;
          chans[c][i] = x;
        }
      return { sampleRate: fmt.rate, channels: chans };
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

/** A WAV file (16-bit PCM) of mixed audio, e.g. to hand to an encoder. */
export function encodeWav(a: { sampleRate: number; channels: Float32Array[] }): Uint8Array {
  const n = a.channels[0]?.length ?? 0;
  const c = a.channels.length;
  const out = new Uint8Array(44 + n * c * 2);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + n * c * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, c, true);
  v.setUint32(24, a.sampleRate, true);
  v.setUint32(28, a.sampleRate * c * 2, true);
  v.setUint16(32, c * 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * c * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let ch = 0; ch < c; ch++, o += 2) {
      const x = Math.max(-1, Math.min(1, a.channels[ch][i]));
      v.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
    }
  return out;
}
