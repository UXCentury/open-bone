/**
 * Pixel operations for preparing art (process_image): key out a flat background, cut a layer out by comparing two
 * versions of a picture, trim, crop, feather edges, flip. They work on straight-alpha RGBA buffers; resizing and file
 * I/O happen in the tool with the canvas.
 */

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Where the result sits in the input image (after crops and trims), in input pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`Not a colour: ${hex}`);
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

/** Median colour of the image border (all edges, or only the top rows). */
export function borderColor(p: Pixels, edges: "all" | "top" = "all", depth = 4): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * p.width + x) * 4;
    if (p.data[i + 3] < 128) return;
    rs.push(p.data[i]);
    gs.push(p.data[i + 1]);
    bs.push(p.data[i + 2]);
  };
  for (let y = 0; y < Math.min(depth, p.height); y++) for (let x = 0; x < p.width; x += 2) take(x, y);
  if (edges === "all") {
    for (let y = Math.max(0, p.height - depth); y < p.height; y++) for (let x = 0; x < p.width; x += 2) take(x, y);
    for (let y = 0; y < p.height; y += 2)
      for (let d = 0; d < depth; d++) {
        take(d, y);
        take(p.width - 1 - d, y);
      }
  }
  if (!rs.length) throw new Error("The border has no opaque pixels to take a background colour from: give `color`");
  const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

export interface KeyOptions {
  /** Background colour; default: the border median. */
  color?: string;
  /** Where to sample the default colour: "all" edges or only the "top" (art that touches the other edges, like grass). */
  sampleFrom?: "all" | "top";
  /** Colour distance (0–441) still counted as background. */
  tolerance?: number;
  /** Distance over which pixels fade from background to opaque (soft, anti-aliased edges). */
  softness?: number;
  /** Pixels at least this bright (0–255 average) stay opaque, e.g. white flowers on a light grey background. */
  keepBrighterThan?: number;
  /**
   * Remove the key colour's cast from what is left (green/blue screen spill on edges): the key's dominant channel is
   * limited to the average of the other two (the usual green-screen despill). Default: on when the key colour is strongly coloured (green, blue, magenta…).
   */
  despill?: boolean;
}

/**
 * Remove a flat background colour everywhere in the image (also in closed gaps), with soft edges, and take the
 * background tint out of the semi-transparent edge pixels so no fringe of it is left.
 */
export function keyColor(p: Pixels, o: KeyOptions = {}): { color: [number, number, number] } {
  const bg = o.color ? parseHex(o.color) : borderColor(p, o.sampleFrom ?? "all");
  const tol = o.tolerance ?? 18;
  const soft = Math.max(1, o.softness ?? 34);
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
    let a = smooth((dist - tol) / soft);
    if (o.keepBrighterThan !== undefined) a = Math.max(a, smooth(((d[i] + d[i + 1] + d[i + 2]) / 3 - o.keepBrighterThan) / 20));
    const a0 = d[i + 3] / 255;
    if (a > 0 && a < 1)
      for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.max(0, (d[i + c] - (1 - a) * bg[c]) / a));
    d[i + 3] = Math.round(a * a0 * 255);
  }
  const k = bg.indexOf(Math.max(...bg));
  const others = [0, 1, 2].filter((c) => c !== k);
  const saturated = bg[k] - Math.max(bg[others[0]], bg[others[1]]) > 80;
  if (o.despill ?? saturated)
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) d[i + k] = Math.min(d[i + k], (d[i + others[0]] + d[i + others[1]]) / 2);
  return { color: bg };
}

