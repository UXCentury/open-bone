/**
 * Texture atlas packing: a MaxRects rectangle packer (pure, no pixels) plus the helpers that map image
 * uvs into atlas page uvs. Composing page pixels is left to whoever has a canvas (editor, MCP, CLI).
 */
import type { AtlasData, AtlasPage, AtlasRegion, Id, OpenBoneDocument } from "./types.ts";

export interface PackInput {
  id: string;
  width: number;
  height: number;
}

export interface PackOptions {
  /** Empty pixels around every rectangle, including the page edges. Default 2. */
  padding?: number;
  /** Largest page size. Default 2048 x 2048. */
  maxWidth?: number;
  maxHeight?: number;
  /** Round page sizes up to powers of two. Default true. */
  powerOfTwo?: boolean;
  /** Make pages square. Default false. */
  square?: boolean;
  /** Let rectangles turn 90° when that packs tighter. Default false. */
  allowRotation?: boolean;
  /** Ids that must never be rotated (their consumers cannot draw a turned rectangle). */
  noRotate?: ReadonlySet<string>;
}

export interface PackedRect extends PackInput {
  x: number;
  y: number;
  /** Stored turned 90° clockwise: its footprint on the page is height × width. */
  rotated?: boolean;
}

/** Width and height a packed rect takes on the page. */
export const footprint = (r: { width: number; height: number; rotated?: boolean }) => (r.rotated ? { w: r.height, h: r.width } : { w: r.width, h: r.height });

