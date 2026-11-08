import { readFileSync } from "node:fs";
import path from "node:path";
import { OpenBoneInstance } from "@openbone/runtime";
import CanvasKitInit from "canvaskit-wasm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GEOMETRY_CASES, type RefDraw, example, examplesDir, flatten, installFakeOffscreenCanvas, packed, posed, webglReference } from "../../engine-kit/test/reference.ts";
import { CanvasKitRenderer, loadOpenBone } from "../src/index.ts";

let restore = () => {};
beforeAll(() => void (restore = installFakeOffscreenCanvas()));
afterAll(() => restore());

/** A CanvasKit stand-in recording drawVertices (texture coords back to 0..1) and clip paths. */
function fakeCanvasKit() {
  const draws: (RefDraw & { blend: unknown; shader: unknown })[] = [];
  let lastPoly: number[] = [];
  const enumOf = (...names: string[]) => Object.fromEntries(names.map((n) => [n, n]));
  const ck = {
    Paint: class {
      blend: unknown;
      shader: unknown;
      setAntiAlias() {}
      setBlendMode(b: unknown) { this.blend = b; }
      setShader(s: unknown) { this.shader = s; }
      setColor() {}
      setStyle() {}
      setStrokeWidth() {}
      setStrokeJoin() {}
      copy() { return new ck.Paint(); }
      delete() {}
    },
    Path: class {
      addPoly(p: Float32Array) { lastPoly = Array.from(p); return this; }
      delete() {}
    },
    BlendMode: enumOf("SrcOver", "Plus", "Multiply", "Screen", "Modulate"),
    VertexMode: enumOf("Triangles"),
    TileMode: enumOf("Clamp"),
    FilterMode: enumOf("Linear"),
    MipmapMode: enumOf("None"),
    ClipOp: enumOf("Intersect"),
    AlphaType: enumOf("Premul"),
    ColorType: enumOf("RGBA_8888"),
    ColorSpace: enumOf("SRGB"),
    MakeImage: () => fakeImage(64, 64),
    MakeImageFromCanvasImageSource: (c: { width: number; height: number }) => fakeImage(c.width, c.height),
    Font: class {
      getMetrics = () => ({ ascent: -8, descent: 2, leading: 0 });
      getGlyphIDs = (s: string) => Array.from(s, () => 1);
      getGlyphWidths = (ids: number[]) => ids.map(() => 5);
      delete() {}
    },
    PaintStyle: enumOf("Fill", "Stroke"),
    StrokeJoin: enumOf("Round"),
    parseColorString: (s: string) => s,
    MakeVertices: (_m: unknown, pos: Float32Array, texs: Float32Array | null, colors: Float32Array, idx: number[]) => ({ pos, texs, colors, idx, delete() {} }),
  };
  let current: { pos: Float32Array; texs: Float32Array | null; colors: Float32Array; idx: number[] } | null = null;
  let tex = { w: 1, h: 1 };
  const canvas = {
    save() {},
    restore() {},
    concat() {},
    getTotalMatrix: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale() {},
    texts: [] as [string, number, number][],
    drawText(s: string, x: number, y: number) {
      canvas.texts.push([s, x, y]);
    },
    clipPath() {
      const p = lastPoly;
      draws.push({ stencil: true, verts: [p], blend: null, shader: null });
    },
    drawVertices(v: typeof current, _mode: unknown, paint: { blend: unknown; shader: { w: number; h: number } | null }) {
      current = v!;
      tex = paint.shader ?? { w: 1, h: 1 };
      const verts = current.idx.map((i) => [
        current!.pos[i * 2],
        current!.pos[i * 2 + 1],
        current!.texs ? current!.texs[i * 2] / tex.w : NaN,
        current!.texs ? current!.texs[i * 2 + 1] / tex.h : NaN,
        ...current!.colors.slice(i * 4, i * 4 + 4),
      ]);
      draws.push({ stencil: false, verts, blend: paint.blend, shader: paint.shader });
    },
  };
  return { ck, canvas, draws };
}
const fakeImage = (w: number, h: number) => ({ width: () => w, height: () => h, makeShaderOptions: () => ({ w, h }), delete() {} });

