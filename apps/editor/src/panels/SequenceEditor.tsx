import { type SequenceAttachment, type SequenceFrame, type SkinData, groupNumbered, sequenceDuration } from "@openbone/core";
import { For, Show, createEffect, onCleanup } from "solid-js";
import { ensureAnimation } from "../edit.ts";
import { imageSize, readFileAsDataUrl, resolveImageUrl } from "../images.ts";
import { sequencePreview, sequenceShown, setSequencePreview } from "../sequence-import.ts";
import { apply, doc, mode, store, time, transaction } from "../state.ts";
import { ColorField, NumberField, SelectField } from "./fields.tsx";

const MODES = [
  { value: "loop", label: "Loop" },
  { value: "once", label: "Once (then hide)" },
  { value: "pingPong", label: "Ping-pong" },
  { value: "holdLast", label: "Hold last frame" },
];

/** A frame drawn at thumbnail size (sheet cells are cropped with CSS background positioning). */
function FrameThumb(p: { frame: SequenceFrame; size: number }) {
  const img = () => doc().images.find((i) => i.id === p.frame.image);
  const style = () => {
    const i = img();
    if (!i?.src) return { width: `${p.size}px`, height: `${p.size}px` };
    const r = p.frame.rect ?? { x: 0, y: 0, width: i.width, height: i.height };
    const s = p.size / Math.max(r.width, r.height);
    return {
      width: `${r.width * s}px`,
      height: `${r.height * s}px`,
      "background-image": `url("${resolveImageUrl(i)}")`,
      "background-size": `${i.width * s}px ${i.height * s}px`,
      "background-position": `${-r.x * s}px ${-r.y * s}px`,
    };
  };
  return (
    <div class="seq-thumb-box" style={{ width: `${p.size}px`, height: `${p.size}px` }}>
      <div class="seq-thumb" style={style()} title={img()?.name ?? "missing image"} />
    </div>
  );
}