export interface PackedPage {
  width: number;
  height: number;
  rects: PackedRect[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** MaxRects bin with the best-short-side-fit heuristic (ties broken by best long side). */
class MaxRectsBin {
  private free: Rect[];
  constructor(w: number, h: number) {
    this.free = w > 0 && h > 0 ? [{ x: 0, y: 0, w, h }] : [];
  }

  insert(w: number, h: number, canRotate = false): { x: number; y: number; rotated: boolean } | null {
    let best: Rect | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    let rotated = false;
    for (const f of this.free) {
      for (const turn of canRotate && w !== h ? [false, true] : [false]) {
        const rw = turn ? h : w;
        const rh = turn ? w : h;
        if (rw > f.w || rh > f.h) continue;
        const dw = f.w - rw;
        const dh = f.h - rh;
        const short = Math.min(dw, dh);
        const long = Math.max(dw, dh);
        if (short < bestShort || (short === bestShort && long < bestLong)) {
          best = f;
          bestShort = short;
          bestLong = long;
          rotated = turn;
        }
      }
    }
    if (!best) return null;
    const placed = { x: best.x, y: best.y, w: rotated ? h : w, h: rotated ? w : h };
    this.place(placed);
    return { x: placed.x, y: placed.y, rotated };
  }

  private place(r: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      // Split the free rect into up to four maximal rects around r.
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // Drop free rects contained in another.
    this.free = next.filter(
      (a, i) =>
        !next.some(
          (b, j) => i !== j && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || !sameRect(a, b)),
        ),
    );
  }
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const nextPot = (n: number) => (n <= 1 ? 1 : 2 ** Math.ceil(Math.log2(n)));

/**
 * Pack `rects` into `w x h` (page pixels) with `pad` around each, in the given order.
 * Returns the placed rects and the ones that did not fit.
 */
function packInto(rects: PackInput[], w: number, h: number, pad: number, rot?: { noRotate?: ReadonlySet<string> }) {
  // Inner bin starts at (pad, pad); each rect reserves `pad` after itself, so every gap and edge gets `pad`.
  const bin = new MaxRectsBin(w - pad, h - pad);
  const placed: PackedRect[] = [];
  const left: PackInput[] = [];
  for (const r of rects) {
    const p = bin.insert(r.width + pad, r.height + pad, !!rot && !rot.noRotate?.has(r.id));
    if (p) placed.push({ id: r.id, width: r.width, height: r.height, x: p.x + pad, y: p.y + pad, ...(p.rotated ? { rotated: true } : {}) });
    else left.push(r);
  }
  return { placed, left };
}

const bounds = (rects: PackedRect[], pad: number) => ({
  w: Math.max(0, ...rects.map((r) => r.x + footprint(r).w)) + pad,
  h: Math.max(0, ...rects.map((r) => r.y + footprint(r).h)) + pad,
});

/**
 * Pack rectangles into as few pages as needed, each as small as possible. Sizes are rounded up to whole
 * pixels. Throws if a rectangle (plus padding) is larger than the max page size.
 */
export function packRects(input: PackInput[], opts: PackOptions = {}): PackedPage[] {
  const pad = Math.max(0, Math.floor(opts.padding ?? 2));
  const maxW = Math.floor(opts.maxWidth ?? 2048);
  const maxH = Math.floor(opts.maxHeight ?? 2048);
  const pot = opts.powerOfTwo ?? true;
  const square = opts.square ?? false;
  // With power-of-two pages the usable size is the largest power of two that fits the limit.
  const limW = pot ? 2 ** Math.floor(Math.log2(maxW)) : maxW;
  const limH = pot ? 2 ** Math.floor(Math.log2(maxH)) : maxH;
  const limS = Math.min(limW, limH);
  const capW = square ? limS : limW;
  const capH = square ? limS : limH;

  const rects = input.map((r) => {
    if (!(r.width > 0 && r.height > 0)) throw new Error(`"${r.id}" has no size (${r.width}x${r.height})`);
    const w = Math.ceil(r.width);
    const h = Math.ceil(r.height);
    const fits = (a: number, b: number) => a + 2 * pad <= capW && b + 2 * pad <= capH;
    if (!fits(w, h) && !(opts.allowRotation && !opts.noRotate?.has(r.id) && fits(h, w)))
      throw new Error(`"${r.id}" (${w}x${h} + ${pad}px padding) does not fit in a ${capW}x${capH} page`);
    return { id: r.id, width: w, height: h };
  });
  // Big first: longest side, then area, then id (deterministic).
  rects.sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || b.width * b.height - a.width * a.height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rot = opts.allowRotation ? { noRotate: opts.noRotate } : undefined;
  const pages: PackedPage[] = [];
  let remaining = rects;
  while (remaining.length) {
    const { placed, left } = packInto(remaining, capW, capH, pad, rot);
    if (!placed.length) throw new Error(`"${remaining[0].id}" does not fit in a ${capW}x${capH} page`);
    pages.push(shrink(placed, { pad, capW, capH, pot, square, rot }));
    remaining = left;
  }
  return pages;
}

/** Find the smallest page that still holds every rect of a full page. */
function shrink(
  rects: PackedRect[],
  o: { pad: number; capW: number; capH: number; pot: boolean; square: boolean; rot?: { noRotate?: ReadonlySet<string> } },
): PackedPage {
  const { pad, capW, capH } = o;
  const area = rects.reduce((s, r) => s + (r.width + pad) * (r.height + pad), 0);
  // With rotation a rect only needs its shorter side to fit across.
  const turnable = (r: PackedRect) => !!o.rot && !o.rot.noRotate?.has(r.id);
  const minW = Math.max(...rects.map((r) => (turnable(r) ? Math.min(r.width, r.height) : r.width))) + 2 * pad;
  const minH = Math.max(...rects.map((r) => (turnable(r) ? Math.min(r.width, r.height) : r.height))) + 2 * pad;
  const candidates: [number, number][] = [];
  if (o.pot) {
    for (let w = nextPot(minW); w <= capW; w *= 2) for (let h = nextPot(minH); h <= capH; h *= 2) if (!o.square || w === h) candidates.push([w, h]);
  } else {
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const w = Math.round(minW + ((capW - minW) * i) / steps);
      if (o.square) candidates.push([Math.max(w, minH), Math.max(w, minH)]);
      else candidates.push([w, capH]);
    }
  }
  // Smallest area first; prefer square-ish pages on ties.
  candidates.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]));
  let best: PackedPage | null = null;
  for (const [w, h] of candidates) {
    if (w * h < area) continue;
    if (best && w * h >= best.width * best.height && o.pot) break;
    const { placed, left } = packInto(rects, w, h, pad, o.rot);
    if (left.length) continue;
    let page: PackedPage;
    if (o.pot) page = { width: w, height: h, rects: placed };
    else {
      const b = bounds(placed, pad);
      page = o.square ? { width: Math.max(b.w, b.h), height: Math.max(b.w, b.h), rects: placed } : { width: b.w, height: b.h, rects: placed };
    }
    if (!best || page.width * page.height < best.width * best.height) best = page;
    if (o.pot) break;
  }
  if (best) return best;
  // The rects came from a cap-sized page, so that always fits.
  const b = bounds(rects, pad);
  return o.pot ? { width: capW, height: capH, rects } : { width: b.w, height: b.h, rects };
}

