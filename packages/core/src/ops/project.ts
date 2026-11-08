import { z } from "zod";
import { newId } from "../document.ts";
import { get } from "../document.ts";
import { defineOp, hex, optId, ref } from "./registry.ts";

defineOp({
  name: "setDocument",
  group: "project",
  description: "Change document settings: name, artboard size, skeleton origin within the artboard (pixels, y-down), background, fps.",
  schema: z.object({
    name: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    originX: z.number().optional(),
    originY: z.number().optional(),
    background: hex.nullable().optional(),
    fps: z.number().positive().optional(),
  }),
  apply(doc, a) {
    for (const [k, v] of Object.entries(a)) if (v !== undefined) (doc as unknown as Record<string, unknown>)[k] = v;
    return {};
  },
});

defineOp({
  name: "addImage",
  group: "project",
  description: "Register an image asset (PNG/JPG/WebP as a data: URI, URL, or path relative to the project file).",
  schema: z.object({
    id: optId,
    name: z.string(),
    src: z.string(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  apply(doc, a) {
    const id = (a.id ??= newId("img"));
    doc.images.push({ id, name: a.name, src: a.src, width: a.width, height: a.height });
    return { id };
  },
});

defineOp({
  name: "deleteImage",
  group: "project",
  description: "Remove an image asset. Fails if attachments still use it.",
  schema: z.object({ image: ref("Image") }),
  apply(doc, a) {
    const img = get.image(doc, a.image);
    for (const skin of doc.skeleton.skins)
      for (const atts of Object.values(skin.attachments))
        for (const att of Object.values(atts))
          if ((att.type === "region" || att.type === "mesh" || att.type === "particles") && att.image === img.id)
            throw new Error(`Image is used by attachment "${att.name}"`);
    doc.images = doc.images.filter((i) => i !== img);
    // The atlas is shared with undo snapshots: replace, don't mutate.
    if (doc.atlas) doc.atlas = { ...doc.atlas, regions: doc.atlas.regions.filter((r) => r.image !== img.id) };
    return {};
  },
});

const px = z.number().int().min(0);
const atlasRegionSchema = z.object({
  image: ref("Image"),
  page: z.string().min(1).describe("Atlas page id"),
  x: px.describe("Packed rect left, page pixels (y-down)"),
  y: px.describe("Packed rect top, page pixels (y-down)"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  offsetX: px.default(0).describe("Where the packed rect starts inside the original image (trim offset, y-down)"),
  offsetY: px.default(0),
  originalWidth: z.number().positive().optional().describe("Original image width (default: the image asset's width)"),
  originalHeight: z.number().positive().optional(),
});

defineOp({
  name: "setAtlas",
  group: "project",
  description:
    "Store a texture atlas: packed pages (images, usually PNG data: URIs) and, per image, the rectangle it occupies in a page. Packed images are drawn from their page, so the WebGL renderer batches them into one draw call. Optional `white` is a solid white block in a page that untextured shapes sample from. Pass `atlas: null` to remove the atlas. With `stripImageSources`, packed images lose their own src (the file then only carries the pages).",
  schema: z.object({
    atlas: z
      .object({
        pages: z
          .array(z.object({ id: z.string().min(1), name: z.string().default(""), src: z.string().min(1), width: z.number().int().positive(), height: z.number().int().positive() }))
          .min(1),
        regions: z.array(atlasRegionSchema),
        white: z.object({ page: z.string().min(1), x: px, y: px, width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
        padding: z.number().int().min(0).default(0),
      })
      .nullable(),
    stripImageSources: z.boolean().default(false),
  }),
  apply(doc, a) {
    if (!a.atlas) {
      if (doc.atlas && doc.images.some((i) => !i.src)) throw new Error("Some images exist only in the atlas (empty src); restore their src first");
      delete doc.atlas;
      return {};
    }
    const pages = new Map<string, { width: number; height: number }>();
    for (const p of a.atlas.pages) {
      if (pages.has(p.id)) throw new Error(`Duplicate atlas page id "${p.id}"`);
      if (doc.images.some((i) => i.id === p.id)) throw new Error(`Atlas page id "${p.id}" is already an image id`);
      pages.set(p.id, p);
    }
    const inPage = (where: string, r: { page: string; x: number; y: number; width: number; height: number }) => {
      const p = pages.get(r.page);
      if (!p) throw new Error(`${where}: unknown atlas page "${r.page}"`);
      if (r.x + r.width > p.width || r.y + r.height > p.height) throw new Error(`${where}: rect lies outside page "${r.page}" (${p.width}x${p.height})`);
    };
    const seen = new Set<string>();
    const regions = a.atlas.regions.map((r) => {
      const img = get.image(doc, r.image);
      if (seen.has(img.id)) throw new Error(`Image "${img.name}" has two atlas regions`);
      seen.add(img.id);
      inPage(`Region of "${img.name}"`, r);
      const originalWidth = r.originalWidth ?? img.width;
      const originalHeight = r.originalHeight ?? img.height;
      if (r.offsetX + r.width > originalWidth + 1e-6 || r.offsetY + r.height > originalHeight + 1e-6)
        throw new Error(`Region of "${img.name}": offset + size exceeds the original ${originalWidth}x${originalHeight}`);
      return { ...r, image: img.id, originalWidth, originalHeight };
    });
    if (a.atlas.white) inPage("White block", a.atlas.white);
    const missing = doc.images.filter((i) => !i.src && !seen.has(i.id));
    if (missing.length) throw new Error(`Images without a src need an atlas region: ${missing.map((i) => i.name).join(", ")}`);
    doc.atlas = {
      pages: a.atlas.pages.map((p) => ({ ...p, name: p.name || p.id })),
      regions,
      ...(a.atlas.white ? { white: a.atlas.white } : {}),
      padding: a.atlas.padding,
    };
    // Image assets are shared between undo snapshots, so replace them instead of mutating.
    if (a.stripImageSources) doc.images = doc.images.map((img) => (seen.has(img.id) ? { ...img, src: "" } : img));
    return { pages: doc.atlas.pages.length, regions: regions.length };
  },
});
