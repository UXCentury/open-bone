import { type Attachment, type BoundingBoxAttachment, type ClippingAttachment, alphaHull, apply as applyM, invert } from "@openbone/core";
import { type Slot, Skeleton } from "@openbone/runtime";
import { askForm } from "../dialogs.tsx";
import { readAlpha } from "../mesh-trace.ts";
import { activeSkinId, apply, mode, ownerSkinArg, selectedAttachment, store, toast } from "../state.ts";
import { bounds, ellipsePolygon, rectPolygon } from "./knots.ts";
import { type PenHost, boneMat, r3 } from "./pen-host.ts";

/**
 * Polygon editing for bounding boxes (and clipping masks): points live in slot-bone space and are setup data, so
 * every edit is one `updateAttachment` op in Setup mode.
 */

export type PolygonAttachment = BoundingBoxAttachment | ClippingAttachment;
export interface PolygonTarget {
  slotId: string;
  slotBone: string;
  name: string;
  att: PolygonAttachment;
}

export const BOX_COLOR = "#ffb400";
export const MASK_COLOR = "#be78ff";
export const polygonColor = (a: PolygonAttachment) => (a.type === "boundingBox" ? (a.color ?? BOX_COLOR) : MASK_COLOR);

export function polygonTarget(): PolygonTarget | null {
  const sel = selectedAttachment();
  if (!sel || (sel.att.type !== "boundingBox" && sel.att.type !== "clipping")) return null;
  const slot = store.doc.skeleton.slots.find((s) => s.id === sel.slotId)!;
  return { slotId: sel.slotId, slotBone: slot.bone, name: sel.att.name, att: sel.att };
}

/** World positions of the polygon's points in the viewport's pose. */
export function polygonWorld(h: PenHost, t: PolygonTarget): number[] | null {
  const sk = h.sk();
  const slot = sk.slotById_(t.slotId);
  if (!slot) return null;
  return Array.from(sk.attachmentWorldVertices(slot, t.att));
}

export function polygonsSetupOnly(): boolean {
  if (mode() !== "animate") return true;
  toast("Bounding box and mask points are setup data: switch to Setup mode to edit them", "info");
  return false;
}

/** Write new world positions (converted to slot-bone space) as one op. */
export function commitPolygon(h: PenHost, t: PolygonTarget, world: number[], label: string): boolean {
  if (world.length < 6) {
    toast("A polygon needs at least 3 points", "error");
    return false;
  }
  const inv = invert(boneMat(h)(t.slotBone));
  const vertices: number[] = [];
  for (let i = 0; i < world.length; i += 2) vertices.push(...applyM(inv, world[i], world[i + 1]).map(r3));
  return setPolygon(t, vertices, label);
}

/** Replace the polygon (slot-bone space). */
export function setPolygon(t: { slotId: string; name: string }, vertices: number[], _label = "edit polygon"): boolean {
  return apply("updateAttachment", { slot: t.slotId, attachment: t.name, ...ownerSkinArg(t.slotId, t.name), props: { vertices } }) !== undefined;
}

// ---------------- presets ----------------

/** Centre and size of the current polygon (slot-bone space), or a 100×100 box at the bone for a degenerate one. */
function frame(att: PolygonAttachment): { cx: number; cy: number; w: number; h: number } {
  const [x0, y0, x1, y1] = bounds(att.vertices);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 1e-3 && h > 1e-3)) return { cx: 0, cy: 0, w: 100, h: 100 };
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h };
}

export function rectPreset(t: PolygonTarget) {
  const f = frame(t.att);
  if (polygonsSetupOnly()) setPolygon(t, rectPolygon(f.cx, f.cy, f.w, f.h).map(r3), "rectangle");
}

export function ellipsePreset(t: PolygonTarget, points: number) {
  const f = frame(t.att);
  if (polygonsSetupOnly()) setPolygon(t, ellipsePolygon(f.cx, f.cy, f.w / 2, f.h / 2, points).map(r3), "ellipse");
}

// ---------------- trace from an image ----------------

type Traceable = Extract<Attachment, { type: "region" | "mesh" }>;

/** A setup-pose skeleton showing the active skin (what the viewport shows in Setup mode). */
function setupSkeleton(): Skeleton {
  const sk = new Skeleton(store.doc);
  sk.setSkin(activeSkinId());
  sk.setToSetupPose();
  sk.updateWorldTransform();
  return sk;
}

/** Slots showing an image or mesh, those on `bone` first. */
function traceSources(sk: Skeleton, bone: string): { slot: Slot; att: Traceable }[] {
  const out: { slot: Slot; att: Traceable }[] = [];
  for (const slot of sk.slots) {
    const att = sk.getAttachment(slot);
    if (att && (att.type === "region" || att.type === "mesh")) out.push({ slot, att });
  }
  return out.sort((a, b) => Number(b.slot.bone.data.id === bone) - Number(a.slot.bone.data.id === bone));
}

/**
 * Wrap the bounding box round the visible pixels of an image or mesh: a convex outline with at most `corners`
 * points around every pixel above the alpha threshold, placed where the image is drawn in the setup pose.
 */
