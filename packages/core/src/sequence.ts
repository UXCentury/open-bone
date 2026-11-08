/**
 * Sprite sequences: frame selection, natural sorting of numbered file names, and sprite sheet parsing
 * (grid, TexturePacker / Aseprite "frames" JSON in hash and array form). Pure, no pixels.
 */
import type { SequenceFrame, SequenceMode } from "./types.ts";

// ---------- Frame selection ----------

/**
 * Frame index for a frame counter (`floor(time * fps) + offset`, or a keyed / input value plus offset).
 * Returns -1 when nothing is shown (`once` after its last frame, or an empty sequence).
 * Counters before the first frame show frame 0 in every mode except `loop`, which wraps.
 */
export function sequenceFrameIndex(count: number, mode: SequenceMode, counter: number): number {
  if (count <= 0 || !Number.isFinite(counter)) return count > 0 ? 0 : -1;
  const f = Math.floor(counter);
  switch (mode) {
    case "loop":
      return ((f % count) + count) % count;
    case "once":
      return f < 0 ? 0 : f >= count ? -1 : f;
    case "holdLast":
      return Math.min(Math.max(f, 0), count - 1);
    case "pingPong": {
      if (count === 1) return 0;
      const period = 2 * count - 2;
      const k = ((f % period) + period) % period;
      return k < count ? k : period - k;
    }
  }
}

/** Frame counter at `time` seconds (the integer part selects the frame). */
export const sequenceCounter = (fps: number, offset: number, time: number) => Math.floor(time * fps + 1e-6) + offset;

/** Seconds a sequence takes to play through once (pingPong: there and back). */
export function sequenceDuration(count: number, fps: number, mode: SequenceMode): number {
  if (fps <= 0 || count <= 0) return 0;
  return (mode === "pingPong" && count > 1 ? 2 * count - 2 : count) / fps;
}

/**
 * Where a frame draws. `uv` is the frame's rect in 0..1 image space [u0, v0, u1, v1]; `quad` is the part of
 * the attachment quad it covers, as fractions [x0, y0, x1, y1] (y-down) of the untrimmed frame.
 */
export function sequenceFrameLayout(frame: SequenceFrame, imageWidth: number, imageHeight: number) {
  const r = frame.rect ?? { x: 0, y: 0, width: imageWidth, height: imageHeight };
  const uv: [number, number, number, number] = [r.x / imageWidth, r.y / imageHeight, (r.x + r.width) / imageWidth, (r.y + r.height) / imageHeight];
  const t = frame.trim;
  const quad: [number, number, number, number] = t
    ? [t.x / t.sourceWidth, t.y / t.sourceHeight, (t.x + r.width) / t.sourceWidth, (t.y + r.height) / t.sourceHeight]
    : [0, 0, 1, 1];
  return { uv, quad };
}

/** Untrimmed size of a frame in pixels. */
export function sequenceFrameSize(frame: SequenceFrame, image: { width: number; height: number }) {
  if (frame.trim) return { width: frame.trim.sourceWidth, height: frame.trim.sourceHeight };
  return frame.rect ? { width: frame.rect.width, height: frame.rect.height } : { width: image.width, height: image.height };
}

// ---------- Natural sort and numbered names ----------

const CHUNKS = /(\d+)|(\D+)/g;

/** Compare strings with digit runs compared as numbers ("f2" < "f10"), case-insensitively. */
export function naturalCompare(a: string, b: string): number {
  const pa = a.toLowerCase().match(CHUNKS) ?? [];
  const pb = b.toLowerCase().match(CHUNKS) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
      // Same value, different padding: shorter first ("1" before "01").
      if (x.length !== y.length) return x.length - y.length;
    } else return x < y ? -1 : 1;
  }
  return pa.length - pb.length || (a < b ? -1 : a > b ? 1 : 0);
}

export const naturalSort = <T>(items: T[], key: (t: T) => string = String): T[] => items.slice().sort((a, b) => naturalCompare(key(a), key(b)));

/** "fire_0001.png" -> { base: "fire", number: 1, ext: "png" }. Null when the name has no trailing number. */
export function parseNumberedName(fileName: string): { base: string; number: number; ext: string } | null {
  const m = /^(.*?)[\s._-]*(\d+)(?:\.([^.]+))?$/.exec(fileName);
  if (!m) return null;
  return { base: m[1] || "frame", number: Number(m[2]), ext: (m[3] ?? "").toLowerCase() };
}

export interface NameGroup<T> {
  /** Shared base name ("fire" for fire_0001.png ...). */
  name: string;
  /** Items in frame order. */
  items: T[];
  /** True when the items are numbered frames (two or more with the same base and extension). */
  sequence: boolean;
}

/**
 * Group file names into sequences: names that differ only in a trailing number (`fire_0001.png`, `fire_0002.png`)
 * form one sequence, naturally sorted. Every other item is its own group.
 */
