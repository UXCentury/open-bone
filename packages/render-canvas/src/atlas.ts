import {
  type AtlasData,
  type AtlasImage,
  type AtlasLayoutOptions,
  type OpenBoneDocument,
  analyzeImageAlpha,
  atlasRegion,
  bleedPixels,
  cropPixels,
  hashPixels,
  layoutAtlas,
  layoutAtlasFit,
  outlineBoxes,
  padEdges,
  premultiplyPixels,
  regionPageRect,
  trimLimits,
} from "@openbone/core";
import { type AtlasResample, type Ctx2D, drawAtlasPage, drawRegionFromPage } from "./index.ts";

/** A canvas this module can draw into (browser HTMLCanvasElement / OffscreenCanvas or @napi-rs/canvas). */
export interface AtlasCanvas {
  width: number;
  height: number;
  getContext(id: "2d"): unknown;
}

/** What packing needs from its environment: canvases, image loading and a PNG encoder. */
export interface AtlasEnv {
  createCanvas(width: number, height: number): AtlasCanvas;
  /** Load an image or atlas page src (data: URI, path or URL). */
  load(src: string, name: string): Promise<CanvasImageSource>;
  /** Encode straight RGBA bytes (stored exactly, so premultiplied pixels survive) as a PNG file. */
  encodePng(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array>;
  /** Encode opaque RGBA bytes (alpha is always 255) as a JPEG file, quality 1–100. Needed only for JPEG pages. */
  encodeJpeg?(rgba: Uint8ClampedArray, width: number, height: number, quality: number): Promise<Uint8Array>;
}

export interface BuildAtlasOptions extends AtlasLayoutOptions {
  /** Shrink only as much as needed to fit one page (ignores `scale`). */
  autoScale?: boolean;
  minScale?: number;
  /** Outline polygon corners (polygon packing). Default 8. */
  maxPolygonVertices?: number;
  /** Pixels at or below this alpha (0–255) count as transparent for whitespace stripping, polygons and blank images. Default 0. */
  alphaThreshold?: number;
  /** Repeat each image's edge pixels into half its padding. Default true. */
  edgePadding?: boolean;
  /** With edge padding, copy opaque edge pixels opaque too (hard edges like a loose texture). Default true. */
  duplicatePadding?: boolean;
  /** Give fully transparent pixels the colour of the nearest visible pixel (alpha stays 0). Default: on unless `premultipliedAlpha`. */
  bleed?: boolean;
  /** Draw a magenta outline around every packed region (for checking a pack). Default false. */
  debug?: boolean;
  /** Page image format. JPEG pages are opaque (transparency is lost; a warning says so). Default "png". */
  pageFormat?: "png" | "jpeg";
  /** JPEG quality 1–100. Default 90. */
  jpegQuality?: number;
  /** How images are resampled when stored at another scale. Default "bilinear". */
  resample?: AtlasResample;
}

/** One entry of a multi-scale pack: the scale images are stored at and the suffix its files get ("" for the first). */
export interface AtlasScaleVariant {
  scale: number;
  suffix: string;
}

export interface BuiltAtlas {
  atlas: AtlasData;
  /** Scale the images were stored at (1 = full size). */
  scale: number;
  /** Things worth telling the user, e.g. that JPEG pages dropped transparency. */
  warnings: string[];
}

const ctx2d = (c: AtlasCanvas) => c.getContext("2d") as Ctx2D;

function base64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Images a particle emitter draws as its look: they render from a plain page rectangle, so they never rotate. */
export function particleImages(doc: OpenBoneDocument): Set<string> {
  const out = new Set<string>();
  for (const skin of doc.skeleton.skins)
    for (const atts of Object.values(skin.attachments)) for (const a of Object.values(atts)) if (a.type === "particles" && a.image) out.add(a.image);
  return out;
}

/** Images of a document loaded and measured once, ready to lay out at any scale. */
export interface AtlasSources {
  sources: Map<string, CanvasImageSource>;
  sized: AtlasImage[];
  noRotate: Set<string>;
}

/**
 * Load every image of `doc` (cutting packed ones back out of their pages) and measure it at layout size: visible
 * bounds and outline (with `stripWhitespace` / `polygons`, at `alphaThreshold`), whether it is blank, and which
 * earlier image has exactly the same packed pixels (aliases).
 */
export async function loadAtlasSources(doc: OpenBoneDocument, opts: BuildAtlasOptions, env: AtlasEnv): Promise<AtlasSources> {
  const pagePixels = new Map<string, Promise<CanvasImageSource>>();
  const sources = new Map<string, CanvasImageSource>();
  const sized: AtlasImage[] = [];
  const limits = trimLimits(doc);
  const alias = opts.alias ?? true;
  const measure = !!(opts.stripWhitespace || opts.polygons) || alias || (opts.ignoreBlank ?? true);
  /** Pixel hash → images with those exact pixels (bytes kept to rule out hash collisions). */
  const seen = new Map<string, { id: string; px: Uint8ClampedArray }[]>();
  for (const img of doc.images) {
    let src: CanvasImageSource;
    let w = img.width;
    let h = img.height;
    if (img.src) src = await env.load(img.src, img.name);
    else {
      const hit = atlasRegion(doc, img.id);
      if (!hit) throw new Error(`Image "${img.name}" has no pixels`);
      const { region: r, page } = hit;
      if (r.empty) {
        // A blank image: nothing to cut out, only its size to keep.
        src = env.createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))) as unknown as CanvasImageSource;
      } else {
        if (!pagePixels.has(page.id)) pagePixels.set(page.id, env.load(page.src, page.name));
        const el = await pagePixels.get(page.id)!;
        // Packed images were cut out at their stored size: lay out from that.
        w = r.originalWidth;
        h = r.originalHeight;
        const c = env.createCanvas(w, h);
        drawRegionFromPage(ctx2d(c), el, r, !!doc.atlas?.premultipliedAlpha);
        src = c as unknown as CanvasImageSource;
      }
    }
    sources.set(img.id, src);
    let extra: Pick<AtlasImage, "trim" | "polygon" | "blank" | "alias"> = {};
    if (measure) {
      // Measure at layout size (the source may be stored at another resolution).
      const c = env.createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
      const g = ctx2d(c);
      g.drawImage(src, 0, 0, c.width, c.height);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      extra = analyzeImageAlpha(px, c.width, c.height, {
        stripWhitespace: opts.stripWhitespace,
        polygons: opts.polygons,
        limit: limits.get(img.id),
        maxVertices: opts.maxPolygonVertices,
        threshold: opts.alphaThreshold,
      });
      if (alias && !extra.blank) {
        const t = extra.trim ?? { x: 0, y: 0, width: c.width, height: c.height };
        const hash = hashPixels(px, c.width, t.x, t.y, t.width, t.height);
        const part = cropPixels(px, c.width, t.x, t.y, t.width, t.height);
        const list = seen.get(hash) ?? [];
        const same = list.find((o) => o.px.length === part.length && o.px.every((v, i) => v === part[i]));
        if (same) extra.alias = same.id;
        else {
          list.push({ id: img.id, px: part });
          seen.set(hash, list);
          extra.alias = img.id;
        }
      }
    }
    sized.push({ id: img.id, width: w, height: h, ...extra });
  }
  return { sources, sized, noRotate: new Set<string>([...(opts.noRotate ?? []), ...particleImages(doc)]) };
}

