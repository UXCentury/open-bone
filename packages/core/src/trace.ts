import { triangulate } from "./geometry.ts";

/**
 * Automatic mesh outline (Spine's "Trace"): turn an image's alpha into a mesh that hugs the visible pixels, so less
 * transparent area is drawn and the mesh deforms around the art. Pure: give it the alpha channel; the editor reads it
 * from a canvas.
 *
 *   1. threshold the alpha (optionally downsampled for big images) and grow it by `padding` pixels;
 *   2. keep the largest opaque area (or the convex hull of everything when the art is in several big pieces);
 *   3. trace its outline with marching squares and simplify it (Douglas-Peucker) to `tolerance`, at most `maxHull`;
 *   4. add interior vertices on a grid (`interior` spacing) so the mesh can bend, and triangulate.
 */

export interface TraceOptions {
  /** Alpha above this (0..255) counts as visible. Default 8. */
  threshold?: number;
  /** Grow the outline outward by this many image pixels (keeps soft edges inside). Default 2. */
  padding?: number;
  /** Outline simplification in image pixels (bigger = fewer vertices). Default: 1% of the image's larger side, at least 1.5. */
  tolerance?: number;
  /** Most outline vertices. Default 48. */
  maxHull?: number;
  /** Spacing of interior vertices in image pixels; 0 = outline only. Default: a quarter of the smaller side. */
  interior?: number;
}

/** Where the image sits in the attachment: like a region (centre, size, scale, rotation in degrees). */
export interface TracePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  /**
   * Instead of the region-style placement: an affine map from uv to attachment space, [a, b, c, d, e, f] with
   * x = a·u + c·v + e, y = b·u + d·v + f (used to re-trace an existing mesh where it already sits).
   */
  uvAffine?: [number, number, number, number, number, number];
}

/** Fit the uv → position affine map of an existing mesh (from three well-spread vertices). Null if degenerate. */
export function meshUvAffine(vertices: number[], uvs: number[]): [number, number, number, number, number, number] | null {
  const n = uvs.length / 2;
  let best: [number, number, number] | null = null;
  let bestArea = 1e-9;
  // Pick the triangle of uv points with the largest area (a few candidates are enough).
  const step = Math.max(1, Math.floor(n / 24));
  for (let i = 0; i < n; i += step)
    for (let j = i + 1; j < n; j += step)
      for (let k = j + 1; k < n; k += step) {
        const ar = Math.abs((uvs[j * 2] - uvs[i * 2]) * (uvs[k * 2 + 1] - uvs[i * 2 + 1]) - (uvs[k * 2] - uvs[i * 2]) * (uvs[j * 2 + 1] - uvs[i * 2 + 1]));
        if (ar > bestArea) {
          bestArea = ar;
          best = [i, j, k];
        }
      }
  if (!best) return null;
  const [i, j, k] = best;
  const du1 = uvs[j * 2] - uvs[i * 2];
  const dv1 = uvs[j * 2 + 1] - uvs[i * 2 + 1];
  const du2 = uvs[k * 2] - uvs[i * 2];
  const dv2 = uvs[k * 2 + 1] - uvs[i * 2 + 1];
  const det = du1 * dv2 - du2 * dv1;
  const dx1 = vertices[j * 2] - vertices[i * 2];
  const dy1 = vertices[j * 2 + 1] - vertices[i * 2 + 1];
  const dx2 = vertices[k * 2] - vertices[i * 2];
  const dy2 = vertices[k * 2 + 1] - vertices[i * 2 + 1];
  const a = (dx1 * dv2 - dx2 * dv1) / det;
  const c = (dx2 * du1 - dx1 * du2) / det;
  const b = (dy1 * dv2 - dy2 * dv1) / det;
  const d = (dy2 * du1 - dy1 * du2) / det;
  const e = vertices[i * 2] - a * uvs[i * 2] - c * uvs[i * 2 + 1];
  const f = vertices[i * 2 + 1] - b * uvs[i * 2] - d * uvs[i * 2 + 1];
  return [a, b, c, d, e, f];
}

export interface TracedMesh {
  vertices: number[];
  uvs: number[];
  triangles: number[];
  hull: number;
}

const MAX_CELLS = 384 * 384;