export function SequenceEditor(p: { slotId: string; att: SequenceAttachment; owner: SkinData }) {
  // Read through doc() so fields follow in-place edits and undo.
  const a = () => (doc(), p.att);
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, props });
  const setFrames = (frames: SequenceFrame[]) => apply("setSequenceFrames", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, frames });
  const count = () => a().frames.length;
  const pinned = () => {
    const s = sequencePreview();
    return s && s.slotId === p.slotId && s.attachment === p.att.name ? s.frame : null;
  };
  onCleanup(() => {
    if (pinned() !== null) setSequencePreview(null);
  });
  createEffect(() => {
    // Drop a pin that points past the end after frames were removed.
    const f = pinned();
    if (f !== null && f >= count()) setSequencePreview(count() ? { slotId: p.slotId, attachment: p.att.name, frame: count() - 1 } : null);
  });
  // The frame the viewport shows (keyed, input-driven or timed); the pinned one while scrubbing.
  const shown = () => pinned() ?? Math.max(0, sequenceShown());
  const pin = (frame: number) => setSequencePreview({ slotId: p.slotId, attachment: p.att.name, frame: Math.max(0, Math.min(count() - 1, frame)) });

  const move = (i: number, d: number) => {
    const f = a().frames.slice();
    const j = i + d;
    if (j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    setFrames(f);
    if (pinned() === i) pin(j);
  };
  const remove = (i: number) => {
    if (count() <= 1) return;
    setFrames(a().frames.filter((_, k) => k !== i));
  };

  let replaceInput!: HTMLInputElement;
  const replace = async (files: FileList | null) => {
    if (!files?.length) return;
    const images = groupNumbered(Array.from(files).filter((f) => f.type.startsWith("image/")), (f) => f.name).flatMap((g) => g.items);
    if (!images.length) return;
    const loaded = await Promise.all(
      images.map(async (f) => {
        const src = await readFileAsDataUrl(f);
        return { name: f.name.replace(/\.[^.]+$/, ""), src, ...(await imageSize(src)) };
      }),
    );
    transaction(`replace frames of ${p.att.name}`, () => {
      const ids = loaded.map((img) => (store.apply("addImage", img) as { id: string }).id);
      store.apply("setSequenceFrames", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, frames: ids, resize: true });
    });
  };

  const inputs = () => doc().stateMachines.flatMap((sm) => sm.inputs.filter((i) => i.type === "number").map((i) => ({ value: i.id, label: `${sm.name} · ${i.name}` })));
  const keyFrame = () => {
    const anim = ensureAnimation();
    if (anim)
      apply("setKeys", {
        animation: anim,
        target: "sequence",
        id: p.slotId,
        attachment: p.att.name,
        property: "frame",
        keys: [{ time: Math.round(time() * 1000) / 1000, value: shown() - a().offset, curve: "stepped" }],
      });
  };

  return (
    <>
      <div class="seq-preview">
        <Show when={a().frames[shown()]} fallback={<div class="hint">No frames</div>}>
          {(f) => <FrameThumb frame={f()} size={96} />}
        </Show>
        <div class="seq-meta">
          <div>
            Frame <b>{shown() + 1}</b> / {count()}
          </div>
          <div class="muted">{sequenceDuration(count(), a().fps, a().mode).toFixed(2)}s per cycle</div>
          <div class="btn-row">
            <button title="Previous frame" onClick={() => pin(shown() - 1)}>◀</button>
            <button title={pinned() === null ? "Hold the viewport on this frame" : "Play again"} onClick={() => (pinned() === null ? pin(shown()) : setSequencePreview(null))}>
              {pinned() === null ? "❚❚" : "▶"}
            </button>
            <button title="Next frame" onClick={() => pin(shown() + 1)}>▶|</button>
          </div>
        </div>
      </div>
      <input class="seq-scrub" type="range" min={0} max={Math.max(0, count() - 1)} step={1} value={shown()} onInput={(e) => pin(Number(e.currentTarget.value))} title="Scrub frames (holds the viewport on the frame)" />
      <Show when={mode() === "animate"}>
        <button title="Key this frame at the current time (stepped). Keys replace the time-based frame while the animation plays." onClick={keyFrame}>
          ◆ Key frame {shown() + 1} at {time().toFixed(2)}s
        </button>
      </Show>
      <NumberField label="FPS" step={1} value={a().fps} onCommit={(v) => v > 0 && set({ fps: v })} />
      <SelectField label="Mode" value={a().mode} options={MODES} onCommit={(v) => set({ mode: v })} />
      <NumberField label="Offset" step={1} value={a().offset} onCommit={(v) => set({ offset: Math.round(v) })} />
      <SelectField
        label="Driven by"
        value={a().input ?? ""}
        options={[{ value: "", label: "Time (animation / state)" }, ...inputs()]}
        onCommit={(v) => set({ input: v || null })}
      />
      <NumberField label="Width" value={a().width} onCommit={(v) => set({ width: v })} />
      <NumberField label="Height" value={a().height} onCommit={(v) => set({ height: v })} />
      <NumberField label="Scale X" step={0.01} value={a().scaleX} onCommit={(v) => set({ scaleX: v })} />
      <NumberField label="Scale Y" step={0.01} value={a().scaleY} onCommit={(v) => set({ scaleY: v })} />
      <ColorField label="Tint" value={a().color} onCommit={(v) => set({ color: v })} />
      <div class="field col">
        <span>Frames</span>
        <div class="seq-frames">
          <For each={a().frames}>
            {(f, i) => (
              <div class="seq-frame" classList={{ current: i() === shown() }} onClick={() => pin(i())}>
                <FrameThumb frame={f} size={36} />
                <span class="seq-num">{i() + 1}</span>
                <span class="row-actions">
                  <button class="row-btn" title="Move earlier" onClick={(e) => { e.stopPropagation(); move(i(), -1); }}>↑</button>
                  <button class="row-btn" title="Move later" onClick={(e) => { e.stopPropagation(); move(i(), 1); }}>↓</button>
                  <button class="row-btn" title="Remove frame" disabled={count() <= 1} onClick={(e) => { e.stopPropagation(); remove(i()); }}>×</button>
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="btn-row">
        <button title="Reverse the frame order" onClick={() => setFrames(a().frames.slice().reverse())}>Reverse</button>
        <button title="Replace all frames with new images (numbered names are sorted naturally)" onClick={() => replaceInput.click()}>Replace frames…</button>
        <input ref={replaceInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void replace(e.currentTarget.files); e.currentTarget.value = ""; }} />
      </div>
    </>
  );
}
