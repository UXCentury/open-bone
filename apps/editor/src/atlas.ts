import { type AtlasData, type ImageAsset, type OpenBoneDocument, applyOp, atlasRegion, layoutAtlas, layoutAtlasFit } from "@openbone/core";
import { drawAtlasPage, drawRegionFromPage } from "@openbone/render-canvas";
import { resolveImageUrl } from "./images.ts";

export interface PackSettings {
  padding: number;
  maxSize: number;
  powerOfTwo: boolean;
  /** Turn images 90° when that packs tighter (not images used by particles). */
  rotate?: boolean;
  /** Store images at this fraction of their size; "auto" shrinks until everything fits on one page. */
  scale?: number | "auto";
}

/** Images a particle emitter draws as its look: they render from a plain page rectangle, so they never rotate. */
function particleImages(d: OpenBoneDocument): Set<string> {
  const out = new Set<string>();
  for (const skin of d.skeleton.skins)
    for (const atts of Object.values(skin.attachments))
      for (const a of Object.values(atts)) if (a.type === "particles" && a.image) out.add(a.image);
  return out;
}

export interface PackOutcome {
  doc: OpenBoneDocument;
  pages: { width: number; height: number; src: string }[];
  /** Scale the images were stored at (1 = full size). */
  scale: number;
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
  drawRegionFromPage(c.getContext("2d")!, el, r);
  return c;
}

/**
 * Pack every image of `doc` into atlas pages (PNG data: URIs) and store them with the `setAtlas` op on a copy.
 * Packed images lose their own src, so the result carries only the pages.
 */
export async function packForExport(doc: OpenBoneDocument, s: PackSettings): Promise<PackOutcome> {
  const d = structuredClone(doc);
  if (!d.images.length) return { doc: d, pages: [], scale: 1 };
  const pageCache = new Map<string, Promise<HTMLImageElement>>();
  const sources = new Map<string, CanvasImageSource>();
  await Promise.all(d.images.map(async (img) => sources.set(img.id, await source(d, img, pageCache))));
  const layout = { padding: s.padding, maxWidth: s.maxSize, maxHeight: s.maxSize, powerOfTwo: s.powerOfTwo, allowRotation: !!s.rotate, noRotate: particleImages(d) };
  // Packed images are cut back out at their stored (possibly scaled) size: lay out from what is really there.
  const sized = d.images.map((img) => {
    const hit = !img.src ? atlasRegion(d, img.id) : null;
    return hit ? { id: img.id, width: hit.region.originalWidth, height: hit.region.originalHeight } : img;
  });
  let scale = 1;
  let atlas: AtlasData;
  if (s.scale === "auto") ({ atlas, scale } = layoutAtlasFit(sized, layout));
  else {
    scale = s.scale ?? 1;
    atlas = layoutAtlas(sized, { ...layout, scale });
  }
  for (const page of atlas.pages) {
    const c = document.createElement("canvas");
    c.width = page.width;
    c.height = page.height;
    drawAtlasPage(c.getContext("2d")!, atlas, page.id, (id) => sources.get(id));
    page.src = c.toDataURL("image/png");
  }
  applyOp(d, "setAtlas", { atlas, stripImageSources: true });
  return { doc: d, pages: atlas.pages.map((p) => ({ width: p.width, height: p.height, src: p.src })), scale };
}
