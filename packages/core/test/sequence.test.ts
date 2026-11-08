import { describe, expect, it } from "vitest";
import {
  DocumentStore,
  createDocument,
  deserializeBinary,
  exportDocument,
  getAttachment,
  gridSheetFrames,
  groupNumbered,
  layoutAtlas,
  naturalCompare,
  naturalSort,
  parseNumberedName,
  parseSheetJson,
  sequenceCounter,
  sequenceDuration,
  sequenceFrameIndex,
  sequenceFrameLayout,
  serializeBinary,
  validate,
  type SequenceAttachment,
} from "../src/index.ts";

function project(frames = 4) {
  const s = new DocumentStore(createDocument("seq"));
  for (let i = 1; i <= frames; i++) s.apply("addImage", { id: `img_${i}`, name: `fire_${String(i).padStart(4, "0")}`, src: `f${i}.png`, width: 32, height: 48 });
  s.apply("addSlot", { bone: "root", name: "fx" });
  return s;
}
const seq = (s: DocumentStore, name = "fire") => getAttachment(s.doc, s.doc.skeleton.slots[0].id, name) as SequenceAttachment;

describe("sequence frame selection", () => {
  const all = (mode: Parameters<typeof sequenceFrameIndex>[1], n: number, from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => sequenceFrameIndex(n, mode, from + i));

  it("loop wraps in both directions", () => {
    expect(all("loop", 3, -3, 7)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
  });
  it("once plays through then hides", () => {
    expect(all("once", 3, -1, 5)).toEqual([0, 0, 1, 2, -1, -1]);
  });
  it("holdLast stays on the last frame", () => {
    expect(all("holdLast", 3, -1, 6)).toEqual([0, 0, 1, 2, 2, 2, 2]);
  });
  it("pingPong goes there and back without repeating the ends", () => {
    expect(all("pingPong", 4, 0, 13)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0]);
    expect(all("pingPong", 1, 0, 3)).toEqual([0, 0, 0]);
    expect(sequenceFrameIndex(4, "pingPong", -1)).toBe(1);
  });
  it("handles empty sequences, fractions and the time counter", () => {
    expect(sequenceFrameIndex(0, "loop", 3)).toBe(-1);
    expect(sequenceFrameIndex(5, "loop", 2.9)).toBe(2);
    expect(sequenceCounter(24, 0, 0.5)).toBe(12);
    expect(sequenceCounter(10, 3, 0.3)).toBe(6); // 0.3*10 must not floor to 2
    expect(sequenceDuration(4, 8, "loop")).toBe(0.5);
    expect(sequenceDuration(4, 6, "pingPong")).toBe(1);
  });
  it("lays out sheet cells and trimmed frames", () => {
    const l = sequenceFrameLayout({ image: "i", rect: { x: 32, y: 0, width: 32, height: 16 }, trim: { x: 4, y: 8, sourceWidth: 64, sourceHeight: 32 } }, 128, 64);
    expect(l.uv).toEqual([0.25, 0, 0.5, 0.25]);
    expect(l.quad).toEqual([4 / 64, 8 / 32, 36 / 64, 24 / 32]);
    expect(sequenceFrameLayout({ image: "i" }, 10, 10)).toEqual({ uv: [0, 0, 1, 1], quad: [0, 0, 1, 1] });
  });
});

describe("natural sorting and numbered names", () => {
  it("compares digit runs as numbers", () => {
    expect(naturalSort(["f10.png", "f2.png", "f1.png", "F3.png"])).toEqual(["f1.png", "f2.png", "F3.png", "f10.png"]);
    expect(naturalSort(["fire_0010", "fire_0009", "fire_0100"])).toEqual(["fire_0009", "fire_0010", "fire_0100"]);
    expect(naturalCompare("a1", "a01")).toBeLessThan(0);
    expect(naturalCompare("a", "a1")).toBeLessThan(0);
    expect(naturalCompare("x2y10", "x2y9")).toBeGreaterThan(0);
  });
  it("parses numbered names", () => {
    expect(parseNumberedName("fire_0001.png")).toEqual({ base: "fire", number: 1, ext: "png" });
    expect(parseNumberedName("smoke2.0012.PNG")).toEqual({ base: "smoke2", number: 12, ext: "png" });
    expect(parseNumberedName("Comp 1 00042.jpg")).toEqual({ base: "Comp 1", number: 42, ext: "jpg" });
    expect(parseNumberedName("logo.png")).toBeNull();
  });
  it("groups files into sequences", () => {
    const files = ["fire_0010.png", "logo.png", "fire_0002.png", "fire_0001.png", "smoke1.png", "spark_1.jpg", "spark_2.jpg"];
    const g = groupNumbered(files, (f) => f);
    const fire = g.find((x) => x.name === "fire")!;
    expect(fire.sequence).toBe(true);
    expect(fire.items).toEqual(["fire_0001.png", "fire_0002.png", "fire_0010.png"]);
    expect(g.find((x) => x.name === "spark")!.items).toEqual(["spark_1.jpg", "spark_2.jpg"]);
    expect(g.filter((x) => !x.sequence).map((x) => x.name).sort()).toEqual(["logo", "smoke1"]);
  });
});

