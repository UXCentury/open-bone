import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore, type OpenBoneDocument, applyOp, createDocument, deserialize, layoutAtlas } from "@openbone/core";
import { Skeleton } from "@openbone/runtime";
import { describe, expect, it } from "vitest";
import { WebGLRenderer } from "../src/index.ts";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");

/** A WebGL2 stand-in: every call is a no-op; bound textures are recorded per draw call. */
function fakeCanvas() {
  const draws: unknown[] = [];
  let bound: unknown = null;
  const gl = new Proxy({ drawingBufferWidth: 800, drawingBufferHeight: 600 } as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "bindTexture") return (_: unknown, tex: unknown) => void (bound = tex);
      if (k === "drawElements") return () => void draws.push(bound);
      if (k === "createTexture") return () => ({});
      return () => ({});
    },
  });
  const canvas = { getContext: () => gl } as unknown as HTMLCanvasElement;
  return { canvas, draws };
}

function drawCalls(doc: OpenBoneDocument) {
  const { canvas, draws } = fakeCanvas();
  const r = new WebGLRenderer(canvas, () => ({}) as TexImageSource);
  r.render(new Skeleton(doc));
  expect(r.drawCalls).toBe(draws.length);
  return { calls: r.drawCalls, textures: new Set(draws).size };
}

/** Pack the document's images (layout only: the stub GL never looks at pixels). */
function packed(doc: OpenBoneDocument) {
  const d = structuredClone(doc);
  if (!d.images.length) return d;
  const atlas = layoutAtlas(d.images);
  for (const p of atlas.pages) p.src = "data:,";
  applyOp(d, "setAtlas", { atlas });
  return d;
}

const example = (name: string) => deserialize(readFileSync(path.join(examples, name), "utf8"));

describe("WebGL batching with an atlas", () => {
  it("draws interleaved images and shapes from one texture in one call", () => {
    const s = new DocumentStore(createDocument("batch"));
    for (let i = 0; i < 4; i++) {
      s.apply("addImage", { name: `img${i}`, src: `${i}.png`, width: 30 + i * 10, height: 20 });
      s.apply("addSlot", { bone: "root", name: `pic${i}` });
      s.apply(i % 2 ? "addMesh" : "addRegion", { slot: `pic${i}`, image: `img${i}` });
      s.apply("addSlot", { bone: "root", name: `shape${i}` });
      s.apply("addShape", { slot: `shape${i}`, shape: "ellipse" });
    }
    const loose = drawCalls(s.doc);
    expect(loose.calls).toBe(8);
    const atlas = drawCalls(packed(s.doc));
    expect(atlas).toEqual({ calls: 1, textures: 1 });
  });

  it("walker example: fewer draw calls packed", () => {
    const loose = drawCalls(example("walker.obone"));
    const atlas = drawCalls(packed(example("walker.obone")));
    expect(atlas.calls).toBeLessThan(loose.calls);
    expect(atlas.calls).toBe(1);
  });

  it("campfire example: sequence frames batch from the atlas page", () => {
    const loose = drawCalls(example("campfire.obone"));
    const atlas = drawCalls(packed(example("campfire.obone")));
    // Each frame image is its own texture loose. Packed, everything samples one page; batches split only on blend
    // and clip changes: glow, smoke and logs (normal), firelight and flames (additive), the front-stones mask's
    // stencil write (its own texture binding), then the clipped front stones.
    expect(atlas.textures).toBe(2);
    expect(atlas.calls).toBeLessThan(loose.calls);
    expect(atlas.calls).toBe(4);
  });

  it("tail example: no images, nothing changes", () => {
    const doc = example("tail.obone");
    expect(packed(doc).atlas).toBeUndefined();
    expect(drawCalls(packed(doc))).toEqual(drawCalls(doc));
  });

  it("blend mode changes still split batches", () => {
    const s = new DocumentStore(createDocument("blend"));
    s.apply("addImage", { name: "a", src: "a.png", width: 10, height: 10 });
    for (const [name, blend] of [["x", "normal"], ["y", "additive"], ["z", "normal"]] as const) {
      s.apply("addSlot", { bone: "root", name });
      s.apply("updateSlot", { slot: name, blend });
      s.apply("addRegion", { slot: name, image: "a" });
    }
    expect(drawCalls(packed(s.doc)).calls).toBe(3);
  });
});
