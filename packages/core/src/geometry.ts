import earcut from "earcut";
import type { ShapeAttachment } from "./types.ts";
import { DEG, pointInPolygon } from "./math.ts";

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

/**
 * Triangulate a simple polygon (flat x,y). With `interior` points (flat x,y, indexed after the polygon
 * vertices) it builds a Delaunay triangulation of all points and keeps the triangles inside the polygon,
 * which is how mesh attachments with a hull plus interior vertices are re-triangulated.
 */
export function triangulate(polygon: number[], interior: number[] = []): number[] {
  if (!interior.length) return earcut(polygon);
  const pts = [...polygon, ...interior];
  const out: number[] = [];
  for (const [a, b, c] of delaunay(pts)) {
    const cx = (pts[a * 2] + pts[b * 2] + pts[c * 2]) / 3;
    const cy = (pts[a * 2 + 1] + pts[b * 2 + 1] + pts[c * 2 + 1]) / 3;
    if (pointInPolygon(cx, cy, polygon)) out.push(a, b, c);
  }
  return out;
}

/** Bowyer–Watson Delaunay triangulation of flat x,y points. Returns counter-clockwise index triples. */
function delaunay(pts: number[]): [number, number, number][] {
  const n = pts.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[i * 2]);
    maxX = Math.max(maxX, pts[i * 2]);
    minY = Math.min(minY, pts[i * 2 + 1]);
    maxY = Math.max(maxY, pts[i * 2 + 1]);
  }
  const d = Math.max(maxX - minX, maxY - minY, 1) * 20;
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const P = [...pts, mx - d, my - d, mx + d, my - d, mx, my + d];
  const x = (i: number) => P[i * 2];
  const y = (i: number) => P[i * 2 + 1];
  type Tri = { v: [number, number, number]; cx: number; cy: number; r2: number };
  const make = (a: number, b: number, c: number): Tri => {
    // Orient counter-clockwise.
    if ((x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a)) < 0) [b, c] = [c, b];
    const ax = x(a), ay = y(a), bx = x(b), by = y(b), cx = x(c), cy = y(c);
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) || 1e-12;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { v: [a, b, c], cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: Tri[] = [make(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const px = x(i), py = y(i);
    const bad: Tri[] = [];
    const keep: Tri[] = [];
    for (const t of tris) ((px - t.cx) ** 2 + (py - t.cy) ** 2 < t.r2 * (1 + 1e-9) ? bad : keep).push(t);
    // Boundary edges of the cavity = edges used by exactly one bad triangle.
    const edges = new Map<string, [number, number]>();
    for (const t of bad)
      for (let e = 0; e < 3; e++) {
        const a = t.v[e], b = t.v[(e + 1) % 3];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        if (edges.has(k)) edges.delete(k);
        else edges.set(k, [a, b]);
      }
    for (const [a, b] of edges.values()) keep.push(make(a, b, i));
    tris = keep;
  }
  return tris.filter((t) => t.v.every((v) => v < n)).map((t) => t.v);
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
