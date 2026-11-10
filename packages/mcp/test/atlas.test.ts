import { mkdtempSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { validate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { readZip } from "@openbone/export";
import { exportFile } from "../src/export.ts";
import { type RenderRequest, packAtlas, packAtlasFull, packAtlasScales, renderPng } from "../src/render.ts";
import { ProjectSession } from "../src/session.ts";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");

async function pixels(png: Buffer) {
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height).data;
}

/** Largest channel difference and the share of pixels differing by more than 8/255. */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  expect(a.length).toBe(b.length);
  let max = 0;
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (let k = 0; k < 4; k++) px = Math.max(px, Math.abs(a[i + k] - b[i + k]));
    max = Math.max(max, px);
    if (px > 8) off++;
  }
  return { max, share: off / (a.length / 4) };
}

async function open(file: string) {
  const s = new ProjectSession();
  s.autosave = false;
  await s.open(path.join(examples, file));
  return s;
}

const frames = (s: ProjectSession): RenderRequest[] => {
  const base = { showBones: false, showBoundingBoxes: false };
  const out: RenderRequest[] = [{ ...base }];
  for (const a of s.doc.animations) for (const time of [0.1, 0.37, 0.8]) out.push({ ...base, animation: a.name, time });
  if (s.doc.stateMachines.length)
    out.push({ ...base, stateMachine: "", steps: [{ pointer: { type: "move", x: s.doc.width / 2, y: s.doc.height / 2 }, advance: 0.3 }] });
  return out;
};

