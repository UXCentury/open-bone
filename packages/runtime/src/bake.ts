import { type BoneProperty, BONE_PROPERTIES, type Curve, type Id, type OpenBoneDocument, animationDuration } from "@openbone/core";
import { OpenBoneInstance } from "./instance.ts";

/**
 * "Bake constraints": play an animation, sample the bones' local values as they are AFTER the constraints (IK,
 * transform, path, physics, sliders) and turn them into ordinary bone keys, so the motion survives with the
 * constraints switched off, or can be edited by hand. Optionally keys the constraints' mixes to 0 over the range.
 */
export interface BakeOptions {
  /** Animation id or name. */
  animation: string;
  /** Bones to bake (ids or names). Default: every bone moved by a constraint. */
  bones?: string[];
  /** Range in seconds (default: the whole animation). */
  start?: number;
  end?: number;
  /** Samples per second (default 30). */
  fps?: number;
  /**
   * Drop keys that linear interpolation of their neighbours reproduces within this tolerance (degrees / units;
   * scales use a 100th of it). 0 keeps a key on every sample. Default 0.01.
   */
  tolerance?: number;
  /** Key the mixes of the constraints that moved the baked bones to 0 over the range (default true). */
  disableConstraints?: boolean;
  /** Skin to bake with (skin bones and constraints follow it). Default: the document's default. */
  skin?: string;
}

/** A `setKeys` op argument (replace: true when the whole timeline is given). */
export interface BakeKeys {
  animation: Id;
  target: "bone" | "ik" | "transform" | "path" | "physics";
  id: Id;
  property: string;
  keys: { time: number; value: number; curve: Curve }[];
  replace: boolean;
}

