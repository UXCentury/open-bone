import { type OpenBoneDocument, applyOp } from "@openbone/core";
import { encodePng } from "@openbone/export";
import { type AtlasCanvas, type AtlasEnv, type AtlasSettings, atlasBuildOptions, buildAtlas, buildAtlasScales } from "@openbone/render-canvas";
import { resolveImageUrl } from "./images.ts";

/** The Export dialog's texture packer settings (the same shape the CLI and MCP tools take). */
export type PackSettings = AtlasSettings;

export interface PackOutcome {
  doc: OpenBoneDocument;
  pages: { width: number; height: number; src: string }[];
  /** Scale the images were stored at (1 = full size). */
  scale: number;
  /** Regions packed by their visible bounds / drawn with an outline polygon. */
  trimmed: number;
  polygons: number;
  /** Regions sharing another image's rect (identical pixels) / blank images that got no space. */
  aliased: number;
  blank: number;
  warnings: string[];
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

const canvas = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });

const env: AtlasEnv = {
  createCanvas: (w, h) => canvas(w, h) as AtlasCanvas,
  load: (src, name) => load(resolveImageUrl({ id: "", name, src, width: 0, height: 0 }), name),
  encodePng: (data, width, height) => encodePng({ width, height, data }),
  encodeJpeg: async (data, width, height, quality) => {
    const c = canvas(width, height);
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", quality / 100));
    if (!blob) throw new Error("Could not encode a JPEG page");
    return new Uint8Array(await blob.arrayBuffer());
  },
};

function outcome(d: OpenBoneDocument, scale: number, warnings: string[]): PackOutcome {
  const regions = d.atlas?.regions ?? [];
  const blank = regions.filter((r) => r.empty).length;
  const rects = new Set(regions.map((r) => `${r.page}:${r.x},${r.y}`)).size;
  return {
    doc: d,
    pages: (d.atlas?.pages ?? []).map((p) => ({ width: p.width, height: p.height, src: p.src })),
    scale,
    trimmed: regions.filter((r) => !r.empty && (r.width !== r.originalWidth || r.height !== r.originalHeight)).length,
    polygons: regions.filter((r) => r.polygon).length,
    aliased: Math.max(0, regions.length - rects - Math.max(0, blank - 1)),
    blank,
    warnings,
  };
}

/**
 * Pack every image of `doc` into atlas pages (PNG or JPEG data: URIs) and store them with the `setAtlas` op on a
 * copy. Packed images lose their own src, so the result carries only the pages. Same code path as the MCP server and CLI.
 */
export async function packForExport(doc: OpenBoneDocument, s: PackSettings): Promise<PackOutcome> {
  const d = structuredClone(doc);
  if (!d.images.length) return outcome(d, 1, []);
  const { atlas, scale, warnings } = await buildAtlas(d, atlasBuildOptions(s), env);
  applyOp(d, "setAtlas", { atlas, stripImageSources: true });
  return outcome(d, scale, warnings);
}

/** One packed copy per row of `s.scales` (several scales in one pack), each with its file name suffix. */
export async function packScalesForExport(doc: OpenBoneDocument, s: PackSettings): Promise<(PackOutcome & { suffix: string })[]> {
  if (!doc.images.length || !s.scales?.length) return [];
  const built = await buildAtlasScales(doc, atlasBuildOptions(s), s.scales, env);
  return built.map((b) => {
    const d = structuredClone(doc);
    applyOp(d, "setAtlas", { atlas: b.atlas, stripImageSources: true });
    return { ...outcome(d, b.scale, b.warnings), suffix: b.suffix };
  });
}