export function groupNumbered<T>(items: T[], name: (t: T) => string): NameGroup<T>[] {
  const groups = new Map<string, { name: string; items: T[] }>();
  const singles: NameGroup<T>[] = [];
  for (const it of items) {
    const n = parseNumberedName(name(it));
    if (!n) {
      singles.push({ name: name(it).replace(/\.[^.]+$/, ""), items: [it], sequence: false });
      continue;
    }
    const key = `${n.base.toLowerCase()}|${n.ext}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { name: n.base, items: [] }));
    g.items.push(it);
  }
  const out: NameGroup<T>[] = [];
  for (const g of groups.values()) {
    if (g.items.length > 1) out.push({ name: g.name, items: naturalSort(g.items, name), sequence: true });
    else out.push({ name: name(g.items[0]).replace(/\.[^.]+$/, ""), items: g.items, sequence: false });
  }
  return [...out, ...singles];
}

// ---------- Sprite sheets ----------

export interface SheetFrame {
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  trim?: SequenceFrame["trim"];
  /** Milliseconds, when the sheet says (Aseprite). */
  duration?: number;
}

export interface GridOptions {
  imageWidth: number;
  imageHeight: number;
  /** Give columns/rows, or the frame size (the other is derived). */
  cols?: number;
  rows?: number;
  frameWidth?: number;
  frameHeight?: number;
  /** Pixels between frames. */
  padding?: number;
  /** Pixels around the whole grid. */
  margin?: number;
  /** Use only the first N cells (row by row). */
  count?: number;
}

/** Cut a sheet into a grid of equal frames, row by row (left to right, top to bottom). */
export function gridSheetFrames(o: GridOptions): SheetFrame[] {
  const pad = Math.max(0, o.padding ?? 0);
  const margin = Math.max(0, o.margin ?? 0);
  const innerW = o.imageWidth - 2 * margin;
  const innerH = o.imageHeight - 2 * margin;
  const cols = o.cols ?? (o.frameWidth ? Math.floor((innerW + pad) / (o.frameWidth + pad)) : 1);
  const rows = o.rows ?? (o.frameHeight ? Math.floor((innerH + pad) / (o.frameHeight + pad)) : 1);
  if (!(cols >= 1 && rows >= 1)) throw new Error("The grid needs at least one column and one row");
  const fw = o.frameWidth ?? (innerW - pad * (cols - 1)) / cols;
  const fh = o.frameHeight ?? (innerH - pad * (rows - 1)) / rows;
  if (!(fw > 0 && fh > 0)) throw new Error("Frames have no size: check the grid against the image size");
  if (margin + cols * fw + (cols - 1) * pad > o.imageWidth + 1e-6 || margin + rows * fh + (rows - 1) * pad > o.imageHeight + 1e-6)
    throw new Error(`A ${cols}x${rows} grid of ${fw}x${fh} frames does not fit a ${o.imageWidth}x${o.imageHeight} image`);
  const total = Math.min(cols * rows, o.count ?? Infinity);
  const out: SheetFrame[] = [];
  for (let i = 0; i < total; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ name: `frame${i}`, rect: { x: margin + c * (fw + pad), y: margin + r * (fh + pad), width: fw, height: fh } });
  }
  return out;
}

interface JsonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface JsonFrame {
  filename?: string;
  frame: JsonRect;
  rotated?: boolean;
  trimmed?: boolean;
  spriteSourceSize?: JsonRect;
  sourceSize?: { w: number; h: number };
  duration?: number;
}

const isRect = (r: unknown): r is JsonRect =>
  !!r && typeof r === "object" && ["x", "y", "w", "h"].every((k) => typeof (r as Record<string, unknown>)[k] === "number");

export interface ParsedSheet {
  /** Sheet image file name from `meta.image`, if given. */
  image?: string;
  frames: SheetFrame[];
  /** Frame rate suggested by per-frame durations (Aseprite), if they are given. */
  fps?: number;
}

/**
 * Parse a sprite sheet JSON in the common "frames" layout written by TexturePacker, Aseprite, Adobe Animate and
 * After Effects exporters: `frames` is either a hash (`{"name": {frame, ...}}`, sorted naturally by name) or an
 * array (`[{filename, frame, ...}]`, kept in order). Trimmed frames keep their placement in the original frame.
 */
export function parseSheetJson(input: string | unknown): ParsedSheet {
  const data = (typeof input === "string" ? JSON.parse(input) : input) as { frames?: unknown; meta?: { image?: unknown } };
  if (!data || typeof data !== "object" || !data.frames || typeof data.frames !== "object")
    throw new Error('Not a sprite sheet: expected a "frames" hash or array');
  const entries: [string, JsonFrame][] = Array.isArray(data.frames)
    ? data.frames.map((f: JsonFrame, i) => [String(f?.filename ?? `frame${i}`), f])
    : naturalSort(Object.entries(data.frames as Record<string, JsonFrame>), ([k]) => k);
  if (!entries.length) throw new Error("The sprite sheet has no frames");
  const frames = entries.map(([name, f]): SheetFrame => {
    if (!f || !isRect(f.frame)) throw new Error(`Frame "${name}" has no frame rect {x, y, w, h}`);
    if (f.rotated) throw new Error(`Frame "${name}" is rotated in the sheet; export the sheet without rotation`);
    const rect = { x: f.frame.x, y: f.frame.y, width: f.frame.w, height: f.frame.h };
    const out: SheetFrame = { name, rect };
    const ss = f.spriteSourceSize;
    const src = f.sourceSize;
    if (isRect(ss) && src && (ss.x !== 0 || ss.y !== 0 || src.w !== rect.width || src.h !== rect.height))
      out.trim = { x: ss.x, y: ss.y, sourceWidth: src.w, sourceHeight: src.h };
    if (typeof f.duration === "number" && f.duration > 0) out.duration = f.duration;
    return out;
  });
  const durations = frames.map((f) => f.duration).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
  const image = typeof data.meta?.image === "string" ? data.meta.image : undefined;
  return {
    frames,
    ...(image ? { image } : {}),
    ...(durations.length ? { fps: Math.round((1000 / durations[durations.length >> 1]) * 100) / 100 } : {}),
  };
}
