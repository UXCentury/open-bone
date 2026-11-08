import { type ImageAsset, type OpenBoneDocument, textureAssets } from "@openbone/core";
import { CanvasRenderer } from "@openbone/render-canvas";
import { OpenBoneInstance } from "@openbone/runtime";
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { WebAudioBackend } from "@openbone/player";
import { audio as editorAudio, resolveAudioUrl } from "../audio.ts";
import { fillArtboard } from "../checker.ts";
import { imageFor } from "../images.ts";
import { animationId, doc } from "../state.ts";
import { viewportApi } from "./Viewport.tsx";

/** Fit the artboard into a w × h canvas: scale and offset (css px). */
export function fitArtboard(d: OpenBoneDocument, w: number, h: number, pad = 8) {
  const z = Math.max(0.01, Math.min((w - pad * 2) / d.width, (h - pad * 2) / d.height));
  return { z, ox: (w - d.width * z) / 2, oy: (h - d.height * z) / 2 };
}

export function renderInstance(
  canvas: HTMLCanvasElement,
  d: OpenBoneDocument,
  draw: (r: CanvasRenderer, v: { x: number; y: number; zoom: number }) => void,
  image: (asset: ImageAsset) => HTMLImageElement | null = imageFor,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 4 || h < 4) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#15171c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const f = fitArtboard(d, w, h);
  fillArtboard(ctx, d.background, f.ox * dpr, f.oy * dpr, d.width * f.z * dpr, d.height * f.z * dpr, 6 * dpr);
  const resolve = (id: string) => {
    const a = textureAssets(d).find((i) => i.id === id);
    return a ? image(a) : null;
  };
  const r = new CanvasRenderer(ctx, resolve);
  draw(r, { x: f.ox * dpr, y: f.oy * dpr, zoom: f.z * dpr });
  return f;
}

/**
 * Preview panel (Spine's Preview view): a second, live view that plays an animation or runs a state machine while
 * you keep editing in the main viewport. It follows the document, so edits show up on the next frame.
 */
