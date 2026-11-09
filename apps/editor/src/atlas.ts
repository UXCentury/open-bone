import { type OpenBoneDocument, applyOp } from "@openbone/core";
import { encodePng } from "@openbone/export";
import { type AtlasCanvas, buildAtlas } from "@openbone/render-canvas";
import { resolveImageUrl } from "./images.ts";

export interface PackSettings {
  padding: number;
  maxSize: number;
  powerOfTwo: boolean;
  /** Turn images 90° when that packs tighter (not images used by particles). */
  rotate?: boolean;
  /** Store images at this fraction of their size; "auto" shrinks until everything fits on one page. */
  scale?: number | "auto";
  /** Pack each image by its visible bounds (whitespace stripping). */
  stripWhitespace?: boolean;
  /** Region attachments draw a tight outline polygon instead of the full quad. */
  polygons?: boolean;
  /** Store page pixels premultiplied (rgb × alpha). */
  premultipliedAlpha?: boolean;
}

export interface PackOutcome {
  doc: OpenBoneDocument;
  pages: { width: number; height: number; src: string }[];
  /** Scale the images were stored at (1 = full size). */
  scale: number;
  /** Regions packed by their visible bounds / drawn with an outline polygon. */
  trimmed: number;
  polygons: number;
}

function load(url: string, name: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`Could not load image "${name}"`));
    img.src = url;
  });
}

/**
 * Pack every image of `doc` into atlas pages (PNG data: URIs) and store them with the `setAtlas` op on a copy.
 * Packed images lose their own src, so the result carries only the pages. Same code path as the MCP server and CLI.
 */
export async function packForExport(doc: OpenBoneDocument, s: PackSettings): Promise<PackOutcome> {
  const d = structuredClone(doc);
  if (!d.images.length) return { doc: d, pages: [], scale: 1, trimmed: 0, polygons: 0 };
  const { atlas, scale } = await buildAtlas(
    d,
    {
      padding: s.padding,
      maxWidth: s.maxSize,
      maxHeight: s.maxSize,
      powerOfTwo: s.powerOfTwo,
      allowRotation: !!s.rotate,
      stripWhitespace: !!s.stripWhitespace,
      polygons: !!s.polygons,
      premultipliedAlpha: !!s.premultipliedAlpha,
      ...(s.scale === "auto" ? { autoScale: true } : { scale: s.scale ?? 1 }),
    },
    {
      createCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }) as AtlasCanvas,
      load: (src, name) => load(resolveImageUrl({ id: "", name, src, width: 0, height: 0 }), name),
      encodePng: (data, width, height) => encodePng({ width, height, data }),
    },
  );
  applyOp(d, "setAtlas", { atlas, stripImageSources: true });
  const regions = d.atlas?.regions ?? [];
  return {
    doc: d,
    pages: atlas.pages.map((p) => ({ width: p.width, height: p.height, src: p.src })),
    scale,
    trimmed: regions.filter((r) => r.width !== r.originalWidth || r.height !== r.originalHeight).length,
    polygons: regions.filter((r) => r.polygon).length,
  };
}
