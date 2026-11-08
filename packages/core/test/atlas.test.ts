import { describe, expect, it } from "vitest";
import {
  ATLAS_WHITE_SIZE,
  DocumentStore,
  type PackedPage,
  atlasUvMap,
  createDocument,
  exportDocument,
  layoutAtlas,
  packRects,
  remapUvs,
  validate,
} from "../src/index.ts";

/** Deterministic pseudo-random sizes. */
function sizes(n: number, seed = 7, max = 120) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, width: 1 + Math.floor(rnd() * max), height: 1 + Math.floor(rnd() * max) }));
}

/** Every rect is inside its page, at least `pad` from the edges and `pad` from every other rect. */
function expectSound(pages: PackedPage[], pad: number) {
  for (const p of pages) {
    for (const r of p.rects) {
      expect(r.x).toBeGreaterThanOrEqual(pad);
      expect(r.y).toBeGreaterThanOrEqual(pad);
      expect(r.x + r.width + pad).toBeLessThanOrEqual(p.width);
      expect(r.y + r.height + pad).toBeLessThanOrEqual(p.height);
    }
    for (let i = 0; i < p.rects.length; i++)
      for (let j = i + 1; j < p.rects.length; j++) {
        const a = p.rects[i];
        const b = p.rects[j];
        const apart = a.x + a.width + pad <= b.x || b.x + b.width + pad <= a.x || a.y + a.height + pad <= b.y || b.y + b.height + pad <= a.y;
        expect(apart, `${a.id} and ${b.id} overlap (pad ${pad})`).toBe(true);
      }
  }
}

const isPot = (n: number) => Number.isInteger(Math.log2(n));

describe("packRects", () => {
  it("packs without overlaps, honouring padding", () => {
    for (const pad of [0, 1, 3]) {
      const input = sizes(60);
      const pages = packRects(input, { padding: pad, maxWidth: 1024, maxHeight: 1024 });
      expectSound(pages, pad);
      expect(pages.flatMap((p) => p.rects.map((r) => r.id)).sort()).toEqual(input.map((r) => r.id).sort());
      for (const p of pages) for (const r of p.rects) expect([r.width, r.height]).toEqual([input.find((i) => i.id === r.id)!.width, input.find((i) => i.id === r.id)!.height]);
    }
  });

  it("uses power-of-two pages by default and tight pages otherwise", () => {
    const input = sizes(25, 3, 60);
    const [pot] = packRects(input);
    expect(isPot(pot.width) && isPot(pot.height)).toBe(true);
    const [tight] = packRects(input, { powerOfTwo: false, padding: 2 });
    expect(tight.width * tight.height).toBeLessThanOrEqual(pot.width * pot.height);
    // Pages are reasonably full: at least half of the area is used.
    const used = input.reduce((s, r) => s + (r.width + 2) * (r.height + 2), 0);
    expect(used / (tight.width * tight.height)).toBeGreaterThan(0.5);
    expectSound([tight], 2);
  });

  it("is exact for a perfect fit", () => {
    const four = ["a", "b", "c", "d"].map((id) => ({ id, width: 32, height: 32 }));
    const [p] = packRects(four, { padding: 0 });
    expect([p.width, p.height]).toEqual([64, 64]);
  });

  it("square pages", () => {
    const [p] = packRects([{ id: "wide", width: 100, height: 10 }], { square: true });
    expect(p.width).toBe(p.height);
    expect(p.width).toBe(128);
  });

  it("spills onto more pages when the max size is reached", () => {
    const input = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, width: 100, height: 100 }));
    const pages = packRects(input, { maxWidth: 256, maxHeight: 256, padding: 2 });
    // 4 tiles of 104 px fit in a 256 page (2 x 2), so 10 tiles need 3 pages.
    expect(pages.length).toBe(3);
    for (const p of pages) expect(p.width <= 256 && p.height <= 256).toBe(true);
    expectSound(pages, 2);
    expect(pages.reduce((n, p) => n + p.rects.length, 0)).toBe(10);
  });

  it("treats a non-power-of-two max as the largest power of two below it", () => {
    const pages = packRects([{ id: "a", width: 400, height: 10 }], { maxWidth: 1000, maxHeight: 1000 });
    expect(pages[0].width).toBe(512);
    expect(() => packRects([{ id: "big", width: 600, height: 10 }], { maxWidth: 1000, maxHeight: 1000 })).toThrow(/does not fit/);
    expect(packRects([{ id: "big", width: 600, height: 10 }], { maxWidth: 1000, maxHeight: 1000, powerOfTwo: false })[0].width).toBe(604);
  });

  it("rejects rects that can never fit and empty ones", () => {
    expect(() => packRects([{ id: "huge", width: 3000, height: 10 }])).toThrow(/huge/);
    expect(() => packRects([{ id: "edge", width: 2048, height: 10 }], { padding: 1 })).toThrow(/padding/);
    expect(() => packRects([{ id: "zero", width: 0, height: 10 }])).toThrow(/no size/);
  });

  it("rounds fractional sizes up", () => {
    const [p] = packRects([{ id: "f", width: 10.2, height: 3.5 }], { padding: 0 });
    expect(p.rects[0]).toMatchObject({ width: 11, height: 4 });
  });

  it("is deterministic", () => {
    expect(packRects(sizes(40))).toEqual(packRects(sizes(40)));
  });
});

