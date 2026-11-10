import type { Skeleton } from "@openbone/runtime";
import { ensureAnimation, setKeysExtending } from "./edit.ts";
import type { MeshTarget } from "./mesh-edit.ts";
import { autoKey, time, toast } from "./state.ts";
import { deformFor } from "./ffd-math.ts";

/**
 * Free-form deformation (Animate mode, Mesh tool): dragging mesh vertices keys a deform at the playhead instead of
 * changing the mesh. Offsets are what the runtime adds to each vertex: in the slot bone's space for an unweighted
 * mesh, and to every bone influence's local position for a weighted one, so a vertex lands where it was dropped in
 * the current pose.
 */

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Where the mesh's vertices are drawn now (posed, with the current deform). */
export function posedVertices(sk: Skeleton, t: MeshTarget): number[] {
  const slot = sk.slotById_(t.slotId);
  const att = slot && sk.getAttachment(slot, t.name);
  return slot && att && att.type === "mesh" ? Array.from(sk.attachmentWorldVertices(slot, att)) : [];
}

/** The deform offsets the posed skeleton currently applies to the mesh (zeros where there are none). */
export function currentDeform(sk: Skeleton, t: MeshTarget): number[] {
  const slot = sk.slotById_(t.slotId);
  const cur = slot?.deform.get(t.name);
  const n = t.att.vertices.length;
  return Array.from({ length: n }, (_, i) => cur?.[i] ?? 0);
}

/** `deformFor` on the viewport's posed skeleton. */
export function deformInPose(sk: Skeleton, t: MeshTarget, base: number[], moved: Map<number, [number, number]>): number[] {
  const bone = (id: string) => sk.boneById_(id)?.world ?? { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
  return deformFor(t.att, bone, bone(t.slotBone), base, moved);
}

/** Key the deform at the playhead (one undo step). */
export function keyDeform(t: MeshTarget, offsets: number[]): boolean {
  if (!autoKey()) {
    toast("Auto-key is off: turn it on to key deforms by dragging vertices", "info");
    return false;
  }
  const anim = ensureAnimation();
  if (!anim) return false;
  setKeysExtending({ animation: anim, target: "deform", id: t.slotId, attachment: t.name, property: "offsets", keys: [{ time: r3(time()), value: offsets.map(r3) }] });
  return true;
}

/** Delete in Animate mode: the selected vertices go back to the mesh's own shape in this key. */
export function resetDeform(sk: Skeleton, t: MeshTarget, indices: number[]) {
  const offsets = currentDeform(sk, t);
  for (const i of indices) {
    offsets[i * 2] = 0;
    offsets[i * 2 + 1] = 0;
  }
  if (keyDeform(t, offsets)) toast(`Reset ${indices.length} vertex${indices.length === 1 ? "" : "es"} in this key`, "info");
}

/** Arrow keys in Animate mode: nudge the selected vertices (world units) and key the deform. */
export function nudgeDeform(sk: Skeleton, t: MeshTarget, indices: number[], dx: number, dy: number) {
  const world = posedVertices(sk, t);
  const moved = new Map(indices.map((i) => [i, [world[i * 2] + dx, world[i * 2 + 1] + dy] as [number, number]]));
  keyDeform(t, deformInPose(sk, t, currentDeform(sk, t), moved));
}
