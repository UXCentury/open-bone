import type {
  ConstraintTarget,
  Id,
  IkConstraintData,
  PathConstraintData,
  PhysicsConstraintData,
  SkeletonData,
  SkinData,
  TransformConstraintData,
} from "./types.ts";

export type ConstraintEntry =
  | { kind: "ik"; data: IkConstraintData }
  | { kind: "transform"; data: TransformConstraintData }
  | { kind: "path"; data: PathConstraintData }
  | { kind: "physics"; data: PhysicsConstraintData };

/** Constraints in the default update order: ik, transform, path, physics, each list in array order. */
export function defaultConstraintOrder(sk: SkeletonData): ConstraintEntry[] {
  return [
    ...sk.ik.map((data) => ({ kind: "ik" as const, data })),
    ...sk.transform.map((data) => ({ kind: "transform" as const, data })),
    ...(sk.path ?? []).map((data) => ({ kind: "path" as const, data })),
    ...(sk.physics ?? []).map((data) => ({ kind: "physics" as const, data })),
  ];
}

/**
 * Every constraint in the order the runtime applies them: sorted by `order`, where a constraint without one uses
 * its index in the default order (ik, transform, path, physics); ties keep the default order. Deterministic.
 */
export function constraintOrder(sk: SkeletonData): ConstraintEntry[] {
  const list = defaultConstraintOrder(sk);
  if (!list.some((e) => e.data.order !== undefined)) return list;
  return list
    .map((e, i) => ({ e, i, k: e.data.order ?? i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.e);
}

/** The `order` a new constraint gets: after every other one when the rig has a custom order, else none. */
export function nextConstraintOrder(sk: SkeletonData): number | undefined {
  const list = defaultConstraintOrder(sk);
  if (!list.some((e) => e.data.order !== undefined)) return undefined;
  return list.reduce((m, e, i) => Math.max(m, e.data.order ?? i), -1) + 1;
}

export const CONSTRAINT_KINDS: ConstraintTarget[] = ["ik", "transform", "path", "physics"];

/** Ids of the bones and constraints that some skin lists (they are only active while such a skin is set). */
export function skinRequired(sk: SkeletonData): { bones: Set<Id>; constraints: Set<Id> } {
  const bones = new Set<Id>();
  const constraints = new Set<Id>();
  for (const skin of sk.skins) {
    for (const id of skin.bones ?? []) bones.add(id);
    for (const id of skin.constraints ?? []) constraints.add(id);
  }
  return { bones, constraints };
}

/**
 * Which bones are active with `skin` set (null = no skin): a bone is active when no skin lists it or `skin` does,
 * and its parent is active. Bones must be in parent-before-child order (as in the document).
 */
export function activeBones(sk: SkeletonData, skin: SkinData | null): Set<Id> {
  const req = skinRequired(sk).bones;
  const mine = new Set(skin?.bones ?? []);
  const out = new Set<Id>();
  for (const b of sk.bones) {
    if (b.parent && !out.has(b.parent)) continue;
    if (!req.has(b.id) || mine.has(b.id)) out.add(b.id);
  }
  return out;
}