describe("atlas uvs", () => {
  it("maps image uvs into the packed rect", () => {
    const m = atlasUvMap(
      { image: "i", page: "p", x: 10, y: 20, width: 50, height: 25, offsetX: 0, offsetY: 0, originalWidth: 50, originalHeight: 25 },
      { width: 100, height: 100 },
    );
    expect(Array.from(remapUvs([0, 0, 1, 1, 0.5, 0.2], m))).toEqual([0.1, 0.2, 0.6, 0.45, 0.35, 0.25].map((x) => Math.fround(x)));
  });

  it("accounts for trimming offsets", () => {
    // 100x100 image whose packed part is the 60x40 rect starting at (30, 50) of the original.
    const r = { image: "i", page: "p", x: 4, y: 8, width: 60, height: 40, offsetX: 30, offsetY: 50, originalWidth: 100, originalHeight: 100 };
    const m = atlasUvMap(r, { width: 128, height: 64 });
    const [u0, v0, u1, v1] = remapUvs([0.3, 0.5, 0.9, 0.9], m);
    expect(u0 * 128).toBeCloseTo(4);
    expect(v0 * 64).toBeCloseTo(8);
    expect(u1 * 128).toBeCloseTo(64);
    expect(v1 * 64).toBeCloseTo(48);
  });
});

function project() {
  const s = new DocumentStore(createDocument("atlas"));
  s.apply("addImage", { id: "img_a", name: "a", src: "a.png", width: 40, height: 20 });
  s.apply("addImage", { id: "img_b", name: "b", src: "b.png", width: 16, height: 64 });
  s.apply("addSlot", { bone: "root", name: "a" });
  s.apply("addRegion", { slot: "a", image: "a" });
  s.apply("addSlot", { bone: "root", name: "b" });
  s.apply("addMesh", { slot: "b", image: "b" });
  return s;
}

function packed(s: DocumentStore) {
  const atlas = layoutAtlas(s.doc.images, { padding: 2 });
  for (const p of atlas.pages) p.src = "data:image/png;base64,AAAA";
  return atlas;
}

describe("setAtlas op", () => {
  it("lays out images plus a white block and stores the atlas", () => {
    const s = project();
    const atlas = packed(s);
    expect(atlas.pages).toHaveLength(1);
    expect(atlas.white).toMatchObject({ width: ATLAS_WHITE_SIZE, height: ATLAS_WHITE_SIZE });
    expect(atlas.regions.map((r) => [r.image, r.originalWidth, r.originalHeight])).toEqual(
      expect.arrayContaining([
        ["img_a", 40, 20],
        ["img_b", 16, 64],
      ]),
    );
    s.apply("setAtlas", { atlas, stripImageSources: true });
    expect(s.doc.atlas!.regions).toHaveLength(2);
    expect(s.doc.images.every((i) => i.src === "")).toBe(true);
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    // Undo restores the loose images.
    s.undo();
    expect(s.doc.atlas).toBeUndefined();
    expect(s.doc.images[0].src).toBe("a.png");
  });

  it("accepts image names and defaults the original size", () => {
    const s = project();
    s.apply("setAtlas", {
      atlas: { pages: [{ id: "pg", src: "p.png", width: 64, height: 64 }], regions: [{ image: "a", page: "pg", x: 0, y: 0, width: 40, height: 20 }] },
    });
    expect(s.doc.atlas!.regions[0]).toMatchObject({ image: "img_a", originalWidth: 40, originalHeight: 20, offsetX: 0 });
  });

  it("rejects broken atlases", () => {
    const s = project();
    const page = { id: "pg", src: "p.png", width: 32, height: 32 };
    const region = { image: "a", page: "pg", x: 0, y: 0, width: 40, height: 20 };
    expect(() => s.apply("setAtlas", { atlas: { pages: [page], regions: [region] } })).toThrow(/outside page/);
    expect(() => s.apply("setAtlas", { atlas: { pages: [page], regions: [{ ...region, page: "nope" }] } })).toThrow(/unknown atlas page/);
    expect(() => s.apply("setAtlas", { atlas: { pages: [{ ...page, width: 64 }], regions: [{ ...region, image: "ghost" }] } })).toThrow(/ghost/);
    expect(() =>
      s.apply("setAtlas", { atlas: { pages: [{ ...page, width: 64 }], regions: [{ ...region, width: 20, offsetX: 30 }] } }),
    ).toThrow(/exceeds the original/);
    expect(() => s.apply("setAtlas", { atlas: { pages: [{ ...page, id: "img_a" }], regions: [] } })).toThrow(/already an image id/);
    expect(() => s.apply("setAtlas", { atlas: { pages: [{ ...page, width: 1.5 }], regions: [] } })).toThrow(/Invalid args/);
  });

  it("will not drop an atlas that holds the only copy of an image", () => {
    const s = project();
    s.apply("setAtlas", { atlas: packed(s), stripImageSources: true });
    expect(() => s.apply("setAtlas", { atlas: null })).toThrow(/only in the atlas/);
  });

  it("deleteImage removes the image's region; export prunes unused regions", () => {
    const s = project();
    s.apply("setAtlas", { atlas: packed(s) });
    s.apply("deleteAttachment", { slot: "b", attachment: "b" });
    const ex = exportDocument(s.doc);
    expect(ex.doc.atlas!.regions.map((r) => r.image)).toEqual(["img_a"]);
    s.apply("deleteImage", { image: "b" });
    expect(s.doc.atlas!.regions.map((r) => r.image)).toEqual(["img_a"]);
  });

  it("validate flags images that have no pixels anywhere", () => {
    const s = project();
    s.doc.images[0].src = "";
    expect(validate(s.doc).some((i) => i.level === "error" && /no src/.test(i.message))).toBe(true);
  });
});