/** Lay out prepared images and compose the page pixels (bleed, edge padding, debug outlines, PMA, PNG or JPEG). */
export async function composeAtlas(src: AtlasSources, opts: BuildAtlasOptions, env: AtlasEnv): Promise<BuiltAtlas> {
  const layout = { ...opts, noRotate: src.noRotate };
  let atlas: AtlasData;
  let scale = 1;
  if (opts.autoScale) ({ atlas, scale } = layoutAtlasFit(src.sized, layout));
  else {
    atlas = layoutAtlas(src.sized, layout);
    scale = atlas.scale ?? 1;
  }
  const warnings: string[] = [];
  const jpeg = opts.pageFormat === "jpeg";
  if (jpeg && !env.encodeJpeg) throw new Error("JPEG pages are not supported here");
  const bleed = opts.bleed ?? !opts.premultipliedAlpha;
  const edge = opts.edgePadding ?? true;
  const dup = opts.duplicatePadding ?? true;
  const e = edge ? Math.floor(atlas.padding / 2) : 0;
  let lostAlpha = false;
  for (const page of atlas.pages) {
    const c = env.createCanvas(page.width, page.height);
    const g = ctx2d(c);
    const missing = drawAtlasPage(g, atlas, page.id, (id) => src.sources.get(id), { extrude: 0, resample: opts.resample });
    if (missing.length) throw new Error(`Missing image pixels: ${missing.join(", ")}`);
    const px = g.getImageData(0, 0, page.width, page.height).data;
    // One box per stored rect (aliases share theirs; blank regions have none worth touching).
    const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const r of atlas.regions) if (r.page === page.id && !r.empty) boxes.set(`${r.x},${r.y}`, regionPageRect(r));
    // Bleed works on canvas-read bytes: a canvas can't hold colour under alpha 0, so this must happen here.
    if (bleed) for (const b of boxes.values()) bleedPixels(px, page.width, b);
    for (const b of boxes.values()) padEdges(px, page.width, page.height, b, e, dup);
    if (jpeg && !lostAlpha)
      for (const b of boxes.values()) {
        for (let y = b.y; y < b.y + b.height && !lostAlpha; y++)
          for (let x = b.x; x < b.x + b.width; x++)
            if (px[(y * page.width + x) * 4 + 3] !== 255) {
              lostAlpha = true;
              break;
            }
        if (lostAlpha) break;
      }
    if (opts.debug) {
      outlineBoxes(px, page.width, page.height, [...boxes.values()]);
      if (atlas.white?.page === page.id) outlineBoxes(px, page.width, page.height, [atlas.white], [0, 255, 255, 255]);
    }
    if (opts.premultipliedAlpha) premultiplyPixels(px);
    if (jpeg) {
      for (let i = 3; i < px.length; i += 4) px[i] = 255;
      const q = Math.max(1, Math.min(100, Math.round(opts.jpegQuality ?? 90)));
      page.src = `data:image/jpeg;base64,${base64(await env.encodeJpeg!(px, page.width, page.height, q))}`;
    } else page.src = `data:image/png;base64,${base64(await env.encodePng(px, page.width, page.height))}`;
  }
  if (lostAlpha) warnings.push("JPEG pages are opaque: the images' transparent pixels are filled in (use PNG to keep transparency)");
  return { atlas, scale, warnings };
}

