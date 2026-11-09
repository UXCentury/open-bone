import { apply as applyM, invert, setupWorld } from "@openbone/core";
import { askForm } from "./dialogs.tsx";
import { selectedBoneId, setSelection, store, toast, transaction } from "./state.ts";

/**
 * Photoshop import (Spine users get this from its PSD script): every layer becomes an image, a slot and a region
 * placed where it sits on the canvas, in the same stacking order. Groups can become bones, so a layered character
 * arrives ready to rig. Opacity and the common blend modes carry over; hidden layers can be skipped.
 */

export const isPsd = (f: File) => /\.psd$/i.test(f.name) || f.type === "image/vnd.adobe.photoshop";

type PsdLayer = {
  name?: string;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  canvas?: HTMLCanvasElement;
  children?: PsdLayer[];
};

const BLEND: Record<string, "normal" | "additive" | "multiply" | "screen"> = {
  multiply: "multiply",
  screen: "screen",
  "linear dodge": "additive",
  "color dodge": "additive",
  lighten: "screen",
};

/** Bounds of a layer or group's visible pixels in canvas pixels (y down). */
function bounds(l: PsdLayer, includeHidden: boolean): { left: number; top: number; right: number; bottom: number } | null {
  if (l.children) {
    let out: { left: number; top: number; right: number; bottom: number } | null = null;
    for (const c of l.children) {
      if (c.hidden && !includeHidden) continue;
      const b = bounds(c, includeHidden);
      if (!b) continue;
      out = out ? { left: Math.min(out.left, b.left), top: Math.min(out.top, b.top), right: Math.max(out.right, b.right), bottom: Math.max(out.bottom, b.bottom) } : b;
    }
    return out;
  }
  if (!l.canvas || l.right === undefined || l.bottom === undefined || (l.right ?? 0) <= (l.left ?? 0) || (l.bottom ?? 0) <= (l.top ?? 0)) return null;
  return { left: l.left ?? 0, top: l.top ?? 0, right: l.right, bottom: l.bottom };
}

function countLayers(ls: PsdLayer[], includeHidden: boolean): { layers: number; groups: number; hidden: number } {
  let layers = 0;
  let groups = 0;
  let hidden = 0;
  for (const l of ls) {
    if (l.hidden) hidden++;
    if (l.hidden && !includeHidden) continue;
    if (l.children) {
      groups++;
      const c = countLayers(l.children, includeHidden);
      layers += c.layers;
      groups += c.groups;
      hidden += c.hidden;
    } else if (l.canvas) layers++;
  }
  return { layers, groups, hidden };
}

