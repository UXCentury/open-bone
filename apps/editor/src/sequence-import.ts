/**
 * Sprite sequence import: numbered image files (After Effects / render output), sprite sheets cut by a grid
 * or described by a TexturePacker / Aseprite "frames" JSON, and ZIP archives of either.
 */
import { type SequenceFrame, gridSheetFrames, groupNumbered, parseSheetJson } from "@openbone/core";
import { importPsd, isPsd } from "./psd-import.ts";
import { readZip } from "@openbone/export";
import type { Skeleton } from "@openbone/runtime";
import { createSignal } from "solid-js";
import { askForm } from "./dialogs.tsx";
import { imageSize, readFileAsDataUrl } from "./images.ts";
import { selectedBoneId, selection, setSelection, skinArg, store, toast, transaction } from "./state.ts";

const IMAGE_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const stem = (name: string) => baseName(name).replace(/\.[^.]+$/, "");
const isImage = (f: File) => f.type.startsWith("image/") || ext(f.name) in IMAGE_EXT;
const isJson = (f: File) => ext(f.name) === "json";
const isZip = (f: File) => ext(f.name) === "zip" || f.type === "application/zip" || f.type === "application/x-zip-compressed";

/** Frame index pinned by the Inspector scrubber, shown in the viewport instead of the playing frame. */
export const [sequencePreview, setSequencePreview] = createSignal<{ slotId: string; attachment: string; frame: number } | null>(null);
/** Frame the viewport drew last for the selected slot's sequence (-1 = hidden or none). */
export const [sequenceShown, setSequenceShown] = createSignal(-1);

/** Viewport hook after posing: apply the pinned frame and report the frame shown for the selected slot. */
export function applySequencePreview(sk: Skeleton) {
  const pin = sequencePreview();
  if (pin) {
    const slot = sk.slotById_(pin.slotId);
    const att = slot && sk.getAttachment(slot, pin.attachment);
    if (slot && att?.type === "sequence") slot.sequenceFrames.set(pin.attachment, pin.frame - att.offset);
  }
  const sel = selection();
  const slot = sel?.kind === "slot" ? sk.slotById_(sel.id) : undefined;
  const att = slot && sk.getAttachment(slot, (sel as { attachment?: string }).attachment ?? slot.attachmentName);
  const shown = slot && att?.type === "sequence" ? sk.sequenceFrame(slot, att) : -1;
  if (shown !== sequenceShown()) setSequenceShown(shown);
}

/** Expand ZIP archives into their image and JSON files (macOS resource forks skipped). */
async function expandZips(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    if (!isZip(f)) {
      out.push(f);
      continue;
    }
    try {
      for (const e of await readZip(new Uint8Array(await f.arrayBuffer()))) {
        const name = baseName(e.name);
        if (e.name.includes("__MACOSX/") || name.startsWith(".")) continue;
        const type = IMAGE_EXT[ext(name)] ?? (ext(name) === "json" ? "application/json" : "");
        if (type) out.push(new File([e.data as BlobPart], name, { type }));
      }
    } catch (err) {
      toast(`${f.name}: ${(err as Error).message}`, "error");
    }
  }
  return out;
}

interface Loaded {
  name: string;
  src: string;
  width: number;
  height: number;
}
async function load(f: File): Promise<Loaded> {
  const src = await readFileAsDataUrl(f);
  const { width, height } = await imageSize(src);
  return { name: stem(f.name), src, width, height };
}

const posNum = (v: string) => (v === "" || (Number.isFinite(Number(v)) && Number(v) > 0) ? null : "Enter a positive number");
const optNum = (v: string) => (v === "" ? undefined : Number(v));

/** Add a slot on the selected bone showing a new sequence. */
function addSequenceSlot(name: string, images: Loaded[], frames: (ids: string[]) => SequenceFrame[], fps: number) {
  transaction(`import sequence ${name}`, () => {
    const ids = images.map((img) => (store.apply("addImage", { name: img.name, src: img.src, width: img.width, height: img.height }) as { id: string }).id);
    const bone = selectedBoneId() ?? store.doc.skeleton.bones[0].id;
    const slot = store.apply("addSlot", { bone, name }) as { id: string };
    store.apply("addSequence", { slot: slot.id, name, frames: frames(ids), fps, ...skinArg() });
    setSelection({ kind: "slot", id: slot.id });
  });
}

async function importNumbered(name: string, files: File[]): Promise<"sequence" | "images" | null> {
  const r = await askForm({
    title: `Import ${files.length} numbered frames`,
    message: `${files[0].name} … ${files[files.length - 1].name}`,
    confirmLabel: "Import",
    fields: [
      {
        key: "as",
        label: "Import as",
        type: "choice",
        options: [
          { value: "sequence", label: "One sequence", description: "Frame-by-frame animation on one slot" },
          { value: "images", label: "Separate images", description: "One slot per image" },
        ],
      },
      { key: "name", label: "Name", type: "text", value: name },
      { key: "fps", label: "Frames per second", type: "text", value: "24", validate: posNum },
    ],
  });
  if (!r) return null;
  if (r.as === "images") return "images";
  const images = await Promise.all(files.map(load));
  addSequenceSlot(r.name, images, (ids) => ids.map((image) => ({ image })), Number(r.fps) || 24);
  return "sequence";
}

