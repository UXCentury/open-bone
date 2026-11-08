/**
 * Cubic bezier splines for path attachments.
 *
 * A path is a list of knots, each stored as three points `[in handle, anchor, out handle]`
 * (flat `[inX, inY, x, y, outX, outY, ...]`). Distances along the path are measured by arc
 * length using a per-segment lookup table, so "50 units along" means the same thing on every
 * segment regardless of how its handles are spaced.
 */

export interface PathSample {
  x: number;
  y: number;
  /** Tangent direction in radians (counter-clockwise from +x). */
  angle: number;
}

export interface Spline {
  closed: boolean;
  /** Total arc length. */
  length: number;
  segments: number;
  /** Point and tangent at an arc-length distance. Open paths extend straight past their ends; closed paths wrap. */
  sample(distance: number): PathSample;
}

/** Arc-length table resolution (samples per bezier segment). */
const STEPS = 32;

function bez(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}
function bezD(a: number, b: number, c: number, d: number, t: number) {
  const u = 1 - t;
  return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
}

/** Build a spline from world (or local) knot vertices. Needs at least two knots (one for a closed path). */
export function buildSpline(vertices: ArrayLike<number>, closed: boolean): Spline {
  const knots = Math.floor(vertices.length / 6);
  const segCount = knots < 2 ? 0 : closed ? knots : knots - 1;
  // Control points per segment: x0,y0,x1,y1,x2,y2,x3,y3
  const ctrl = new Float64Array(Math.max(segCount, 1) * 8);
  for (let s = 0; s < segCount; s++) {
    const a = s * 6;
    const b = ((s + 1) % knots) * 6;
    ctrl.set([vertices[a + 2], vertices[a + 3], vertices[a + 4], vertices[a + 5], vertices[b], vertices[b + 1], vertices[b + 2], vertices[b + 3]], s * 8);
  }
  // Cumulative arc length at each table entry (segCount * STEPS + 1 entries).
  const table = new Float64Array(segCount * STEPS + 1);
  let total = 0;
  for (let s = 0; s < segCount; s++) {
    const o = s * 8;
    let px = ctrl[o];
    let py = ctrl[o + 1];
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
      const y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
      total += Math.hypot(x - px, y - py);
      table[s * STEPS + i] = total;
      px = x;
      py = y;
    }
  }

  const point = (s: number, t: number): PathSample => {
    const o = s * 8;
    const x = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
    const y = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
    let dx = bezD(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t);
    let dy = bezD(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t);
    if (dx * dx + dy * dy < 1e-12) {
      // Handle sits on its anchor: take the direction across a small step instead.
      const t0 = Math.max(0, t - 1e-3);
      const t1 = Math.min(1, t + 1e-3);
      dx = bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t1) - bez(ctrl[o], ctrl[o + 2], ctrl[o + 4], ctrl[o + 6], t0);
      dy = bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t1) - bez(ctrl[o + 1], ctrl[o + 3], ctrl[o + 5], ctrl[o + 7], t0);
      if (dx * dx + dy * dy < 1e-18) {
        dx = ctrl[o + 6] - ctrl[o];
        dy = ctrl[o + 7] - ctrl[o + 1];
      }
    }
    return { x, y, angle: Math.atan2(dy, dx) };
  };

  const sample = (distance: number): PathSample => {
    if (segCount === 0) {
      const x = knots ? vertices[2] : 0;
      const y = knots ? vertices[3] : 0;
      return { x, y, angle: 0 };
    }
    let d = distance;
    if (closed && total > 0) d = ((d % total) + total) % total;
    else if (d <= 0 || d >= total) {
      // Extend in a straight line along the end tangent.
      const end = d <= 0 ? point(0, 0) : point(segCount - 1, 1);
      const over = d <= 0 ? d : d - total;
      return { x: end.x + Math.cos(end.angle) * over, y: end.y + Math.sin(end.angle) * over, angle: end.angle };
    }
    // Binary search the table for the entry just below d.
    let lo = 0;
    let hi = table.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = table[hi] - table[lo];
    const f = span > 0 ? (d - table[lo]) / span : 0;
    const seg = Math.min(segCount - 1, Math.floor(lo / STEPS));
    const t = (lo - seg * STEPS + f) / STEPS;
    return point(seg, Math.min(1, t));
  };

  return { closed, length: total, segments: segCount, sample };
}

/**
 * Knot vertices for a smooth curve through `anchors` (flat x,y list). Handles are placed along the
 * line through the neighbouring anchors at a third of the distance to each neighbour.
 */
export function smoothKnots(anchors: number[], closed: boolean): number[] {
  const n = Math.floor(anchors.length / 2);
  const out: number[] = [];
  const at = (i: number): [number, number] => {
    if (closed) i = ((i % n) + n) % n;
    else i = Math.max(0, Math.min(n - 1, i));
    return [anchors[i * 2], anchors[i * 2 + 1]];
  };
  for (let i = 0; i < n; i++) {
    const [x, y] = at(i);
    const [px, py] = at(i - 1);
    const [nx, ny] = at(i + 1);
    let tx = nx - px;
    let ty = ny - py;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const inLen = Math.hypot(x - px, y - py) / 3;
    const outLen = Math.hypot(nx - x, ny - y) / 3;
    out.push(x - tx * inLen, y - ty * inLen, x, y, x + tx * outLen, y + ty * outLen);
  }
  return out;
}

/** Polyline approximation of a spline for drawing (flat x,y). */
export function splinePolyline(sp: Spline, stepsPerSegment = 16): number[] {
  const out: number[] = [];
  const n = Math.max(1, sp.segments * stepsPerSegment);
  for (let i = 0; i <= n; i++) {
    const p = sp.sample((sp.length * i) / n);
    out.push(p.x, p.y);
  }
  return out;
}
