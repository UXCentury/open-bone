/**
 * Pure geometry for the Pen tool: Bézier path knots and polygon points. No editor state here, so it is unit
 * tested on its own (apps/editor/test/knots.test.ts).
 *
 * A path is flat `[inX, inY, x, y, outX, outY, ...]`, three points per knot (in handle, anchor, out handle), the
 * layout of `PathAttachment.vertices`. Point index `p = knot * 3 + part` with part 0 = in, 1 = anchor, 2 = out.
 * A polygon (bounding box, clipping mask) is flat `[x0, y0, x1, y1, ...]`.
 */

export type Pt = [number, number];
export type HandleMode = "smooth" | "mirrored" | "broken";
export type Part = 0 | 1 | 2;

export const knotCount = (v: ArrayLike<number>) => Math.floor(v.length / 6);
export const pointOf = (v: ArrayLike<number>, p: number): Pt => [v[p * 2], v[p * 2 + 1]];
const setPoint = (v: number[], p: number, [x, y]: Pt) => {
  v[p * 2] = x;
  v[p * 2 + 1] = y;
};

// ---------------- Bézier ----------------

/** De Casteljau split of one cubic at `t`: [left p0..p3, right p0..p3] (8 points). */
export function splitCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): [Pt, Pt, Pt, Pt, Pt, Pt, Pt] {
  const l = (a: Pt, b: Pt): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = l(p0, p1);
  const b = l(p1, p2);
  const c = l(p2, p3);
  const d = l(a, b);
  const e = l(b, c);
  const m = l(d, e);
  // left: p0, a, d, m  right: m, e, c, p3 (m shared)
  return [p0, a, d, m, e, c, p3];
}

export function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [k0 * p0[0] + k1 * p1[0] + k2 * p2[0] + k3 * p3[0], k0 * p0[1] + k1 * p1[1] + k2 * p2[1] + k3 * p3[1]];
}

export const segmentCount = (v: ArrayLike<number>, closed: boolean) => {
  const n = knotCount(v);
  return n < 2 ? 0 : closed ? n : n - 1;
};

/** The four control points of segment `s` (knot s → knot s+1, wrapping on closed paths). */
export function segmentPoints(v: ArrayLike<number>, s: number): [Pt, Pt, Pt, Pt] {
  const n = knotCount(v);
  const a = s * 3;
  const b = ((s + 1) % n) * 3;
  return [pointOf(v, a + 1), pointOf(v, a + 2), pointOf(v, b), pointOf(v, b + 1)];
}

/** The point of the path nearest (x, y): segment, curve parameter and distance. Null for paths under two knots. */
export function nearestOnPath(v: ArrayLike<number>, closed: boolean, x: number, y: number, steps = 48): { segment: number; t: number; dist: number; point: Pt } | null {
  const segs = segmentCount(v, closed);
  let best: { segment: number; t: number; dist: number; point: Pt } | null = null;
  for (let s = 0; s < segs; s++) {
    const [p0, p1, p2, p3] = segmentPoints(v, s);
    let bt = 0;
    let bd = Infinity;
    for (let i = 0; i <= steps; i++) {
      const [px, py] = cubicAt(p0, p1, p2, p3, i / steps);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) {
        bd = d;
        bt = i / steps;
      }
    }
    // Refine by bisection-style narrowing around the best sample.
    let lo = Math.max(0, bt - 1 / steps);
    let hi = Math.min(1, bt + 1 / steps);
    for (let it = 0; it < 24; it++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const a = cubicAt(p0, p1, p2, p3, m1);
      const b = cubicAt(p0, p1, p2, p3, m2);
      if ((a[0] - x) ** 2 + (a[1] - y) ** 2 < (b[0] - x) ** 2 + (b[1] - y) ** 2) hi = m2;
      else lo = m1;
    }
    const t = (lo + hi) / 2;
    const point = cubicAt(p0, p1, p2, p3, t);
    const dist = Math.hypot(point[0] - x, point[1] - y);
    if (!best || dist < best.dist) best = { segment: s, t, dist, point };
  }
  return best;
}