describe("atlas packing renders the same", () => {
  for (const file of ["walker.obone", "button.obone"]) {
    it(`${file}: packed and unpacked frames match`, async () => {
      const s = await open(file);
      const reqs = frames(s);
      const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
      if (s.doc.images.length) {
        const atlas = await packAtlas(s, s.doc, { padding: 2 });
        s.store.apply("setAtlas", { atlas, stripImageSources: true });
        expect(s.doc.atlas!.pages).toHaveLength(1);
        expect(s.doc.images.every((i) => i.src === "")).toBe(true);
        expect(s.doc.atlas!.regions.map((r) => [r.x, r.y])).not.toContainEqual([0, 0]);
      }
      expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
      for (let i = 0; i < reqs.length; i++) {
        const after = await pixels((await renderPng(s, reqs[i])).png);
        const d = diff(before[i], after);
        // Packed images draw only their own page rect, so the Canvas2D output matches: at most a stray edge pixel off by more than 8/255
        // (images drawn enlarged sample the extruded padding at their edges, a shade different from a clamped edge).
        expect(d.share, `frame ${i} of ${file}`).toBeLessThan(1e-4);
        if (d.share === 0) expect(d.max, `frame ${i} of ${file}`).toBeLessThanOrEqual(8);
      }
    });
  }

  it("re-packs an already packed (stripped) document from its pages", async () => {
    const s = await open("walker.obone");
    const reqs = frames(s);
    const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
    s.store.apply("setAtlas", { atlas: await packAtlas(s, s.doc, { padding: 1 }), stripImageSources: true });
    s.store.apply("setAtlas", { atlas: await packAtlas(s, s.doc, { padding: 6, powerOfTwo: false }), stripImageSources: true });
    expect(s.doc.atlas!.regions[0]).toMatchObject({ x: 6, y: 6 });
    for (let i = 0; i < reqs.length; i++) expect(diff(before[i], await pixels((await renderPng(s, reqs[i])).png)).share).toBeLessThan(0.001);
  });

  it("rotated packing (knight: painted regions + weighted cape mesh) renders the same, and re-packs", async () => {
    const s = await open("knight.obone");
    const reqs = frames(s).slice(0, 5);
    const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
    const atlas = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false, allowRotation: true });
    expect(atlas.regions.some((r) => r.rotated)).toBe(true);
    s.store.apply("setAtlas", { atlas, stripImageSources: true });
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    const check = async () => {
      for (let i = 0; i < reqs.length; i++) {
        const d = diff(before[i], await pixels((await renderPng(s, reqs[i])).png));
        // Turned images are resampled through a rotation: allow a few edge pixels to differ slightly.
        expect(d.share, `frame ${i}`).toBeLessThan(0.002);
      }
    };
    await check();
    // Re-pack from the rotated pages without rotation: images are cut back out upright.
    s.store.apply("setAtlas", { atlas: await packAtlas(s, s.doc, { padding: 3, powerOfTwo: false }), stripImageSources: true });
    expect(s.doc.atlas!.regions.some((r) => r.rotated)).toBe(false);
    await check();
  });

  it("pack_atlas works on a saved project and the file keeps only the pages", async () => {
    const s = await open("walker.obone");
    const dir = mkdtempSync(path.join(tmpdir(), "ob-atlas-"));
    const atlas = await packAtlas(s, s.doc);
    s.store.apply("setAtlas", { atlas, stripImageSources: true });
    const file = await s.save(path.join(dir, "walker-packed.obone"));
    const t = new ProjectSession();
    await t.open(file);
    expect(t.doc.atlas!.pages[0].src.startsWith("data:image/png;base64,")).toBe(true);
    expect(t.doc.images.length).toBeGreaterThan(0);
    expect(t.doc.images.every((i) => i.src === "")).toBe(true);
  });

  it("extrudes image edges into the padding (so GPU filtering matches a loose texture)", async () => {
    const s = await open("walker.obone");
    const atlas = await packAtlas(s, s.doc, { padding: 4 });
    const [page] = atlas.pages;
    const r = atlas.regions[0];
    const img = await loadImage(Buffer.from(page.src.split(",")[1], "base64"));
    const c = createCanvas(page.width, page.height);
    c.getContext("2d").drawImage(img, 0, 0);
    const at = (x: number, y: number) => Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data);
    const midY = r.y + (r.height >> 1);
    const midX = r.x + (r.width >> 1);
    expect(at(r.x - 1, midY)).toEqual(at(r.x, midY));
    expect(at(r.x - 2, midY)).toEqual(at(r.x, midY));
    expect(at(r.x + r.width + 1, midY)).toEqual(at(r.x + r.width - 1, midY));
    expect(at(midX, r.y - 2)).toEqual(at(midX, r.y));
    // Beyond half the padding stays empty, so neighbours never touch.
    expect(at(r.x - 3, midY)[3]).toBe(0);
  });

  it("polygon outlines and premultiplied pages render the same, and re-pack", async () => {
    for (const file of ["knight.obone", "walker.obone"]) {
      const s = await open(file);
      const reqs = frames(s).slice(0, 4);
      const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
      const atlas = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false, stripWhitespace: true, polygons: true, premultipliedAlpha: true, allowRotation: true });
      expect(atlas).toMatchObject({ premultipliedAlpha: true, stripWhitespace: true, polygons: true });
      expect(atlas.regions.filter((r) => r.polygon).length).toBeGreaterThan(3);
      s.store.apply("setAtlas", { atlas, stripImageSources: true });
      expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
      const check = async (what: string) => {
        for (let i = 0; i < reqs.length; i++) {
          const d = diff(before[i], await pixels((await renderPng(s, reqs[i])).png));
          // Premultiplied storage rounds faint pixels and rotation resamples: a few edge pixels may differ.
          expect(d.share, `${file} ${what} frame ${i}`).toBeLessThan(0.003);
        }
      };
      await check("packed");
      // Re-pack from the premultiplied pages into a straight-alpha atlas: pixels come back intact.
      s.store.apply("setAtlas", { atlas: await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false }), stripImageSources: true });
      expect(s.doc.atlas!.premultipliedAlpha).toBeUndefined();
      await check("re-packed");
    }
  }, 60_000);

  it("strips whitespace (meshes keep their uvs), stores premultiplied pixels, and renders the same", async () => {
    // A 120x100 image with a soft disc in the middle and a lot of transparent margin.
    const c = createCanvas(120, 100);
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(60, 50, 5, 60, 50, 25);
    grad.addColorStop(0, "rgba(255,120,40,1)");
    grad.addColorStop(1, "rgba(40,80,255,0)");
    g.fillStyle = grad;
    g.fillRect(30, 20, 60, 60);
    const src = `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`;
    const s = new ProjectSession();
    s.autosave = false;
    s.newProject("trim", null, { width: 300, height: 140, originX: 150, originY: 70, background: "#202020" });
    s.store.apply("addImage", { id: "disc", name: "disc", src, width: 120, height: 100 });
    s.store.apply("addImage", { id: "disc2", name: "disc2", src, width: 120, height: 100 });
    s.store.apply("addSlot", { bone: "root", name: "a" });
    s.store.apply("addRegion", { slot: "a", image: "disc", x: -70, rotation: 20, scaleX: 1.3 });
    s.store.apply("addSlot", { bone: "root", name: "b" });
    // A mesh whose uvs reach into the margin: that part must stay packed.
    s.store.apply("addMesh", { slot: "b", image: "disc2", vertices: [10, -40, 130, -40, 130, 40, 10, 40], uvs: [0.05, 0.1, 0.9, 0.1, 0.9, 0.9, 0.05, 0.9], triangles: [0, 1, 2, 0, 2, 3], hull: 4 });
    const before = await pixels((await renderPng(s, {})).png);
    const atlas = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false, stripWhitespace: true, polygons: true, premultipliedAlpha: true });
    const disc = atlas.regions.find((r) => r.image === "disc")!;
    const disc2 = atlas.regions.find((r) => r.image === "disc2")!;
    // The visible disc is about 50x50 around (60, 50).
    expect(disc.width).toBeLessThan(60);
    expect(disc.height).toBeLessThan(60);
    expect(disc.offsetX).toBeGreaterThan(30);
    expect(disc.polygon!.length / 2).toBeGreaterThanOrEqual(6);
    // The mesh's uvs span x 6..108, y 10..90: kept.
    expect(disc2.offsetX).toBeLessThanOrEqual(6);
    expect(disc2.offsetX + disc2.width).toBeGreaterThanOrEqual(108);
    expect(disc2.offsetY + disc2.height).toBeGreaterThanOrEqual(90);
    s.store.apply("setAtlas", { atlas, stripImageSources: true });
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    const d = diff(before, await pixels((await renderPng(s, {})).png));
    expect(d.share).toBeLessThan(0.003);

    // Page bytes as stored: rgb = straight rgb × alpha.
    const straight = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false, stripWhitespace: true });
    const raw = (src: string) => decodeRawPng(Buffer.from(src.split(",")[1], "base64"));
    const a = raw(straight.pages[0].src);
    const b = raw((await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false, stripWhitespace: true, premultipliedAlpha: true })).pages[0].src);
    let soft = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(b[i + 3]).toBe(a[i + 3]);
      if (a[i + 3] > 0 && a[i + 3] < 255) {
        soft++;
        for (let k = 0; k < 3; k++) expect(Math.abs(b[i + k] - Math.round((a[i + k] * a[i + 3]) / 255))).toBeLessThanOrEqual(1);
      }
    }
    expect(soft).toBeGreaterThan(100);
  });
});

