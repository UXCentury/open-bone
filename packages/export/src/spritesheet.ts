import { packRects } from "@openbone/core";
import type { Frame } from "./bytes.ts";

/**
 * Sprite sheets: pack rendered animation frames into a few textures, with transparent borders trimmed and
 * identical frames stored once. Pure (no canvas), so engine packs can be built and tested anywhere.
 */

export interface SheetClipInput {
  /** Animation name; frames are named `<name>_0001`, `<name>_0002`, ... */
  name: string;
  fps: number;
  loop: boolean;
  /** All frames of all clips must have the same size. */
  frames: Frame[];
}

export interface SheetOptions {
  /** Trim transparent borders, recording the offset in `spriteSourceSize`. Default true. */
  trim?: boolean;
  /** Pixels between frames and around the page edge. Default 2. */
  padding?: number;
  /** Largest sheet size. Default 2048. */
  maxSize?: number;
  /** Round sheet sizes up to powers of two. Default false. */
  powerOfTwo?: boolean;
  /** Store pixel-identical frames once (aliases share the sheet rect). Default true. */
  dedupe?: boolean;
  /** Pixel position of the skeleton origin inside the untrimmed frame; becomes each frame's pivot. Default the centre. */
  origin?: { x: number; y: number };
  /** Alpha at or below this counts as transparent when trimming. Default 0. */
  alphaThreshold?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetFrame {
  /** Unique frame name, e.g. `walk_0003`. */
  name: string;
  clip: string;
  /** Index within the clip. */
  index: number;
  /** Sheet (page) index. */
  sheet: number;
  /** Rect on the sheet (top-left origin). */
  frame: Rect;
  trimmed: boolean;
  /** Where the trimmed rect sits inside the untrimmed frame. */
  spriteSourceSize: Rect;
  sourceSize: { w: number; h: number };
  /** Pivot (skeleton origin) as a fraction of the untrimmed frame, y down (TexturePacker convention). */
  pivot: { x: number; y: number };
  /** Name of the frame whose pixels this one reuses, when deduplicated. */
  aliasOf?: string;
}

export interface SheetClip {
  name: string;
  fps: number;
  loop: boolean;
  /** Frame names in play order. */
  frames: string[];
}

export interface SpriteSheetPage {
  width: number;
  height: number;
  /** Composited RGBA pixels. */
  image: Frame;
}

export interface SpriteSheetSet {
  pages: SpriteSheetPage[];
  frames: SheetFrame[];
  clips: SheetClip[];
  /** Untrimmed frame size (same for every frame). */
  sourceSize: { w: number; h: number };
  /** Origin pixel inside the untrimmed frame. */
  origin: { x: number; y: number };
}

/** Bounds of the pixels with alpha above `threshold`; a fully transparent frame trims to a 1x1 rect at 0,0. */
export function trimBounds(f: Frame, threshold = 0): Rect {
  const { width: w, height: h, data } = f;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Copy `r` of `src` into a new frame. */
export function cropFrame(src: Frame, r: Rect): Frame {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * src.width + r.x) * 4;
    out.set(src.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { width: r.w, height: r.h, data: out };
}

/** Copy all of `src` into `dst` at x, y. */
export function blitFrame(dst: Frame, src: Frame, x: number, y: number) {
  for (let row = 0; row < src.height; row++) {
    const to = ((y + row) * dst.width + x) * 4;
    dst.data.set(src.data.subarray(row * src.width * 4, (row + 1) * src.width * 4), to);
  }
}

/** FNV-1a over the pixels plus the size: cheap key for spotting identical frames (confirmed byte by byte). */
function hashFrame(f: Frame): string {
  let h = 0x811c9dc5;
  const d = f.data;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
  return `${f.width}x${f.height}:${(h >>> 0).toString(16)}`;
}

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Frame name: `<clip>_<n>` with n 1-based and zero padded to 4 digits. */
export const frameName = (clip: string, i: number) => `${clip}_${String(i + 1).padStart(4, "0")}`;

/** Trim, dedupe and pack the frames of several clips into sprite sheets. */
export function buildSpriteSheets(clips: SheetClipInput[], opts: SheetOptions = {}): SpriteSheetSet {
  const trim = opts.trim ?? true;
  const pad = Math.max(0, Math.floor(opts.padding ?? 2));
  const maxSize = Math.max(16, Math.floor(opts.maxSize ?? 2048));
  const dedupe = opts.dedupe ?? true;
  const first = clips.find((c) => c.frames.length)?.frames[0];
  if (!first) throw new Error("Nothing to pack: no frames");
  const sw = first.width;
  const sh = first.height;
  const origin = opts.origin ?? { x: sw / 2, y: sh / 2 };
  const names = new Set<string>();
  for (const c of clips) {
    if (names.has(c.name)) throw new Error(`Two clips are named "${c.name}"`);
    names.add(c.name);
  }

  // Unique trimmed images, keyed by the first frame that uses them.
  const uniques: { id: string; image: Frame; trim: Rect }[] = [];
  const byHash = new Map<string, number[]>();
  const frames: SheetFrame[] = [];
  const frameUnique: number[] = [];
  const outClips: SheetClip[] = [];
  for (const c of clips) {
    const list: string[] = [];
    c.frames.forEach((f, i) => {
      if (f.width !== sw || f.height !== sh) throw new Error(`Frame ${i + 1} of "${c.name}" is ${f.width}x${f.height}, expected ${sw}x${sh}`);
      const name = frameName(c.name, i);
      const t = trim ? trimBounds(f, opts.alphaThreshold ?? 0) : { x: 0, y: 0, w: sw, h: sh };
      const img = t.w === sw && t.h === sh ? f : cropFrame(f, t);
      let u = -1;
      if (dedupe) {
        const key = `${t.x},${t.y}/${hashFrame(img)}`;
        const hits = byHash.get(key) ?? [];
        u = hits.find((k) => sameBytes(uniques[k].image.data, img.data)) ?? -1;
        if (u < 0) byHash.set(key, [...hits, uniques.length]);
      }
      const aliasOf = u >= 0 ? uniques[u].id : undefined;
      if (u < 0) {
        u = uniques.length;
        uniques.push({ id: name, image: img, trim: t });
      }
      frameUnique.push(u);
      frames.push({
        name,
        clip: c.name,
        index: i,
        sheet: 0,
        frame: { x: 0, y: 0, w: t.w, h: t.h },
        trimmed: t.w !== sw || t.h !== sh,
        spriteSourceSize: t,
        sourceSize: { w: sw, h: sh },
        pivot: { x: round4(origin.x / sw), y: round4(origin.y / sh) },
        ...(aliasOf ? { aliasOf } : {}),
      });
      list.push(name);
    });
    outClips.push({ name: c.name, fps: c.fps, loop: c.loop, frames: list });
  }

  const packed = packRects(
    uniques.map((u) => ({ id: u.id, width: u.image.width, height: u.image.height })),
    { padding: pad, maxWidth: maxSize, maxHeight: maxSize, powerOfTwo: opts.powerOfTwo ?? false },
  );
  const where = new Map<string, { sheet: number; x: number; y: number }>();
  const uniqueById = new Map(uniques.map((u) => [u.id, u]));
  const pages: SpriteSheetPage[] = packed.map((p, sheet) => {
    const image: Frame = { width: p.width, height: p.height, data: new Uint8Array(p.width * p.height * 4) };
    for (const r of p.rects) {
      where.set(r.id, { sheet, x: r.x, y: r.y });
      blitFrame(image, uniqueById.get(r.id)!.image, r.x, r.y);
    }
    return { width: p.width, height: p.height, image };
  });
  frames.forEach((f, i) => {
    const at = where.get(uniques[frameUnique[i]].id)!;
    f.sheet = at.sheet;
    f.frame.x = at.x;
    f.frame.y = at.y;
  });
  return { pages, frames, clips: outClips, sourceSize: { w: sw, h: sh }, origin };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