/** Bounding box of pixels with alpha above `threshold`, grown by `padding`. Null when nothing is visible. */
export function alphaBounds(p: Pixels, threshold = 8, padding = 0): Box | null {
  let x0 = p.width;
  let y0 = p.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      if (p.data[(y * p.width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - padding);
  y0 = Math.max(0, y0 - padding);
  x1 = Math.min(p.width - 1, x1 + padding);
  y1 = Math.min(p.height - 1, y1 + padding);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function crop(p: Pixels, b: Box): Pixels {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  const w = Math.max(1, Math.min(p.width - x, Math.round(b.width)));
  const h = Math.max(1, Math.min(p.height - y, Math.round(b.height)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(p.data.subarray(((y + r) * p.width + x) * 4, ((y + r) * p.width + x + w) * 4), r * w * 4);
  return { data: out, width: w, height: h };
}

/** Fade alpha to 0 over the given number of pixels at each side (so tiled copies overlap without seams). */
export function featherEdges(p: Pixels, o: { left?: number; right?: number; top?: number; bottom?: number }) {
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      let f = 1;
      if (o.left) f = Math.min(f, smooth(x / o.left));
      if (o.right) f = Math.min(f, smooth((p.width - 1 - x) / o.right));
      if (o.top) f = Math.min(f, smooth(y / o.top));
      if (o.bottom) f = Math.min(f, smooth((p.height - 1 - y) / o.bottom));
      if (f < 1) p.data[(y * p.width + x) * 4 + 3] *= f;
    }
}

export function flip(p: Pixels, horizontal: boolean, vertical: boolean): Pixels {
  const out = new Uint8ClampedArray(p.data.length);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const sx = horizontal ? p.width - 1 - x : x;
      const sy = vertical ? p.height - 1 - y : y;
      out.set(p.data.subarray((sy * p.width + sx) * 4, (sy * p.width + sx) * 4 + 4), (y * p.width + x) * 4);
    }
  return { data: out, width: p.width, height: p.height };
}

/** Keep only the largest connected group of visible pixels (alpha > threshold), clearing stray specks. */
export function keepLargest(p: Pixels, threshold = 12) {
  const n = p.width * p.height;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] || p.data[s * 4 + 3] <= threshold) continue;
    next++;
    let size = 0;
    let top = 0;
    stack[top++] = s;
    label[s] = next;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % p.width;
      const nb = [x > 0 ? i - 1 : -1, x < p.width - 1 ? i + 1 : -1, i - p.width, i + p.width];
      for (const j of nb)
        if (j >= 0 && j < n && !label[j] && p.data[j * 4 + 3] > threshold) {
          label[j] = next;
          stack[top++] = j;
        }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  // Keep the faint edge pixels that touch the kept group (they carry the anti-aliasing).
  for (let i = 0; i < n; i++) {
    if (label[i] === best) continue;
    if (label[i] === 0 && p.data[i * 4 + 3] > 0) {
      const x = i % p.width;
      const near = [x > 0 ? i - 1 : -1, x < p.width - 1 ? i + 1 : -1, i - p.width, i + p.width].some((j) => j >= 0 && j < n && label[j] === best);
      if (near) continue;
    }
    p.data[i * 4 + 3] = 0;
  }
}

export interface DifferenceOptions {
  /** Channel difference (0–1) below which pixels count as unchanged. */
  threshold?: number;
  /** Range (0–1) over which alpha ramps up above the threshold. */
  softness?: number;
  /** Only look inside this box of the image (pixels outside become transparent). */
  region?: Box;
  /** Fade the matte out between these rows (e.g. where a tree meets repainted grass): {from, to}, alpha 1 at from, 0 at to. */
  fadeRows?: { from: number; to: number };
  /** Keep only the largest cut-out piece (default true). */
  keepLargest?: boolean;
}

/**
 * Cut out what differs between `p` and `other` (the same picture with the object removed, e.g. an inpainted "clean
 * plate"): `p` keeps its colours, alpha becomes how much the two differ. A median and a small dilation clean the matte.
 */
export function differenceMatte(p: Pixels, other: Pixels, o: DifferenceOptions = {}) {
  if (other.width !== p.width || other.height !== p.height) throw new Error(`The other image is ${other.width}×${other.height}; it must be ${p.width}×${p.height} (resize it first)`);
  const w = p.width;
  const h = p.height;
  const diff = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = i * 4;
    diff[i] = Math.max(Math.abs(p.data[a] - other.data[a]), Math.abs(p.data[a + 1] - other.data[a + 1]), Math.abs(p.data[a + 2] - other.data[a + 2])) / 255;
  }
  // 5×5 median (drops repaint noise), then 3×3 max (closes thin gaps), then a light blur.
  const med = filter(diff, w, h, 2, (v) => v.sort((x, y) => x - y)[v.length >> 1]);
  const dil = filter(med, w, h, 1, (v) => Math.max(...v));
  const blur = filter(dil, w, h, 1, (v) => v.reduce((s, x) => s + x, 0) / v.length);
  const th = o.threshold ?? 0.06;
  const soft = o.softness ?? 0.09;
  const r = o.region;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let a = smooth((blur[i] - th) / soft);
      if (r && (x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height)) a = 0;
      if (o.fadeRows) {
        const { from, to } = o.fadeRows;
        a *= to === from ? (y < from ? 1 : 0) : smooth((to - y) / (to - from));
      }
      p.data[i * 4 + 3] = Math.round(a * p.data[i * 4 + 3]);
    }
  if (o.keepLargest ?? true) keepLargest(p);
}

function filter(src: Float32Array, w: number, h: number, r: number, f: (v: number[]) => number): Float32Array {
  const out = new Float32Array(src.length);
  const v: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      v.length = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          v.push(src[yy * w + xx]);
        }
      out[y * w + x] = f(v);
    }
  return out;
}
