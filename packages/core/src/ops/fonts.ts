import { z } from "zod";
import { RefError, newId } from "../document.ts";
import type { FontAsset, OpenBoneDocument } from "../types.ts";
import { defineOp, optId, ref } from "./registry.ts";

function needFont(d: OpenBoneDocument, r: string): FontAsset {
  const f = (d.fonts ?? []).find((x) => x.id === r) ?? (d.fonts ?? []).find((x) => x.name === r);
  if (!f) throw new RefError(`Font "${r}" not found. Available: ${(d.fonts ?? []).map((x) => x.name).join(", ") || "(none)"}`);
  return f;
}

const weight = z.number().int().min(100).max(1000).describe("CSS weight of the file's face (400 regular, 700 bold)");
const style = z.enum(["normal", "italic"]);

defineOp({
  name: "addFont",
  group: "project",
  description:
    "Add a font file (TTF/OTF; WOFF/WOFF2 work on the web only) as a data: URI or a path relative to the project. Text attachments whose font list names `family` use it (the face whose weight is closest to theirs) before any installed font, in the editor and every runtime.",
  schema: z.object({
    id: optId,
    name: z.string().min(1).describe("Asset name (usually the file name)"),
    family: z.string().min(1).describe('Family name texts use in their font list, e.g. "Noto Serif JP"'),
    src: z.string().min(1).describe("data: URI, relative path or URL"),
    weight: weight.default(400),
    style: style.default("normal"),
  }),
  apply(doc, a) {
    doc.fonts ??= [];
    if (doc.fonts.some((x) => x.name === a.name)) throw new Error(`Font "${a.name}" already exists`);
    const id = (a.id ??= newId("fnt"));
    doc.fonts.push({ id, name: a.name, family: a.family.trim(), src: a.src, weight: a.weight, style: a.style });
    return { id };
  },
});

defineOp({
  name: "updateFont",
  group: "project",
  description: "Rename a font asset, change its family, weight or style, or replace its file.",
  schema: z.object({
    font: ref("Font"),
    name: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    src: z.string().min(1).optional(),
    weight: weight.optional(),
    style: style.optional(),
  }),
  apply(doc, a) {
    const old = needFont(doc, a.font);
    if (a.name && a.name !== old.name && doc.fonts!.some((x) => x.name === a.name)) throw new Error(`Font "${a.name}" already exists`);
    // Assets are shared between undo snapshots: replace, never mutate.
    const next: FontAsset = {
      ...old,
      ...(a.name ? { name: a.name } : {}),
      ...(a.family ? { family: a.family.trim() } : {}),
      ...(a.src ? { src: a.src } : {}),
      ...(a.weight !== undefined ? { weight: a.weight } : {}),
      ...(a.style ? { style: a.style } : {}),
    };
    doc.fonts = doc.fonts!.map((x) => (x === old ? next : x));
    return {};
  },
});

defineOp({
  name: "deleteFont",
  group: "project",
  description: "Delete a font asset. Texts that used its family fall back to installed fonts.",
  schema: z.object({ font: ref("Font") }),
  apply(doc, a) {
    const f = needFont(doc, a.font);
    doc.fonts = doc.fonts!.filter((x) => x !== f);
    if (!doc.fonts.length) delete doc.fonts;
    return {};
  },
});
