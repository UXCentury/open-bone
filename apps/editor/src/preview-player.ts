/**
 * The one sound preview of the editor: the Inspector's player and the ▶ buttons on Audio rows drive it together, so a
 * row's ▶ starts the sound in the Inspector's player (waveform, time, pause and stop there) and turns into ⏸ while it
 * plays. Plays the decoded file through the editor's audio context with the sound's volume, rate and loop.
 */
import { type AudioAsset, findSound } from "@openbone/core";
import { createEffect, createRoot, createSignal } from "solid-js";
import { audio, audioMuted } from "./audio.ts";
import { store } from "./state.ts";
import { type Decoded, decodeAudio } from "./waveform.ts";

export interface PreviewParams {
  asset: AudioAsset | undefined;
  volume?: number;
  rate?: number;
  loop?: boolean;
}

/** What is loaded in the player: a sound (`sound:<id>`) or an audio file (`audio:<id>`). */
const [key, setKey] = createSignal<string | null>(null);
const [playing, setPlaying] = createSignal(false);
const [pos, setPos] = createSignal(0); // seconds into the file

let params: PreviewParams = { asset: undefined };
let decoded: Decoded | null = null;
let src: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let startedAt = 0; // context time when playback (re)started
let startPos = 0; // file position at that moment
let raf = 0;
let buffer: AudioBuffer | null = null;
let bufferFor: Float32Array | null = null;

const rate = () => params.rate ?? 1;
const duration = () => decoded?.duration ?? params.asset?.duration ?? 0;

/** Position now (seconds), following the audio clock while playing. */
function now(): number {
  const c = audio.activate();
  if (!c || !playing()) return pos();
  const t = startPos + (c.currentTime - startedAt) * rate();
  const d = duration();
  return params.loop && d > 0 ? t % d : Math.min(t, d);
}

function halt() {
  if (src) {
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    src.disconnect();
    src = null;
  }
  gain?.disconnect();
  gain = null;
  cancelAnimationFrame(raf);
}

function tick() {
  setPos(now());
  raf = requestAnimationFrame(tick);
}

function start(from: number) {
  const c = audio.activate();
  const d = decoded;
  if (!c || !d) return;
  if (!audio.unlocked) void c.resume();
  halt();
  if (!buffer || bufferFor !== d.samples) {
    buffer = c.createBuffer(1, d.samples.length, d.sampleRate);
    buffer.copyToChannel(d.samples as Float32Array<ArrayBuffer>, 0);
    bufferFor = d.samples;
  }
  gain = c.createGain();
  gain.gain.value = audioMuted() ? 0 : (params.volume ?? 1);
  gain.connect(c.destination);
  src = c.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate();
  src.loop = !!params.loop;
  src.connect(gain);
  const at = from >= d.duration - 0.01 ? 0 : Math.max(0, from);
  src.start(0, at);
  startedAt = c.currentTime;
  startPos = at;
  src.onended = () => {
    halt();
    setPlaying(false);
    setPos(0);
  };
  setPos(at);
  setPlaying(true);
  raf = requestAnimationFrame(tick);
}

/** Load `k` into the player (stopping whatever else was in it) without playing. */
function select(k: string, p: PreviewParams) {
  if (key() !== k || params.asset?.id !== p.asset?.id) {
    halt();
    setPlaying(false);
    setPos(0);
    decoded = null;
  }
  setKey(k);
  params = p;
}

export const preview = {
  key,
  playing,
  pos,
  duration,
  /** Playing, or paused part way: the row shows its stop button. */
  active: (k: string) => key() === k && (playing() || pos() > 0),
  isPlaying: (k: string) => key() === k && playing(),

  async play(k: string, p: PreviewParams, from?: number) {
    select(k, p);
    if (!p.asset) return;
    decoded = await decodeAudio(p.asset);
    if (key() !== k) return; // something else was picked meanwhile
    start(from ?? pos());
  },
  pause() {
    if (!playing()) return;
    setPos(now());
    halt();
    setPlaying(false);
  },
  stop() {
    halt();
    setPlaying(false);
    setPos(0);
  },
  toggle(k: string, p: PreviewParams) {
    if (preview.isPlaying(k)) preview.pause();
    else void preview.play(k, p);
  },
  seek(k: string, p: PreviewParams, t: number) {
    const c = Math.max(0, Math.min(duration() || p.asset?.duration || 0, t));
    if (key() === k && playing()) void preview.play(k, p, c);
    else {
      select(k, p);
      setPos(c);
    }
  },
  /** The Inspector's sound settings changed: apply them, restarting from the same spot when rate or loop changed. */
  update(k: string, p: PreviewParams) {
    if (key() !== k) return;
    if (p.asset?.id !== params.asset?.id) {
      select(k, p);
      return;
    }
    const restart = playing() && (p.rate !== params.rate || p.loop !== params.loop);
    const at = now();
    params = p;
    if (gain) gain.gain.value = audioMuted() ? 0 : (p.volume ?? 1);
    if (restart) start(at);
  },
};

// Mute applies at once to what is playing.
createRoot(() =>
  createEffect(() => {
    const m = audioMuted();
    if (gain) gain.gain.value = m ? 0 : (params.volume ?? 1);
  }),
);

/** Player settings of a sound (its file, volume, rate and loop). */
export function soundPreview(id: string): PreviewParams {
  const s = findSound(store.doc, id);
  return { asset: s ? store.doc.audio?.assets.find((a) => a.id === s.asset) : undefined, volume: s?.volume, rate: s?.rate, loop: s?.loop };
}

/** Player settings of an audio file (as is). */
export function audioPreview(id: string): PreviewParams {
  return { asset: store.doc.audio?.assets.find((a) => a.id === id) };
}