/** Trace a mesh from an alpha channel (`alpha[y * width + x]`, 0..255). Returns null when nothing is visible. */
export function traceMesh(alpha: ArrayLike<number>, width: number, height: number, place: TracePlacement, opts: TraceOptions = {}): TracedMesh | null {
  const threshold = opts.threshold ?? 8;
  // Work on a grid of at most MAX_CELLS cells (max-pooled), so big images stay fast.
  const k = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_CELLS)));
  const gw = Math.ceil(width / k);
  const gh = Math.ceil(height / k);
  let mask: Uint8Array = new Uint8Array(gw * gh);
  let any = false;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (alpha[y * width + x] > threshold) {
        mask[Math.floor(y / k) * gw + Math.floor(x / k)] = 1;
        any = true;
      }
  if (!any) return null;
  const pad = Math.max(0, Math.round((opts.padding ?? 2) / k));
  if (pad > 0) mask = dilate(mask, gw, gh, pad);

  const { labels, sizes } = components(mask, gw, gh);
  let biggest = 1;
  for (let i = 2; i < sizes.length; i++) if (sizes[i] > sizes[biggest]) biggest = i;
  const total = sizes.reduce((a, b) => a + b, 0);
  const scattered = sizes.some((s, i) => i !== biggest && s > total * 0.05);

  // Outline in grid-corner coordinates (0..gw, 0..gh), y down.
  let outline: number[];
  if (scattered) outline = convexHull(mask, gw, gh);
  else {
    const keep = new Uint8Array(gw * gh);
    for (let i = 0; i < keep.length; i++) keep[i] = labels[i] === biggest ? 1 : 0;
    outline = marchingSquares(keep, gw, gh);
  }

  const maxHull = Math.max(3, opts.maxHull ?? 48);
  let tol = (opts.tolerance ?? Math.max(1.5, Math.max(width, height) * 0.01)) / k;
  let hull = simplifyClosed(outline, tol);
  for (let tries = 0; (hull.length / 2 > maxHull || !isSimple(hull)) && tries < 12; tries++) {
    tol *= 1.4;
    hull = simplifyClosed(outline, tol);
  }
  if (hull.length < 6 || !isSimple(hull)) hull = convexHull(mask, gw, gh);
  hull = hull.map((v, i) => Math.min(i % 2 ? gh : gw, Math.max(0, v)) * k);
  // Grid corners scaled back can overshoot the image by up to k-1 pixels.
  for (let i = 0; i < hull.length; i += 2) {
    hull[i] = Math.min(width, hull[i]);
    hull[i + 1] = Math.min(height, hull[i + 1]);
  }

  // Interior vertices on a grid, away from the outline, so the mesh can bend smoothly.
  const spacing = opts.interior ?? Math.max(8, Math.min(width, height) / 4);
  const inner: number[] = [];
  if (spacing > 0) {
    for (let y = spacing / 2; y < height; y += spacing)
      for (let x = spacing / 2; x < width; x += spacing)
        if (insidePolygon(x, y, hull) && distanceToPolygon(x, y, hull) > spacing * 0.4) inner.push(x, y);
  }

  // Image pixels → attachment space (centred, scaled, rotated, y up) and uvs.
  const sx = place.scaleX ?? 1;
  const sy = place.scaleY ?? 1;
  const r = ((place.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const px = [...hull, ...inner];
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < px.length; i += 2) {
    const u = px[i] / width;
    const v = px[i + 1] / height;
    uvs.push(u, v);
    if (place.uvAffine) {
      const [a, b, c, d, e, f] = place.uvAffine;
      vertices.push(a * u + c * v + e, b * u + d * v + f);
      continue;
    }
    const lx = (u - 0.5) * place.width * sx;
    const ly = (0.5 - v) * place.height * sy;
    vertices.push(place.x + lx * cos - ly * sin, place.y + lx * sin + ly * cos);
  }
  const hullCount = hull.length / 2;
  const triangles = triangulate(vertices.slice(0, hullCount * 2), vertices.slice(hullCount * 2));
  if (!triangles.length) return null;
  return { vertices, uvs, triangles, hull: hullCount };
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // Separable square dilation (row pass, then column pass).
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** 4-connected components: label per cell (0 = empty) and size per label. */
function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % w;
      const y = (c - x) / w;
      const visit = (n: number) => {
        if (mask[n] && !labels[n]) {
          labels[n] = id;
          stack.push(n);
        }
      };
      if (x > 0) visit(c - 1);
      if (x < w - 1) visit(c + 1);
      if (y > 0) visit(c - w);
      if (y < h - 1) visit(c + w);
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * Outer boundary of a single 4-connected blob as grid-corner points (counter-clockwise in y-down coordinates).
 * Walks the cell edges that separate filled from empty cells, starting from the topmost-leftmost filled cell.
 */
function marchingSquares(mask: Uint8Array, w: number, h: number): number[] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  let start = -1;
  for (let i = 0; i < mask.length && start < 0; i++) if (mask[i]) start = i;
  const sx = start % w;
  const sy = (start - sx) / w;
  // State: a corner (x, y) and a direction; the filled cell is always on the right of travel (y down).
  let x = sx;
  let y = sy;
  let dir = 0; // 0 right, 1 down, 2 left, 3 up
  const out: number[] = [];
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  for (let guard = 0; guard < (w + 1) * (h + 1) * 4; guard++) {
    out.push(x, y);
    x += DX[dir];
    y += DY[dir];
    // Back at the start corner (it is touched once: nothing is filled above it or to its left).
    if (x === sx && y === sy) break;
    // Cells around corner (x, y): tl (x-1,y-1), tr (x,y-1), bl (x-1,y), br (x,y).
    const tl = at(x - 1, y - 1);
    const tr = at(x, y - 1);
    const bl = at(x - 1, y);
    const br = at(x, y);
    // Pick the next edge keeping filled on the right: try turning right, straight, then left.
    const filledRight = (d: number) => {
      // For travel direction d from this corner, the cell on the right / left of the next edge.
      switch (d) {
        case 0:
          return br && !tr;
        case 1:
          return bl && !br;
        case 2:
          return tl && !bl;
        default:
          return tr && !tl;
      }
    };
    const right = (dir + 1) % 4;
    const left = (dir + 3) % 4;
    if (filledRight(right)) dir = right;
    else if (filledRight(dir)) {
      /* keep going straight */
    }
    else if (filledRight(left)) dir = left;
    else dir = (dir + 2) % 4;
  }
  return removeCollinear(out);
}