export interface BakeResult {
  /** setKeys arguments to apply, in order, in one transaction. */
  ops: BakeKeys[];
  /** Names of the baked bones that got keys. */
  bones: string[];
  /** Names of the constraints whose mixes are keyed to 0. */
  constraints: string[];
  samples: number;
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Bones each constraint moves, by constraint id, with the timeline target kind and the mix properties to zero. */
function constraintBones(doc: OpenBoneDocument) {
  const sk = doc.skeleton;
  return [
    ...sk.ik.map((c) => ({ kind: "ik" as const, c, bones: c.bones, mixes: ["mix"] })),
    ...sk.transform.map((c) => ({ kind: "transform" as const, c, bones: c.bones, mixes: ["mix"] })),
    ...sk.path.map((c) => ({ kind: "path" as const, c, bones: c.bones, mixes: ["mixRotate", "mixX", "mixY"] })),
    ...sk.physics.map((c) => ({ kind: "physics" as const, c, bones: [c.bone], mixes: ["mix"] })),
  ];
}

/** Greedy key reduction: keep a key only when skipping it would move the line between the kept neighbours by > tol. */
function simplify(times: number[], values: number[], tol: number): number[] {
  const n = times.length;
  if (n <= 2 || tol <= 0) return times.map((_, i) => i);
  const keep = [0];
  let anchor = 0;
  for (let i = 1; i < n - 1; i++) {
    // Can the segment anchor → i+1 stand in for every sample between them?
    const t0 = times[anchor];
    const t1 = times[i + 1];
    let ok = true;
    for (let j = anchor + 1; j <= i && ok; j++) {
      const f = (times[j] - t0) / (t1 - t0);
      ok = Math.abs(values[anchor] + (values[i + 1] - values[anchor]) * f - values[j]) <= tol;
    }
    if (!ok) {
      keep.push(i);
      anchor = i;
    }
  }
  keep.push(n - 1);
  return keep;
}

export function bakeConstraints(doc: OpenBoneDocument, o: BakeOptions): BakeResult {
  const anim = doc.animations.find((a) => a.id === o.animation || a.name === o.animation);
  if (!anim) throw new Error(`Animation "${o.animation}" not found`);
  const duration = animationDuration(anim);
  const start = Math.max(0, o.start ?? 0);
  const end = Math.max(start, o.end ?? duration);
  const fps = Math.min(240, Math.max(1, o.fps ?? 30));
  const tol = Math.max(0, o.tolerance ?? 0.01);
  const sk = doc.skeleton;
  const boneByRef = (r: string) => sk.bones.find((b) => b.id === r) ?? sk.bones.find((b) => b.name === r);

  const owners = constraintBones(doc);
  let boneIds: Id[];
  if (o.bones?.length) {
    boneIds = o.bones.map((r) => {
      const b = boneByRef(r);
      if (!b) throw new Error(`Bone "${r}" not found`);
      return b.id;
    });
  } else boneIds = [...new Set(owners.flatMap((x) => x.bones))].filter((id) => boneByRef(id));
  if (!boneIds.length) throw new Error("No bones to bake: the skeleton has no constraints (or pass `bones`)");
  // Keep document order, so parents come first in the result.
  const order = new Map(sk.bones.map((b, i) => [b.id, i]));
  boneIds = [...new Set(boneIds)].sort((a, b) => order.get(a)! - order.get(b)!);

  // Play from 0 so physics has simulated everything before `start`, sampling on the fps grid plus `end` itself.
  const inst = new OpenBoneInstance(doc);
  if (o.skin) inst.skeleton.setSkin(o.skin);
  inst.play(anim.id, false);
  inst.advance(0);
  const bones = boneIds.map((id) => inst.skeleton.bones.find((b) => b.data.id === id)!);
  const times: number[] = [];
  const samples = bones.map(() => BONE_PROPERTIES.map(() => [] as number[]));
  const record = (t: number) => {
    times.push(t);
    bones.forEach((b, i) => BONE_PROPERTIES.forEach((p, j) => samples[i][j].push(b.applied[p])));
  };
  const dt = 1 / fps;
  let now = 0;
  const eps = 1e-6;
  if (start <= eps) record(0);
  for (let i = 1; now < end - eps; i++) {
    const next = Math.min(i * dt, end);
    inst.advance(next - now);
    now = next;
    if (now >= start - eps) record(now);
  }
  // A start between grid points: the first recorded sample is the next grid point, so add one at `start` itself.
  if (!times.length || times[0] > start + eps) {
    const again = new OpenBoneInstance(doc);
    if (o.skin) again.skeleton.setSkin(o.skin);
    again.play(anim.id, false);
    again.advance(0);
    for (let t = 0; t < start - eps; ) {
      const step = Math.min(dt, start - t);
      again.advance(step);
      t += step;
    }
    times.unshift(start);
    bones.forEach((_, i) => {
      const b = again.skeleton.bones.find((x) => x.data.id === boneIds[i])!;
      BONE_PROPERTIES.forEach((p, j) => samples[i][j].unshift(b.applied[p]));
    });
  }

  const ops: BakeKeys[] = [];
  const baked = new Set<string>();
  const inRange = (t: number) => t >= start - eps && t <= end + eps;
  bones.forEach((b, i) => {
    BONE_PROPERTIES.forEach((prop: BoneProperty, j) => {
      const vals = samples[i][j].slice();
      if (prop === "rotation" || prop === "shearX" || prop === "shearY")
        for (let k = 1; k < vals.length; k++) vals[k] = vals[k - 1] + ((((vals[k] - vals[k - 1] + 180) % 360) + 360) % 360) - 180;
      const ptol = prop === "scaleX" || prop === "scaleY" ? tol / 100 : tol;
      const existing = anim.timelines.find((tl) => tl.target === "bone" && tl.id === b.data.id && tl.property === prop);
      const setup = b.data[prop];
      // Nothing to say: constant at the setup value and not keyed already.
      if (!existing && vals.every((v) => Math.abs(v - setup) <= Math.max(ptol, 1e-6))) return;
      const kept = simplify(times, vals, ptol);
      const outside = ((existing?.keys ?? []) as { time: number; value: number; curve: Curve }[]).filter((k) => !inRange(k.time));
      const keys = [...outside, ...kept.map((k) => ({ time: times[k], value: r4(vals[k]), curve: "linear" as Curve }))].sort((p, q) => p.time - q.time);
      ops.push({ animation: anim.id, target: "bone", id: b.data.id, property: prop, keys, replace: true });
      baked.add(b.data.name);
    });
  });

  const disabled: string[] = [];
  if (o.disableConstraints !== false) {
    const set = new Set(boneIds);
    for (const x of owners) {
      if (!x.bones.some((id) => set.has(id))) continue;
      disabled.push(x.c.name);
      for (const prop of x.mixes) {
        const existing = anim.timelines.find((tl) => tl.target === x.kind && tl.id === x.c.id && tl.property === prop);
        const outside = ((existing?.keys ?? []) as { time: number; value: number; curve: Curve }[]).filter((k) => !inRange(k.time));
        // The value the constraint has outside the range when nothing else keys it: its setup mix (transform: x1).
        const setupMix = x.kind === "transform" && prop === "mix" ? 1 : ((x.c as unknown as Record<string, number>)[prop] ?? 1);
        const keys = [...outside];
        if (!existing && start > eps) keys.push({ time: 0, value: setupMix, curve: "stepped" });
        keys.push({ time: r4(start), value: 0, curve: "stepped" });
        if (end < duration - eps && !outside.some((k) => k.time > end)) keys.push({ time: r4(end), value: 0, curve: "stepped" }, { time: r4(Math.min(duration, end + dt)), value: setupMix, curve: "stepped" });
        keys.sort((p, q) => p.time - q.time);
        ops.push({ animation: anim.id, target: x.kind, id: x.c.id, property: prop, keys, replace: true });
      }
    }
  }
  return { ops, bones: [...baked], constraints: disabled, samples: times.length };
}
