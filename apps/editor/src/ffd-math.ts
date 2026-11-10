import type { MeshAttachment } from "@openbone/core";
import { type Mat, localOffset, weightedOffset } from "./tools/knots.ts";

/**
 * Deform offsets that put each moved vertex at its new world position in the current pose (the rest keep `base`):
 * in the slot bone's space for an unweighted mesh, added to every bone influence's local position for a weighted one
 * (how the runtime applies deform keys).
 */
export function deformFor(att: MeshAttachment, bones: (id: string) => Mat, slotBone: Mat, base: number[], moved: Map<number, [number, number]>): number[] {
  const out = base.slice();
  for (const [i, [wx, wy]] of moved) {
    const inf = att.weights?.[i];
    const [ox, oy] = inf ? weightedOffset(inf, bones, wx, wy) : localOffset(slotBone, att.vertices[i * 2], att.vertices[i * 2 + 1], wx, wy);
    out[i * 2] = ox;
    out[i * 2 + 1] = oy;
  }
  return out;
}

