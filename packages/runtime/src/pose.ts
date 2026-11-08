import { type Affine, apply, identity, invert } from "@openbone/core";
import type { Bone } from "./skeleton.ts";

/**
 * Pose tool solver (Spine's "Pose" tool): rotate a chain of bones so a point on the last one reaches a target.
 * Cyclic coordinate descent: each pass rotates every bone, from the grabbed bone up to the top of the chain, so the
 * grabbed point swings toward the target. Works on the bones' local rotations (what an editor keys), honours
 * flipped parents, and leaves translation, scale and constraints alone.
 */

export interface PoseChain {
  /** The grabbed bone first, then its ancestors up the chain (each must be the parent of the previous one). */
  bones: Bone[];
  /** The grabbed point in the first bone's local space (its tip is [length, 0]). */
  local: [number, number];
}

const DEG = 180 / Math.PI;
const wrap = (d: number) => {
  let x = d % 360;
  if (x > 180) x -= 360;
  else if (x <= -180) x += 360;
  return x;
};
const detSign = (m: Affine) => Math.sign(m.a * m.d - m.b * m.c) || 1;

/** Ancestors of `bone` (itself first), at most `length` bones, never including a parentless root unless it is `bone`. */
export function poseChainFrom(bone: Bone, length: number): Bone[] {
  const out: Bone[] = [bone];
  for (let b = bone.parent; b && out.length < Math.max(1, length); b = b.parent) {
    if (!b.parent) break; // keep the root bone still: it places the whole skeleton
    out.push(b);
  }
  return out;
}

/** Where the grabbed point is now, in world space. */
export function poseEffector(chain: PoseChain): [number, number] {
  return apply(chain.bones[0].world, chain.local[0], chain.local[1]) as [number, number];
}

/** The grab point to use for a click at world (x, y): the click itself, or the bone's tip when clicked near its base. */
export function poseGrabPoint(bone: Bone, x: number, y: number): [number, number] {
  const [lx, ly] = apply(invert(bone.world), x, y);
  const len = bone.data.length;
  // Grabbing near the joint would leave the bone nothing to aim with: use the tip instead.
  if (len > 0 && Math.hypot(lx, ly) < len * 0.5) return [len, 0];
  return [lx, ly];
}

/**
 * Rotate the chain so its grabbed point moves toward (tx, ty). Mutates the bones' `rotation` (and `applied.rotation`)
 * and refreshes their world transforms. Returns the remaining distance to the target.
 */
export function solvePose(chain: PoseChain, tx: number, ty: number, iterations = 16): number {
  const root: Affine = identity();
  for (let it = 0; it < iterations; it++) {
    for (const b of chain.bones) {
      const [ex, ey] = poseEffector(chain);
      const bx = b.world.x;
      const by = b.world.y;
      if (Math.hypot(ex - bx, ey - by) < 1e-6 || Math.hypot(tx - bx, ty - by) < 1e-6) continue;
      const delta = wrap((Math.atan2(ty - by, tx - bx) - Math.atan2(ey - by, ex - bx)) * DEG);
      if (Math.abs(delta) < 1e-6) continue;
      // A flipped parent mirrors rotation: turn the other way to move the same way on screen.
      const change = delta * detSign(b.parent ? b.parent.world : root);
      b.rotation += change;
      b.applied.rotation += change;
      b.updateSubtree(root);
    }
    const [ex, ey] = poseEffector(chain);
    if (Math.hypot(tx - ex, ty - ey) < 1e-3) break;
  }
  const [ex, ey] = poseEffector(chain);
  return Math.hypot(tx - ex, ty - ey);
}
