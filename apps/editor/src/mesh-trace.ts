import { type Attachment, type TraceOptions, gridMesh, meshUvAffine, traceMesh } from "@openbone/core";
import { askForm } from "./dialogs.tsx";
import { resolveImageUrl } from "./images.ts";
import { store, toast, transaction } from "./state.ts";

type Region = Extract<Attachment, { type: "region" }>;
type Mesh = Extract<Attachment, { type: "mesh" }>;

/** The alpha channel of an image asset (loaded at its natural size). */
export async function readAlpha(imageId: string): Promise<{ alpha: Uint8ClampedArray; width: number; height: number } | null> {
  const asset = store.doc.images.find((i) => i.id === imageId);
  if (!asset?.src) {
    toast("This image has no file of its own (it is packed in an atlas). Unpack the atlas to trace it.", "error");
    return null;
  }
  const img = new Image();
  img.crossOrigin = "anonymous";
  // Wait for load (not img.decode(), which never settles in a background tab).
  const loaded = new Promise<boolean>((ok) => {
    img.onload = () => ok(true);
    img.onerror = () => ok(false);
  });
  img.src = resolveImageUrl(asset);
  if (!(img.complete && img.naturalWidth) && !(await loaded)) {
    toast(`Could not load image "${asset.name}"`, "error");
    return null;
  }
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const alpha = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { alpha, width: c.width, height: c.height };
}

/** Ask how detailed the traced mesh should be. */
async function askTraceOptions(title: string): Promise<TraceOptions | null> {
  const r = await askForm({
    title,
    message: "Builds a mesh that hugs the image's visible pixels: less transparent area is drawn and the mesh bends with the art.",
    confirmLabel: "Trace",
    fields: [
      {
        key: "detail",
        type: "choice",
        label: "Outline",
        value: "48",
        options: [
          { value: "16", label: "Simple", description: "Up to 16 outline points" },
          { value: "48", label: "Balanced", description: "Up to 48 points (recommended)" },
          { value: "96", label: "Detailed", description: "Up to 96 points, follows the edge closely" },
        ],
      },
      {
        key: "interior",
        type: "choice",
        label: "Inside",
        value: "4",
        options: [
          { value: "0", label: "Outline only", description: "Fewest vertices; fine for parts that do not bend" },
          { value: "4", label: "Some points", description: "A grid of about 4×4 for bending (recommended)" },
          { value: "8", label: "Many points", description: "About 8×8, for cloth, capes and tails" },
        ],
      },
      { key: "padding", type: "text", label: "Padding (px)", value: "2", validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "A number ≥ 0") },
    ],
  });
  if (!r) return null;
  const maxHull = Number(r.detail);
  return { maxHull, padding: Number(r.padding), tolerance: maxHull > 48 ? 1 : undefined, interior: Number(r.interior) ? -Number(r.interior) : 0 };
}

/** Resolve an "about N×N" interior request into pixel spacing for this image. */
function interiorSpacing(opts: TraceOptions, width: number, height: number): TraceOptions {
  const n = opts.interior ?? 0;
  return n < 0 ? { ...opts, interior: Math.max(6, Math.min(width, height) / -n) } : opts;
}

/** Replace a region with a mesh traced from its image (keeps its name, place, rotation and tint). */
export async function traceRegion(slotId: string, skinId: string, r: Region) {
  const opts = await askTraceOptions(`Trace mesh: ${r.name}`);
  if (!opts) return;
  const a = await readAlpha(r.image);
  if (!a) return;
  const mesh = traceMesh(a.alpha, a.width, a.height, { x: r.x, y: r.y, width: r.width, height: r.height, scaleX: r.scaleX, scaleY: r.scaleY, rotation: r.rotation }, interiorSpacing(opts, a.width, a.height));
  if (!mesh) return toast("Nothing visible to trace in this image", "error");
  transaction("trace mesh", () => {
    store.apply("deleteAttachment", { slot: slotId, attachment: r.name, skin: skinId });
    store.apply("addMesh", { slot: slotId, skin: skinId, name: r.name, image: r.image, ...mesh, color: r.color });
  });
  toast(`Traced ${mesh.hull} outline + ${mesh.vertices.length / 2 - mesh.hull} inner vertices, ${mesh.triangles.length / 3} triangles`, "info");
}

/** Re-trace an unweighted mesh where it sits (same image mapping). Deform keys for it are removed. */
export async function retraceMesh(slotId: string, skinId: string, m: Mesh) {
  if (m.weights?.length) return toast("This mesh is weighted to bones: re-tracing would lose the weights. Clear them first.", "error");
  const affine = meshUvAffine(m.vertices, m.uvs);
  if (!affine) return toast("Could not work out where this mesh's image sits", "error");
  const opts = await askTraceOptions(`Re-trace mesh: ${m.name}`);
  if (!opts) return;
  const a = await readAlpha(m.image);
  if (!a) return;
  const mesh = traceMesh(a.alpha, a.width, a.height, { x: 0, y: 0, width: 1, height: 1, uvAffine: affine }, interiorSpacing(opts, a.width, a.height));
  if (!mesh) return toast("Nothing visible to trace in this image", "error");
  transaction("re-trace mesh", () => {
    store.apply("deleteAttachment", { slot: slotId, attachment: m.name, skin: skinId });
    store.apply("addMesh", { slot: slotId, skin: skinId, name: m.name, image: m.image, ...mesh, color: m.color });
  });
  toast(`Re-traced: ${mesh.hull} outline + ${mesh.vertices.length / 2 - mesh.hull} inner vertices`, "info");
}

/** Grid mesh for a region, honouring its rotation and scale (the old conversion ignored rotation). */
export function regionGridMesh(r: Region, cols = 4, rows = 4) {
  const g = gridMesh(r.width * r.scaleX, r.height * r.scaleY, cols, rows, 0, 0);
  const rad = (r.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const vertices: number[] = [];
  for (let i = 0; i < g.vertices.length; i += 2) {
    const x = g.vertices[i];
    const y = g.vertices[i + 1];
    vertices.push(r.x + x * cos - y * sin, r.y + x * sin + y * cos);
  }
  return { ...g, vertices };
}