describe("CanvasKit geometry matches render-webgl", () => {
  for (const c of GEOMETRY_CASES)
    it(c.name, () => {
      const doc = c.atlas ? packed(example(c.file)) : example(c.file);
      const inst = posed(doc, 0.6, 12, c.setup);
      const sizes = new Map([...(doc.atlas?.pages ?? []), ...doc.images].map((t) => [t.id, fakeImage(t.width, t.height)]));
      const { ck, canvas, draws } = fakeCanvasKit();
      const r = new CanvasKitRenderer(ck as never, (id) => sizes.get(id) as never);
      r.render(canvas as never, inst.skeleton);
      const ref = webglReference(inst.skeleton);
      expect(draws.map((d) => d.stencil)).toEqual(ref.map((d) => d.stencil));
      // Clip paths are polygons (not triangulated): compare the solid draws, with white (untextured) uvs ignored.
      const solid = (d: RefDraw[]) => d.filter((x) => !x.stencil);
      const got = flatten(solid(draws));
      const want = flatten(solid(ref));
      expect(got.length).toBe(want.length);
      for (let i = 0; i < got.length; i++) {
        const g = got[i];
        const w = want[i];
        expect([g[1], g[2]]).toEqual([w[1], w[2]]);
        if (!Number.isNaN(g[3])) expect(Math.abs(g[3] - w[3]) + Math.abs(g[4] - w[4])).toBeLessThan(2e-3);
        expect(g.slice(5)).toEqual(w.slice(5));
      }
      expect(r.drawCalls).toBe(solid(ref).length);
    });

  it("maps blend modes to Skia's", () => {
    const inst = posed(example("campfire.obone"));
    const { ck, canvas, draws } = fakeCanvasKit();
    const doc = inst.doc;
    const sizes = new Map(doc.images.map((t) => [t.id, fakeImage(t.width, t.height)]));
    new CanvasKitRenderer(ck as never, (id) => sizes.get(id) as never).render(canvas as never, inst);
    expect(new Set(draws.filter((d) => !d.stencil).map((d) => d.blend))).toEqual(new Set(["SrcOver", "Plus"]));
  });
});

describe("CanvasKit text", () => {
  it("draws text natively when fonts are given", () => {
    const inst = posed(example("crash.obone"));
    const { ck, canvas, draws } = fakeCanvasKit();
    const sizes = new Map(inst.doc.images.map((t) => [t.id, fakeImage(t.width, t.height)]));
    const families: string[] = [];
    const r = new CanvasKitRenderer(ck as never, (id) => sizes.get(id) as never, { fonts: (family) => (families.push(family), {} as never) });
    r.render(canvas as never, inst);
    const texts = inst.drawList().filter((i) => i.text);
    expect(canvas.texts.map((t) => t[0])).toEqual(expect.arrayContaining(texts.map((t) => t.text!.content.split("\n")[0])));
    expect(families.length).toBeGreaterThan(0);
    // Text no longer goes through textured quads.
    expect(r.drawCalls).toBe(draws.filter((d) => !d.stencil).length);
    expect(r.drawCalls).toBe(webglReference(inst.skeleton).length - texts.length);
  });
});

describe("CanvasKit (real Skia, Node)", () => {
  it("decodes the knight's images and draws it", async () => {
    const ck = await CanvasKitInit();
    const bytes = readFileSync(path.join(examplesDir, "knight.obone"));
    const fileFetch = (async (url: string) => new Response(readFileSync(path.join(examplesDir, url)))) as unknown as typeof fetch;
    const asset = await loadOpenBone(ck, bytes, { fetch: fileFetch });
    expect(asset.images.size).toBe(asset.doc.images.length);
    const inst = new OpenBoneInstance(asset.doc);
    inst.useStateMachine();
    inst.advance(0.2);
    const W = 225;
    const H = 150;
    const surface = ck.MakeSurface(W, H)!;
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    const r = new CanvasKitRenderer(ck, (id) => asset.images.get(id));
    r.render(canvas, inst, { x: 0, y: 0, zoom: 0.25 });
    const px = canvas.readPixels(0, 0, { width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB })!;
    // The painted background covers the artboard: opaque, and not one flat colour.
    let opaque = 0;
    const colours = new Set<number>();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 255) opaque++;
      colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    }
    expect(opaque).toBeGreaterThan(W * H * 0.95);
    expect(colours.size).toBeGreaterThan(500);
    expect(r.drawCalls).toBe(20);
    r.dispose();
    surface.delete();
  }, 20000);
});