/**
 * Pack every image of `doc` into atlas pages, the one code path behind the editor's Export dialog, the MCP
 * `pack_atlas` / `export_file` tools and the CLI. Images that already live only in an atlas are cut back out of
 * their page. With `stripWhitespace` each image is packed by its visible bounds (meshes keep everything their uvs
 * cover, particle images stay whole); with `polygons` regions get a convex outline to draw; with
 * `premultipliedAlpha` page pixels are stored as rgb × a; identical images are stored once (`alias`) and blank ones
 * take no space (`ignoreBlank`). Pages come back as PNG (or JPEG) data: URIs, ready for `setAtlas`.
 */
export async function buildAtlas(doc: OpenBoneDocument, opts: BuildAtlasOptions, env: AtlasEnv): Promise<BuiltAtlas> {
  return composeAtlas(await loadAtlasSources(doc, opts, env), opts, env);
}

/** Several scales in one pack: one atlas (with its own pages) per variant, images loaded once. */
export async function buildAtlasScales(doc: OpenBoneDocument, opts: BuildAtlasOptions, variants: AtlasScaleVariant[], env: AtlasEnv): Promise<(BuiltAtlas & { suffix: string })[]> {
  const src = await loadAtlasSources(doc, opts, env);
  const out: (BuiltAtlas & { suffix: string })[] = [];
  for (const v of variants) out.push({ ...(await composeAtlas(src, { ...opts, autoScale: false, scale: v.scale }, env)), suffix: v.suffix });
  return out;
}

/** Parse "1,0.5" and ",@0.5x" into scale variants; missing suffixes default to "" for 1 and "@<scale>x" otherwise. */
export function parseScaleVariants(scales: string | number[], suffixes?: string | string[]): AtlasScaleVariant[] {
  const list = (typeof scales === "string" ? scales.split(",") : scales.map(String)).map((x) => x.trim()).filter((x) => x !== "").map(Number);
  const sfx = typeof suffixes === "string" ? suffixes.split(",") : (suffixes ?? []);
  const out = list.map((scale, i) => {
    if (!(scale > 0 && scale <= 1)) throw new Error(`Scale ${scale} must be above 0 and at most 1`);
    return { scale, suffix: sfx[i] ?? (scale === 1 ? "" : `@${scale}x`) };
  });
  const names = new Set(out.map((v) => v.suffix));
  if (names.size !== out.length) throw new Error("Every scale needs its own suffix");
  return out;
}

