import { describe, expect, it } from "vitest";
import {
  ATLAS_WHITE_SIZE,
  DocumentStore,
  type PackedPage,
  atlasUvMap,
  createDocument,
  exportDocument,
  footprint,
  layoutAtlas,
  layoutAtlasFit,
  regionPageRect,
  packRects,
  remapUvs,
  alphaBounds,
  alphaHull,
  analyzeImageAlpha,
  polygonArea,
  premultipliedTextures,
  premultiplyPixels,
  trimLimits,
  unpremultiplyPixels,
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

describe("packer rotation and scaling", () => {
  // Tall strips that only share a page tightly when some turn sideways.
  const strips = [
    { id: "a", width: 40, height: 400 },
    { id: "b", width: 40, height: 400 },
    { id: "c", width: 400, height: 40 },
    { id: "d", width: 400, height: 40 },
  ];

  it("rotating packs into a smaller page and never overlaps", () => {
    const plain = packRects(strips, { padding: 0, powerOfTwo: false, maxWidth: 512, maxHeight: 512 });
    const turned = packRects(strips, { padding: 0, powerOfTwo: false, maxWidth: 512, maxHeight: 512, allowRotation: true });
    const area = (ps: typeof plain) => ps.reduce((s, p) => s + p.width * p.height, 0);
    expect(area(turned)).toBeLessThanOrEqual(area(plain));
    for (const page of turned) {
      const rs = page.rects.map((r) => ({ x: r.x, y: r.y, ...footprint(r) }));
      for (const r of rs) {
        expect(r.x + r.w).toBeLessThanOrEqual(page.width);
        expect(r.y + r.h).toBeLessThanOrEqual(page.height);
      }
      for (let i = 0; i < rs.length; i++)
        for (let j = i + 1; j < rs.length; j++) {
          const [p, q] = [rs[i], rs[j]];
          expect(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y).toBe(true);
        }
    }
  });

  it("a rectangle too tall for the page fits once rotated; noRotate is respected", () => {
    const wide = [{ id: "w", width: 500, height: 100 }];
    expect(() => packRects(wide, { maxWidth: 256, maxHeight: 512, powerOfTwo: false, padding: 0 })).toThrow();
    const p = packRects(wide, { maxWidth: 256, maxHeight: 512, powerOfTwo: false, padding: 0, allowRotation: true });
    expect(p[0].rects[0].rotated).toBe(true);
    expect(() => packRects(wide, { maxWidth: 256, maxHeight: 512, powerOfTwo: false, padding: 0, allowRotation: true, noRotate: new Set(["w"]) })).toThrow();
  });

  it("rotated regions map image corners onto the turned page rect", () => {
    const r = { image: "i", page: "p", x: 10, y: 20, width: 30, height: 50, offsetX: 0, offsetY: 0, originalWidth: 30, originalHeight: 50, rotated: true };
    const page = { width: 100, height: 100 };
    const m = atlasUvMap(r, page);
    const at = (u: number, v: number) => {
      const o = remapUvs([u, v], m);
      return [Math.round(o[0] * page.width), Math.round(o[1] * page.height)];
    };
    // Turned 90° clockwise into a 50 × 30 footprint at (10, 20): image top-left → page top-right.
    expect(at(0, 0)).toEqual([60, 20]);
    expect(at(1, 0)).toEqual([60, 50]);
    expect(at(0, 1)).toEqual([10, 20]);
    expect(at(1, 1)).toEqual([10, 50]);
    expect(regionPageRect(r)).toEqual({ x: 10, y: 20, width: 50, height: 30 });
  });

  it("scale shrinks the stored images; auto-fit finds a scale that fits one page", () => {
    const imgs = [
      { id: "a", width: 800, height: 800 },
      { id: "b", width: 800, height: 800 },
    ];
    const half = layoutAtlas(imgs, { scale: 0.5, powerOfTwo: false, padding: 0, white: false });
    expect(half.regions[0].width).toBe(400);
    expect(half.scale).toBe(0.5);
    const { atlas, scale } = layoutAtlasFit(imgs, { maxWidth: 1024, maxHeight: 1024, powerOfTwo: false, padding: 2, white: false });
    expect(atlas.pages.length).toBe(1);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(0.55);
    expect(layoutAtlasFit([{ id: "s", width: 100, height: 100 }], { white: false }).scale).toBe(1);
  });
});

/** RGBA pixels of a w x h image where `on(x, y)` pixels are opaque (alpha 255, or `alpha`). */
function mask(w: number, h: number, on: (x: number, y: number) => boolean, alpha = 255) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) px.set([200, 100, 50, alpha], (y * w + x) * 4);
  return px;
}

const inside = (poly: number[], x: number, y: number) => {
  // Convex polygon: the point is on the same side of every edge (with a tiny tolerance).
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    const c = (poly[j] - poly[i]) * (y - poly[i + 1]) - (poly[j + 1] - poly[i + 1]) * (x - poly[i]);
    if (c > 0.1) pos++;
    if (c < -0.1) neg++;
  }
  return pos === 0 || neg === 0;
};

