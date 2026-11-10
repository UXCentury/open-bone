import { buildSpline, pointInPolygon, splinePolyline } from "@openbone/core";
import { Skeleton } from "@openbone/runtime";
import { createEffect, createSignal, on } from "solid-js";
import type { MenuItem } from "../menu.tsx";
import { activeSkinId, mode, selectedBoneId, selection, setSelection, showBones, store, toast, tool } from "../state.ts";
import { slotOpacity } from "../visibility.ts";
import { type HandleMode, type Pt, deletePoints, insertPoint, knotCount, moveHandle, nearestEdge, nearestOnPath, placedKnot } from "./knots.ts";
import { type Drawing, type PathTarget, commitDrawing, deleteKnotsOf, editPath, insertKnotAt, knotMode, pathShown, pathTarget, pathWorld, resetHandlesOf, setClosed, setKnotMode, setModeOf, setupOnly } from "./path-edit.ts";
import { type PenHost, boneMat, penHost, penHover, penSel, setPenHost, setPenHover, setPenSel } from "./pen-host.ts";
import { type PolygonTarget, commitPolygon, polygonColor, polygonTarget, polygonWorld, polygonsSetupOnly } from "./polygon-edit.ts";

/**
 * The Pen tool: draw paths (click knots, drag to pull handles, click the first knot to close, Enter/Esc to finish),
 * edit path knots and handles, and edit bounding-box / mask points. `Viewport.tsx` forwards pointer events here
 * and calls `drawPenOverlay` each frame; everything else lives in this folder.
 */

export { penSel, penHover };

const [drawing, setDrawing] = createSignal<Drawing | null>(null);
export { drawing };

type PenDrag =
  | {
      kind: "path";
      t: PathTarget;
      start: Pt;
      base: number[];
      grabbed: number;
      /** Alt on a handle: break it. Alt on an anchor: pull out new handles. */
      alt: boolean;
      cur: number[] | null;
      preview: Skeleton | null;
    }
  | { kind: "poly"; t: PolygonTarget; start: Pt; base: number[]; moving: number[]; grabbed: number; cur: number[] | null; preview: Skeleton | null; inserted: boolean }
  | { kind: "place"; anchor: Pt; drag: Pt | null; down: Pt };
let pd: PenDrag | null = null;

/** The skeleton to draw while a knot or point drag is previewed (null: draw the viewport's own). */
export const penPreview = (): Skeleton | null => (pd && pd.kind !== "place" ? pd.preview : null);

const PICK = 7; // px
const px = (h: PenHost) => 1 / h.zoom();

