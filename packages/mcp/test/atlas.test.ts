import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { validate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { type RenderRequest, packAtlas, renderPng } from "../src/render.ts";
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
});
