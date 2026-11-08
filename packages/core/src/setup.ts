import type { Affine } from "./math.ts";
import { boneWorld } from "./math.ts";
import type { Id, OpenBoneDocument } from "./types.ts";

/** Setup-pose world matrices of every bone (no constraints). */
export function setupWorld(d: OpenBoneDocument): Map<Id, Affine> {
  const out = new Map<Id, Affine>();
  for (const b of d.skeleton.bones) {
    const parent = b.parent ? (out.get(b.parent) ?? null) : null;
    out.set(b.id, boneWorld(parent, b, b.inherit));
  }
  return out;
}
