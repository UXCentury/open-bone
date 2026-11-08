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
          if ((att.type === "region" || att.type === "mesh") && att.image === img.id)
            throw new Error(`Image is used by attachment "${att.name}"`);
    doc.images = doc.images.filter((i) => i !== img);
    return {};
  },
});