function hitPoint(world: ArrayLike<number>, x: number, y: number, r: number, filter?: (i: number) => boolean): number {
  let best = -1;
  let bd = r;
  for (let i = 0; i < world.length / 2; i++) {
    if (filter && !filter(i)) continue;
    const d = Math.hypot(world[i * 2] - x, world[i * 2 + 1] - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Path point under (x, y): anchors win over handles sitting on them. */
function hitPathPoint(world: ArrayLike<number>, x: number, y: number, r: number): number {
  const a = hitPoint(world, x, y, r, (i) => i % 3 === 1);
  const hnd = hitPoint(world, x, y, r, (i) => i % 3 !== 1 && Math.hypot(world[i * 2] - world[(i - (i % 3) + 1) * 2], world[i * 2 + 1] - world[(i - (i % 3) + 1) * 2 + 1]) > 1e-6);
  if (a < 0) return hnd;
  if (hnd < 0) return a;
  const da = Math.hypot(world[a * 2] - x, world[a * 2 + 1] - y);
  const dh = Math.hypot(world[hnd * 2] - x, world[hnd * 2 + 1] - y);
  return dh + 1e-9 < da * 0.6 ? hnd : a;
}

const shownPath = (h: PenHost, t: PathTarget) => pathShown(h.sk(), t.slotId, t.name, slotOpacity);
const shownPoly = (h: PenHost, t: PolygonTarget) => {
  const slot = h.sk().slotById_(t.slotId);
  return !!slot && slot.bone.active && slotOpacity(t.slotId) > 0;
};

/** A visible path whose curve passes near (x, y), or a bounding box containing it: what a click selects. */
function pickPenAttachment(h: PenHost, x: number, y: number): { slotId: string; name: string } | null {
  const sk = h.sk();
  const r = PICK * px(h);
  for (const slot of [...sk.drawOrder].reverse()) {
    const att = sk.getAttachment(slot);
    if (att?.type !== "path" || !pathShown(sk, slot.data.id, att.name, slotOpacity)) continue;
    const hit = nearestOnPath(sk.attachmentWorldVertices(slot, att), att.closed, x, y);
    if (hit && hit.dist <= r) return { slotId: slot.data.id, name: att.name };
  }
  for (const slot of [...sk.drawOrder].reverse()) {
    if (!slot.bone.active || slotOpacity(slot.data.id) <= 0) continue;
    const atts = [sk.doc.skeleton.skins[0], sk.skin].flatMap((k) => Object.values(k?.attachments[slot.data.id] ?? {}));
    for (const att of atts) {
      if (att.type !== "boundingBox") continue;
      if (pointInPolygon(x, y, sk.attachmentWorldVertices(slot, att))) return { slotId: slot.data.id, name: att.name };
    }
  }
  return null;
}

function makePreview(t: { slotId: string; name: string }): Skeleton {
  const doc = structuredClone(store.doc);
  // The preview shows the edited points as setup data; drop this attachment's deform so they aren't offset twice.
  for (const a of doc.animations) a.timelines = a.timelines.filter((tl) => !(tl.target === "deform" && tl.id === t.slotId && tl.attachment === t.name));
  const ps = new Skeleton(doc);
  ps.setSkin(activeSkinId());
  return ps;
}

/** Show `world` points on the preview skeleton (bones posed as in the viewport). */
function updatePreview(h: PenHost, ps: Skeleton, t: { slotId: string; slotBone: string; name: string }, world: number[]) {
  const slot = ps.slotById_(t.slotId);
  const att = slot && ps.getAttachment(slot, t.name);
  if (!att) return;
  const mats = boneMat(h);
  if (att.type === "path" && att.weights) {
    att.weights = att.weights.map((inf, i) =>
      inf.map((b) => {
        const m = mats(b.bone);
        const det = m.a * m.d - m.b * m.c || 1e-12;
        const dx = world[i * 2] - m.x;
        const dy = world[i * 2 + 1] - m.y;
        return { ...b, x: (m.d * dx - m.b * dy) / det, y: (-m.c * dx + m.a * dy) / det };
      }),
    );
  } else if (att.type === "path" || att.type === "boundingBox" || att.type === "clipping") {
    const m = mats(t.slotBone);
    const det = m.a * m.d - m.b * m.c || 1e-12;
    att.vertices = [];
    for (let i = 0; i < world.length; i += 2) {
      const dx = world[i] - m.x;
      const dy = world[i + 1] - m.y;
      att.vertices.push((m.d * dx - m.b * dy) / det, (-m.c * dx + m.a * dy) / det);
    }
  }
  h.repose(ps);
}

// ---------------- pointer ----------------

/** Alt-drag on a knot or handle edits it (instead of panning the view). */
export function penAltHit(x: number, y: number): boolean {
  const h = penHost();
  const t = pathTarget();
  if (!h || !t || !shownPath(h, t)) return false;
  const w = pathWorld(h, t);
  return !!w && hitPathPoint(w, x, y, PICK * px(h)) >= 0;
}

export function penDown(e: PointerEvent, x: number, y: number): void {
  const h = penHost();
  if (!h) return;
  const r = PICK * px(h);
  const d = drawing();
  if (d) return drawingDown(h, d, e, x, y);

  const pt = pathTarget();
  if (pt && shownPath(h, pt)) {
    const world = pathWorld(h, pt)!;
    const hit = hitPathPoint(world, x, y, r);
    if (hit >= 0) {
      let sel = penSel();
      if (e.shiftKey) sel = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit];
      else if (!sel.includes(hit) || hit % 3 !== 1) sel = [hit];
      setPenSel(sel);
      if (sel.includes(hit)) pd = { kind: "path", t: pt, start: [x, y], base: world, grabbed: hit, alt: e.altKey, cur: null, preview: null };
      return;
    }
    const near = nearestOnPath(world, pt.att.closed, x, y);
    if (near && near.dist <= r) {
      insertKnotAt(h, pt, near.segment, near.t);
      return;
    }
    // An end knot of an open path selected: keep drawing from it.
    const sel = penSel();
    const n = knotCount(world);
    if (!pt.att.closed && sel.length === 1 && (sel[0] === 1 || sel[0] === n * 3 - 2) && !pickPenAttachment(h, x, y)) {
      if (!setupOnly("Drawing")) return;
      const prepend = sel[0] === 1 && n > 1;
      startDrawing(h, { bone: pt.slotBone, knots: [], closed: false, extend: { slotId: pt.slotId, name: pt.name, prepend } }, e, x, y);
      return;
    }
  }

  const gt = polygonTarget();
  if (gt && shownPoly(h, gt)) {
    const world = polygonWorld(h, gt)!;
    const hit = hitPoint(world, x, y, r);
    if (hit >= 0 || (nearestEdge(world, x, y)?.dist ?? Infinity) <= r || pointInPolygon(x, y, world)) {
      if (!polygonsSetupOnly()) return;
      if (hit >= 0) {
        let sel = penSel();
        if (e.shiftKey) sel = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit];
        else if (!sel.includes(hit)) sel = [hit];
        setPenSel(sel);
        if (sel.includes(hit)) pd = { kind: "poly", t: gt, start: [x, y], base: world, moving: sel, grabbed: hit, cur: null, preview: null, inserted: false };
        return;
      }
      const edge = nearestEdge(world, x, y)!;
      if (edge.dist <= r) {
        // Insert on the edge; the drag that follows moves it, and both land as one op on release.
        const { vertices, index } = insertPoint(world, edge.edge, x, y);
        setPenSel([index]);
        pd = { kind: "poly", t: gt, start: [x, y], base: vertices, moving: [index], grabbed: index, cur: vertices, preview: null, inserted: true };
        return;
      }
      // Inside: move the whole polygon.
      pd = { kind: "poly", t: gt, start: [x, y], base: world, moving: world.map((_, i) => i).filter((i) => i < world.length / 2), grabbed: -1, cur: null, preview: null, inserted: false };
      return;
    }
  }

  const other = pickPenAttachment(h, x, y);
  if (other) {
    setSelection({ kind: "slot", id: other.slotId, attachment: other.name });
    setPenSel([]);
    return;
  }
  if (gt && penSel().length) {
    setPenSel([]);
    return;
  }
  if (mode() === "animate") {
    toast("Draw new paths in Setup mode (in Animate mode the Pen tool keys knots of the selected path)", "info");
    return;
  }
  const bone = (pt ? pt.slotBone : selectedBoneId()) ?? store.doc.skeleton.bones[0]?.id;
  if (!bone) return;
  startDrawing(h, { bone, knots: [], closed: false }, e, x, y);
}

function startDrawing(h: PenHost, d: Drawing, e: PointerEvent, x: number, y: number) {
  setDrawing(d);
  setPenSel([]);
  pd = { kind: "place", anchor: h.snap(x, y, e, drawingAnchors(h, d)), drag: null, down: [x, y] };
}

/** Anchors of the path being drawn, including the path it extends (world space). */
function drawingAnchors(h: PenHost, d: Drawing): [number, number][] {
  const out: [number, number][] = [];
  const all = drawingWorld(h, d);
  for (let i = 2; i < all.length; i += 6) out.push([all[i], all[i + 1]]);
  return out;
}

/** Every knot of the path being drawn in path order (the extended path's knots included). */
export function drawingWorld(h: PenHost, d: Drawing): number[] {
  if (!d.extend) return d.knots;
  const t = pathTarget();
  const w = t && t.slotId === d.extend.slotId && t.name === d.extend.name ? pathWorld(h, t) : null;
  if (!w) return d.knots;
  return d.extend.prepend ? [...d.knots, ...w] : [...w, ...d.knots];
}

function drawingDown(h: PenHost, d: Drawing, e: PointerEvent, x: number, y: number) {
  const all = drawingWorld(h, d);
  const n = all.length / 6;
  const r = PICK * px(h);
  // Click the other end's anchor to close the path.
  const first = d.extend?.prepend ? n - 1 : 0;
  if (n >= 2 && Math.hypot(all[first * 6 + 2] - x, all[first * 6 + 3] - y) <= r) {
    setDrawing({ ...d, closed: true });
    finishDrawing();
    return;
  }
  pd = { kind: "place", anchor: h.snap(x, y, e, drawingAnchors(h, d)), drag: null, down: [x, y] };
}

/** Pointer move. Returns true while the Pen tool is dragging (the viewport then does nothing else). */
export function penMove(e: PointerEvent, x: number, y: number): boolean {
  const h = penHost();
  if (!h) return false;
  if (!pd) {
    updateHover(h, x, y);
    return false;
  }
  if (pd.kind === "place") {
    // A drag (from where the button went down, not the snapped anchor) pulls out handles.
    const [ax, ay] = pd.down;
    pd.drag = Math.hypot(x - ax, y - ay) * h.zoom() > 3 ? [x - ax + pd.anchor[0], y - ay + pd.anchor[1]] : null;
    return true;
  }
  if (pd.kind === "path") {
    const { t, base, grabbed } = pd;
    const k = Math.floor(grabbed / 3);
    const part = grabbed % 3;
    const dx = x - pd.start[0];
    const dy = y - pd.start[1];
    let cur: number[];
    if (part === 1 && pd.alt) {
      cur = base.slice();
      cur.splice(k * 6, 6, ...placedKnot([base[k * 6 + 2], base[k * 6 + 3]], Math.hypot(dx, dy) * h.zoom() > 2 ? [x, y] : null));
    } else if (part === 1) {
      // Snap the grabbed anchor; the other selected points follow by the same offset.
      const sel = new Set(penSel());
      const moving = new Set([...sel].filter((p) => p % 3 === 1).map((p) => Math.floor(p / 3)));
      const others: [number, number][] = [];
      for (let q = 0; q < base.length / 6; q++) if (!moving.has(q)) others.push([base[q * 6 + 2], base[q * 6 + 3]]);
      const [sx, sy] = h.snap(base[grabbed * 2] + dx, base[grabbed * 2 + 1] + dy, e, others);
      const ox = sx - base[grabbed * 2];
      const oy = sy - base[grabbed * 2 + 1];
      cur = base.slice();
      for (let p = 0; p < base.length / 2; p++) {
        const kk = Math.floor(p / 3);
        if (moving.has(kk) || (sel.has(p) && !moving.has(kk))) {
          cur[p * 2] = base[p * 2] + ox;
          cur[p * 2 + 1] = base[p * 2 + 1] + oy;
        }
      }
    } else {
      const m: HandleMode = pd.alt ? "broken" : knotMode(t, k, base);
      cur = moveHandle(base, k, part as 0 | 2, [base[grabbed * 2] + dx, base[grabbed * 2 + 1] + dy], m);
    }
    pd.cur = cur;
    pd.preview ??= makePreview(t);
    updatePreview(h, pd.preview, t, cur);
    return true;
  }
  // polygon
  const { base, moving, grabbed } = pd;
  let dx = x - pd.start[0];
  let dy = y - pd.start[1];
  if (grabbed >= 0) {
    const mv = new Set(moving);
    const others: [number, number][] = [];
    for (let i = 0; i < base.length / 2; i++) if (!mv.has(i)) others.push([base[i * 2], base[i * 2 + 1]]);
    const [sx, sy] = h.snap(base[grabbed * 2] + dx, base[grabbed * 2 + 1] + dy, e, others);
    dx = sx - base[grabbed * 2];
    dy = sy - base[grabbed * 2 + 1];
  }
  const cur = base.slice();
  for (const i of moving) {
    cur[i * 2] = base[i * 2] + dx;
    cur[i * 2 + 1] = base[i * 2 + 1] + dy;
  }
  pd.cur = cur;
  pd.preview ??= makePreview(pd.t);
  updatePreview(h, pd.preview, pd.t, cur);
  return true;
}

function updateHover(h: PenHost, x: number, y: number) {
  let hv = -1;
  const pt = pathTarget();
  if (tool() === "pen") {
    if (pt && shownPath(h, pt)) hv = hitPathPoint(pathWorld(h, pt)!, x, y, PICK * px(h));
    else {
      const gt = polygonTarget();
      if (gt && shownPoly(h, gt)) hv = hitPoint(polygonWorld(h, gt)!, x, y, PICK * px(h));
    }
  }
  if (hv !== penHover()) setPenHover(hv);
}

/** Pointer up. Returns true when the Pen tool handled it. */
export function penUp(): boolean {
  const h = penHost();
  const d = pd;
  pd = null;
  if (!h || !d) return false;
  h.clearSnap();
  if (d.kind === "place") {
    const dr = drawing();
    if (!dr) return true;
    const knot = placedKnot(d.anchor, d.drag, dr.extend?.prepend);
    setDrawing({ ...dr, knots: dr.extend?.prepend ? [...knot, ...dr.knots] : [...dr.knots, ...knot] });
    return true;
  }
  if (!d.cur) return true;
  if (d.kind === "path") {
    const k = Math.floor(d.grabbed / 3);
    const part = d.grabbed % 3;
    if (d.alt && part !== 1) setKnotMode(d.t, k, "broken");
    if (d.alt && part === 1) setKnotMode(d.t, k, undefined);
    if (d.cur.some((v, i) => Math.abs(v - d.base[i]) > 1e-9)) editPath(h, d.t, d.cur, part === 1 ? (penSel().length > 1 ? "move knots" : "move knot") : "move handle");
    return true;
  }
  if (d.inserted || d.cur.some((v, i) => Math.abs(v - d.base[i]) > 1e-9)) commitPolygon(h, d.t, d.cur, d.inserted ? "add point" : d.grabbed < 0 ? "move polygon" : "move points");
  return true;
}

// ---------------- finishing, keyboard ----------------

export function finishDrawing() {
  const h = penHost();
  const d = drawing();
  setDrawing(null);
  pd = null;
  if (!h || !d) return;
  const res = commitDrawing(h, d);
  if (res) {
    setSelection({ kind: "slot", id: res.slotId, attachment: res.name });
    setPenSel([]);
  }
}

export function cancelDrawing() {
  setDrawing(null);
  pd = null;
}

/** Enter: finish the path being drawn. */
export function penFinish(): boolean {
  if (!drawing()) return false;
  finishDrawing();
  return true;
}

/** Esc: finish drawing, else clear the point selection. False when there was nothing to do. */
export function penDeselect(): boolean {
  if (drawing()) {
    finishDrawing();
    return true;
  }
  if (penSel().length) {
    setPenSel([]);
    return true;
  }
  return false;
}

const selectedKnots = () => [...new Set(penSel().map((p) => Math.floor(p / 3)))];

export function penDelete(): boolean {
  const h = penHost();
  if (!h) return false;
  if (drawing()) {
    // Drop the last placed knot.
    const d = drawing()!;
    setDrawing({ ...d, knots: d.extend?.prepend ? d.knots.slice(6) : d.knots.slice(0, -6) });
    return true;
  }
  if (!penSel().length) return false;
  const pt = pathTarget();
  if (pt) return deleteKnotsOf(h, pt, selectedKnots());
  const gt = polygonTarget();
  if (gt) {
    if (!polygonsSetupOnly()) return true;
    const world = polygonWorld(h, gt);
    if (!world) return false;
    const next = deletePoints(world, penSel());
    if (next.length < 6) {
      toast("A polygon needs at least 3 points", "error");
      return true;
    }
    if (commitPolygon(h, gt, next, "delete points")) setPenSel([]);
    return true;
  }
  return false;
}

export function penSelectAll(): boolean {
  const pt = pathTarget();
  if (pt) {
    setPenSel(Array.from({ length: knotCount(pt.att.vertices) }, (_, k) => k * 3 + 1));
    return true;
  }
  const gt = polygonTarget();
  if (gt) {
    setPenSel(Array.from({ length: gt.att.vertices.length / 2 }, (_, i) => i));
    return true;
  }
  return false;
}

export function penNudge(dx: number, dy: number): boolean {
  const h = penHost();
  if (!h || !penSel().length) return false;
  const pt = pathTarget();
  const gt = polygonTarget();
  const world = pt ? pathWorld(h, pt) : gt ? polygonWorld(h, gt) : null;
  if (!world) return false;
  const sel = new Set(penSel());
  const knots = pt ? new Set([...sel].filter((p) => p % 3 === 1).map((p) => Math.floor(p / 3))) : new Set<number>();
  for (let p = 0; p < world.length / 2; p++)
    if (sel.has(p) || knots.has(Math.floor(p / 3))) {
      world[p * 2] += dx;
      world[p * 2 + 1] += dy;
    }
  if (pt) editPath(h, pt, world, "nudge knots");
  else if (gt && polygonsSetupOnly()) commitPolygon(h, gt, world, "nudge points");
  return true;
}

// ---------------- context menu ----------------

/** Viewport right-click items for the knot under the pointer (or the selected knots). */
export function penMenuItems(): MenuItem[] {
  const h = penHost();
  if (!h || tool() !== "pen") return [];
  const pt = pathTarget();
  const d = drawing();
  if (d) return [{ label: "Finish path", shortcut: "edit.finishPath", action: finishDrawing }, { label: "Cancel drawing", action: cancelDrawing }];
  if (!pt) {
    const gt = polygonTarget();
    return gt && penSel().length ? [{ label: `Delete ${penSel().length > 1 ? `${penSel().length} points` : "point"}`, danger: true, action: () => penDelete() }] : [];
  }
  const hv = penHover();
  if (hv >= 0 && !penSel().includes(hv)) setPenSel([hv]);
  const knots = selectedKnots();
  const items: MenuItem[] = [];
  if (knots.length) {
    const modes = knots.map((k) => knotMode(pt, k));
    const all = (m: HandleMode) => modes.every((x) => x === m);
    items.push(
      { label: "Smooth handles", checked: all("smooth"), action: () => setModeOf(h, pt, knots, "smooth") },
      { label: "Mirrored handles", checked: all("mirrored"), action: () => setModeOf(h, pt, knots, "mirrored") },
      { label: "Broken handles (corner)", checked: all("broken"), action: () => setModeOf(h, pt, knots, "broken") },
      { label: "Reset handles", action: () => resetHandlesOf(h, pt, knots) },
      { label: knots.length > 1 ? `Delete ${knots.length} knots` : "Delete knot", danger: true, action: () => deleteKnotsOf(h, pt, knots) },
      "sep",
    );
  }
  items.push({ label: "Closed path", checked: pt.att.closed, action: () => setupOnly("Closing a path") && setClosed(pt, !pt.att.closed) });
  return items;
}

// ---------------- drawing the overlay ----------------

/**
 * Paths (all visible ones in their colour; the selected one highlighted with its knots and handles), the path
 * being drawn, and the selected bounding box / mask with its points. `ctx` is set up for skeleton space.
 */
export function drawPenOverlay(ctx: CanvasRenderingContext2D, zoom: number, shown: Skeleton) {
  const h = penHost();
  const k = 1 / zoom; // one device px in skeleton units
  const penOn = tool() === "pen";
  const pt = pathTarget();
  const gt = polygonTarget();
  const sel = new Set(penSel());
  const hv = penHover();

  // Every visible path.
  for (const slot of shown.drawOrder) {
    const att = shown.getAttachment(slot);
    if (att?.type !== "path" || !pathShown(shown, slot.data.id, att.name, slotOpacity)) continue;
    const isSel = !!pt && pt.slotId === slot.data.id && pt.name === att.name;
    if (!isSel && !showBones() && !penOn) continue;
    const v = shown.attachmentWorldVertices(slot, att);
    drawCurve(ctx, v, att.closed, att.color, k, isSel);
    if (isSel || showBones() || penOn) drawKnots(ctx, v, att.color, k, isSel && penOn ? sel : null, isSel && penOn ? hv : -1, isSel);
  }

  // Selected bounding box / mask: translucent fill and its points.
  if (gt) {
    const slot = shown.slotById_(gt.slotId);
    const att = slot && shown.getAttachment(slot, gt.name);
    if (slot && att && (att.type === "boundingBox" || att.type === "clipping") && slot.bone.active && slotOpacity(gt.slotId) > 0) {
      const v = shown.attachmentWorldVertices(slot, att);
      const color = polygonColor(att);
      ctx.beginPath();
      for (let i = 0; i < v.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, v[i], v[i + 1]);
      ctx.closePath();
      ctx.fillStyle = `${color}30`;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * k;
      ctx.stroke();
      if (penOn) {
        const s = 3.5 * k;
        for (let i = 0; i < v.length / 2; i++) {
          ctx.fillStyle = sel.has(i) ? "#ffcc00" : color;
          ctx.strokeStyle = "#000000aa";
          ctx.lineWidth = k;
          ctx.fillRect(v[i * 2] - s, v[i * 2 + 1] - s, s * 2, s * 2);
          ctx.strokeRect(v[i * 2] - s, v[i * 2 + 1] - s, s * 2, s * 2);
          if (i === hv) ring(ctx, v[i * 2], v[i * 2 + 1], s * 2.2, k);
        }
      }
    }
  }

  // The path being drawn, with a rubber band to the pointer.
  const d = drawing();
  if (d && h) {
    const all = drawingWorld(h, d);
    const live = pd?.kind === "place" ? placedKnot(pd.anchor, pd.drag, d.extend?.prepend) : null;
    const pts = live ? (d.extend?.prepend ? [...live, ...all] : [...all, ...live]) : all;
    const color = (pt && d.extend ? pt.att.color : null) ?? "#ff7a00";
    if (pts.length >= 12) drawCurve(ctx, pts, false, color, k, true);
    const p = h.pointer();
    if (p && !live && all.length >= 6) {
      // Preview of the next segment from the end being drawn.
      const end = d.extend?.prepend ? 0 : all.length / 6 - 1;
      const [hx, hy] = d.extend?.prepend ? [all[0], all[1]] : [all[end * 6 + 4], all[end * 6 + 5]];
      ctx.beginPath();
      ctx.moveTo(all[end * 6 + 2], all[end * 6 + 3]);
      ctx.bezierCurveTo(hx, hy, p[0], p[1], p[0], p[1]);
      ctx.setLineDash([4 * k, 3 * k]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawKnots(ctx, pts, color, k, null, -1, true);
    // The anchor that closes the path gets a ring.
    const n = pts.length / 6;
    if (n >= 2) {
      const f = d.extend?.prepend ? n - 1 : 0;
      ring(ctx, pts[f * 6 + 2], pts[f * 6 + 3], 6 * k, k);
    }
  }
}

function drawCurve(ctx: CanvasRenderingContext2D, v: ArrayLike<number>, closed: boolean, color: string, k: number, selected: boolean) {
  if (v.length < 12) return;
  const line = splinePolyline(buildSpline(v, closed));
  ctx.beginPath();
  for (let i = 0; i < line.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, line[i], line[i + 1]);
  if (selected) {
    ctx.strokeStyle = "#ffffffaa";
    ctx.lineWidth = 4.5 * k;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = (selected ? 2.5 : 2) * k;
  ctx.stroke();
}

function drawKnots(ctx: CanvasRenderingContext2D, v: ArrayLike<number>, color: string, k: number, sel: Set<number> | null, hover: number, selected: boolean) {
  ctx.lineWidth = k;
  ctx.strokeStyle = selected ? "#ffffffcc" : color;
  ctx.beginPath();
  for (let q = 0; q + 5 < v.length; q += 6) {
    ctx.moveTo(v[q], v[q + 1]);
    ctx.lineTo(v[q + 2], v[q + 3]);
    ctx.lineTo(v[q + 4], v[q + 5]);
  }
  ctx.stroke();
  const s = (selected ? 4 : 3) * k;
  for (let q = 0; q + 5 < v.length; q += 6) {
    const p = q / 2;
    for (const hp of [p, p + 2]) {
      if (Math.hypot(v[hp * 2] - v[q + 2], v[hp * 2 + 1] - v[q + 3]) < 1e-6) continue;
      ctx.beginPath();
      ctx.arc(v[hp * 2], v[hp * 2 + 1], s * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = sel?.has(hp) ? "#ffcc00" : color;
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = "#000000aa";
        ctx.stroke();
      }
      if (hp === hover) ring(ctx, v[hp * 2], v[hp * 2 + 1], s * 2, k);
    }
    ctx.fillStyle = sel?.has(p + 1) ? "#ffcc00" : color;
    ctx.fillRect(v[q + 2] - s, v[q + 3] - s, s * 2, s * 2);
    if (selected) {
      ctx.strokeStyle = "#000000aa";
      ctx.strokeRect(v[q + 2] - s, v[q + 3] - s, s * 2, s * 2);
    }
    if (p + 1 === hover) ring(ctx, v[q + 2], v[q + 3], s * 2, k);
  }
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, k: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#ffcc00";
  ctx.lineWidth = 1.5 * k;
  ctx.stroke();
}

// ---------------- wiring ----------------

/** Call once from the viewport: registers its host and keeps the tool's state in step with the editor. */
export function usePen(host: PenHost) {
  setPenHost(host);
  createEffect(
    on(
      () => {
        const s = selection();
        return s?.kind === "slot" ? `${s.id}|${s.attachment ?? ""}` : s ? `${s.kind}|${s.id}` : "";
      },
      () => setPenSel([]),
      { defer: true },
    ),
  );
  // Leaving the tool finishes the path being drawn.
  createEffect(on(tool, (t) => t !== "pen" && drawing() && finishDrawing(), { defer: true }));
}

