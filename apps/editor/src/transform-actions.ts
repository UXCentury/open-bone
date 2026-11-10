import { type Attachment, BONE_PROPERTIES, type BoneProperty, getAttachment, localFromWorld, wrapDeg } from "@openbone/core";
import { commitBone, keyBoneProperty } from "./edit.ts";
import { viewportApi } from "./panels/Viewport.tsx";
import { activeSkin, apply, compensate, mode, ownerSkinArg, store, toast, transaction } from "./state.ts";

/**
 * Quick transforms from the context menu: flip, rotate and reset an attachment (image, shape, sequence, mesh, text),
 * and flip, rotate, skew and reset a bone. Each is one undo step. Bone changes go to the setup pose in Setup mode and
 * become keys at the current time in Animate mode.
 */

export type AttTransform = "flipX" | "flipY" | "rot90" | "rot-90" | "rot180" | "skewX+" | "skewX-" | "skewY+" | "skewY-" | "reset";
const r2 = (n: number) => Math.round(n * 1000) / 1000;
const wrap = (deg: number) => {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return r2(d);
};

/** Which attachment transforms make sense for this attachment type. */
export function attTransformsFor(att: Attachment | null | undefined): AttTransform[] {
  if (!att) return [];
  switch (att.type) {
    case "region":
    case "sequence":
      return ["flipX", "flipY", "rot90", "rot-90", "rot180", "skewX+", "skewX-", "skewY+", "skewY-", "reset"];
    case "mesh":
      return ["flipX", "flipY", "rot90", "rot-90", "rot180"];
    case "shape":
      return ["flipX", "flipY", "rot90", "rot-90", "rot180", "reset"];
    case "text":
    case "point":
      return ["rot90", "rot-90", "rot180", "reset"];
    default:
      return [];
  }
}

export function transformAttachment(slotId: string, name: string, op: AttTransform) {
  const att = getAttachment(store.doc, slotId, name, activeSkin()?.id);
  if (!att) return;
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: slotId, attachment: name, props, ...ownerSkinArg(slotId, name) });
  const turn = op === "rot90" ? -90 : op === "rot-90" ? 90 : op === "rot180" ? 180 : 0; // "rot90" = clockwise on screen
  if (att.type === "mesh") {
    // Mirror or turn the vertices about the mesh's own centre (weights are re-bound by the op).
    const v = att.vertices;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < v.length; i += 2) {
      minX = Math.min(minX, v[i]); maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]); maxY = Math.max(maxY, v[i + 1]);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    if (op === "reset") return toast("A mesh has no rotation to reset: its shape is its vertices", "info");
    const a = (turn * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const out = v.map((_, i) => {
      const x = v[i - (i % 2)] - cx, y = v[i - (i % 2) + 1] - cy;
      let nx = x, ny = y;
      if (op === "flipX") nx = -x;
      else if (op === "flipY") ny = -y;
      else [nx, ny] = [x * c - y * s, x * s + y * c];
      return r2(i % 2 ? cy + ny : cx + nx);
    });
    return set({ vertices: out });
  }
  const cur = att as { rotation?: number; scaleX?: number; scaleY?: number; skewX?: number; skewY?: number; points?: number[]; shape?: string };
  if (op === "reset") return set({ rotation: 0, ...("scaleX" in cur ? { scaleX: 1, scaleY: 1 } : {}), ...(cur.skewX || cur.skewY ? { skewX: 0, skewY: 0 } : {}) });
  if (op.startsWith("skew")) {
    const d = op.endsWith("+") ? 15 : -15;
    return set(op.startsWith("skewX") ? { skewX: r2((cur.skewX ?? 0) + d) } : { skewY: r2((cur.skewY ?? 0) + d) });
  }
  if (turn) return set({ rotation: wrap((cur.rotation ?? 0) + turn) });
  if ("scaleX" in cur && cur.scaleX !== undefined) return set(op === "flipX" ? { scaleX: -(cur.scaleX ?? 1) } : { scaleY: -(cur.scaleY ?? 1) });
  // Shapes have no scale: mirror polygon points and the rotation instead.
  const props: Record<string, unknown> = { rotation: wrap(-(cur.rotation ?? 0)) };
  if (cur.points) props.points = cur.points.map((p, i) => (op === "flipX" ? (i % 2 ? p : -p) : i % 2 ? -p : p));
  return set(props);
}

