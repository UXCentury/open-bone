/**
 * Test helpers shared by the engine runtimes: run `@openbone/render-webgl` against a recording WebGL2 stand-in
 * and turn what it uploads per draw call into plain geometry, so each engine's output can be compared with it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore, type OpenBoneDocument, applyOp, createDocument, deserialize, layoutAtlas } from "@openbone/core";
import { WebGLRenderer } from "@openbone/render-webgl";
import { OpenBoneInstance, type Skeleton } from "@openbone/runtime";
import type { Batch } from "../src/batch.ts";

export const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
export const example = (name: string): OpenBoneDocument => deserialize(readFileSync(path.join(examplesDir, name), "utf8"));

/** One draw call: vertices in skeleton space with uvs and straight colours; `stencil` = a clip-mask write. */
export interface RefDraw {
  stencil: boolean;
  /** Per triangle-list vertex (indices expanded): x, y, u, v, r, g, b, a, then the dark colour's r, g, b. */
  verts: number[][];
}

/** What render-webgl draws for this pose, call by call. */
export function webglReference(sk: Skeleton): RefDraw[] {
  const draws: RefDraw[] = [];
  let vbo = new Float32Array(0);
  let ibo = new Uint16Array(0);
  let colorWrite = true;
  let bound: unknown = null;
  const ARRAY = 1;
  const ELEMENT = 2;
  const gl = new Proxy({ drawingBufferWidth: 800, drawingBufferHeight: 600, ARRAY_BUFFER: ARRAY, ELEMENT_ARRAY_BUFFER: ELEMENT } as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "bufferData")
        return (target: number, data: Float32Array | Uint16Array) => {
          if (target === ARRAY) vbo = Float32Array.from(data as Float32Array);
          else ibo = Uint16Array.from(data as Uint16Array);
        };
      if (k === "colorMask") return (r: boolean) => void (colorWrite = r);
      if (k === "bindTexture") return (_: unknown, tex: unknown) => void (bound = tex);
      if (k === "drawElements")
        return (_mode: number, count: number) => {
          const verts: number[][] = [];
          for (let i = 0; i < count; i++) {
            // render-webgl's vertex: x, y, u, v, r, g, b, a, then the two-colour tint's dark r, g, b.
            const o = ibo[i] * 11;
            verts.push(Array.from(vbo.subarray(o, o + 11)));
          }
          draws.push({ stencil: !colorWrite, verts });
          void bound;
        };
      if (k === "createTexture") return () => ({});
      return () => ({});
    },
  });
  const canvas = { getContext: () => gl } as unknown as HTMLCanvasElement;
  const r = new WebGLRenderer(canvas, () => ({}) as TexImageSource);
  r.render(sk);
  return draws;
}

/** The same shape of record from engine-kit batches (a stencil write before each batch that starts a new mask). */
export function batchesAsDraws(batches: Batch[]): RefDraw[] {
  const out: RefDraw[] = [];
  let clip: Batch["clip"];
  for (const b of batches) {
    if (b.clip !== clip) {
      clip = b.clip;
      if (clip) {
        const p = clip.polygon;
        out.push({ stencil: true, verts: Array.from(clip.indices, (i) => [p[i * 2], p[i * 2 + 1], 1, 1, 1, 1, 1, 1, 0, 0, 0]) });
      }
    }
    const verts: number[][] = [];
    for (const i of b.indices)
      verts.push([b.vertices[i * 2], b.vertices[i * 2 + 1], b.uvs[i * 2], b.uvs[i * 2 + 1], ...rgba(b.colors, i), ...darkAt(b.dark, i)]);
    out.push({ stencil: false, verts });
  }
  return out;
}

const rgba = (c: Float32Array, i: number) => [c[i * 4], c[i * 4 + 1], c[i * 4 + 2], c[i * 4 + 3]];
/** A vertex's dark colour from a per-vertex rgb array (black when the batch has none). */
export const darkAt = (d: ArrayLike<number> | undefined, i: number) => (d ? [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]] : [0, 0, 0]);

/** Flatten draws to one list of rounded numbers (draw-call boundaries dropped, for engines that merge batches). */
export function flatten(draws: RefDraw[], digits = 3): number[][] {
  const k = 10 ** digits;
  const r = (x: number) => Math.round(x * k) / k + 0; // + 0 turns -0 into 0
  return draws.flatMap((d) => d.verts.map((v) => [d.stencil ? 1 : 0, ...v.map(r)]));
}

/** Pack a document's images into an atlas (layout only: nothing looks at pixels in these tests). */
export function packed(doc: OpenBoneDocument): OpenBoneDocument {
  const d = structuredClone(doc);
  if (!d.images.length) return d;
  const atlas = layoutAtlas(d.images);
  for (const p of atlas.pages) p.src = "data:,";
  applyOp(d, "setAtlas", { atlas });
  return d;
}

