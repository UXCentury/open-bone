import {
  type AtlasData,
  type AtlasImage,
  type AtlasLayoutOptions,
  type OpenBoneDocument,
  analyzeImageAlpha,
  atlasRegion,
  layoutAtlas,
  layoutAtlasFit,
  premultiplyPixels,
  trimLimits,
} from "@openbone/core";
import { type Ctx2D, drawAtlasPage, drawRegionFromPage } from "./index.ts";

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
}

export interface BuildAtlasOptions extends AtlasLayoutOptions {
  /** Shrink only as much as needed to fit one page (ignores `scale`). */
  autoScale?: boolean;
  minScale?: number;
  /** Outline polygon corners (polygon packing). Default 8. */
  maxPolygonVertices?: number;
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

/**
 * Pack every image of `doc` into atlas pages, the one code path behind the editor's Export dialog, the MCP
 * `pack_atlas` / `export_file` tools and the CLI. Images that already live only in an atlas are cut back out of
 * their page. With `stripWhitespace` each image is packed by its visible bounds (meshes keep everything their uvs
 * cover, particle images stay whole); with `polygons` regions get a convex outline to draw; with
 * `premultipliedAlpha` page pixels are stored as rgb × a. Pages come back as PNG data: URIs, ready for `setAtlas`.
 */
export async function buildAtlas(doc: OpenBoneDocument, opts: BuildAtlasOptions, env: AtlasEnv): Promise<{ atlas: AtlasData; scale: number }> {
  const pagePixels = new Map<string, Promise<CanvasImageSource>>();
  const sources = new Map<string, CanvasImageSource>();
  const sized: AtlasImage[] = [];
  const limits = trimLimits(doc);
  const analyze = !!(opts.stripWhitespace || opts.polygons);
  for (const img of doc.images) {
    let src: CanvasImageSource;
    let w = img.width;
    let h = img.height;
    if (img.src) src = await env.load(img.src, img.name);
    else {
      const hit = atlasRegion(doc, img.id);
      if (!hit) throw new Error(`Image "${img.name}" has no pixels`);
      const { region: r, page } = hit;
      if (!pagePixels.has(page.id)) pagePixels.set(page.id, env.load(page.src, page.name));
      const el = await pagePixels.get(page.id)!;
      // Packed images were cut out at their stored size: lay out from that.
      w = r.originalWidth;
      h = r.originalHeight;
      const c = env.createCanvas(w, h);
      drawRegionFromPage(ctx2d(c), el, r, !!doc.atlas?.premultipliedAlpha);
      src = c as unknown as CanvasImageSource;
    }
    sources.set(img.id, src);
    let extra: Pick<AtlasImage, "trim" | "polygon"> = {};
    if (analyze) {
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
      });
    }
    sized.push({ id: img.id, width: w, height: h, ...extra });
  }
  const noRotate = new Set<string>([...(opts.noRotate ?? []), ...particleImages(doc)]);
  const layout = { ...opts, noRotate };
  let atlas: AtlasData;
  let scale = 1;
  if (opts.autoScale) ({ atlas, scale } = layoutAtlasFit(sized, layout));
  else {
    atlas = layoutAtlas(sized, layout);
    scale = atlas.scale ?? 1;
  }
  for (const page of atlas.pages) {
    const c = env.createCanvas(page.width, page.height);
    const g = ctx2d(c);
    const missing = drawAtlasPage(g, atlas, page.id, (id) => sources.get(id));
    if (missing.length) throw new Error(`Missing image pixels: ${missing.join(", ")}`);
    const px = g.getImageData(0, 0, page.width, page.height).data;
    if (opts.premultipliedAlpha) premultiplyPixels(px);
    page.src = `data:image/png;base64,${base64(await env.encodePng(px, page.width, page.height))}`;
  }
  return { atlas, scale };
}