describe("sprite sheet parsing", () => {
  it("cuts a grid by columns and rows, with padding and margin", () => {
    const f = gridSheetFrames({ imageWidth: 100, imageHeight: 50, cols: 4, rows: 2, padding: 2, margin: 1 });
    expect(f).toHaveLength(8);
    expect(f[0].rect).toEqual({ x: 1, y: 1, width: 23, height: 23 });
    expect(f[5].rect).toEqual({ x: 26, y: 26, width: 23, height: 23 });
  });
  it("cuts a grid by frame size and count", () => {
    const f = gridSheetFrames({ imageWidth: 256, imageHeight: 128, frameWidth: 64, frameHeight: 64, count: 6 });
    expect(f.map((x) => [x.rect.x, x.rect.y])).toEqual([[0, 0], [64, 0], [128, 0], [192, 0], [0, 64], [64, 64]]);
    expect(() => gridSheetFrames({ imageWidth: 100, imageHeight: 100, cols: 3, rows: 1, frameWidth: 40 })).toThrow(/does not fit/);
  });
  it("reads the hash format (TexturePacker), sorted naturally, with trim", () => {
    const json = {
      frames: {
        "walk_10.png": { frame: { x: 0, y: 0, w: 10, h: 10 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 10, h: 10 }, sourceSize: { w: 10, h: 10 } },
        "walk_2.png": { frame: { x: 10, y: 0, w: 8, h: 6 }, rotated: false, trimmed: true, spriteSourceSize: { x: 1, y: 2, w: 8, h: 6 }, sourceSize: { w: 10, h: 10 } },
      },
      meta: { image: "walk.png", size: { w: 32, h: 16 } },
    };
    const p = parseSheetJson(JSON.stringify(json));
    expect(p.image).toBe("walk.png");
    expect(p.frames.map((f) => f.name)).toEqual(["walk_2.png", "walk_10.png"]);
    expect(p.frames[0]).toEqual({ name: "walk_2.png", rect: { x: 10, y: 0, width: 8, height: 6 }, trim: { x: 1, y: 2, sourceWidth: 10, sourceHeight: 10 } });
    expect(p.frames[1].trim).toBeUndefined();
    expect(p.fps).toBeUndefined();
  });
  it("reads the array format (Aseprite) in order, with fps from durations", () => {
    const json = {
      frames: [
        { filename: "b 1.aseprite", frame: { x: 16, y: 0, w: 16, h: 16 }, sourceSize: { w: 16, h: 16 }, spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 }, duration: 100 },
        { filename: "b 0.aseprite", frame: { x: 0, y: 0, w: 16, h: 16 }, duration: 100 },
        { filename: "b 2.aseprite", frame: { x: 32, y: 0, w: 16, h: 16 }, duration: 200 },
      ],
      meta: { app: "http://www.aseprite.org/", image: "b.png" },
    };
    const p = parseSheetJson(json);
    expect(p.frames.map((f) => f.rect.x)).toEqual([16, 0, 32]);
    expect(p.fps).toBe(10);
  });
  it("rejects what it cannot draw", () => {
    expect(() => parseSheetJson({ nope: 1 })).toThrow(/frames/);
    expect(() => parseSheetJson({ frames: { a: { frame: { x: 0, y: 0, w: 1, h: 1 }, rotated: true } } })).toThrow(/rotated/);
    expect(() => parseSheetJson({ frames: [] })).toThrow(/no frames/);
  });
});