// ---------- Document atlas layout ----------

/** Size of the solid white block shapes sample from (a few pixels so linear filtering stays pure white). */
export const ATLAS_WHITE_SIZE = 4;
const WHITE_ID = "@white";

export interface AtlasLayoutOptions extends PackOptions {
  /** Add a white block so untextured shapes batch with images. Default true. */
  white?: boolean;
  /** Page id prefix. Default "atlas_page". */
  pageId?: string;
  /** Store images at this fraction of their size (smaller pages, softer art). Default 1. */
  scale?: number;
  /** Recorded in the atlas: page pixels will be stored premultiplied (whoever composes the pages does it). */
  premultipliedAlpha?: boolean;
  /** Recorded in the atlas: images were trimmed to their visible bounds (pass each image's `trim`). */
  stripWhitespace?: boolean;
  /** Recorded in the atlas: images carry outline polygons (pass each image's `polygon`). */
  polygons?: boolean;
}

/** An image to lay out, optionally trimmed to its visible part and with an outline polygon (both in its own pixels). */
export interface AtlasImage {
  id: string;
  width: number;
  height: number;
  /** Visible bounds in image pixels (y-down); only this part is packed. */
  trim?: { x: number; y: number; width: number; height: number };
  /** Convex outline around the visible pixels, flat [x0,y0,...] in image pixels (y-down). */
  polygon?: number[];
}

/** A polygon is kept only when its area is below this fraction of its packed rect. */
const POLYGON_WORTH = 0.9;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Lay out images on atlas pages. The returned atlas has pages with an empty `src`: draw each region's image
 * at (x, y) (and fill `white` with opaque white), then store the page images as their `src`.
 */
