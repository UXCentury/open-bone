import type { AudioAsset } from "@openbone/core";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { audio, audioMuted } from "../audio.ts";
import { PEAK_RATE, decodedNow } from "../waveform.ts";

/**
 * A small audio player for the Inspector: the waveform (played part highlighted, click or drag to seek), play/pause,
 * stop and the time. Plays the decoded file through the editor's audio context with the sound's volume, rate and loop.
 */
export function MiniPlayer(p: { asset: AudioAsset | undefined; volume?: number; rate?: number; loop?: boolean }) {
  let canvas!: HTMLCanvasElement;
  const decoded = () => decodedNow(p.asset);
  const duration = () => decoded()?.duration ?? p.asset?.duration ?? 0;
  const rate = () => p.rate ?? 1;
  const [playing, setPlaying] = createSignal(false);
  const [pos, setPos] = createSignal(0); // seconds into the file

  let src: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let startedAt = 0; // context time when playback (re)started
  let startPos = 0; // file position at that moment
  let raf = 0;
  let buffer: AudioBuffer | null = null;
  let bufferFor: Float32Array | null = null;

  const ctx = () => audio.activate();
  const now = () => {
    const c = ctx();
    if (!c || !playing()) return pos();
    const t = startPos + (c.currentTime - startedAt) * rate();
    const d = duration();
    return p.loop && d > 0 ? t % d : Math.min(t, d);
  };

  const halt = () => {
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
  };

  const tick = () => {
    setPos(now());
    raf = requestAnimationFrame(tick);
  };

  const play = (from = pos()) => {
    const c = ctx();
    const d = decoded();
    if (!c || !d) return;
    halt();
    if (!buffer || bufferFor !== d.samples) {
      buffer = c.createBuffer(1, d.samples.length, d.sampleRate);
      buffer.copyToChannel(d.samples as Float32Array<ArrayBuffer>, 0);
      bufferFor = d.samples;
    }
    gain = c.createGain();
    gain.gain.value = audioMuted() ? 0 : (p.volume ?? 1);
    gain.connect(c.destination);
    src = c.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate();
    src.loop = !!p.loop;
    src.connect(gain);
    const at = from >= d.duration - 0.01 ? 0 : from;
    src.start(0, at);
    startedAt = c.currentTime;
    startPos = at;
    src.onended = () => {
      halt();
      setPlaying(false);
      setPos(0);
    };
    setPlaying(true);
    raf = requestAnimationFrame(tick);
  };
  const pause = () => {
    setPos(now());
    halt();
    setPlaying(false);
  };
  const stop = () => {
    halt();
    setPlaying(false);
    setPos(0);
  };
  const seek = (t: number) => {
    const c = Math.max(0, Math.min(duration(), t));
    if (playing()) play(c);
    else setPos(c);
  };

  // A different file, or volume/rate/loop changed while playing: restart from the same spot.
  createEffect(() => {
    void p.asset?.id;
    stop();
  });
  createEffect(() => {
    const v = audioMuted() ? 0 : (p.volume ?? 1);
    if (gain) gain.gain.value = v;
  });
  createEffect(() => {
    void rate();
    void p.loop;
    if (src) play(now());
  });
  onCleanup(halt);

  // Waveform: peaks across the width, the played part in the accent colour, the playhead on top.
  createEffect(() => {
    const d = decoded();
    const t = pos();
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 200;
    const h = canvas.clientHeight || 44;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    if (!d) {
      g.fillStyle = "#3a3f4b";
      g.fillRect(0, mid - 0.5, w, 1);
      return;
    }
    const played = d.duration > 0 ? (t / d.duration) * w : 0;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * d.duration * PEAK_RATE);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * d.duration * PEAK_RATE));
      let m = 0;
      for (let b = b0; b < b1 && b < d.peaks.length; b++) m = Math.max(m, d.peaks[b]);
      const a = Math.max(0.5, Math.min(1, m) * (mid - 2));
      g.fillStyle = x < played ? "#7c9cff" : "#59607088";
      g.fillRect(x, mid - a, 1, a * 2);
    }
    if (t > 0 || playing()) {
      g.fillStyle = "#ffffff";
      g.fillRect(Math.min(w - 1, Math.round(played)), 0, 1.5, h);
    }
  });

  const seekFrom = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration());
  };
  const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

  return (
    <div class="mini-player">
      <canvas
        ref={canvas}
        class="mini-wave"
        title="Click or drag to seek"
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointer */
          }
          seekFrom(e);
        }}
        onPointerMove={(e) => e.buttons & 1 && seekFrom(e)}
      />
      <div class="mini-controls">
        <button class="mini-btn" disabled={!decoded()} title={playing() ? "Pause" : "Play"} aria-label={playing() ? "Pause" : "Play"} onClick={() => (playing() ? pause() : play())}>
          {playing() ? "⏸" : "▶"}
        </button>
        <button class="mini-btn" disabled={!playing() && pos() === 0} title="Stop" aria-label="Stop" onClick={stop}>
          ■
        </button>
        <span class="mini-time">
          {clock(pos())} / {clock(duration())}
        </span>
        <Show when={p.loop}>
          <span class="mini-tag" title="This sound loops">⟳ loop</span>
        </Show>
        <Show when={audioMuted()}>
          <span class="mini-tag warn" title="Editor audio is muted (speaker button in the toolbar)">muted</span>
        </Show>
      </div>
    </div>
  );
}
