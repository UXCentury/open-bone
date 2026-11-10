import { For, Show } from "solid-js";
import { doc, mode, selectedBoneId, store, time } from "../state.ts";
import { kbd } from "../shortcuts/index.ts";
import { slotOpacity } from "../visibility.ts";
import type { HandleMode } from "./knots.ts";
import { deleteKnotsOf, knotMode, pathTarget, resetHandlesOf, setClosed, setModeOf, setupOnly } from "./path-edit.ts";
import { cancelDrawing, drawing, finishDrawing, penDelete, penSel } from "./pen.ts";
import { penHost } from "./pen-host.ts";
import { polygonTarget } from "./polygon-edit.ts";

const MODES: { id: HandleMode; label: string; title: string }[] = [
  { id: "smooth", label: "Smooth", title: "Handles stay in line; each keeps its own length" },
  { id: "mirrored", label: "Mirrored", title: "Handles stay in line and the same length" },
  { id: "broken", label: "Broken", title: "Handles move independently (a corner). Alt-drag a handle to break it" },
];

/** Floating panel for the Pen tool (paths and bounding boxes). */
export function PenPanel() {
  const path = () => (doc(), pathTarget());
  const poly = () => (doc(), polygonTarget());
  const knots = () => [...new Set(penSel().map((p) => Math.floor(p / 3)))];
  const boneName = (id: string | null | undefined) => (id ? (doc().skeleton.bones.find((b) => b.id === id)?.name ?? id) : "");
  const currentMode = (): HandleMode | null => {
    const t = path();
    const ks = knots();
    if (!t || !ks.length) return null;
    const m = ks.map((k) => knotMode(t, k));
    return m.every((x) => x === m[0]) ? m[0] : null;
  };
  const hidden = () => {
    const t = path();
    if (!t) return false;
    const slot = doc().skeleton.slots.find((s) => s.id === t.slotId);
    return slot?.attachment !== t.name || slotOpacity(t.slotId) <= 0;
  };
  return (
    <div class="mesh-panel pen-panel" onPointerDown={(e) => e.stopPropagation()}>
      <Show
        when={!drawing()}
        fallback={
          <>
            <div class="mesh-title">
              Drawing {drawing()!.extend ? <>onto <b>{drawing()!.extend!.name}</b></> : <>a new path on <b>{boneName(drawing()!.bone)}</b></>} · {drawing()!.knots.length / 6} new knot{drawing()!.knots.length === 6 ? "" : "s"}
            </div>
            <div class="hint">Click to place knots, drag to pull out handles. Click the first knot to close the path; {kbd("edit.finishPath")} or Esc finishes, {kbd("edit.delete")} removes the last knot.</div>
            <div class="btn-row">
              <button class="primary" onClick={finishDrawing}>Finish</button>
              <button onClick={cancelDrawing}>Cancel</button>
            </div>
          </>
        }
      >
        <Show when={path()}>
          {(t) => (
            <>
              <div class="mesh-title">
                Path · <b>{t().name}</b> · {t().att.vertices.length / 6} knots{t().att.closed ? " · closed" : ""}
                {t().att.weights ? " · weighted" : ""}
              </div>
              <Show when={hidden()}>
                <div class="hint warn">This path is hidden: show it (slot “Showing” or the eye in the Skeleton tree) to edit its knots.</div>
              </Show>
              <Show when={mode() === "animate"}>
                <div class="hint">Animate mode: dragging knots keys the path's deform at {time().toFixed(2)}s. Add or remove knots in Setup mode.</div>
              </Show>
              <div class="field">
                <span>Handles</span>
                <div class="segmented group">
                  <For each={MODES}>
                    {(m) => (
                      <button disabled={!knots().length} classList={{ active: currentMode() === m.id }} title={m.title} onClick={() => setModeOf(penHost()!, t(), knots(), m.id)}>
                        {m.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="btn-row">
                <button disabled={!knots().length} title="Smooth handles from the neighbouring knots" onClick={() => resetHandlesOf(penHost()!, t(), knots())}>
                  Reset handles
                </button>
                <label class="check" title="Join the last knot back to the first">
                  <input type="checkbox" checked={t().att.closed} onChange={(e) => (setupOnly("Closing a path") ? setClosed(t(), e.currentTarget.checked) : (e.currentTarget.checked = t().att.closed))} /> Closed
                </label>
                <button class="danger" disabled={!knots().length} onClick={() => deleteKnotsOf(penHost()!, t(), knots())}>
                  Delete {knots().length || ""}
                </button>
              </div>
              <div
                class="hint"
                title={`Drag anchors (handles follow) or handles. Alt-drag a handle to break it, Alt-drag an anchor to pull out new handles. Click the curve to add a knot, ${kbd("edit.delete")} deletes, right-click a knot for handle modes. With an end knot selected, click empty space to keep drawing.`}
              >
                Drag knots or handles · Alt-drag breaks a handle · click the curve to add a knot · right-click for modes
              </div>
            </>
          )}
        </Show>
        <Show when={!path() && poly()}>
          {(t) => (
            <>
              <div class="mesh-title">
                {t().att.type === "boundingBox" ? "Bounding box" : "Mask"} · <b>{t().name}</b> · {t().att.vertices.length / 2} points
              </div>
              <Show when={mode() === "animate"}>
                <div class="hint warn">Points are setup data: switch to Setup mode to edit them.</div>
              </Show>
              <div class="btn-row">
                <button class="danger" disabled={!penSel().length} onClick={() => penDelete()}>
                  Delete {penSel().length || ""}
                </button>
              </div>
              <div class="hint" title={`Drag points (shift-click adds to the selection), click an edge to add a point, drag inside to move the whole outline, ${kbd("edit.delete")} deletes. Trace from an image or use a preset in the Inspector.`}>
                Drag points · click an edge to add one · drag inside to move all · {kbd("edit.delete")} deletes
              </div>
            </>
          )}
        </Show>
        <Show when={!path() && !poly()}>
          <div class="mesh-title">Pen</div>
          <div class="hint">
            Click to start a new path on <b>{boneName(selectedBoneId() ?? store.doc.skeleton.bones[0]?.id)}</b> (drag to pull out handles). Click a path or a bounding box to edit it.
          </div>
        </Show>
      </Show>
    </div>
  );
}