/**
 * Insert a knot on segment `s` at parameter `t`, splitting the Bézier so the curve keeps its exact shape: the
 * neighbouring handles shorten and the new knot gets collinear handles. Returns the new vertices and the new
 * knot's index.
 */
export function insertKnot(v: ArrayLike<number>, s: number, t: number): { vertices: number[]; knot: number } {
  const out = Array.from(v);
  const n = knotCount(v);
  const a = s;
  const b = (s + 1) % n;
  const [p0, p1, p2, p3] = segmentPoints(v, s);
  const [, l1, l2, m, r1, r2] = splitCubic(p0, p1, p2, p3, t);
  setPoint(out, a * 3 + 2, l1);
  setPoint(out, b * 3, r2);
  const knot = s + 1; // inserted after knot a (for the closing segment of a closed path: appended at the end)
  out.splice(knot * 6, 0, l2[0], l2[1], m[0], m[1], r1[0], r1[1]);
  return { vertices: out, knot };
}

/** Remove knots (by index). */
export function deleteKnots(v: ArrayLike<number>, knots: Iterable<number>): number[] {
  const drop = new Set(knots);
  const out: number[] = [];
  for (let k = 0; k < knotCount(v); k++) if (!drop.has(k)) for (let i = 0; i < 6; i++) out.push(v[k * 6 + i]);
  return out;
}

// ---------------- handle modes ----------------

const EPS = 1e-6;

/** The mode a knot's handles are in, read from their geometry. A zero-length handle counts as broken (a corner). */
export function inferMode(v: ArrayLike<number>, k: number, tolDeg = 0.5): HandleMode {
  const [ix, iy] = pointOf(v, k * 3);
  const [ax, ay] = pointOf(v, k * 3 + 1);
  const [ox, oy] = pointOf(v, k * 3 + 2);
  const li = Math.hypot(ax - ix, ay - iy);
  const lo = Math.hypot(ox - ax, oy - ay);
  if (li < EPS || lo < EPS) return "broken";
  // Angle between (anchor - in) and (out - anchor).
  const cross = (ax - ix) * (oy - ay) - (ay - iy) * (ox - ax);
  const dot = (ax - ix) * (ox - ax) + (ay - iy) * (oy - ay);
  const ang = Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI);
  if (ang > tolDeg) return "broken";
  return Math.abs(li - lo) <= Math.max(1e-3, 1e-3 * Math.max(li, lo)) ? "mirrored" : "smooth";
}