describe("whitespace stripping and polygon packing", () => {
  const disc = (x: number, y: number) => Math.hypot(x + 0.5 - 50, y + 0.5 - 40) < 20;

  it("finds the visible bounds", () => {
    expect(alphaBounds(mask(100, 80, disc), 100, 80)).toEqual({ x: 30, y: 20, width: 40, height: 40 });
    expect(alphaBounds(mask(10, 10, () => false), 10, 10)).toBeNull();
    expect(alphaBounds(mask(10, 10, () => true, 3), 10, 10, 5)).toBeNull();
  });

  it("outlines every visible pixel with a few corners, tighter than the bounds", () => {
    const px = mask(100, 80, disc);
    for (const max of [4, 6, 8, 12]) {
      const poly = alphaHull(px, 100, 80, { maxVertices: max })!;
      expect(poly.length / 2).toBeLessThanOrEqual(max + 4);
      for (let y = 0; y < 80; y++)
        for (let x = 0; x < 100; x++) if (disc(x, y)) for (const [cx, cy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) expect(inside(poly, cx, cy), `${max}: ${cx},${cy}`).toBe(true);
      for (let i = 0; i < poly.length; i += 2) {
        expect(poly[i]).toBeGreaterThanOrEqual(0);
        expect(poly[i]).toBeLessThanOrEqual(100);
        expect(poly[i + 1]).toBeGreaterThanOrEqual(0);
        expect(poly[i + 1]).toBeLessThanOrEqual(80);
      }
      if (max >= 8) expect(polygonArea(poly)).toBeLessThan(0.9 * 40 * 40);
    }
  });

  it("packs trimmed bounds with offsets and keeps worthwhile polygons", () => {
    const px = mask(100, 80, disc);
    const a = analyzeImageAlpha(px, 100, 80, { stripWhitespace: true, polygons: true });
    expect(a.trim).toEqual({ x: 30, y: 20, width: 40, height: 40 });
    const atlas = layoutAtlas([{ id: "d", width: 100, height: 80, ...a }, { id: "sq", width: 30, height: 30, polygon: [0, 0, 30, 0, 30, 30, 0, 30] }], { padding: 2, stripWhitespace: true, polygons: true });
    const r = atlas.regions.find((x) => x.image === "d")!;
    expect(r).toMatchObject({ offsetX: 30, offsetY: 20, width: 40, height: 40, originalWidth: 100, originalHeight: 80 });
    expect(r.polygon!.length).toBeGreaterThanOrEqual(8);
    // A polygon covering the whole rect is dropped (the quad is cheaper).
    expect(atlas.regions.find((x) => x.image === "sq")!.polygon).toBeUndefined();
    expect(atlas).toMatchObject({ stripWhitespace: true, polygons: true });
    // At half scale offsets and polygon scale too (rounded outwards).
    const half = layoutAtlas([{ id: "d", width: 100, height: 80, ...a }], { scale: 0.5 }).regions[0];
    expect(half).toMatchObject({ offsetX: 15, offsetY: 10, width: 20, height: 20, originalWidth: 50, originalHeight: 40 });
    for (let i = 0; i < half.polygon!.length; i += 2) {
      expect(half.polygon![i]).toBeGreaterThanOrEqual(15);
      expect(half.polygon![i]).toBeLessThanOrEqual(35);
    }
  });

  it("keeps what meshes sample and never trims particle images", () => {
    const s = new DocumentStore(createDocument("t"));
    s.apply("addImage", { id: "m", name: "m", src: "m.png", width: 100, height: 80 });
    s.apply("addImage", { id: "p", name: "p", src: "p.png", width: 100, height: 80 });
    s.apply("addSlot", { bone: "root", name: "a" });
    s.apply("addMesh", { slot: "a", image: "m", vertices: [0, 0, 10, 0, 10, 10, 0, 10], uvs: [0.1, 0.1, 0.5, 0.1, 0.5, 0.95, 0.1, 0.95], triangles: [0, 1, 2, 0, 2, 3], hull: 4 });
    s.apply("addSlot", { bone: "root", name: "b" });
    s.apply("addParticles", { slot: "b", look: "image", image: "p" });
    const limits = trimLimits(s.doc);
    expect(limits.get("m")).toEqual([0.1, 0.1, 0.5, 0.95]);
    expect(limits.get("p")).toBe(false);
    const px = mask(100, 80, disc);
    expect(analyzeImageAlpha(px, 100, 80, { stripWhitespace: true, limit: limits.get("m") }).trim).toEqual({ x: 10, y: 8, width: 60, height: 68 });
    expect(analyzeImageAlpha(px, 100, 80, { stripWhitespace: true, polygons: true, limit: false })).toEqual({});
  });
});

describe("premultiplied alpha", () => {
  it("premultiplies and back", () => {
    const px = new Uint8ClampedArray([200, 100, 50, 128, 10, 20, 30, 255, 99, 99, 99, 0]);
    premultiplyPixels(px);
    expect(Array.from(px)).toEqual([100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
    unpremultiplyPixels(px);
    expect(Array.from(px)).toEqual([199, 100, 50, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  });

  it("lists premultiplied pages", () => {
    const atlas = layoutAtlas([{ id: "a", width: 10, height: 10 }], { premultipliedAlpha: true });
    expect([...premultipliedTextures({ atlas })]).toEqual(["atlas_page0"]);
    expect(premultipliedTextures({ atlas: { ...atlas, premultipliedAlpha: undefined } }).size).toBe(0);
  });
});