export async function importPsd(file: File) {
  let psd: { width: number; height: number; children?: PsdLayer[] };
  try {
    const { readPsd } = await import("ag-psd");
    psd = readPsd(await file.arrayBuffer(), { skipCompositeImageData: true, skipThumbnail: true, useImageData: false }) as typeof psd;
  } catch (e) {
    toast(`Could not read ${file.name}: ${(e as Error).message}`, "error");
    return;
  }
  const top = psd.children ?? [];
  const all = countLayers(top, true);
  if (!all.layers) return toast(`${file.name} has no pixel layers to import`, "error");
  const base = file.name.replace(/\.[^.]+$/, "");
  const d0 = store.doc;
  const empty = d0.skeleton.slots.length === 0;
  const r = await askForm({
    title: `Import ${file.name}`,
    message: `${psd.width}×${psd.height} px · ${all.layers} layer${all.layers === 1 ? "" : "s"}${all.groups ? ` in ${all.groups} group${all.groups === 1 ? "" : "s"}` : ""}${all.hidden ? ` · ${all.hidden} hidden` : ""}. Each layer becomes a slot with its image, placed where it is in the PSD and stacked in the same order. One undo step.`,
    confirmLabel: "Import",
    fields: [
      {
        key: "groups",
        type: "choice",
        label: "Groups",
        value: all.groups ? "bones" : "flat",
        options: [
          { value: "bones", label: "Become bones", description: "One bone per group, at the centre of its layers; the group's layers are slots on it" },
          { value: "flat", label: "Ignore", description: "Every layer goes on one bone" },
        ],
      },
      {
        key: "hidden",
        type: "choice",
        label: "Hidden layers",
        value: "skip",
        options: [
          { value: "skip", label: "Skip them" },
          { value: "include", label: "Import them hidden", description: "Their slots start with nothing showing; key the attachment to show them" },
        ],
      },
      {
        key: "size",
        type: "choice",
        label: "Artboard",
        value: empty ? "match" : "keep",
        options: [
          { value: "match", label: `Match the PSD (${psd.width}×${psd.height})`, description: "The PSD canvas fills the artboard" },
          { value: "keep", label: `Keep ${d0.width}×${d0.height}`, description: "Layers keep their place relative to the artboard's top-left corner" },
        ],
      },
    ],
  });
  if (!r) return;
  const includeHidden = r.hidden === "include";
  const asBones = r.groups === "bones";

  // Encode every layer first (async), then build the rig in one transaction.
  type Item = { layer: PsdLayer; src: string; parentKey: string | null };
  const items: Item[] = [];
  const groups: { key: string; name: string; parentKey: string | null; layer: PsdLayer }[] = [];
  const walk = (ls: PsdLayer[], parentKey: string | null, path: string) => {
    // ag-psd lists layers bottom to top, which is back-to-front draw order.
    ls.forEach((l, i) => {
      if (l.hidden && !includeHidden) return;
      if (l.children) {
        if (!bounds(l, includeHidden)) return;
        const key = `${path}/${i}`;
        if (asBones) groups.push({ key, name: l.name || "group", parentKey, layer: l });
        walk(l.children, asBones ? key : parentKey, key);
      } else if (l.canvas && bounds(l, includeHidden)) items.push({ layer: l, src: l.canvas.toDataURL("image/png"), parentKey });
    });
  };
  walk(top, null, "");

  let firstSlot: string | null = null;
  try {
    transaction(`Import ${file.name}`, () => {
      if (r.size === "match") {
        // Keep the origin's relative place (e.g. bottom-centre for characters).
        const d = store.doc;
        store.apply("setDocument", { width: psd.width, height: psd.height, originX: Math.round((psd.width * d.originX) / d.width), originY: Math.round((psd.height * d.originY) / d.height) });
      }
      const doc = store.doc;
      const toSkeleton = (px: number, py: number): [number, number] => [px - doc.originX, doc.originY - py];
      const rootBone = selectedBoneId() ?? doc.skeleton.bones[0].id;
      const boneOf = new Map<string | null, string>([[null, rootBone]]);
      const usedNames = new Set([...doc.skeleton.bones.map((b) => b.name), ...doc.skeleton.slots.map((s) => s.name), ...doc.images.map((i) => i.name)]);
      const unique = (n: string) => {
        let out = n.trim() || "layer";
        for (let k = 2; usedNames.has(out); k++) out = `${n.trim() || "layer"} ${k}`;
        usedNames.add(out);
        return out;
      };
      const localIn = (boneId: string, sx: number, sy: number) => applyM(invert(setupWorld(store.doc).get(boneId)!), sx, sy);

      for (const g of groups) {
        const b = bounds(g.layer, includeHidden)!;
        const parent = boneOf.get(g.parentKey) ?? rootBone;
        const [sx, sy] = toSkeleton((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        const [lx, ly] = localIn(parent, sx, sy);
        const res = store.apply("addBone", { parent, name: unique(g.name), x: Math.round(lx * 100) / 100, y: Math.round(ly * 100) / 100, length: 0 }) as { id: string };
        boneOf.set(g.key, res.id);
      }
      for (const it of items) {
        const l = it.layer;
        const b = bounds(l, includeHidden)!;
        const name = unique(l.name || "layer");
        const img = store.apply("addImage", { name, src: it.src, width: b.right - b.left, height: b.bottom - b.top }) as { id: string };
        const bone = boneOf.get(it.parentKey) ?? rootBone;
        const alpha = Math.round(Math.max(0, Math.min(1, l.opacity ?? 1)) * 255);
        const blend = BLEND[l.blendMode ?? ""] ?? "normal";
        const slot = store.apply("addSlot", { bone, name, ...(alpha < 255 ? { color: `#ffffff${alpha.toString(16).padStart(2, "0")}` } : {}), ...(blend !== "normal" ? { blend } : {}) }) as { id: string };
        firstSlot ??= slot.id;
        const [sx, sy] = toSkeleton((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        const [lx, ly] = localIn(bone, sx, sy);
        store.apply("addRegion", { slot: slot.id, image: img.id, name, x: Math.round(lx * 100) / 100, y: Math.round(ly * 100) / 100, activate: !l.hidden });
      }
    });
  } catch (e) {
    toast(`PSD import failed: ${(e as Error).message}`, "error");
    return;
  }
  if (firstSlot) setSelection({ kind: "slot", id: firstSlot });
  toast(`Imported ${items.length} layer${items.length === 1 ? "" : "s"}${groups.length ? ` and ${groups.length} group bone${groups.length === 1 ? "" : "s"}` : ""} from ${base}.`);
}