function removeCollinear(p: number[]): number[] {
  const n = p.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const c = (i + 1) % n;
    const cross = (p[i * 2] - p[a * 2]) * (p[c * 2 + 1] - p[i * 2 + 1]) - (p[i * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[i * 2]);
    if (cross !== 0) out.push(p[i * 2], p[i * 2 + 1]);
  }
  return out;
}

/** Douglas-Peucker for a closed polygon: split at the two farthest-apart points, simplify both halves. */
function simplifyClosed(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n <= 4) return p.slice();
  let a = 0;
  let b = 0;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2;
    if (d > best) {
      best = d;
      b = i;
    }
  }
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = (p[i * 2] - p[b * 2]) ** 2 + (p[i * 2 + 1] - p[b * 2 + 1]) ** 2;
    if (d > best) {
      best = d;
      a = i;
    }
  }
  if (a > b) [a, b] = [b, a];
  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const rec = (i: number, j: number) => {
    // Points strictly between i and j going forward (wrapping).
    let far = -1;
    let fd = tol * tol;
    for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) {
      const d = segDistSq(p[k * 2], p[k * 2 + 1], p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]);
      if (d > fd) {
        fd = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      rec(i, far);
      rec(far, j);
    }
  };
  rec(a, b);
  rec(b, a);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
}

/** True when no two non-adjacent edges of the closed polygon cross. */
export function isSimple(p: number[]): boolean {
  const n = p.length / 2;
  if (n < 3) return false;
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue;
      const [ax, ay, bx, by] = [p[i * 2], p[i * 2 + 1], p[i2 * 2], p[i2 * 2 + 1]];
      const [cx, cy, dx, dy] = [p[j * 2], p[j * 2 + 1], p[j2 * 2], p[j2 * 2 + 1]];
      const d1 = cross(ax, ay, bx, by, cx, cy);
      const d2 = cross(ax, ay, bx, by, dx, dy);
      const d3 = cross(cx, cy, dx, dy, ax, ay);
      const d4 = cross(cx, cy, dx, dy, bx, by);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
    }
  }
  return true;
}

/** Convex hull (monotone chain) of the filled cells' corners. */
function convexHull(mask: Uint8Array, w: number, h: number): number[] {
  const pts: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    if (minX >= 0) pts.push([minX, y], [minX, y + 1], [maxX + 1, y], [maxX + 1, y + 1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}

function insidePolygon(x: number, y: number, p: number[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) {
    const xi = p[i * 2];
    const yi = p[i * 2 + 1];
    const xj = p[j * 2];
    const yj = p[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(x: number, y: number, p: number[]): number {
  let best = Infinity;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    best = Math.min(best, segDistSq(x, y, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]));
  }
  return Math.sqrt(best);
}