export function layoutAtlas(images: AtlasImage[], opts: AtlasLayoutOptions = {}): AtlasData {
  const padding = Math.max(0, Math.floor(opts.padding ?? 2));
  const scale = Math.min(1, Math.max(0.01, opts.scale ?? 1));
  const sized = (n: number) => Math.max(1, Math.round(n * scale));
  // Per image: stored size and the part of it that is packed (trimmed images keep only their visible bounds).
  const parts = new Map<string, { ow: number; oh: number; ox: number; oy: number; w: number; h: number; polygon?: number[] }>();
  for (const i of images) {
    const ow = sized(i.width);
    const oh = sized(i.height);
    let part = { ow, oh, ox: 0, oy: 0, w: ow, h: oh } as { ow: number; oh: number; ox: number; oy: number; w: number; h: number; polygon?: number[] };
    if (i.trim && i.trim.width > 0 && i.trim.height > 0) {
      const kx = ow / i.width;
      const ky = oh / i.height;
      const x0 = Math.max(0, Math.floor(i.trim.x * kx));
      const y0 = Math.max(0, Math.floor(i.trim.y * ky));
      const x1 = Math.min(ow, Math.max(x0 + 1, Math.ceil((i.trim.x + i.trim.width) * kx)));
      const y1 = Math.min(oh, Math.max(y0 + 1, Math.ceil((i.trim.y + i.trim.height) * ky)));
      part = { ow, oh, ox: x0, oy: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (i.polygon && i.polygon.length >= 6) {
      const kx = ow / i.width;
      const ky = oh / i.height;
      const box = { x0: part.ox, y0: part.oy, x1: part.ox + part.w, y1: part.oy + part.h };
      const poly: number[] = [];
      for (let k = 0; k < i.polygon.length; k += 2)
        poly.push(round3(Math.min(box.x1, Math.max(box.x0, i.polygon[k] * kx))), round3(Math.min(box.y1, Math.max(box.y0, i.polygon[k + 1] * ky))));
      // Only worth it when the polygon covers clearly less than the packed rect.
      if (polygonArea(poly) < POLYGON_WORTH * part.w * part.h) part.polygon = poly;
    }
    parts.set(i.id, part);
  }
  const input: PackInput[] = images.map((i) => ({ id: i.id, width: parts.get(i.id)!.w, height: parts.get(i.id)!.h }));
  if (input.length && opts.white !== false) input.push({ id: WHITE_ID, width: ATLAS_WHITE_SIZE, height: ATLAS_WHITE_SIZE });
  const packed = packRects(input, { ...opts, padding });
  const prefix = opts.pageId ?? "atlas_page";
  const atlas: AtlasData = {
    pages: [],
    regions: [],
    padding,
    ...(scale !== 1 ? { scale } : {}),
    ...(opts.premultipliedAlpha ? { premultipliedAlpha: true } : {}),
    ...(opts.stripWhitespace ? { stripWhitespace: true } : {}),
    ...(opts.polygons ? { polygons: true } : {}),
  };
  packed.forEach((p, i) => {
    const page: AtlasPage = { id: `${prefix}${i}`, name: `atlas ${i + 1}`, src: "", width: p.width, height: p.height };
    atlas.pages.push(page);
    for (const r of p.rects) {
      if (r.id === WHITE_ID) {
        atlas.white = { page: page.id, x: r.x, y: r.y, width: r.width, height: r.height };
        continue;
      }
      const part = parts.get(r.id)!;
      atlas.regions.push({
        image: r.id,
        page: page.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        offsetX: part.ox,
        offsetY: part.oy,
        // Page pixels: with `scale` these are smaller than the image asset's size (uvs only use the ratios).
        originalWidth: part.ow,
        originalHeight: part.oh,
        ...(r.rotated ? { rotated: true } : {}),
        ...(part.polygon ? { polygon: part.polygon } : {}),
      });
    }
  });
  return atlas;
}

/**
 * page uv = offset + image uv * scale (both axes, v down). A rotated region (stored turned 90° clockwise) maps
 * page u = ou - v * su, page v = ov + u * sv.
 */
export interface UvMap {
  ou: number;
  ov: number;
  su: number;
  sv: number;
  rotated?: boolean;
}

/** Linear map from 0..1 uvs of the original image to uvs in the atlas page. */
export function atlasUvMap(region: AtlasRegion, page: Pick<AtlasPage, "width" | "height">): UvMap {
  if (region.rotated) {
    // Image pixel (ix, iy) of the trimmed rect sits at page (x + height - iy, y + ix).
    return {
      ou: (region.x + region.height + region.offsetY) / page.width,
      ov: (region.y - region.offsetX) / page.height,
      su: region.originalHeight / page.width,
      sv: region.originalWidth / page.height,
      rotated: true,
    };
  }
  return {
    ou: (region.x - region.offsetX) / page.width,
    ov: (region.y - region.offsetY) / page.height,
    su: region.originalWidth / page.width,
    sv: region.originalHeight / page.height,
  };
}

export function remapUvs(uvs: ArrayLike<number>, m: UvMap, out: Float32Array = new Float32Array(uvs.length)): Float32Array {
  for (let i = 0; i < uvs.length; i += 2) {
    const u = uvs[i];
    const v = uvs[i + 1];
    out[i] = m.rotated ? m.ou - v * m.su : m.ou + u * m.su;
    out[i + 1] = m.rotated ? m.ov + u * m.sv : m.ov + v * m.sv;
  }
  return out;
}

/** The page rectangle a packed region covers (its footprint: width and height swap when rotated). */
export const regionPageRect = (r: AtlasRegion) => ({ x: r.x, y: r.y, width: r.rotated ? r.height : r.width, height: r.rotated ? r.width : r.height });

/**
 * Lay out images at the largest scale (down to `minScale`) that fits on a single page, for "auto scale" packing.
 * Returns the layout and the scale used (1 when everything already fits).
 */
export function layoutAtlasFit(images: AtlasImage[], opts: AtlasLayoutOptions & { minScale?: number } = {}): { atlas: AtlasData; scale: number } {
  const fitsOne = (scale: number) => {
    try {
      const a = layoutAtlas(images, { ...opts, scale });
      return a.pages.length <= 1 ? a : null;
    } catch {
      return null;
    }
  };
  const full = fitsOne(1);
  if (full) return { atlas: full, scale: 1 };
  const min = Math.max(0.05, opts.minScale ?? 0.25);
  let lo = min;
  let hi = 1;
  let best = fitsOne(min);
  if (!best) return { atlas: layoutAtlas(images, { ...opts, scale: min }), scale: min };
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const a = fitsOne(mid);
    if (a) {
      best = a;
      lo = mid;
    } else hi = mid;
  }
  return { atlas: best, scale: Math.round(lo * 1000) / 1000 };
}

/** True when the packed rect holds only part of the original image (it was trimmed). */
export const isTrimmed = (r: AtlasRegion) =>
  r.offsetX !== 0 || r.offsetY !== 0 || r.width !== r.originalWidth || r.height !== r.originalHeight;

/** The atlas region (and its page) of an image, if the document has one. */
export function atlasRegion(doc: OpenBoneDocument, image: Id): { region: AtlasRegion; page: AtlasPage } | null {
  const region = doc.atlas?.regions.find((r) => r.image === image);
  const page = region && doc.atlas!.pages.find((p) => p.id === region.page);
  return region && page ? { region, page } : null;
}

/** Texture sources a loader needs: atlas pages plus images that are not packed (or still have their own src). */
export function textureAssets(doc: OpenBoneDocument): AtlasPage[] {
  return [...(doc.atlas?.pages ?? []), ...doc.images].filter((t) => t.src);
}

// ---------- Whitespace stripping, polygon packing, premultiplied alpha ----------

/** Area of a simple polygon (flat [x0,y0,...]), always positive. */
export function polygonArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(a) / 2;
}