/**
 * Texture packer settings as the Export dialog, the CLI and the MCP tools take them (one shape for all three),
 * turned into `BuildAtlasOptions` by `atlasBuildOptions`.
 */
export interface AtlasSettings {
  /** Empty pixels around each image. Default 2. */
  padding?: number;
  /** Largest page width and height (both); `maxWidth` / `maxHeight` override it per axis. Default 2048. */
  maxSize?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Smallest page size. Default 0. */
  minWidth?: number;
  minHeight?: number;
  /** Page sizes are powers of two. Default true. */
  powerOfTwo?: boolean;
  /** Pages are square. Default false. */
  square?: boolean;
  /** Page sizes are multiples of 4. Default false. */
  multipleOf4?: boolean;
  rotate?: boolean;
  /** Store images at this fraction of their size; "auto" shrinks only as much as needed to fit one page. */
  scale?: number | "auto";
  /** Several scales in one pack (atlas exports): one atlas + page set per entry. Overrides `scale`. */
  scales?: AtlasScaleVariant[];
  stripWhitespace?: boolean;
  polygons?: boolean;
  premultipliedAlpha?: boolean;
  /** Store identical images once. Default true. */
  alias?: boolean;
  /** Fully transparent images take no space. Default true. */
  ignoreBlank?: boolean;
  /** 0–255: pixels at or below count as transparent. Default 0. */
  alphaThreshold?: number;
  edgePadding?: boolean;
  duplicatePadding?: boolean;
  bleed?: boolean;
  filterMin?: AtlasData["filterMin"];
  filterMag?: AtlasData["filterMag"];
  wrapX?: AtlasData["wrapX"];
  wrapY?: AtlasData["wrapY"];
  pixelFormat?: AtlasData["pixelFormat"];
  pageFormat?: "png" | "jpeg";
  jpegQuality?: number;
  resample?: AtlasResample;
  debug?: boolean;
}

/** Settings (dialog / CLI / MCP shape) → packer options, applying the defaults. */
export function atlasBuildOptions(s: AtlasSettings = {}): BuildAtlasOptions {
  const max = s.maxSize ?? 2048;
  return {
    padding: s.padding ?? 2,
    maxWidth: s.maxWidth ?? max,
    maxHeight: s.maxHeight ?? max,
    minWidth: s.minWidth ?? 0,
    minHeight: s.minHeight ?? 0,
    powerOfTwo: s.powerOfTwo ?? true,
    square: !!s.square,
    multipleOf4: !!s.multipleOf4,
    allowRotation: !!s.rotate,
    stripWhitespace: !!s.stripWhitespace,
    polygons: !!s.polygons,
    premultipliedAlpha: !!s.premultipliedAlpha,
    alias: s.alias ?? true,
    ignoreBlank: s.ignoreBlank ?? true,
    alphaThreshold: s.alphaThreshold ?? 0,
    edgePadding: s.edgePadding ?? true,
    duplicatePadding: s.duplicatePadding ?? true,
    bleed: s.bleed ?? !s.premultipliedAlpha,
    filterMin: s.filterMin,
    filterMag: s.filterMag,
    wrapX: s.wrapX,
    wrapY: s.wrapY,
    pixelFormat: s.pixelFormat,
    pageFormat: s.pageFormat ?? "png",
    jpegQuality: s.jpegQuality ?? 90,
    resample: s.resample ?? "bilinear",
    debug: !!s.debug,
    ...(s.scale === "auto" ? { autoScale: true } : { scale: s.scale ?? 1 }),
  };
}

/** Short human summary of what a built atlas holds ("2 page(s) 512×512, 256×128 (premultiplied, 3 aliased)"). */
export function describeAtlas(at: AtlasData): string {
  const aliased = at.regions.length - new Set(at.regions.map((r) => `${r.page}:${r.x},${r.y}`)).size - Math.max(0, at.regions.filter((r) => r.empty).length - 1);
  const blank = at.regions.filter((r) => r.empty).length;
  const flags = [
    at.premultipliedAlpha && "premultiplied",
    at.stripWhitespace && "trimmed",
    at.polygons && "polygons",
    at.scale && `${Math.round(at.scale * 100)}%`,
    aliased > 0 && `${aliased} aliased`,
    blank > 0 && `${blank} blank`,
  ].filter(Boolean);
  return `${at.pages.length} page(s) ${at.pages.map((p) => `${p.width}×${p.height}`).join(", ")}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}