export async function traceFromImage(t: PolygonTarget) {
  if (!polygonsSetupOnly()) return;
  const sk = setupSkeleton();
  const sources = traceSources(sk, t.slotBone);
  if (!sources.length) return toast("No image or mesh to trace: add one to a slot first", "error");
  const r = await askForm({
    title: `Trace ${t.name} from an image`,
    message: "Wraps the outline round the visible pixels of an image or mesh, where it is drawn in the setup pose.",
    confirmLabel: "Trace",
    fields: [
      {
        key: "slot",
        type: "choice",
        label: "Image",
        value: sources[0].slot.data.id,
        options: sources.map((s) => ({
          value: s.slot.data.id,
          label: `${s.slot.data.name} · ${s.att.name}`,
          description: `${s.att.type === "mesh" ? "mesh" : "image"}${s.slot.bone.data.id === t.slotBone ? ", same bone" : ""}`,
        })),
      },
      { key: "corners", type: "text", label: "Corners", value: "8", validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 3 && Number(v) <= 64 ? null : "A whole number from 3 to 64") },
    ],
  });
  if (!r) return;
  const src = sources.find((s) => s.slot.data.id === r.slot)!;
  const a = await readAlpha(src.att.image);
  if (!a) return;
  // alphaHull reads the alpha channel of RGBA pixels.
  const rgba = new Uint8Array(a.width * a.height * 4);
  for (let i = 0; i < a.alpha.length; i++) rgba[i * 4 + 3] = a.alpha[i];
  // Clipping the hull to the image's edges can add corners: ask for fewer until it fits the corner count.
  const corners = Number(r.corners);
  let hull: number[] | null = null;
  for (let max = corners; max >= 3; max--) {
    hull = alphaHull(rgba, a.width, a.height, { threshold: 8, maxVertices: max });
    if (!hull || hull.length / 2 <= corners) break;
  }
  if (!hull) return toast("Nothing visible to trace in this image", "error");
  const uv = hull.map((v, i) => v / (i % 2 ? a.height : a.width));
  const world = uvToWorld(sk, src.slot, src.att, uv);
  const inv = invert(sk.boneById_(t.slotBone)!.world);
  const local: number[] = [];
  for (let i = 0; i < world.length; i += 2) local.push(...applyM(inv, world[i], world[i + 1]).map(r3));
  // Keep a counter-clockwise winding (y-up), like the presets.
  if (signedArea(local) < 0) for (let i = 0, j = local.length - 2; i < j; i += 2, j -= 2) [local[i], local[i + 1], local[j], local[j + 1]] = [local[j], local[j + 1], local[i], local[i + 1]];
  if (setPolygon(t, local, "trace bounding box")) toast(`Traced ${local.length / 2} corners from ${src.att.name}`, "info");
}

function signedArea(p: number[]) {
  let s = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

/** Map image uv points (0..1, v down) to where the attachment draws them. */
export function uvToWorld(sk: Skeleton, slot: Slot, att: Traceable, uv: number[]): number[] {
  const wv = sk.attachmentWorldVertices(slot, att);
  if (att.type === "region") {
    // Corners TL, TR, BR, BL: the image is an affine parallelogram.
    const [tlx, tly, trx, try_, , , blx, bly] = wv;
    const out: number[] = [];
    for (let i = 0; i < uv.length; i += 2) {
      const u = uv[i];
      const v = uv[i + 1];
      out.push(tlx + u * (trx - tlx) + v * (blx - tlx), tly + u * (try_ - tly) + v * (bly - tly));
    }
    return out;
  }
  return meshUvToWorld(att.uvs, att.triangles, wv, uv);
}

/** Barycentric map through the triangle containing each uv point (the nearest triangle, extrapolated, outside). */
export function meshUvToWorld(uvs: ArrayLike<number>, tris: ArrayLike<number>, world: ArrayLike<number>, uv: number[]): number[] {
  const out: number[] = [];
  for (let p = 0; p < uv.length; p += 2) {
    const x = uv[p];
    const y = uv[p + 1];
    let best: [number, number, number, number, number, number] | null = null;
    let bestOut = Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const ax = uvs[a * 2], ay = uvs[a * 2 + 1];
      const v0x = uvs[b * 2] - ax, v0y = uvs[b * 2 + 1] - ay;
      const v1x = uvs[c * 2] - ax, v1y = uvs[c * 2 + 1] - ay;
      const den = v0x * v1y - v1x * v0y;
      if (Math.abs(den) < 1e-12) continue;
      const s = ((x - ax) * v1y - v1x * (y - ay)) / den;
      const r = (v0x * (y - ay) - (x - ax) * v0y) / den;
      const w = 1 - s - r;
      // How far outside the triangle (0 = inside).
      const outside = Math.max(0, -s) + Math.max(0, -r) + Math.max(0, -w);
      if (outside < bestOut) {
        bestOut = outside;
        best = [a, b, c, w, s, r];
        if (outside === 0) break;
      }
    }
    if (!best) {
      out.push(world[0] ?? 0, world[1] ?? 0);
      continue;
    }
    const [a, b, c, w, s, r] = best;
    out.push(w * world[a * 2] + s * world[b * 2] + r * world[c * 2], w * world[a * 2 + 1] + s * world[b * 2 + 1] + r * world[c * 2 + 1]);
  }
  return out;
}