/** Move one handle of knot `k` (part 0 = in, 2 = out); the other follows the knot's mode. Returns new vertices. */
export function moveHandle(v: ArrayLike<number>, k: number, part: 0 | 2, to: Pt, mode: HandleMode): number[] {
  const out = Array.from(v);
  const anchor = pointOf(v, k * 3 + 1);
  setPoint(out, k * 3 + part, to);
  if (mode === "broken") return out;
  const other = part === 0 ? 2 : 0;
  const dx = to[0] - anchor[0];
  const dy = to[1] - anchor[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return out;
  const op = pointOf(v, k * 3 + other);
  const olen = mode === "mirrored" ? len : Math.hypot(op[0] - anchor[0], op[1] - anchor[1]);
  setPoint(out, k * 3 + other, [anchor[0] - (dx / len) * olen, anchor[1] - (dy / len) * olen]);
  return out;
}

/** Move knot `k`'s anchor; both handles move with it. */
export function moveAnchor(v: ArrayLike<number>, k: number, to: Pt): number[] {
  const out = Array.from(v);
  const [ax, ay] = pointOf(v, k * 3 + 1);
  const dx = to[0] - ax;
  const dy = to[1] - ay;
  for (let p = k * 3; p < k * 3 + 3; p++) setPoint(out, p, [v[p * 2] + dx, v[p * 2 + 1] + dy]);
  return out;
}

/** Put knot `k`'s handles into `mode`: smooth aligns them (keeping lengths), mirrored also evens the lengths. */
export function applyMode(v: ArrayLike<number>, k: number, mode: HandleMode): number[] {
  if (mode === "broken") return Array.from(v);
  const [ix, iy] = pointOf(v, k * 3);
  const [ax, ay] = pointOf(v, k * 3 + 1);
  const [ox, oy] = pointOf(v, k * 3 + 2);
  const li = Math.hypot(ax - ix, ay - iy);
  const lo = Math.hypot(ox - ax, oy - ay);
  // Shared direction: the average of both handles' directions (through the anchor).
  let tx = (li > EPS ? (ax - ix) / li : 0) + (lo > EPS ? (ox - ax) / lo : 0);
  let ty = (li > EPS ? (ay - iy) / li : 0) + (lo > EPS ? (oy - ay) / lo : 0);
  const tl = Math.hypot(tx, ty);
  if (tl < EPS) return Array.from(v); // both handles collapsed (or exactly opposite in a way we can't average)
  tx /= tl;
  ty /= tl;
  const [nin, nout] = mode === "mirrored" ? [(li + lo) / 2, (li + lo) / 2] : [li, lo];
  const out = Array.from(v);
  setPoint(out, k * 3, [ax - tx * nin, ay - ty * nin]);
  setPoint(out, k * 3 + 2, [ax + tx * nout, ay + ty * nout]);
  return out;
}

/** Reset knot `k`'s handles to an automatic smooth curve through its neighbours (like `addPath` anchors). */
export function resetHandles(v: ArrayLike<number>, closed: boolean, k: number): number[] {
  const n = knotCount(v);
  const out = Array.from(v);
  const anchor = (i: number): Pt => {
    const j = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return pointOf(v, j * 3 + 1);
  };
  const [x, y] = anchor(k);
  const [px, py] = anchor(k - 1);
  const [nx, ny] = anchor(k + 1);
  let tx = nx - px;
  let ty = ny - py;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const inLen = Math.hypot(x - px, y - py) / 3;
  const outLen = Math.hypot(nx - x, ny - y) / 3;
  setPoint(out, k * 3, [x - tx * inLen, y - ty * inLen]);
  setPoint(out, k * 3 + 2, [x + tx * outLen, y + ty * outLen]);
  return out;
}

/** A knot placed by click-dragging from `anchor` to `drag`: the out handle at the pointer, the in handle mirrored. */
export function placedKnot(anchor: Pt, drag: Pt | null, backwards = false): number[] {
  if (!drag) return [anchor[0], anchor[1], anchor[0], anchor[1], anchor[0], anchor[1]];
  const mirror: Pt = [2 * anchor[0] - drag[0], 2 * anchor[1] - drag[1]];
  const [inH, outH] = backwards ? [drag, mirror] : [mirror, drag];
  return [inH[0], inH[1], anchor[0], anchor[1], outH[0], outH[1]];
}

// ---------------- polygons ----------------

export function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
}

/** Nearest edge of a closed polygon to (x, y): edge i runs from point i to point i+1. */
export function nearestEdge(poly: ArrayLike<number>, x: number, y: number): { edge: number; dist: number } | null {
  const n = poly.length / 2;
  if (n < 2) return null;
  let best = { edge: 0, dist: Infinity };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = Math.sqrt(segDistSq(x, y, poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]));
    if (d < best.dist) best = { edge: i, dist: d };
  }
  return best;
}

/** Insert a point on edge `edge` (between point edge and edge+1). Returns the new polygon and the point's index. */
export function insertPoint(poly: ArrayLike<number>, edge: number, x: number, y: number): { vertices: number[]; index: number } {
  const out = Array.from(poly);
  const index = edge + 1;
  out.splice(index * 2, 0, x, y);
  return { vertices: out, index };
}

