import type { Skeleton, Slot } from "@openbone/runtime";
import { createSignal } from "solid-js";
import { apply, store, toast } from "./state.ts";
import { eyeOpacity } from "./visibility.ts";

/**
 * Order view (View → Order view, shortcut Z): the character turned to face you, with draw order as left-to-right depth.
 *
 * Every visible part is drawn on its own, front-facing and at its real height, centred in a column whose position is
 * its place in the draw order: the back-most part on the left, the front-most on the right. A side-view character
 * then reads like a front view (back arm and leg on one side, torso in the middle, front arm and leg on the other),
 * so a part in the wrong layer stands out. Drag a part left or right to move it in the draw order.
 *
 * Editor-only, like View → Attachments and the eye buttons: it changes how the viewport draws, not the document.
 */
export const [zView, setZView_] = createSignal(false);
/** 3D view (View → 3D view, Shift+Z): every part on its own plane in depth, with the bones, in an orbiting camera. */
export const [view3d, setView3d_] = createSignal(false);
// The two views replace the canvas, so only one is on at a time.
export const setZView = (on: boolean) => {
  if (on) setView3d_(false);
  setZView_(on);
};
export const setView3d = (on: boolean) => {
  if (on) setZView_(false);
  setView3d_(on);
};

export interface ZColumn {
  slot: Slot;
  /** Index of the slot in the document's draw order (skeleton.slots). */
  docIndex: number;
  /** Horizontal shift (skeleton units) that moves the part from where it is into its column. */
  dx: number;
  /** Column centre x (skeleton units). */
  x: number;
  /** The part's drawn triangles (skeleton units, before the shift), for hit testing. */
  tris: { vertices: Float32Array; indices: Uint16Array }[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface ZLayout {
  columns: ZColumn[];
  spacing: number;
  /** Parts left out because they cover most of the artboard (backgrounds), by slot name. */
  skipped: string[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function bounds(tris: { vertices: Float32Array }[]) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const { vertices: v } of tris)
    for (let i = 0; i < v.length; i += 2) {
      x0 = Math.min(x0, v[i]);
      x1 = Math.max(x1, v[i]);
      y0 = Math.min(y0, v[i + 1]);
      y1 = Math.max(y1, v[i + 1]);
    }
  return { x0, x1, y0, y1 };
}

/** Lay the skeleton's visible parts out in draw order. `artboardWidth` decides what counts as a background. */
export function zLayout(sk: Skeleton, artboardWidth: number): ZLayout {
  const order = new Map(store.doc.skeleton.slots.map((s, i) => [s.id, i]));
  // What is actually drawn (images, meshes, shapes, text), grouped by slot in draw order. Click boxes don't count.
  const bySlot = new Map<Slot, { vertices: Float32Array; indices: Uint16Array }[]>();
  for (const it of sk.drawList()) {
    if (eyeOpacity(it.slot.data.id) <= 0 || it.vertices.length < 6) continue;
    const list = bySlot.get(it.slot) ?? [];
    list.push({ vertices: it.vertices.slice(), indices: it.indices });
    bySlot.set(it.slot, list);
  }
  const parts: { slot: Slot; tris: { vertices: Float32Array; indices: Uint16Array }[]; b: ReturnType<typeof bounds> }[] = [];
  const skipped: string[] = [];
  for (const [slot, tris] of bySlot) {
    const b = bounds(tris);
    // Scenery spans the artboard; spread out it would dwarf the character, so it is listed instead.
    if (b.x1 - b.x0 > artboardWidth * 0.8) {
      skipped.push(slot.data.name);
      continue;
    }
    parts.push({ slot, tris, b });
  }
  // Column spacing from the parts' widths (most parts fit, the widest overlap their neighbours a little).
  const widths = parts.map((p) => p.b.x1 - p.b.x0).sort((a, b) => a - b);
  const typical = widths.length ? widths[Math.floor(widths.length * 0.75)] : 60;
  const spacing = Math.max(36, Math.min(220, typical * 1.1));
  const n = parts.length;
  const columns = parts.map((p, i) => {
    const x = (i - (n - 1) / 2) * spacing;
    return { slot: p.slot, docIndex: order.get(p.slot.data.id) ?? 0, x, dx: x - (p.b.x0 + p.b.x1) / 2, tris: p.tris, minX: p.b.x0, maxX: p.b.x1, minY: p.b.y0, maxY: p.b.y1 };
  });
  const ys = parts.flatMap((p) => [p.b.y0, p.b.y1]);
  return {
    columns,
    spacing,
    skipped,
    minX: n ? columns[0].x - spacing / 2 : -spacing,
    maxX: n ? columns[n - 1].x + spacing / 2 : spacing,
    minY: ys.length ? Math.min(...ys) : 0,
    maxY: ys.length ? Math.max(...ys) : 100,
  };
}

/** Whether (x, y) is inside any of the part's drawn triangles, shifted by dx. */
function pointIn(x: number, y: number, tris: ZColumn["tris"], dx: number) {
  const px = x - dx;
  for (const { vertices: v, indices: ix } of tris)
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const a = ix[t] * 2;
      const b = ix[t + 1] * 2;
      const c = ix[t + 2] * 2;
      const d1 = (px - v[b]) * (v[a + 1] - v[b + 1]) - (v[a] - v[b]) * (y - v[b + 1]);
      const d2 = (px - v[c]) * (v[b + 1] - v[c + 1]) - (v[b] - v[c]) * (y - v[c + 1]);
      const d3 = (px - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (y - v[a + 1]);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) return true;
    }
  return false;
}

/** The column under a point (skeleton units): the front-most part whose shifted outline contains it. */
export function zHit(layout: ZLayout, x: number, y: number): ZColumn | null {
  for (let i = layout.columns.length - 1; i >= 0; i--) {
    const c = layout.columns[i];
    if (pointIn(x, y, c.tris, c.dx)) return c;
  }
  return null;
}

/** Column position a drag at x (skeleton units) would drop into. */
export function zDropIndex(layout: ZLayout, x: number): number {
  const n = layout.columns.length;
  if (!n) return 0;
  const i = Math.round(x / layout.spacing + (n - 1) / 2);
  return Math.max(0, Math.min(n - 1, i));
}

/** Move the part from column `from` to column `to` in the draw order (one undoable edit). */
export function zMove(layout: ZLayout, from: number, to: number) {
  if (from === to) return;
  const moving = layout.columns[from];
  const target = layout.columns[to];
  if (!moving || !target) return;
  // updateSlot's index is the slot's final position: taking the target's current index puts the part just in front
  // of it when moving forward and just behind it when moving back.
  apply("updateSlot", { slot: moving.slot.data.id, index: target.docIndex });
  toast(`${moving.slot.data.name} moved ${to > from ? "in front of" : "behind"} ${target.slot.data.name}`, "info");
}