describe("sequence ops", () => {
  it("adds a sequence from image refs with defaults from the first frame", () => {
    const s = project();
    const r = s.apply("addSequence", { slot: "fx", frames: ["fire_0001", "fire_0002", "img_3"], fps: 12 }) as { name: string; frames: number };
    expect(r).toMatchObject({ name: "fire", frames: 3 });
    const a = seq(s);
    expect(a).toMatchObject({ type: "sequence", width: 32, height: 48, fps: 12, mode: "loop", offset: 0, color: "#ffffff" });
    expect(a.frames.map((f) => f.image)).toEqual(["img_1", "img_2", "img_3"]);
    expect(s.doc.skeleton.slots[0].attachment).toBe("fire");
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("adds a sequence from a sheet grid and from explicit rects", () => {
    const s = project(0);
    s.apply("addImage", { id: "sheet", name: "sheet", src: "s.png", width: 128, height: 64 });
    s.apply("addSequence", { slot: "fx", name: "grid", grid: { image: "sheet", cols: 4, rows: 2 } });
    expect(seq(s, "grid").frames).toHaveLength(8);
    expect(seq(s, "grid")).toMatchObject({ width: 32, height: 32 });
    s.apply("addSequence", { slot: "fx", name: "cells", frames: [{ image: "sheet", rect: { x: 0, y: 0, width: 10, height: 10 }, trim: { x: 1, y: 1, sourceWidth: 12, sourceHeight: 14 } }] });
    expect(seq(s, "cells")).toMatchObject({ width: 12, height: 14 });
    expect(() => s.apply("addSequence", { slot: "fx", frames: [{ image: "sheet", rect: { x: 120, y: 0, width: 10, height: 10 } }] })).toThrow(/outside/);
    expect(() => s.apply("addSequence", { slot: "fx" })).toThrow(/frames or a grid/);
  });

  it("replaces, reorders and validates frames and props", () => {
    const s = project();
    s.apply("addSequence", { slot: "fx", name: "fire", frames: ["img_1", "img_2"] });
    s.apply("setSequenceFrames", { slot: "fx", attachment: "fire", frames: ["img_4", "img_3", "img_2", "img_1"] });
    expect(seq(s).frames.map((f) => f.image)).toEqual(["img_4", "img_3", "img_2", "img_1"]);
    s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { mode: "pingPong", fps: 6, offset: 2, frames: ["fire_0001"] } });
    expect(seq(s)).toMatchObject({ mode: "pingPong", fps: 6, offset: 2, frames: [{ image: "img_1" }] });
    expect(() => s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { mode: "bounce" } })).toThrow();
    expect(() => s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { fps: 0 } })).toThrow(/fps/);
    expect(() => s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { frames: ["nope"] } })).toThrow(/not found/);
    s.undo();
    expect(seq(s).frames).toHaveLength(4);
  });

  it("binds a number input by name and refuses other input types", () => {
    const s = project();
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "level", type: "number" });
    s.apply("addInput", { stateMachine: "sm", name: "on", type: "bool" });
    s.apply("addSequence", { slot: "fx", frames: ["img_1", "img_2"], input: "level" });
    expect(seq(s).input).toBe(s.doc.stateMachines[0].inputs[0].id);
    expect(() => s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { input: "on" } })).toThrow(/number input/);
    s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { input: null } });
    expect(seq(s).input).toBeNull();
  });

  it("keys the frame on a sequence timeline and drops it with the slot", () => {
    const s = project();
    s.apply("addSequence", { slot: "fx", frames: ["img_1", "img_2"] });
    s.apply("createAnimation", { name: "a" });
    s.apply("setKeys", { animation: "a", target: "sequence", id: "fx", attachment: "fire", keys: [{ time: 0, value: 0, curve: "stepped" }, { time: 1, value: 1 }] });
    const tl = s.doc.animations[0].timelines[0];
    expect(tl).toMatchObject({ target: "sequence", property: "frame", attachment: "fire" });
    expect(() => s.apply("setKeys", { animation: "a", target: "sequence", id: "fx", attachment: "nope", keys: [{ time: 0, value: 0 }] })).toThrow(/sequence attachment/);
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    s.apply("deleteSlot", { slot: "fx" });
    expect(s.doc.animations[0].timelines).toEqual([]);
  });

  it("works with skins, image deletion, export pruning, the atlas and binary files", () => {
    const s = project();
    s.apply("addImage", { id: "unused", name: "unused", src: "u.png", width: 4, height: 4 });
    s.apply("addSequence", { slot: "fx", frames: ["img_1", "img_2"] });
    s.apply("addSkin", { name: "blue" });
    s.apply("addSequence", { slot: "fx", skin: "blue", name: "fire", frames: ["img_3", "img_4"] });
    const blue = s.doc.skeleton.skins[1].id;
    expect((getAttachment(s.doc, s.doc.skeleton.slots[0].id, "fire", blue) as SequenceAttachment).frames[0].image).toBe("img_3");
    expect(() => s.apply("deleteImage", { image: "img_3" })).toThrow(/used by attachment/);
    const out = exportDocument(s.doc);
    expect(out.doc.images.map((i) => i.id).sort()).toEqual(["img_1", "img_2", "img_3", "img_4"]);
    const atlas = layoutAtlas(s.doc.images);
    expect(atlas.regions.map((r) => r.image)).toEqual(expect.arrayContaining(["img_1", "img_2", "img_3", "img_4"]));
    const back = deserializeBinary(serializeBinary(s.doc));
    expect(back.skeleton.skins).toEqual(s.doc.skeleton.skins);
  });
});
