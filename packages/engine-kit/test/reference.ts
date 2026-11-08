/**
 * Test helpers shared by the engine runtimes: run `@openbone/render-webgl` against a recording WebGL2 stand-in
 * and turn what it uploads per draw call into plain geometry, so each engine's output can be compared with it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenBoneDocument, applyOp, deserialize, layoutAtlas } from "@openbone/core";
import { WebGLRenderer } from "@openbone/render-webgl";
import { OpenBoneInstance, type Skeleton } from "@openbone/runtime";
import type { Batch } from "../src/batch.ts";

export const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");
export const example = (name: string): OpenBoneDocument => deserialize(readFileSync(path.join(examplesDir, name), "utf8"));

/** One draw call: vertices in skeleton space with uvs and straight colours; `stencil` = a clip-mask write. */
export interface RefDraw {
  stencil: boolean;
  /** Per triangle-list vertex (indices expanded): x, y, u, v, r, g, b, a. */
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
            const o = ibo[i] * 8;
            verts.push(Array.from(vbo.subarray(o, o + 8)));
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
        out.push({ stencil: true, verts: Array.from(clip.indices, (i) => [p[i * 2], p[i * 2 + 1], 1, 1, 1, 1, 1, 1]) });
      }
    }
    const verts: number[][] = [];
    for (const i of b.indices)
      verts.push([b.vertices[i * 2], b.vertices[i * 2 + 1], b.uvs[i * 2], b.uvs[i * 2 + 1], b.colors[i * 4], b.colors[i * 4 + 1], b.colors[i * 4 + 2], b.colors[i * 4 + 3]]);
    out.push({ stencil: false, verts });
  }
  return out;
}

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

/** Examples used by every engine's geometry test, with the features they exercise. */
export const GEOMETRY_CASES: { name: string; file: string; atlas?: boolean; setup?: (i: OpenBoneInstance) => void }[] = [
  { name: "knight (regions, mesh, state machine)", file: "knight.obone", setup: (i) => i.stateMachine?.setInput("walk", true) },
  { name: "knight packed into an atlas", file: "knight.obone", atlas: true },
  { name: "campfire (sequences, additive, clipping)", file: "campfire.obone" },
  { name: "rocket (particles)", file: "rocket.obone", setup: (i) => i.stateMachine?.fire("launch") },
  { name: "button (clipping mask, shapes)", file: "button.obone" },
  { name: "walker packed (weights, atlas)", file: "walker.obone", atlas: true },
  { name: "crash game (text, sequence)", file: "crash.obone", setup: (i) => i.stateMachine?.fire("start") },
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