export type BoneTransform = "flipX" | "flipY" | "rot90" | "rot-90" | "rot180" | "skewX+" | "skewX-" | "skewY+" | "skewY-" | "resetRS" | "resetSkew";

export function transformBone(boneId: string, op: BoneTransform) {
  const b = store.doc.skeleton.bones.find((x) => x.id === boneId);
  if (!b) return;
  const props: Partial<Record<BoneProperty, number>> = {};
  switch (op) {
    case "flipX": props.scaleX = -b.scaleX; break;
    case "flipY": props.scaleY = -b.scaleY; break;
    case "rot90": props.rotation = wrap(b.rotation - 90); break;
    case "rot-90": props.rotation = wrap(b.rotation + 90); break;
    case "rot180": props.rotation = wrap(b.rotation + 180); break;
    case "skewX+": props.shearX = r2((b.shearX ?? 0) + 15); break;
    case "skewX-": props.shearX = r2((b.shearX ?? 0) - 15); break;
    case "skewY+": props.shearY = r2((b.shearY ?? 0) + 15); break;
    case "skewY-": props.shearY = r2((b.shearY ?? 0) - 15); break;
    case "resetRS": props.rotation = 0; props.scaleX = 1; props.scaleY = 1; break;
    case "resetSkew": props.shearX = 0; props.shearY = 0; break;
  }
  const kept = compensate() ? keepChildren(boneId, props) : [];
  if (kept.length)
    return transaction(`${op} ${b.name}`, () => {
      commitBone(boneId, props);
      for (const k of kept) commitBone(k.id, k.props);
    });
  if (mode() === "setup") return apply("updateBone", { bone: boneId, ...props });
  transaction(`${op} ${b.name}`, () => {
    for (const [k, v] of Object.entries(props)) if (BONE_PROPERTIES.includes(k as BoneProperty)) keyBoneProperty(boneId, k as BoneProperty, v as number);
  });
}

/**
 * With Compensate on: the local transforms that keep the bone's direct children where they are on screen once the
 * bone gets `props` (so flipping the upper arm flips only the upper arm, not the forearm and hand). Solved on the
 * viewport's posed skeleton; a mirrored result is written as a negative scale Y rather than a 180° shear.
 */
function keepChildren(boneId: string, props: Partial<Record<BoneProperty, number>>): { id: string; props: Record<string, number> }[] {
  const sk = viewportApi.skeleton?.();
  const bone = sk?.boneById_(boneId);
  if (!sk || !bone || !bone.children.length) return [];
  const before = bone.children.map((c) => ({ c, world: { ...c.world } }));
  const saved = { x: bone.x, y: bone.y, rotation: bone.rotation, scaleX: bone.scaleX, scaleY: bone.scaleY, shearX: bone.shearX, shearY: bone.shearY };
  Object.assign(bone, props);
  sk.updateWorldTransform();
  const r = (n: number, d = 100) => Math.round(n * d) / d;
  const out = before.map(({ c, world }) => {
    const l = localFromWorld(bone.world, world, c.inherit, { x: c.x, y: c.y, rotation: c.rotation, scaleX: c.scaleX, scaleY: c.scaleY, shearX: c.shearX, shearY: c.shearY });
    let { scaleY, shearY } = l;
    if (Math.abs(wrapDeg(shearY - 180)) < 1e-6 || Math.abs(wrapDeg(shearY + 180)) < 1e-6) {
      scaleY = -scaleY;
      shearY = 0;
    }
    const next: Record<string, number> = { x: r(l.x), y: r(l.y), rotation: r(wrapDeg(l.rotation)), scaleX: r(l.scaleX, 1e4), scaleY: r(scaleY, 1e4), shearY: r(wrapDeg(shearY)) };
    const cur: Record<string, number> = { x: c.x, y: c.y, rotation: c.rotation, scaleX: c.scaleX, scaleY: c.scaleY, shearY: c.shearY };
    const changed: Record<string, number> = {};
    for (const k of Object.keys(next)) if (Math.abs(next[k] - cur[k]) > 1e-6) changed[k] = next[k];
    return { id: c.data.id, props: changed };
  });
  Object.assign(bone, saved);
  sk.updateWorldTransform();
  return out.filter((o) => Object.keys(o.props).length);
}
