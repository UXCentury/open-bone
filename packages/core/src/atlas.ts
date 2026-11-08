/**
 * Texture atlas packing: a MaxRects rectangle packer (pure, no pixels) plus the helpers that map image
 * uvs into atlas page uvs. Composing page pixels is left to whoever has a canvas (editor, MCP, CLI).
 */
import type { AtlasData, AtlasPage, AtlasRegion, Id, ImageAsset, OpenBoneDocument } from "./types.ts";

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
}

export interface PackedRect extends PackInput {
  x: number;
  y: number;
}

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

  insert(w: number, h: number): { x: number; y: number } | null {
    let best: Rect | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const f of this.free) {
      if (w > f.w || h > f.h) continue;
      const dw = f.w - w;
      const dh = f.h - h;
      const short = Math.min(dw, dh);
      const long = Math.max(dw, dh);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = f;
        bestShort = short;
        bestLong = long;
      }
    }
    if (!best) return null;
    const placed = { x: best.x, y: best.y, w, h };
    this.place(placed);
    return placed;
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
function packInto(rects: PackInput[], w: number, h: number, pad: number) {
  // Inner bin starts at (pad, pad); each rect reserves `pad` after itself, so every gap and edge gets `pad`.
  const bin = new MaxRectsBin(w - pad, h - pad);
  const placed: PackedRect[] = [];
  const left: PackInput[] = [];
  for (const r of rects) {
    const p = bin.insert(r.width + pad, r.height + pad);
    if (p) placed.push({ ...r, x: p.x + pad, y: p.y + pad });
    else left.push(r);
  }
  return { placed, left };
}

const bounds = (rects: PackedRect[], pad: number) => ({
  w: Math.max(0, ...rects.map((r) => r.x + r.width)) + pad,
  h: Math.max(0, ...rects.map((r) => r.y + r.height)) + pad,
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
    if (w + 2 * pad > capW || h + 2 * pad > capH)
      throw new Error(`"${r.id}" (${w}x${h} + ${pad}px padding) does not fit in a ${capW}x${capH} page`);
    return { id: r.id, width: w, height: h };
  });
  // Big first: longest side, then area, then id (deterministic).
  rects.sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || b.width * b.height - a.width * a.height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const pages: PackedPage[] = [];
  let remaining = rects;
  while (remaining.length) {
    const { placed, left } = packInto(remaining, capW, capH, pad);
    pages.push(shrink(placed, { pad, capW, capH, pot, square }));
    remaining = left;
  }
  return pages;
}

/** Find the smallest page that still holds every rect of a full page. */
function shrink(
  rects: PackedRect[],
  o: { pad: number; capW: number; capH: number; pot: boolean; square: boolean },
): PackedPage {
  const { pad, capW, capH } = o;
  const area = rects.reduce((s, r) => s + (r.width + pad) * (r.height + pad), 0);
  const minW = Math.max(...rects.map((r) => r.width)) + 2 * pad;
  const minH = Math.max(...rects.map((r) => r.height)) + 2 * pad;
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
    const { placed, left } = packInto(rects, w, h, pad);
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
}

/**
 * Lay out images on atlas pages. The returned atlas has pages with an empty `src`: draw each region's image
 * at (x, y) (and fill `white` with opaque white), then store the page images as their `src`.
 */
export function layoutAtlas(images: Pick<ImageAsset, "id" | "width" | "height">[], opts: AtlasLayoutOptions = {}): AtlasData {
  const padding = Math.max(0, Math.floor(opts.padding ?? 2));
  const input: PackInput[] = images.map((i) => ({ id: i.id, width: i.width, height: i.height }));
  if (input.length && opts.white !== false) input.push({ id: WHITE_ID, width: ATLAS_WHITE_SIZE, height: ATLAS_WHITE_SIZE });
  const packed = packRects(input, { ...opts, padding });
  const prefix = opts.pageId ?? "atlas_page";
  const atlas: AtlasData = { pages: [], regions: [], padding };
  const byId = new Map(images.map((i) => [i.id, i]));
  packed.forEach((p, i) => {
    const page: AtlasPage = { id: `${prefix}${i}`, name: `atlas ${i + 1}`, src: "", width: p.width, height: p.height };
    atlas.pages.push(page);
    for (const r of p.rects) {
      if (r.id === WHITE_ID) {
        atlas.white = { page: page.id, x: r.x, y: r.y, width: r.width, height: r.height };
        continue;
      }
      const img = byId.get(r.id)!;
      atlas.regions.push({
        image: r.id,
        page: page.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        offsetX: 0,
        offsetY: 0,
        originalWidth: img.width,
        originalHeight: img.height,
      });
    }
  });
  return atlas;
}

/** page uv = offset + image uv * scale (both axes, v down). */
export interface UvMap {
  ou: number;
  ov: number;
  su: number;
  sv: number;
}

/** Linear map from 0..1 uvs of the original image to uvs in the atlas page. */
export function atlasUvMap(region: AtlasRegion, page: Pick<AtlasPage, "width" | "height">): UvMap {
  return {
    ou: (region.x - region.offsetX) / page.width,
    ov: (region.y - region.offsetY) / page.height,
    su: region.originalWidth / page.width,
    sv: region.originalHeight / page.height,
  };
}

export function remapUvs(uvs: ArrayLike<number>, m: UvMap, out: Float32Array = new Float32Array(uvs.length)): Float32Array {
  for (let i = 0; i < uvs.length; i += 2) {
    out[i] = m.ou + uvs[i] * m.su;
    out[i + 1] = m.ov + uvs[i + 1] * m.sv;
  }
  return out;
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
