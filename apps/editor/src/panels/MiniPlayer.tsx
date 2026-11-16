import type { AudioAsset } from "@openbone/core";
import { Show, createEffect, untrack } from "solid-js";
import { audioMuted } from "../audio.ts";
import { type PreviewParams, preview } from "../preview-player.ts";
import { PEAK_RATE, decodedNow } from "../waveform.ts";

/**
 * A small audio player for the Inspector: the waveform (played part highlighted, click or drag to seek), play/pause,
 * stop and the time. It shows the editor's one sound preview (preview-player.ts), which the ▶ buttons on Audio rows
 * start too; `id` names what this player holds (`sound:<id>` or `audio:<id>`).
 */
export function MiniPlayer(p: { id: string; asset: AudioAsset | undefined; volume?: number; rate?: number; loop?: boolean }) {
  let canvas!: HTMLCanvasElement;
  const decoded = () => decodedNow(p.asset);
  const duration = () => decoded()?.duration ?? p.asset?.duration ?? 0;
  const params = (): PreviewParams => ({ asset: p.asset, volume: p.volume, rate: p.rate, loop: p.loop });
  const mine = () => preview.key() === p.id;
  const playing = () => preview.isPlaying(p.id);
  const pos = () => (mine() ? preview.pos() : 0);
  const play = () => void preview.play(p.id, params());
  const pause = () => preview.pause();
  const stop = () => mine() && preview.stop();
  const seek = (t: number) => preview.seek(p.id, params(), t);

  // Volume, rate, loop or file changed in the Inspector: the playing preview follows.
  createEffect(() => {
    const q = params();
    untrack(() => preview.update(p.id, q));
  });

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