export function PreviewPanel() {
  let canvas!: HTMLCanvasElement;
  const [source, setSource] = createSignal("current");
  const [playing, setPlaying] = createSignal(true);
  const [speed, setSpeed] = createSignal(1);
  const [sound, setSound] = createSignal(true);
  let inst: OpenBoneInstance | null = null;
  // The preview's own voices (separate from the viewport's), on the editor's audio context once it is unlocked.
  let sfx: WebAudioBackend | null = null;
  const audioFor = () => {
    if (!sfx || (editorAudio.ctx && sfx.ctx !== editorAudio.ctx)) {
      sfx?.dispose();
      sfx = new WebAudioBackend(doc(), { resolveUrl: resolveAudioUrl, ...(editorAudio.ctx ? { context: editorAudio.ctx } : {}) });
      sfx.unlock(window);
    }
    return sfx;
  };
  onCleanup(() => sfx?.dispose());

  const build = () => {
    const d = doc();
    sfx?.stopAll(0.05);
    inst = new OpenBoneInstance(d);
    inst.on("audio", (c) => {
      if (!sound() || !d.audio?.assets.length) return;
      const a = audioFor();
      a.setDocument(d);
      a.handle(c);
    });
    const src = source();
    if (src.startsWith("sm:")) inst.useStateMachine(d.stateMachines.find((m) => m.id === src.slice(3))?.name);
    else {
      const id = src === "current" ? (animationId() ?? d.animations[0]?.id) : src.slice(5);
      const a = d.animations.find((x) => x.id === id);
      if (a) inst.animationState.setAnimation(0, a.name, true, 0);
    }
    inst.advance(0);
  };
  createEffect(on([doc, source, () => (source() === "current" ? animationId() : null)], build));

  onMount(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!inst) return;
      if (playing()) inst.advance(dt * speed());
      renderInstance(canvas, doc(), (r, v) => r.render(inst!.skeleton, { view: v, clear: false, bones: false }));
    };
    raf = requestAnimationFrame(frame);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // State machines get the pointer (hover, click listeners) like the real player.
  const pointer = (type: "down" | "up" | "move", e: PointerEvent) => {
    const sm = inst?.stateMachine;
    if (!sm) return;
    // Fit from the canvas as it is now (not the last drawn frame, which may be stale after a resize).
    const r = canvas.getBoundingClientRect();
    const f = fitArtboard(doc(), r.width, r.height);
    const ax = (e.clientX - r.left - f.ox) / f.z;
    const ay = (e.clientY - r.top - f.oy) / f.z;
    const [x, y] = inst!.artboardToSkeleton(ax, ay);
    sm.pointer(type, x, y);
  };

  return (
    <div class="panel preview-panel">
      <div class="preview-bar">
        <select value={source()} onChange={(e) => setSource(e.currentTarget.value)} title="What the preview plays">
          <option value="current" selected={source() === "current"}>Current animation</option>
          <For each={doc().animations}>{(a) => <option value={`anim:${a.id}`} selected={source() === `anim:${a.id}`}>▶ {a.name}</option>}</For>
          <For each={doc().stateMachines}>{(m) => <option value={`sm:${m.id}`} selected={source() === `sm:${m.id}`}>◈ {m.name}</option>}</For>
        </select>
        <button
          title={sound() ? "Sound on: click to mute the preview" : "Sound off: click to hear the preview"}
          onClick={() => {
            const on = !sound();
            setSound(on);
            if (!on) sfx?.stopAll(0.05);
          }}
        >
          {sound() ? "🔊" : "🔇"}
        </button>
        <button
          title={playing() ? "Pause" : "Play"}
          onClick={() => {
            if (playing()) sfx?.stopAll(0.05);
            setPlaying(!playing());
          }}
        >
          {playing() ? "⏸" : "▶"}
        </button>
        <button title="Restart" onClick={build}>
          ⟲
        </button>
        <select value={String(speed())} onChange={(e) => setSpeed(Number(e.currentTarget.value))} title="Speed">
          <For each={[0.25, 0.5, 1, 2]}>{(s) => <option value={s} selected={speed() === s}>{s}×</option>}</For>
        </select>
      </div>
      <canvas
        ref={canvas}
        class="preview-canvas"
        onPointerDown={(e) => pointer("down", e)}
        onPointerUp={(e) => pointer("up", e)}
        onPointerMove={(e) => pointer("move", e)}
      />
      <Show when={source().startsWith("sm:")}>
        <div class="muted small pad">Click and hover in the preview to drive the state machine's listeners.</div>
      </Show>
    </div>
  );
}

/** Outline panel: the whole artboard in miniature with the main viewport's visible area; click or drag to move it. */
export function OutlinePanel() {
  let canvas!: HTMLCanvasElement;
  let inst: OpenBoneInstance | null = null;
  createEffect(() => {
    inst = new OpenBoneInstance(doc());
    inst.advance(0);
  });
  onMount(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!inst) return;
      const d = doc();
      const f = renderInstance(canvas, d, (r, v) => r.render(inst!.skeleton, { view: v, clear: false, bones: false }));
      if (!f) return;
      // The main viewport's visible area, in artboard pixels.
      const vi = viewportApi.info?.();
      if (!vi) return;
      const ctx = canvas.getContext("2d")!;
      const dpr = window.devicePixelRatio || 1;
      const ax = -vi.x / vi.zoom;
      const ay = -vi.y / vi.zoom;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = "#ffcc00";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(f.ox + ax * f.z, f.oy + ay * f.z, (vi.w / vi.zoom) * f.z, (vi.h / vi.zoom) * f.z);
    };
    raf = requestAnimationFrame(frame);
    onCleanup(() => cancelAnimationFrame(raf));
  });
  const moveTo = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const f = fitArtboard(doc(), r.width, r.height);
    viewportApi.centerOn?.((e.clientX - r.left - f.ox) / f.z, (e.clientY - r.top - f.oy) / f.z);
  };
  return (
    <div class="panel preview-panel">
      <canvas
        ref={canvas}
        class="preview-canvas outline"
        title="Click or drag to move the viewport"
        onPointerDown={(e) => {
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointer: dragging still works without capture */
          }
          moveTo(e);
        }}
        onPointerMove={(e) => e.buttons & 1 && moveTo(e)}
      />
    </div>
  );
}
