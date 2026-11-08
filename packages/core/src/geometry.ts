import earcut from "earcut";
import type { ShapeAttachment } from "./types.ts";
import { DEG } from "./math.ts";

/** Outline polygon (flat x,y) of a shape attachment in its slot-bone local space. */
export function shapeOutline(s: ShapeAttachment, segments = 32): number[] {
  let pts: number[] = [];
  const hw = s.width / 2;
  const hh = s.height / 2;
  if (s.shape === "rect") {
    const r = Math.min(s.radius ?? 0, hw, hh);
    if (r <= 0) pts = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
    else {
      const corners: [number, number, number][] = [
        [hw - r, -hh + r, -90],
        [hw - r, hh - r, 0],
        [-hw + r, hh - r, 90],
        [-hw + r, -hh + r, 180],
      ];
      const seg = Math.max(2, Math.round(segments / 4));
      for (const [cx, cy, start] of corners)
        for (let i = 0; i <= seg; i++) {
          const a = (start + (90 * i) / seg) * DEG;
          pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
    }
  } else if (s.shape === "ellipse") {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(a) * hw, Math.sin(a) * hh);
    }
  } else {
    pts = (s.points ?? []).slice();
  }
  const cos = Math.cos(s.rotation * DEG);
  const sin = Math.sin(s.rotation * DEG);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    pts[i] = s.x + x * cos - y * sin;
    pts[i + 1] = s.y + x * sin + y * cos;
  }
  return pts;
}

export function triangulate(polygon: number[]): number[] {
  return earcut(polygon);
}

/** Regular grid mesh covering a width x height rect centred at (x,y). Returns hull-first vertex order. */
export function gridMesh(width: number, height: number, cols: number, rows: number, x = 0, y = 0) {
  cols = Math.max(1, Math.floor(cols));
  rows = Math.max(1, Math.floor(rows));
  const idx = (c: number, r: number) => r * (cols + 1) + c;
  // Build grid order, then remap so hull vertices come first.
  const hullOrder: number[] = [];
  for (let c = 0; c <= cols; c++) hullOrder.push(idx(c, 0));
  for (let r = 1; r <= rows; r++) hullOrder.push(idx(cols, r));
  for (let c = cols - 1; c >= 0; c--) hullOrder.push(idx(c, rows));
  for (let r = rows - 1; r >= 1; r--) hullOrder.push(idx(0, r));
  const interior: number[] = [];
  for (let r = 1; r < rows; r++) for (let c = 1; c < cols; c++) interior.push(idx(c, r));
  const order = [...hullOrder, ...interior];
  const remap = new Map<number, number>();
  order.forEach((g, i) => remap.set(g, i));
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const g of order) {
    const c = g % (cols + 1);
    const r = Math.floor(g / (cols + 1));
    const u = c / cols;
    const v = r / rows;
    uvs.push(u, v);
    // v grows downward in image space; y-up skeleton space so flip.
    vertices.push(x - width / 2 + u * width, y + height / 2 - v * height);
  }
  const triangles: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = remap.get(idx(c, r))!;
      const b = remap.get(idx(c + 1, r))!;
      const cc = remap.get(idx(c + 1, r + 1))!;
      const d = remap.get(idx(c, r + 1))!;
      triangles.push(a, b, cc, a, cc, d);
    }
  return { vertices, uvs, triangles, hull: hullOrder.length };
}

/** Squared distance from point to segment. */
export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}