/** A posed instance: state machine (or first animation) advanced `t` seconds in `steps` steps. */
export function posed(doc: OpenBoneDocument, t = 0.5, steps = 10, setup?: (i: OpenBoneInstance) => void): OpenBoneInstance {
  const inst = new OpenBoneInstance(doc);
  if (doc.stateMachines.length) inst.useStateMachine();
  else if (doc.animations.length) inst.play(doc.animations[0].name);
  setup?.(inst);
  inst.advance(0);
  for (let i = 0; i < steps; i++) inst.advance(t / steps);
  return inst;
}

/**
 * The two-colour tint fixture: an 80×20 artboard (origin at its centre) with three copies of a 20×10 image whose
 * left half is black and right half white, all in one batch:
 * - "tinted" (artboard x 5..25): dark red, light green: black → red, white → green;
 * - "plain" (x 30..50): no dark colour (a dark-less item inside a dark batch): black stays black, white white;
 * - "blue" (x 55..75): dark blue, white light: black → blue, white stays white.
 */
export function darkTintDoc(): OpenBoneDocument {
  const s = new DocumentStore(createDocument("dark-tint"));
  s.apply("setDocument", { width: 80, height: 20, originX: 40, originY: 10 });
  s.apply("addImage", { id: "bw", name: "bw", src: "bw.png", width: 20, height: 10 });
  const slot = (name: string, x: number, color: string, dark?: string) => {
    s.apply("addSlot", { bone: "root", name, color, ...(dark ? { dark } : {}) });
    s.apply("addRegion", { slot: name, image: "bw", x });
  };
  slot("tinted", -25, "#00ff00", "#ff0000");
  slot("plain", 0, "#ffffff");
  slot("blue", 25, "#ffffff", "#0000ff");
  return s.doc;
}

/** Pixels of the fixture's image (RGBA, 20×10): left half black, right half white, opaque. */
export function blackWhitePixels(): Uint8Array {
  const px = new Uint8Array(20 * 10 * 4);
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 20; x++) {
      const o = (y * 20 + x) * 4;
      px.set(x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255], o);
    }
  return px;
}

/** Artboard pixels to sample in the fixture (centre row) and the colour each must come out as. */
export const DARK_TINT_EXPECTED: { x: number; y: number; rgb: [number, number, number] }[] = [
  { x: 10, y: 10, rgb: [255, 0, 0] },
  { x: 20, y: 10, rgb: [0, 255, 0] },
  { x: 35, y: 10, rgb: [0, 0, 0] },
  { x: 45, y: 10, rgb: [255, 255, 255] },
  { x: 60, y: 10, rgb: [0, 0, 255] },
  { x: 70, y: 10, rgb: [255, 255, 255] },
];

export interface GeometryCase {
  name: string;
  /** Example file name, or `doc` for a document built in code. */
  file: string;
  doc?: () => OpenBoneDocument;
  atlas?: boolean;
  setup?: (i: OpenBoneInstance) => void;
}

/** The document a case draws (packed into an atlas when the case asks for it). */
export function caseDoc(c: Pick<GeometryCase, "file" | "doc" | "atlas">): OpenBoneDocument {
  const doc = c.doc ? c.doc() : example(c.file);
  return c.atlas ? packed(doc) : doc;
}

/** Examples used by every engine's geometry test, with the features they exercise. */
export const GEOMETRY_CASES: GeometryCase[] = [
  { name: "knight (regions, mesh, state machine)", file: "knight.obone", setup: (i) => i.stateMachine?.setInput("walk", true) },
  { name: "knight packed into an atlas", file: "knight.obone", atlas: true },
  { name: "campfire (sequences, additive, clipping)", file: "campfire.obone" },
  { name: "rocket (particles)", file: "rocket.obone", setup: (i) => i.stateMachine?.fire("launch") },
  { name: "button (clipping mask, shapes)", file: "button.obone" },
  { name: "walker packed (weights, atlas)", file: "walker.obone", atlas: true },
  { name: "crash game (text, sequence)", file: "crash.obone", setup: (i) => i.stateMachine?.fire("start") },
  { name: "two-colour tint (dark and plain items in one batch)", file: "dark-tint", doc: darkTintDoc },
];

/**
 * Node has no canvas: give render-webgl (and TextRasterizer) an OffscreenCanvas whose 2D context ignores drawing,
 * so text items still produce their quads. Returns a function that removes it again.
 */
export function installFakeOffscreenCanvas(): () => void {
  const g = globalThis as { OffscreenCanvas?: unknown };
  if (g.OffscreenCanvas) return () => {};
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === "createImageData" ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => ({})),
    set: (t, k, v) => ((t[k] = v), true),
  });
  g.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return ctx;
    }
  };
  return () => delete g.OffscreenCanvas;
}
