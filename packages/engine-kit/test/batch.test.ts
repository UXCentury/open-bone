import { PARTICLE_DOT_SIZE } from "@openbone/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBatches, loadDocument, particleDotPixels, resolveAssetUrl, textureRequests } from "../src/index.ts";
import { TextRasterizer } from "../src/text.ts";
import { GEOMETRY_CASES, batchesAsDraws, example, flatten, installFakeOffscreenCanvas, packed, posed, webglReference } from "./reference.ts";

let restore = () => {};
beforeAll(() => void (restore = installFakeOffscreenCanvas()));
afterAll(() => restore());

describe("buildBatches matches render-webgl", () => {
  for (const c of GEOMETRY_CASES)
    it(c.name, () => {
      const doc = c.atlas ? packed(example(c.file)) : example(c.file);
      const inst = posed(doc, 0.6, 12, c.setup);
      const ref = webglReference(inst.skeleton);
      const batches = buildBatches(inst.drawList());
      // Same draw calls, same split points, same vertices, uvs and colours.
      expect(batchesAsDraws(batches).map((d) => d.stencil)).toEqual(ref.map((d) => d.stencil));
      expect(flatten(batchesAsDraws(batches))).toEqual(flatten(ref));
    });

  it("packed documents batch into fewer draws", () => {
    const loose = buildBatches(posed(example("walker.obone")).drawList());
    const atlas = buildBatches(posed(packed(example("walker.obone"))).drawList());
    expect(atlas.length).toBe(1);
    expect(loose.length).toBeGreaterThan(1);
  });

  it("missing textures draw as white and batch together", () => {
    const items = posed(example("knight.obone")).drawList();
    const batches = buildBatches(items, { hasTexture: () => false });
    expect(batches.length).toBe(1);
    expect(batches[0].texture).toBeNull();
  });

  it("splits at the vertex limit", () => {
    const items = posed(example("knight.obone")).drawList();
    const one = buildBatches(items, { hasTexture: () => false });
    const split = buildBatches(items, { hasTexture: () => false, maxVertices: 20 });
    expect(split.length).toBeGreaterThan(one.length);
    expect(split.reduce((n, b) => n + b.indices.length, 0)).toBe(one[0].indices.length);
    for (const b of split) expect(b.vertices.length / 2).toBeLessThanOrEqual(Math.max(20, ...b.items.map((i) => i.vertices.length / 2)));
  });
});

describe("text rasteriser", () => {
  it("redraws only when the content or scale changes", () => {
    const inst = posed(example("crash.obone"));
    const text = inst.drawList().find((i) => i.text)!;
    const r = new TextRasterizer();
    const a = r.get("t", text.text!, 1)!;
    const v = a.version;
    expect(r.get("t", text.text!, 1)!.version).toBe(v);
    expect(r.get("t", text.text!, 3)!.version).not.toBe(v);
    expect(r.get("t", { ...text.text!, content: "other" }, 3)!.version).not.toBe(v);
  });
});

describe("loading", () => {
  it("resolves assets against the document folder", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(example("knight.obone")));
    const fetchStub = (async () => new Response(bytes)) as typeof fetch;
    const { doc, baseUrl } = await loadDocument("https://cdn.example.com/anims/knight.obone", { fetch: fetchStub });
    expect(baseUrl).toBe("https://cdn.example.com/anims/");
    const reqs = textureRequests(doc, baseUrl);
    expect(reqs[0].url).toBe("https://cdn.example.com/anims/assets/eleven/knight-torso.png");
    expect(resolveAssetUrl("data:image/png;base64,xx", baseUrl)).toBe("data:image/png;base64,xx");
  });

  it("requests atlas pages, not packed images", () => {
    const doc = packed(example("knight.obone"));
    for (const img of doc.images) img.src = "";
    const reqs = textureRequests(doc, "/");
    expect(reqs.map((r) => r.id)).toEqual(doc.atlas!.pages.map((p) => p.id));
  });

  it("particle sprite pixels", () => {
    const px = particleDotPixels(true);
    expect(px.length).toBe(PARTICLE_DOT_SIZE * PARTICLE_DOT_SIZE * 4);
    const centre = ((PARTICLE_DOT_SIZE / 2) * PARTICLE_DOT_SIZE + PARTICLE_DOT_SIZE / 2) * 4;
    expect(px[centre + 3]).toBe(255);
    expect(px[3]).toBe(0);
  });
});