export function deletePoints(poly: ArrayLike<number>, indices: Iterable<number>): number[] {
  const drop = new Set(indices);
  const out: number[] = [];
  for (let i = 0; i < poly.length / 2; i++) if (!drop.has(i)) out.push(poly[i * 2], poly[i * 2 + 1]);
  return out;
}

export function rectPolygon(cx: number, cy: number, w: number, h: number): number[] {
  const x = w / 2;
  const y = h / 2;
  return [cx - x, cy - y, cx + x, cy - y, cx + x, cy + y, cx - x, cy + y];
}

/** Counter-clockwise ellipse outline with `n` points, the first at angle 0. */
export function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, n: number): number[] {
  const out: number[] = [];
  const k = Math.max(3, Math.round(n));
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return out;
}

/** Axis-aligned bounds of flat points: [minX, minY, maxX, maxY]. */
export function bounds(pts: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    x1 = Math.max(x1, pts[i]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  return [x0, y0, x1, y1];
}

// ---------------- weighted points ----------------

/** A 2D affine transform (same layout as core's `Affine`). */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
}
export interface Influence {
  bone: string;
  x: number;
  y: number;
  weight: number;
}

const mul = (m: Mat, x: number, y: number): Pt => [m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y];
function inv(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c || 1e-12;
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) };
}

/** World position of a weighted point (plus a deform offset added to every influence's local position). */
export function weightedWorld(inf: Influence[], bones: (id: string) => Mat, offset: Pt = [0, 0]): Pt {
  let x = 0;
  let y = 0;
  for (const i of inf) {
    const [px, py] = mul(bones(i.bone), i.x + offset[0], i.y + offset[1]);
    x += px * i.weight;
    y += py * i.weight;
  }
  return [x, y];
}

/**
 * Re-bind a weighted point to sit at world (wx, wy): every influence keeps its bone and weight, and its local
 * position becomes that world point in its bone's space (so the weighted sum lands exactly there).
 */
export function rebindWorld(inf: { bone: string; weight: number }[], bones: (id: string) => Mat, wx: number, wy: number): Influence[] {
  const total = inf.reduce((s, i) => s + i.weight, 0) || 1;
  return inf.map((i) => {
    const [x, y] = mul(inv(bones(i.bone)), wx, wy);
    return { bone: i.bone, x, y, weight: i.weight / total };
  });
}

/**
 * Deform offset (added to every influence's local position) that moves a weighted point to (wx, wy) in the
 * current pose: world = base + (Σ wᵢ·Lᵢ)·d with Lᵢ each bone's linear part, so d = (Σ wᵢ·Lᵢ)⁻¹ (target − base).
 */
export function weightedOffset(inf: Influence[], bones: (id: string) => Mat, wx: number, wy: number): Pt {
  const [bx, by] = weightedWorld(inf, bones);
  let a = 0, b = 0, c = 0, d = 0;
  for (const i of inf) {
    const m = bones(i.bone);
    a += m.a * i.weight;
    b += m.b * i.weight;
    c += m.c * i.weight;
    d += m.d * i.weight;
  }
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [0, 0];
  const rx = wx - bx;
  const ry = wy - by;
  return [(d * rx - b * ry) / det, (-c * rx + a * ry) / det];
}

/** Offset in a bone's local space that moves an unweighted point from local (lx, ly) to world (wx, wy). */
export function localOffset(m: Mat, lx: number, ly: number, wx: number, wy: number): Pt {
  const [x, y] = mul(inv(m), wx, wy);
  return [x - lx, y - ly];
}

/** Blend two bone → weight maps (t = 0: all `a`, 1: all `b`), dropping tiny influences and renormalising. */
export function blendInfluences(a: Map<string, number>, b: Map<string, number>, t: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const bone of new Set([...a.keys(), ...b.keys()])) {
    const w = (1 - t) * (a.get(bone) ?? 0) + t * (b.get(bone) ?? 0);
    if (w > 1e-4) out.set(bone, w);
  }
  const total = [...out.values()].reduce((s, w) => s + w, 0) || 1;
  for (const [k, w] of out) out.set(k, w / total);
  return out;
}