/**
 * Bounds of the pixels whose alpha is above `threshold` in RGBA pixels (row-major, y-down), or null when the
 * image is fully transparent.
 */
export function alphaBounds(rgba: ArrayLike<number>, width: number, height: number, threshold = 0): { x: number; y: number; width: number; height: number } | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4 + 3;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4] <= threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

type Pt = [number, number];
const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (monotone chain), counter-clockwise in y-down coordinates' maths sense; collinear points dropped. */
function convexHull(points: Pt[]): Pt[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Cut a convex polygon down to `max` vertices while still containing it: repeatedly drop the edge whose removal
 * (extending its two neighbouring edges until they meet) adds the least area.
 */
function reduceHull(hull: Pt[], max: number): Pt[] {
  const p = hull.slice();
  while (p.length > max) {
    const n = p.length;
    let best = -1;
    let bestArea = Infinity;
    let bestPt: Pt | null = null;
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], d = p[(i + 2) % n];
      // a + t (b - a) = d + s (c - d), meeting beyond b and beyond c.
      const rx = b[0] - a[0], ry = b[1] - a[1];
      const sx = c[0] - d[0], sy = c[1] - d[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((d[0] - a[0]) * sy - (d[1] - a[1]) * sx) / den;
      const s = ((d[0] - a[0]) * ry - (d[1] - a[1]) * rx) / den;
      if (t < 1 - 1e-9 || s < 1 - 1e-9) continue;
      const x: Pt = [a[0] + t * rx, a[1] + t * ry];
      const area = Math.abs(cross(b, x, c)) / 2;
      if (area < bestArea) {
        bestArea = area;
        best = i;
        bestPt = x;
      }
    }
    if (best < 0 || !bestPt) break;
    // Replace b (index best) and c with the meeting point.
    const ci = (best + 1) % n;
    p[best] = bestPt;
    p.splice(ci, 1);
  }
  return p;
}

/** Clip a convex polygon to an axis-aligned box (Sutherland–Hodgman). */
function clipToBox(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i - 1 + src.length) % src.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * A convex outline with at most `maxVertices` corners around every pixel whose alpha is above `threshold`
 * (flat [x0,y0,...] in pixel units, y-down; pixel (x, y) covers x..x+1, y..y+1). Null when fully transparent.
 */
export function alphaHull(rgba: ArrayLike<number>, width: number, height: number, opts: { threshold?: number; maxVertices?: number } = {}): number[] | null {
  const th = opts.threshold ?? 0;
  const max = Math.max(3, opts.maxVertices ?? 8);
  const pts: Pt[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width * 4 + 3;
    let l = -1, r = -1;
    for (let x = 0; x < width; x++)
      if (rgba[row + x * 4] > th) {
        if (l < 0) l = x;
        r = x;
      }
    if (l < 0) continue;
    pts.push([l, y], [r + 1, y], [l, y + 1], [r + 1, y + 1]);
  }
  if (!pts.length) return null;
  let hull = reduceHull(convexHull(pts), max);
  hull = clipToBox(hull, 0, 0, width, height);
  return hull.flatMap(([x, y]) => [round3(x), round3(y)]);
}