/** Ask for a grid over a sprite sheet image and add it as a sequence. */
export async function importGridSheet(file: File) {
  const img = await load(file);
  const r = await askForm({
    title: `Sprite sheet “${img.name}” (${img.width}×${img.height})`,
    message: "Cut the sheet into equal frames, row by row. Give columns and rows, or the frame size; leave the rest empty.",
    confirmLabel: "Import",
    fields: [
      { key: "cols", label: "Columns", type: "text", value: "", required: false, validate: posNum },
      { key: "rows", label: "Rows", type: "text", value: "", required: false, validate: posNum },
      { key: "frameWidth", label: "Frame width (px)", type: "text", value: "", required: false, validate: posNum },
      { key: "frameHeight", label: "Frame height (px)", type: "text", value: "", required: false, validate: posNum },
      { key: "padding", label: "Padding between frames (px)", type: "text", value: "0", required: false },
      { key: "margin", label: "Margin around the grid (px)", type: "text", value: "0", required: false },
      { key: "count", label: "Frame count (empty = all cells)", type: "text", value: "", required: false, validate: posNum },
      { key: "fps", label: "Frames per second", type: "text", value: "24", validate: posNum },
    ],
  });
  if (!r) return;
  let cells;
  try {
    const cols = optNum(r.cols);
    const rows = optNum(r.rows);
    if (cols === undefined && rows === undefined && !r.frameWidth && !r.frameHeight) throw new Error("Give columns and rows, or a frame size");
    cells = gridSheetFrames({
      imageWidth: img.width,
      imageHeight: img.height,
      cols,
      rows,
      frameWidth: optNum(r.frameWidth),
      frameHeight: optNum(r.frameHeight),
      padding: Number(r.padding) || 0,
      margin: Number(r.margin) || 0,
      count: optNum(r.count),
    });
  } catch (e) {
    return toast((e as Error).message, "error");
  }
  addSequenceSlot(img.name, [img], ([id]) => cells.map((c) => ({ image: id, rect: c.rect })), Number(r.fps) || 24);
}

/** Import a sheet described by a "frames" JSON; its image is matched by meta.image, the JSON's name, or is the only image. */
async function importJsonSheet(json: File, images: File[]): Promise<File | null> {
  let sheet;
  try {
    sheet = parseSheetJson(await json.text());
  } catch (e) {
    toast(`${json.name}: ${(e as Error).message}`, "error");
    return null;
  }
  const want = sheet.image ? baseName(sheet.image).toLowerCase() : null;
  const file =
    images.find((f) => f.name.toLowerCase() === want) ??
    images.find((f) => stem(f.name).toLowerCase() === stem(json.name).toLowerCase()) ??
    (images.length === 1 ? images[0] : undefined);
  if (!file) {
    toast(`${json.name}: drop or select its sheet image${sheet.image ? ` (${sheet.image})` : ""} together with the JSON`, "error");
    return null;
  }
  const img = await load(file);
  const fps = sheet.fps ?? 24;
  addSequenceSlot(stem(json.name), [img], ([id]) => sheet.frames.map((f) => ({ image: id, rect: f.rect, ...(f.trim ? { trim: f.trim } : {}) })), fps);
  toast(`Imported ${sheet.frames.length} frames from ${json.name}`);
  return file;
}

/**
 * Import dropped or selected files. Sheet JSONs take their image; numbered images become one sequence (after
 * asking); other images are handed to `single` (regular image import), or, with `sheet`, cut as a grid sheet.
 */
export async function importFiles(input: FileList | File[], single: (files: File[]) => Promise<void>, opts: { sheet?: boolean } = {}) {
  const all = await expandZips(Array.from(input));
  // Photoshop files become layered rigs (one slot per layer).
  for (const psd of all.filter(isPsd)) await importPsd(psd);
  const files = all.filter((f) => !isPsd(f));
  let images = files.filter(isImage);
  for (const json of files.filter(isJson)) {
    const used = await importJsonSheet(json, images);
    if (used) images = images.filter((f) => f !== used);
  }
  const loose: File[] = [];
  for (const g of groupNumbered(images, (f) => f.name)) {
    if (!g.sequence) {
      loose.push(...g.items);
      continue;
    }
    const r = await importNumbered(g.name, g.items);
    if (r === "images") loose.push(...g.items);
  }
  if (!loose.length) return;
  if (opts.sheet) for (const f of loose) await importGridSheet(f);
  else await single(loose);
}
