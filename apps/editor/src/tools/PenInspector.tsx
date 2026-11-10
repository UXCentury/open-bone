import { For, Show, createSignal } from "solid-js";
import { ColorField } from "../panels/fields.tsx";
import { autoWeightsFor, averageWeights, setBoneWeight } from "../mesh-edit.ts";
import { doc, ownerSkinArg, apply, setTool, tool, toast } from "../state.ts";
import { kbd } from "../shortcuts/index.ts";
import { knotCount } from "./knots.ts";
import { anchorSetupWorld, commitKnotWeights, pathTargetFor, pathWeightTable, unbindPath } from "./path-edit.ts";
import { penSel } from "./pen.ts";
import { BOX_COLOR, type PolygonTarget, ellipsePreset, rectPreset, traceFromImage } from "./polygon-edit.ts";

/**
 * Inspector parts for paths and bounding boxes: binding path knots to bones, and the bounding-box presets / trace.
 */

/** "Bind knots to bones": pick knots with the Pen tool (or all), pick bones, then bind and tune the weights. */
export function PathKnotWeights(p: { slotId: string; name: string }) {
  const [bones, setBones] = createSignal<string[]>([]);
  const target = () => (doc(), pathTargetFor(p.slotId, p.name));
  const boneName = (id: string) => doc().skeleton.bones.find((b) => b.id === id)?.name ?? id;
  /** Selected knots (Pen tool), else every knot. */
  const knots = () => {
    const t = target();
    if (!t) return [];
    const sel = [...new Set(penSel().map((q) => Math.floor(q / 3)))];
    return sel.length && tool() === "pen" ? sel : Array.from({ length: knotCount(t.att.vertices) }, (_, k) => k);
  };
  const scope = () => {
    const t = target();
    const n = knots().length;
    return t && n === knotCount(t.att.vertices) ? `all ${n} knots` : `${n} selected knot${n === 1 ? "" : "s"}`;
  };
  const anchors = () => knots().map((k) => k * 3 + 1);
  const rows = () => {
    const t = target();
    if (!t?.att.weights) return [];
    return averageWeights(pathWeightTable(t), anchors());
  };
  const run = (fn: (table: Map<string, number>[]) => number[]) => {
    const t = target();
    if (!t) return;
    const table = pathWeightTable(t);
    const changed = fn(table);
    if (changed.length) commitKnotWeights(t, table, [...new Set(changed.map((q) => Math.floor(q / 3)))]);
  };
  const bindAuto = () => {
    if (!bones().length) return toast("Pick one or more bones to bind to", "error");
    run((table) => autoWeightsFor(table, anchors(), anchorSetupWorld(target()!), bones(), 2));
  };
  const bindFull = () => {
    if (bones().length !== 1) return toast("Pick exactly one bone to bind the knots to it fully", "error");
    const b = bones()[0];
    run((table) => anchors().map((a) => ((table[a] = new Map([[b, 1]])), a)));
  };
  return (
    <div class="knot-weights">
      <div class="muted small">Bind knots to bones · {scope()}</div>
      <Show when={tool() !== "pen"}>
        <div class="hint">
          Select knots with the <button class="link" onClick={() => setTool("pen")}>Pen tool ({kbd("tool.pen")})</button> to bind only some of them.
        </div>
      </Show>
      <select multiple size={5} title="Bones to bind to (Ctrl/⌘ or shift-click for several)" onChange={(e) => setBones(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}>
        <For each={doc().skeleton.bones}>{(b) => <option value={b.id}>{b.name}</option>}</For>
      </select>
      <div class="btn-row">
        <button disabled={!bones().length} title="Weight each knot to its nearest picked bones (up to 2), by distance in the setup pose" onClick={bindAuto}>
          Bind by distance
        </button>
        <button disabled={bones().length !== 1} title="Bind the knots 100% to the picked bone" onClick={bindFull}>
          Bind 100%
        </button>
        <button class="danger" disabled={!target()?.att.weights} title="Remove all weights: the path follows its slot bone again" onClick={() => target() && unbindPath(target()!)}>
          Unbind
        </button>
      </div>
      <For each={rows()}>
        {(r) => (
          <label class="field weight-row" title={`Set ${boneName(r.bone)} on ${scope()}; the other bones share the rest`}>
            <span>{boneName(r.bone)}</span>
            <input type="range" min="0" max="100" step="1" value={Math.round(r.w * 100)} onChange={(e) => run((table) => setBoneWeight(table, anchors(), r.bone, Number(e.currentTarget.value) / 100))} />
            <span class="num">{Math.round(r.w * 100)}%</span>
          </label>
        )}
      </For>
    </div>
  );
}

/** Bounding box: colour, edit with the Pen tool, trace from an image, rectangle and ellipse presets. */
export function BoundingBoxTools(p: { t: PolygonTarget }) {
  const [points, setPoints] = createSignal(12);
  const color = () => (p.t.att.type === "boundingBox" ? (p.t.att.color ?? BOX_COLOR) : BOX_COLOR);
  return (
    <>
      <div class="hint">Hit area for state-machine listeners · {p.t.att.vertices.length / 2} points.</div>
      <Show when={p.t.att.type === "boundingBox"}>
        <ColorField label="Color" value={color()} onCommit={(v) => apply("updateAttachment", { slot: p.t.slotId, attachment: p.t.name, ...ownerSkinArg(p.t.slotId, p.t.name), props: { color: v } })} />
      </Show>
      <div class="btn-row">
        <button classList={{ active: tool() === "pen" }} title={`Drag, add and delete points in the viewport (Pen tool, ${kbd("tool.pen")})`} onClick={() => setTool("pen")}>
          Edit points
        </button>
        <button title="Wrap the outline round the visible pixels of an image or mesh" onClick={() => void traceFromImage(p.t)}>
          Trace from image…
        </button>
      </div>
      <div class="btn-row">
        <button title="A rectangle over the current outline's bounds" onClick={() => rectPreset(p.t)}>
          Rectangle
        </button>
        <button title="An ellipse inside the current outline's bounds" onClick={() => ellipsePreset(p.t, points())}>
          Ellipse
        </button>
        <label class="check" title="Ellipse points">
          <input class="tiny" type="number" min="3" max="64" value={points()} onChange={(e) => setPoints(Math.min(64, Math.max(3, Math.round(Number(e.currentTarget.value) || 12))))} /> pts
        </label>
      </div>
    </>
  );
}