describe("texture packer options render the same", () => {
  /** Walker plus a second copy of the head image (identical pixels, its own id) and a fully transparent image, both drawn. */
  async function walkerWithAliasAndBlank() {
    const s = await open("walker.obone");
    const head = s.doc.images.find((i) => i.name === "walker-head")!;
    s.store.apply("addImage", { id: "head_copy", name: "head-copy", src: head.src, width: head.width, height: head.height });
    const blank = createCanvas(40, 30);
    s.store.apply("addImage", { id: "blank", name: "blank", src: `data:image/png;base64,${blank.toBuffer("image/png").toString("base64")}`, width: 40, height: 30 });
    const root = s.doc.skeleton.bones[0].id;
    s.store.apply("addSlot", { bone: root, name: "head-copy" });
    s.store.apply("addRegion", { slot: "head-copy", image: "head_copy", x: 120, y: 80, rotation: 15, scaleX: 0.6, scaleY: 0.6 });
    s.store.apply("addSlot", { bone: root, name: "blank" });
    s.store.apply("addRegion", { slot: "blank", image: "blank", x: -60, y: 40 });
    return { s, head };
  }

  it("aliases identical images and gives blank images no space; packed and unpacked frames match", async () => {
    const { s, head } = await walkerWithAliasAndBlank();
    const reqs = frames(s).slice(0, 4);
    const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
    const off = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false, alias: false, ignoreBlank: false });
    const atlas = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false });
    const r = (id: string) => atlas.regions.find((x) => x.image === id)!;
    expect([r("head_copy").x, r("head_copy").y, r("head_copy").page]).toEqual([r(head.id).x, r(head.id).y, r(head.id).page]);
    expect(r("blank")).toMatchObject({ empty: true, width: 1, height: 1 });
    const rects = (a: typeof atlas) => new Set(a.regions.filter((x) => !x.empty).map((x) => `${x.page}:${x.x},${x.y}`)).size;
    // The copy shares the head's rect and the blank image has none: two rects fewer.
    expect(rects(atlas)).toBe(rects(off) - 2);
    s.store.apply("setAtlas", { atlas, stripImageSources: true });
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    for (let i = 0; i < reqs.length; i++) expect(diff(before[i], await pixels((await renderPng(s, reqs[i])).png)).share, `frame ${i}`).toBeLessThan(1e-4);
    // Re-packing from the pages keeps the aliases and the blank image (and its size).
    const again = await packAtlas(s, s.doc, { padding: 2, powerOfTwo: false });
    expect(again.regions.find((x) => x.image === "blank")!.empty).toBe(true);
    const r2 = (id: string) => again.regions.find((x) => x.image === id)!;
    expect([r2("head_copy").x, r2("head_copy").y]).toEqual([r2(head.id).x, r2(head.id).y]);
  }, 60_000);

  it("edge padding without duplication, bleed and a min/multiple-of-4 page render the same; padding and bleed bytes are as asked", async () => {
    const s = await open("walker.obone");
    const reqs = frames(s).slice(0, 4);
    const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
    const opts = { padding: 4, powerOfTwo: false, duplicatePadding: false, multipleOf4: true, minWidth: 1500 };
    const atlas = await packAtlas(s, s.doc, opts);
    for (const p of atlas.pages) {
      expect(p.width % 4).toBe(0);
      expect(p.height % 4).toBe(0);
      expect(p.width).toBeGreaterThanOrEqual(1500);
    }
    const raw = decodeRawPng(Buffer.from(atlas.pages[0].src.split(",")[1], "base64"));
    const W = atlas.pages[0].width;
    const at = (x: number, y: number) => Array.from(raw.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    // An opaque edge pixel is repeated into the padding as colour only.
    let opaqueEdges = 0;
    let bled = 0;
    let transparentInside = 0;
    for (const r of atlas.regions.filter((x) => x.page === atlas.pages[0].id && !x.rotated)) {
      for (let y = r.y; y < r.y + r.height; y++) {
        const e = at(r.x, y);
        if (e[3] === 255) {
          opaqueEdges++;
          expect(at(r.x - 1, y)).toEqual([e[0], e[1], e[2], 0]);
          expect(at(r.x - 2, y)).toEqual([e[0], e[1], e[2], 0]);
        }
        for (let x = r.x; x < r.x + r.width; x++) {
          const p = at(x, y);
          if (p[3] === 0) {
            transparentInside++;
            if (p[0] || p[1] || p[2]) bled++;
          }
        }
      }
    }
    expect(opaqueEdges).toBeGreaterThan(0);
    // Bleed coloured every fully transparent pixel inside the images.
    expect(transparentInside).toBeGreaterThan(100);
    expect(bled / transparentInside).toBeGreaterThan(0.99);
    const plain = decodeRawPng(Buffer.from((await packAtlas(s, s.doc, { ...opts, bleed: false })).pages[0].src.split(",")[1], "base64"));
    // Without bleed, transparent pixels inside the images stay black (the padding still carries edge colours).
    let plainBled = 0;
    for (const r of atlas.regions.filter((x) => x.page === atlas.pages[0].id && !x.rotated))
      for (let y = r.y; y < r.y + r.height; y++)
        for (let x = r.x; x < r.x + r.width; x++) {
          const i = (y * W + x) * 4;
          if (plain[i + 3] === 0 && (plain[i] || plain[i + 1] || plain[i + 2])) plainBled++;
        }
    expect(plainBled).toBe(0);
    s.store.apply("setAtlas", { atlas, stripImageSources: true });
    for (let i = 0; i < reqs.length; i++) expect(diff(before[i], await pixels((await renderPng(s, reqs[i])).png)).share, `frame ${i}`).toBeLessThan(1e-4);
  }, 60_000);

  it("several scales in one pack: each scale's packed frames match the unpacked ones", async () => {
    const s = await open("walker.obone");
    const reqs = frames(s).slice(0, 3);
    const before = await Promise.all(reqs.map(async (r) => pixels((await renderPng(s, r)).png)));
    const built = await packAtlasScales(s, s.doc, { padding: 2, powerOfTwo: false }, [
      { scale: 1, suffix: "" },
      { scale: 0.5, suffix: "@0.5x" },
    ]);
    expect(built.map((b) => [b.suffix, b.scale])).toEqual([["", 1], ["@0.5x", 0.5]]);
    const [full, half] = built.map((b) => b.atlas);
    expect(half.scale).toBe(0.5);
    expect(half.pages[0].width).toBeLessThan(full.pages[0].width);
    for (const b of built) {
      const t = await open("walker.obone");
      t.store.apply("setAtlas", { atlas: b.atlas, stripImageSources: true });
      expect(validate(t.doc).filter((i) => i.level === "error")).toEqual([]);
      for (let i = 0; i < reqs.length; i++) {
        const after = await pixels((await renderPng(t, reqs[i])).png);
        const d = diff(before[i], after);
        // Full size matches exactly; half size is the same picture, softer (resampled art).
        if (b.scale === 1) expect(d.share, `frame ${i}`).toBeLessThan(1e-4);
        else {
          // Half size is the same picture, softer (resampled art): small on average, and few pixels far off.
          let sum = 0;
          let far = 0;
          for (let k = 0; k < after.length; k += 4) {
            let px = 0;
            for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(after[k + c] - before[i][k + c]));
            sum += px;
            if (px > 64) far++;
          }
          expect(sum / (after.length / 4), `half frame ${i} mean`).toBeLessThan(8);
          expect(far / (after.length / 4), `half frame ${i} far`).toBeLessThan(0.01);
        }
      }
    }
  }, 60_000);

  it("export_file atlas: one data file + page set per scale; JPEG pages warn about transparency; debug outlines", async () => {
    const s = await open("walker.obone");
    const r = await exportFile(s, { format: "atlas", atlas: { scales: [{ scale: 1, suffix: "" }, { scale: 0.5, suffix: "@0.5x" }], pageFormat: "jpeg", jpegQuality: 80, filterMin: "mipmap", wrapX: "repeat" } }, async () => {
      throw new Error("no scripts needed");
    });
    const zip = await readZip(r.bytes);
    const names = zip.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["walker.json", "walker@0.5x.json", "walker.jpg", "walker@0.5x.jpg"]));
    const half = JSON.parse(new TextDecoder().decode(zip.find((e) => e.name === "walker@0.5x.json")!.data));
    expect(half.atlas).toMatchObject({ scale: 0.5, filterMin: "mipmap", wrapX: "repeat" });
    expect(half.atlas.pages[0].src).toBe("walker@0.5x.jpg");
    expect(r.note).toMatch(/JPEG pages are opaque/);
    expect(r.note).toMatch(/@0\.5x: 1 page/);

    const dbg = await packAtlasFull(s, s.doc, { padding: 2, powerOfTwo: false, debug: true });
    expect(dbg.warnings).toEqual([]);
    const raw = decodeRawPng(Buffer.from(dbg.atlas.pages[0].src.split(",")[1], "base64"));
    const reg = dbg.atlas.regions[0];
    const W = dbg.atlas.pages[0].width;
    expect(Array.from(raw.subarray((reg.y * W + reg.x) * 4, (reg.y * W + reg.x) * 4 + 4))).toEqual([255, 0, 255, 255]);
  }, 60_000);
});

/** Raw RGBA bytes of an 8-bit RGBA PNG exactly as stored (no colour management or premultiplication by a decoder). */
function decodeRawPng(png: Buffer): Uint8Array {
  let p = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString("ascii", p + 4, p + 8);
    if (type === "IHDR") {
      w = png.readUInt32BE(p + 8);
      h = png.readUInt32BE(p + 12);
    } else if (type === "IDAT") idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const ul = x >= 4 && y ? out[(y - 1) * stride + x - 4] : 0;
      const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      out[y * stride + x] = (v + [0, left, up, (left + up) >> 1, paeth][f]) & 255;
    }
  }
  return out;
}
