import { describe, expect, it } from "vitest";
import {
  type AtlasData,
  DocumentStore,
  analyzeImageAlpha,
  atlasSampling,
  atlasUvMap,
  bleedPixels,
  createDocument,
  deserialize,
  deserializeBinary,
  filterParts,
  footprint,
  hashPixels,
  layoutAtlas,
  outlineBoxes,
  packRects,
  padEdges,
  remapUvs,
  serialize,
  serializeBinary,
  textureSamplings,
  validate,
} from "../src/index.ts";

const ids = (n: number, w = 30, h = 20) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, width: w, height: h }));
const overlaps = (a: { x: number; y: number; width: number; height: number; rotated?: boolean }, b: typeof a) => {
  const fa = footprint(a);
  const fb = footprint(b);
  return a.x < b.x + fb.w && b.x < a.x + fa.w && a.y < b.y + fb.h && b.y < a.y + fa.h;
};

describe("page constraints", () => {
  it("never makes pages smaller than the minimum", () => {
    const [p] = packRects(ids(1, 10, 10), { padding: 1, powerOfTwo: false, minWidth: 100, minHeight: 60 });
    expect([p.width, p.height]).toEqual([100, 60]);
    // With power-of-two pages the minimum rounds up to the next power of two.
    const [q] = packRects(ids(1, 10, 10), { padding: 1, minWidth: 100, minHeight: 60 });
    expect([q.width, q.height]).toEqual([128, 64]);
  });

  it("takes separate max width and height", () => {
    const pages = packRects(ids(40), { padding: 2, maxWidth: 256, maxHeight: 64 });
    for (const p of pages) {
      expect(p.width).toBeLessThanOrEqual(256);
      expect(p.height).toBeLessThanOrEqual(64);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(() => packRects([{ id: "tall", width: 10, height: 100 }], { maxWidth: 256, maxHeight: 64 })).toThrow(/does not fit/);
  });

  it("rounds sizes up to multiples of 4 and keeps square pages square", () => {
    for (const n of [1, 3, 7, 13]) {
      for (const p of packRects(ids(n, 13, 9), { padding: 1, powerOfTwo: false, multipleOf4: true, maxWidth: 1023, maxHeight: 1023 })) {
        expect(p.width % 4).toBe(0);
        expect(p.height % 4).toBe(0);
        expect(p.width).toBeLessThanOrEqual(1020);
      }
      for (const pot of [true, false]) for (const p of packRects(ids(n, 40, 11), { padding: 2, powerOfTwo: pot, square: true })) expect(p.width).toBe(p.height);
    }
  });

  it("every rect still lies inside its page, apart from the others", () => {
    for (const opts of [{ minWidth: 300 }, { multipleOf4: true, powerOfTwo: false }, { square: true, powerOfTwo: false }, { maxWidth: 128, maxHeight: 512 }]) {
      const pages = packRects(ids(25, 23, 17), { padding: 2, ...opts });
      for (const p of pages) {
        for (const r of p.rects) {
          expect(r.x + footprint(r).w).toBeLessThanOrEqual(p.width - 2);
          expect(r.y + footprint(r).h).toBeLessThanOrEqual(p.height - 2);
        }
        for (let i = 0; i < p.rects.length; i++) for (let j = i + 1; j < p.rects.length; j++) expect(overlaps(p.rects[i], p.rects[j])).toBe(false);
      }
    }
  });
});

describe("aliases and blank images", () => {
  const imgs = [
    { id: "a", width: 40, height: 30, alias: "a" },
    { id: "b", width: 40, height: 30, alias: "a" },
    { id: "c", width: 50, height: 30, trim: { x: 10, y: 0, width: 40, height: 30 }, alias: "a" },
    { id: "d", width: 40, height: 30, alias: "d" },
    { id: "blank1", width: 64, height: 64, blank: true },
    { id: "blank2", width: 8, height: 8, blank: true },
  ];

  it("stores identical images once: their regions share a rect but keep their own offsets", () => {
    const at = layoutAtlas(imgs, { padding: 2, powerOfTwo: false });
    const r = (id: string) => at.regions.find((x) => x.image === id)!;
    expect([r("b").x, r("b").y]).toEqual([r("a").x, r("a").y]);
    expect([r("c").x, r("c").y]).toEqual([r("a").x, r("a").y]);
    expect(r("c")).toMatchObject({ offsetX: 10, originalWidth: 50, width: 40 });
    expect([r("d").x, r("d").y]).not.toEqual([r("a").x, r("a").y]);
    // a/b/c + d + the blank block + white: four rects.
    expect(new Set(at.regions.map((x) => `${x.x},${x.y}`)).size + 1).toBe(4);
    // Off: every image gets its own rect.
    const off = layoutAtlas(imgs, { padding: 2, powerOfTwo: false, alias: false });
    expect(new Set(off.regions.filter((x) => !x.empty).map((x) => `${x.x},${x.y}`)).size).toBe(4);
  });

  it("only aliases images of the same packed size, and keeps a shared rect upright when any user must be", () => {
    const at = layoutAtlas(
      [
        { id: "a", width: 90, height: 20, alias: "k" },
        { id: "b", width: 90, height: 20, alias: "k" },
        { id: "c", width: 91, height: 20, alias: "k" },
      ],
      { padding: 1, powerOfTwo: false, allowRotation: true, noRotate: new Set(["b"]), maxWidth: 100, maxHeight: 400 },
    );
    const r = (id: string) => at.regions.find((x) => x.image === id)!;
    expect([r("a").x, r("a").y]).toEqual([r("b").x, r("b").y]);
    expect([r("c").x, r("c").y]).not.toEqual([r("a").x, r("a").y]);
    expect(r("a").rotated).toBeUndefined();
  });

  it("gives blank images no space: their regions point at one shared 1×1 transparent block", () => {
    const at = layoutAtlas(imgs, { padding: 2, powerOfTwo: false });
    const b1 = at.regions.find((x) => x.image === "blank1")!;
    const b2 = at.regions.find((x) => x.image === "blank2")!;
    expect(b1).toMatchObject({ empty: true, width: 1, height: 1, originalWidth: 1, originalHeight: 1, offsetX: 0, offsetY: 0 });
    expect([b2.x, b2.y]).toEqual([b1.x, b1.y]);
    // Every uv of the image lands inside that one pixel.
    const page = at.pages[0];
    const uv = remapUvs([0, 0, 1, 1, 0.5, 0.5], atlasUvMap(b1, page));
    for (let i = 0; i < uv.length; i += 2) {
      expect(uv[i] * page.width).toBeGreaterThanOrEqual(b1.x - 1e-6);
      expect(uv[i] * page.width).toBeLessThanOrEqual(b1.x + 1 + 1e-6);
    }
    // Kept as their own rects when the option is off.
    const keep = layoutAtlas(imgs, { padding: 2, powerOfTwo: false, ignoreBlank: false });
    expect(keep.regions.find((x) => x.image === "blank1")).toMatchObject({ width: 64, height: 64 });
    expect(keep.regions.some((x) => x.empty)).toBe(false);
  });

  it("stores the result with setAtlas and validates", () => {
    const doc = createDocument("t");
    const store = new DocumentStore(doc);
    for (const i of imgs) store.apply("addImage", { id: i.id, name: i.id, src: "data:image/png;base64,AA==", width: i.width, height: i.height });
    const at = layoutAtlas(imgs, { padding: 2 });
    for (const p of at.pages) p.src = "data:image/png;base64,AA==";
    store.apply("setAtlas", { atlas: at, stripImageSources: true });
    expect(store.doc.atlas!.regions.find((r) => r.image === "blank1")!.empty).toBe(true);
    expect(validate(store.doc).filter((i) => i.level === "error")).toEqual([]);
  });
});

/** RGBA image from an alpha map ('.' = 0, digits = alpha × 28, '#' = 255) in a solid colour. */
function img(rows: string[], rgb: [number, number, number] = [200, 100, 50]) {
  const w = rows[0].length;
  const px = new Uint8ClampedArray(w * rows.length * 4);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const a = ch === "." ? 0 : ch === "#" ? 255 : Number(ch) * 28;
      px.set(a ? [...rgb, a] : [0, 0, 0, 0], (y * w + x) * 4);
    }),
  );
  return { px, w, h: rows.length };
}

