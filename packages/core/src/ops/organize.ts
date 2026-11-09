import { z } from "zod";
import { get } from "../document.ts";
import { type FolderKind, folderItems, inFolder, normalizeFolder, renamedFolder } from "../folders.ts";
import type { OpenBoneDocument } from "../types.ts";
import { defineOp, ref } from "./registry.ts";

const kind = z
  .enum(["slot", "skin", "animation", "event", "constraint", "stateMachine"])
  .describe("What the items are (constraint = IK, transform, path, physics constraints and sliders)");

function setOrClear(item: { folder?: string }, folder: string | undefined) {
  if (folder) item.folder = folder;
  else delete item.folder;
}

function resolveItem(doc: OpenBoneDocument, k: FolderKind, r: string) {
  const list = folderItems(doc, k);
  const it = list.find((x) => x.id === r) ?? list.find((x) => x.name === r);
  if (!it) throw new Error(`${k} "${r}" not found. Available: ${list.map((x) => x.name).slice(0, 30).join(", ") || "(none)"}`);
  return it;
}

defineOp({
  name: "setFolder",
  group: "project",
  description:
    'Put slots, skins, animations, events, constraints or state machines in a folder ("body/arms"; null or "" = top level). Folders only organise the editor lists and tree: they never change drawing, posing or exports.',
  schema: z.object({
    kind,
    items: z.array(ref("Item")).min(1),
    folder: z.string().nullable().describe('Folder path, "/" between levels; null or "" for the top level'),
  }),
  apply(doc, a) {
    const folder = normalizeFolder(a.folder);
    const items = a.items.map((r) => resolveItem(doc, a.kind, r));
    for (const it of items) setOrClear(it, folder);
    return { folder: folder ?? null, items: items.length };
  },
});

defineOp({
  name: "renameFolder",
  group: "project",
  description:
    'Rename or move a folder with everything in it, sub-folders included ("body/arms" → "limbs"). `to` null or "" deletes the folder level: its items and sub-folders move up into the parent. For slots, `bone` limits it to the slots of one bone.',
  schema: z.object({
    kind,
    from: z.string().min(1).describe("Current folder path"),
    to: z.string().nullable().describe('New path; null or "" removes this level (contents move to the parent folder)'),
    bone: ref("Bone").optional().describe("Slots only: only the slots on this bone"),
  }),
  apply(doc, a) {
    const from = normalizeFolder(a.from);
    if (!from) throw new Error("`from` must name a folder");
    let to = normalizeFolder(a.to);
    // Deleting a nested folder moves its contents into the parent, not to the top.
    if (a.to == null || a.to.trim() === "") to = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : undefined;
    const bone = a.bone ? get.bone(doc, a.bone).id : undefined;
    if (bone && a.kind !== "slot") throw new Error("`bone` only applies to slots");
    let items = folderItems(doc, a.kind).filter((it) => inFolder(it.folder, from));
    if (bone) items = items.filter((it) => (it as { bone?: string }).bone === bone);
    if (!items.length) throw new Error(`Folder "${from}" has no ${a.kind}s in it`);
    for (const it of items) setOrClear(it, renamedFolder(it.folder, from, to));
    return { items: items.length, to: to ?? null };
  },
});
