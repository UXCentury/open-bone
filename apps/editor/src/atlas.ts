import { type AtlasData, type ImageAsset, type OpenBoneDocument, applyOp, atlasRegion, layoutAtlas } from "@openbone/core";
import { drawAtlasPage } from "@openbone/render-canvas";
import { resolveImageUrl } from "./images.ts";

export interface PackSettings {
  padding: number;
  maxSize: number;
  powerOfTwo: boolean;
}

export interface PackOutcome {
  doc: OpenBoneDocument;
  pages: { width: number; height: number; src: string }[];
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

/** Pixels of an image: its own src, or (already packed, no src) cut back out of its current atlas page. */
async function source(d: OpenBoneDocument, img: ImageAsset, pages: Map<string, Promise<HTMLImageElement>>): Promise<CanvasImageSource> {
  if (img.src) return load(resolveImageUrl(img), img.name);
  const hit = atlasRegion(d, img.id);
  if (!hit) throw new Error(`Image "${img.name}" has no pixels`);
  const { region: r, page } = hit;
  if (!pages.has(page.id)) pages.set(page.id, load(resolveImageUrl(page), page.name));
  const el = await pages.get(page.id)!;
  const c = document.createElement("canvas");
  c.width = r.originalWidth;
  c.height = r.originalHeight;
  c.getContext("2d")!.drawImage(el, r.x, r.y, r.width, r.height, r.offsetX, r.offsetY, r.width, r.height);
  return c;
}

/**
 * Pack every image of `doc` into atlas pages (PNG data: URIs) and store them with the `setAtlas` op on a copy.
 * Packed images lose their own src, so the result carries only the pages.
 */
export async function packForExport(doc: OpenBoneDocument, s: PackSettings): Promise<PackOutcome> {
  const d = structuredClone(doc);
  if (!d.images.length) return { doc: d, pages: [] };
  const pageCache = new Map<string, Promise<HTMLImageElement>>();
  const sources = new Map<string, CanvasImageSource>();
  await Promise.all(d.images.map(async (img) => sources.set(img.id, await source(d, img, pageCache))));
  const atlas: AtlasData = layoutAtlas(d.images, { padding: s.padding, maxWidth: s.maxSize, maxHeight: s.maxSize, powerOfTwo: s.powerOfTwo });
  for (const page of atlas.pages) {
    const c = document.createElement("canvas");
    c.width = page.width;
    c.height = page.height;
    drawAtlasPage(c.getContext("2d")!, atlas, page.id, (id) => sources.get(id));
    page.src = c.toDataURL("image/png");
  }
  applyOp(d, "setAtlas", { atlas, stripImageSources: true });
  return { doc: d, pages: atlas.pages.map((p) => ({ width: p.width, height: p.height, src: p.src })) };
}