describe("alpha threshold", () => {
  it("trims and tests blankness against the threshold", () => {
    const { px, w, h } = img(["1....", ".1...", "..#..", ".....", "....2"]);
    expect(analyzeImageAlpha(px, w, h, { stripWhitespace: true }).trim).toBeUndefined();
    expect(analyzeImageAlpha(px, w, h, { stripWhitespace: true, threshold: 60 }).trim).toEqual({ x: 2, y: 2, width: 1, height: 1 });
    expect(analyzeImageAlpha(px, w, h, { stripWhitespace: true, threshold: 30 }).trim).toEqual({ x: 2, y: 2, width: 3, height: 3 });
    expect(analyzeImageAlpha(px, w, h, {}).blank).toBeUndefined();
    expect(analyzeImageAlpha(px, w, h, { threshold: 255 }).blank).toBe(true);
    const faint = img(["111", "111"]);
    expect(analyzeImageAlpha(faint.px, faint.w, faint.h, {}).blank).toBeUndefined();
    expect(analyzeImageAlpha(faint.px, faint.w, faint.h, { threshold: 28 }).blank).toBe(true);
  });
});

describe("page pixels", () => {
  it("bleed gives transparent pixels the nearest visible colour and keeps their alpha at 0", () => {
    const W = 6;
    const px = new Uint8ClampedArray(W * 3 * 4);
    px.set([255, 0, 0, 255], (1 * W + 1) * 4); // red at (1,1)
    px.set([0, 0, 255, 128], (1 * W + 4) * 4); // half-transparent blue at (4,1)
    bleedPixels(px, W, { x: 0, y: 0, width: W, height: 3 });
    const at = (x: number, y: number) => Array.from(px.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect(at(0, 0)).toEqual([255, 0, 0, 0]);
    expect(at(5, 2)).toEqual([0, 0, 255, 0]);
    expect(at(4, 1)).toEqual([0, 0, 255, 128]);
    // Between the two, each pixel takes its nearer neighbour's colour.
    expect(at(2, 1)).toEqual([255, 0, 0, 0]);
    expect(at(3, 1)).toEqual([0, 0, 255, 0]);
    // Only inside the box.
    const big = new Uint8ClampedArray(10 * 10 * 4);
    big.set([9, 9, 9, 255], (5 * 10 + 5) * 4);
    bleedPixels(big, 10, { x: 4, y: 4, width: 3, height: 3 });
    expect(Array.from(big.subarray((4 * 10 + 4) * 4, (4 * 10 + 4) * 4 + 4))).toEqual([9, 9, 9, 0]);
    expect(Array.from(big.subarray((3 * 10 + 3) * 4, (3 * 10 + 3) * 4 + 4))).toEqual([0, 0, 0, 0]);
  });

  it("edge padding repeats edges into the padding; opaque ones as colour only unless duplicated", () => {
    // 2x1 image at (2,2) on an 6x5 page: left pixel opaque red, right pixel half-transparent green.
    const make = () => {
      const px = new Uint8ClampedArray(6 * 5 * 4);
      px.set([255, 0, 0, 255], (2 * 6 + 2) * 4);
      px.set([0, 255, 0, 100], (2 * 6 + 3) * 4);
      return px;
    };
    const at = (px: Uint8ClampedArray, x: number, y: number) => Array.from(px.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
    const soft = make();
    padEdges(soft, 6, 5, { x: 2, y: 2, width: 2, height: 1 }, 1, false);
    expect(at(soft, 1, 2)).toEqual([255, 0, 0, 0]);
    expect(at(soft, 4, 2)).toEqual([0, 255, 0, 100]);
    expect(at(soft, 2, 1)).toEqual([255, 0, 0, 0]);
    expect(at(soft, 4, 3)).toEqual([0, 255, 0, 100]);
    expect(at(soft, 0, 2)).toEqual([0, 0, 0, 0]);
    const hard = make();
    padEdges(hard, 6, 5, { x: 2, y: 2, width: 2, height: 1 }, 2, true);
    expect(at(hard, 0, 2)).toEqual([255, 0, 0, 255]);
    expect(at(hard, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(at(hard, 5, 4)).toEqual([0, 255, 0, 100]);
  });

  it("debug outlines are drawn just inside each box", () => {
    const px = new Uint8ClampedArray(5 * 5 * 4);
    outlineBoxes(px, 5, 5, [{ x: 1, y: 1, width: 3, height: 3 }]);
    expect(Array.from(px.subarray((1 * 5 + 1) * 4, (1 * 5 + 1) * 4 + 4))).toEqual([255, 0, 255, 255]);
    expect(Array.from(px.subarray((3 * 5 + 2) * 4, (3 * 5 + 2) * 4 + 4))).toEqual([255, 0, 255, 255]);
    expect(px[(2 * 5 + 2) * 4 + 3]).toBe(0);
    expect(px[(0 * 5 + 0) * 4 + 3]).toBe(0);
  });

  it("hashes equal pixels equally and different pixels differently", () => {
    const a = img(["#1.", ".##"]);
    const b = img(["..#1.", "...##"]);
    expect(hashPixels(a.px, a.w, 0, 0, 3, 2)).toBe(hashPixels(b.px, b.w, 2, 0, 3, 2));
    expect(hashPixels(a.px, a.w, 0, 0, 3, 2)).not.toBe(hashPixels(img(["#2.", ".##"]).px, 3, 0, 0, 3, 2));
  });
});

describe("sampling metadata", () => {
  const atlas = (): AtlasData => ({
    pages: [{ id: "p0", name: "p0", src: "data:image/png;base64,AA==", width: 8, height: 8 }],
    regions: [{ image: "i", page: "p0", x: 1, y: 1, width: 4, height: 4, offsetX: 0, offsetY: 0, originalWidth: 4, originalHeight: 4 }],
    padding: 1,
    filterMin: "mipmapLinearNearest",
    filterMag: "nearest",
    wrapX: "repeat",
    wrapY: "mirroredRepeat",
    pixelFormat: "RGBA4444",
  });

  it("round-trips through setAtlas, JSON and binary", () => {
    const store = new DocumentStore(createDocument("t"));
    store.apply("addImage", { id: "i", name: "i", src: "", width: 4, height: 4 });
    store.apply("setAtlas", { atlas: atlas() });
    const want = { filterMin: "mipmapLinearNearest", filterMag: "nearest", wrapX: "repeat", wrapY: "mirroredRepeat", pixelFormat: "RGBA4444" };
    expect(store.doc.atlas).toMatchObject(want);
    expect(deserialize(serialize(store.doc)).atlas).toMatchObject(want);
    expect(deserializeBinary(serializeBinary(store.doc)).atlas).toMatchObject(want);
    // Defaults are left out of the file.
    store.apply("setAtlas", { atlas: { ...atlas(), filterMin: "linear", filterMag: "linear", wrapX: "clamp", wrapY: "clamp", pixelFormat: "RGBA8888" } });
    for (const k of Object.keys(want)) expect(k in store.doc.atlas!).toBe(false);
    expect(() => store.apply("setAtlas", { atlas: { ...atlas(), wrapX: "tile" } })).toThrow();
  });

  it("tells renderers how to sample each page", () => {
    expect(textureSamplings({ atlas: { ...atlas(), filterMin: undefined, filterMag: undefined, wrapX: undefined, wrapY: undefined } }).size).toBe(0);
    expect(textureSamplings({ atlas: atlas() }).get("p0")).toEqual({ min: "mipmapLinearNearest", mag: "nearest", wrapX: "repeat", wrapY: "mirroredRepeat", mipmaps: true });
    expect(filterParts("mipmap")).toEqual({ texel: "linear", mip: "linear" });
    expect(filterParts("mipmapNearestLinear")).toEqual({ texel: "nearest", mip: "linear" });
    expect(filterParts("nearest")).toEqual({ texel: "nearest", mip: "none" });
    expect(atlasSampling({ filterMin: "linear", wrapY: "repeat" })).toEqual({ wrapY: "repeat" });
    // layoutAtlas records what it is given.
    expect(layoutAtlas([{ id: "a", width: 4, height: 4 }], { filterMag: "nearest", pixelFormat: "RGB565" })).toMatchObject({ filterMag: "nearest", pixelFormat: "RGB565" });
  });
});