/** rgb × a, in place (RGBA bytes). */
export function premultiplyPixels(px: Uint8Array | Uint8ClampedArray): typeof px {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 255) continue;
    px[i] = Math.round((px[i] * a) / 255);
    px[i + 1] = Math.round((px[i + 1] * a) / 255);
    px[i + 2] = Math.round((px[i + 2] * a) / 255);
  }
  return px;
}

/** rgb ÷ a, in place (RGBA bytes): premultiplied back to straight alpha. */
export function unpremultiplyPixels(px: Uint8Array | Uint8ClampedArray): typeof px {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      px[i] = px[i + 1] = px[i + 2] = 0;
      continue;
    }
    px[i] = Math.min(255, Math.round((px[i] * 255) / a));
    px[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a));
    px[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a));
  }
  return px;
}

/** Ids of the textures (atlas pages) whose pixels are stored premultiplied. */
export function premultipliedTextures(doc: Pick<OpenBoneDocument, "atlas">): Set<Id> {
  return new Set(doc.atlas?.premultipliedAlpha ? doc.atlas.pages.map((p) => p.id) : []);
}

/**
 * What whitespace stripping may cut from each image: `false` = keep the whole image (particles draw it as a
 * plain rectangle), or a uv box [u0, v0, u1, v1] that must stay packed (meshes sample everything their uvs cover).
 * Images not in the map may be trimmed freely.
 */
export function trimLimits(doc: OpenBoneDocument): Map<Id, false | [number, number, number, number]> {
  const out = new Map<Id, false | [number, number, number, number]>();
  for (const skin of doc.skeleton.skins)
    for (const atts of Object.values(skin.attachments))
      for (const a of Object.values(atts)) {
        if (a.type === "particles" && a.image) out.set(a.image, false);
        if (a.type !== "mesh" || out.get(a.image) === false) continue;
        let [u0, v0, u1, v1] = (out.get(a.image) as [number, number, number, number] | undefined) ?? [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < a.uvs.length; i += 2) {
          u0 = Math.min(u0, a.uvs[i]);
          u1 = Math.max(u1, a.uvs[i]);
          v0 = Math.min(v0, a.uvs[i + 1]);
          v1 = Math.max(v1, a.uvs[i + 1]);
        }
        if (u0 <= u1) out.set(a.image, [u0, v0, u1, v1]);
      }
  return out;
}

/**
 * The trim rect and outline polygon to pack for one image, from its RGBA pixels: visible bounds (grown to keep
 * what `limit` asks for), and with `polygons` a convex outline. Undefined fields mean "the whole image".
 */
export function analyzeImageAlpha(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  opts: { stripWhitespace?: boolean; polygons?: boolean; limit?: false | [number, number, number, number]; maxVertices?: number },
): Pick<AtlasImage, "trim" | "polygon"> {
  if (opts.limit === false || (!opts.stripWhitespace && !opts.polygons)) return {};
  const vis = alphaBounds(rgba, width, height) ?? { x: 0, y: 0, width: 1, height: 1 };
  let trim: AtlasImage["trim"];
  if (opts.stripWhitespace) {
    let x0 = vis.x, y0 = vis.y, x1 = vis.x + vis.width, y1 = vis.y + vis.height;
    if (opts.limit) {
      x0 = Math.min(x0, Math.max(0, Math.floor(opts.limit[0] * width)));
      y0 = Math.min(y0, Math.max(0, Math.floor(opts.limit[1] * height)));
      x1 = Math.max(x1, Math.min(width, Math.ceil(opts.limit[2] * width)));
      y1 = Math.max(y1, Math.min(height, Math.ceil(opts.limit[3] * height)));
    }
    if (x0 > 0 || y0 > 0 || x1 < width || y1 < height) trim = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const polygon = opts.polygons ? (alphaHull(rgba, width, height, { maxVertices: opts.maxVertices }) ?? undefined) : undefined;
  return { ...(trim ? { trim } : {}), ...(polygon ? { polygon } : {}) };
}
