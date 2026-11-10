import { type Affine, type Attachment, apply as applyM, invert } from "@openbone/core";

/**
 * Rotate and scale tools on a part (Setup mode): the attachment itself turns or grows, not its bone. With several
 * parts selected they turn or scale together around the grabbed part's origin, so their positions follow; each part's
 * values stay in its own bone's space.
 */

export type PartOp = "rotate" | "scale";
export type PartAttachment = Extract<Attachment, { type: "region" | "sequence" | "shape" | "point" | "text" }>;

export interface PartState {
  slotId: string;
  name: string;
  att: PartAttachment;
  /** The slot bone's world transform when the drag started. */
  world: Affine;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const wrap = (deg: number) => {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
};

/** World position of the part's origin. */
export const partOrigin = (p: PartState): [number, number] => applyM(p.world, p.att.x, p.att.y) as [number, number];

/** Whether the tool changes anything on this part beyond its position (a point has no size). */
export const scalable = (a: PartAttachment) => a.type !== "point";

/**
 * New attachment values for `p` after turning by `amount` degrees (rotate) or scaling by the factor `amount` (scale)
 * around the world point `pivot`.
 */
export function partProps(p: PartState, op: PartOp, pivot: [number, number], amount: number): Record<string, unknown> {
  const a = p.att;
  const [ox, oy] = partOrigin(p);
  let wx = ox;
  let wy = oy;
  const props: Record<string, unknown> = {};
  if (op === "rotate") {
    const t = (amount * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const dx = ox - pivot[0];
    const dy = oy - pivot[1];
    wx = pivot[0] + dx * c - dy * s;
    wy = pivot[1] + dx * s + dy * c;
    // A mirrored bone turns its children the other way.
    const det = p.world.a * p.world.d - p.world.b * p.world.c;
    props.rotation = r3(wrap(a.rotation + (det < 0 ? -amount : amount)));
  } else {
    wx = pivot[0] + (ox - pivot[0]) * amount;
    wy = pivot[1] + (oy - pivot[1]) * amount;
    if (a.type === "region" || a.type === "sequence") {
      props.scaleX = r3(a.scaleX * amount);
      props.scaleY = r3(a.scaleY * amount);
    } else if (a.type === "shape") {
      props.width = r3(a.width * amount);
      props.height = r3(a.height * amount);
      if (a.radius) props.radius = r3(a.radius * amount);
      if (a.points) props.points = a.points.map((v) => r3(v * amount));
    } else if (a.type === "text") {
      props.size = r3(a.size * amount);
      props.width = r3(a.width * amount);
      props.height = r3(a.height * amount);
    }
  }
  const [lx, ly] = applyM(invert(p.world), wx, wy);
  if (Math.abs(lx - a.x) > 1e-6 || Math.abs(ly - a.y) > 1e-6) {
    props.x = r3(lx);
    props.y = r3(ly);
  }
  return props;
}

/** The drag amount: degrees turned (Shift: 15° steps) or the scale factor (Shift: 10% steps). */
export function dragAmount(op: PartOp, pivot: [number, number], start: [number, number], now: [number, number], snap: boolean): number {
  if (op === "rotate") {
    const a0 = Math.atan2(start[1] - pivot[1], start[0] - pivot[0]);
    const a1 = Math.atan2(now[1] - pivot[1], now[0] - pivot[0]);
    const deg = wrap(((a1 - a0) * 180) / Math.PI);
    return snap ? Math.round(deg / 15) * 15 : deg;
  }
  const d0 = Math.max(1e-3, Math.hypot(start[0] - pivot[0], start[1] - pivot[1]));
  const f = Math.max(0.01, Math.hypot(now[0] - pivot[0], now[1] - pivot[1]) / d0);
  return snap ? Math.max(0.1, Math.round(f * 10) / 10) : f;
}
