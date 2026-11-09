import { describe, expect, it } from "vitest";
import {
  DocumentStore,
  createDocument,
  deserializeBinary,
  folderPaths,
  folderTree,
  importConflicts,
  normalizeFolder,
  renamedFolder,
  restoreLocked,
  serialize,
  serializeBinary,
  setInfluence,
  swapInfluence,
  setupWorld,
  validate,
  type ImportReport,
  type OpenBoneDocument,
} from "../src/index.ts";


// ---------------- Folders ----------------

function foldered() {
  const s = new DocumentStore(createDocument("folders"));
  s.apply("addBone", { name: "body" });
  for (const n of ["armL", "armR", "head"]) s.apply("addSlot", { bone: "body", name: n });
  for (const n of ["walk", "run", "idle"]) s.apply("createAnimation", { name: n });
  s.apply("addEvent", { name: "step" });
  s.apply("addSkin", { name: "red" });
  s.apply("createStateMachine", { name: "sm" });
  s.apply("addIkConstraint", { name: "aim", bones: ["body"], target: "root" });
  return s;
}

describe("folders", () => {
  it("normalises and renames paths", () => {
    expect(normalizeFolder(" body// arms/ ")).toBe("body/arms");
    expect(normalizeFolder(" / ")).toBeUndefined();
    expect(renamedFolder("body/arms/left", "body/arms", "limbs")).toBe("limbs/left");
    expect(renamedFolder("body/armsX", "body/arms", "limbs")).toBe("body/armsX");
    expect(renamedFolder("body/arms", "body/arms", undefined)).toBeUndefined();
    expect(folderPaths([{ folder: "a/b/c" }, { folder: "d" }, {}])).toEqual(["a", "a/b", "a/b/c", "d"]);
  });

  it("sets folders on every kind, and clears them", () => {
    const s = foldered();
    s.apply("setFolder", { kind: "slot", items: ["armL", "armR"], folder: "body/arms" });
    s.apply("setFolder", { kind: "animation", items: ["walk", "run"], folder: "locomotion" });
    s.apply("setFolder", { kind: "event", items: ["step"], folder: "sfx" });
    s.apply("setFolder", { kind: "skin", items: ["red"], folder: "outfits" });
    s.apply("setFolder", { kind: "stateMachine", items: ["sm"], folder: "ui" });
    s.apply("setFolder", { kind: "constraint", items: ["aim"], folder: "ik" });
    const d = s.doc;
    expect(d.skeleton.slots.map((x) => x.folder)).toEqual(["body/arms", "body/arms", undefined]);
    expect(d.animations.find((a) => a.name === "walk")!.folder).toBe("locomotion");
    expect(d.events[0].folder).toBe("sfx");
    expect(d.skeleton.skins[1].folder).toBe("outfits");
    expect(d.stateMachines[0].folder).toBe("ui");
    expect(d.skeleton.ik[0].folder).toBe("ik");
    s.apply("setFolder", { kind: "animation", items: ["walk"], folder: null });
    expect("folder" in d.animations.find((a) => a.name === "walk")!).toBe(false);
    expect(() => s.apply("setFolder", { kind: "slot", items: ["nope"], folder: "x" })).toThrow(/not found/);
  });

  it("renames a folder with its sub-folders, and deleting one moves its contents up a level", () => {
    const s = foldered();
    s.apply("setFolder", { kind: "animation", items: ["walk"], folder: "body/legs" });
    s.apply("setFolder", { kind: "animation", items: ["run"], folder: "body/legs/fast" });
    s.apply("setFolder", { kind: "animation", items: ["idle"], folder: "body" });
    s.apply("renameFolder", { kind: "animation", from: "body/legs", to: "locomotion" });
    const f = (n: string) => s.doc.animations.find((a) => a.name === n)!.folder;
    expect([f("walk"), f("run"), f("idle")]).toEqual(["locomotion", "locomotion/fast", "body"]);
    // Delete "locomotion": its items go to the top level, its sub-folder becomes a top-level folder.
    s.apply("renameFolder", { kind: "animation", from: "locomotion", to: null });
    expect([f("walk"), f("run")]).toEqual([undefined, "fast"]);
    // Delete a nested folder: contents go to the parent.
    s.apply("setFolder", { kind: "animation", items: ["walk"], folder: "a/b" });
    s.apply("renameFolder", { kind: "animation", from: "a/b", to: "" });
    expect(f("walk")).toBe("a");
    expect(() => s.apply("renameFolder", { kind: "animation", from: "zzz", to: "y" })).toThrow(/no animations/);
  });

  it("limits slot folder renames to one bone", () => {
    const s = foldered();
    s.apply("addBone", { name: "other" });
    s.apply("addSlot", { bone: "other", name: "x" });
    s.apply("setFolder", { kind: "slot", items: ["armL", "x"], folder: "f" });
    s.apply("renameFolder", { kind: "slot", from: "f", to: "g", bone: "body" });
    expect(s.doc.skeleton.slots.find((x) => x.name === "armL")!.folder).toBe("g");
    expect(s.doc.skeleton.slots.find((x) => x.name === "x")!.folder).toBe("f");
  });

  it("builds a sorted folder tree that keeps item order", () => {
    const tree = folderTree(
      [
        { name: "a", folder: "z" },
        { name: "b" },
        { name: "c", folder: "m/n" },
        { name: "d", folder: "z" },
      ],
      ["empty"],
    );
    expect(tree.items.map((i) => i.name)).toEqual(["b"]);
    expect(tree.folders.map((f) => f.path)).toEqual(["empty", "m", "z"]);
    expect(tree.folders[2].items.map((i) => i.name)).toEqual(["a", "d"]);
    expect(tree.folders[1].folders[0].path).toBe("m/n");
  });

  it("does not change drawing or posing, and survives JSON and binary round trips", () => {
    const s = foldered();
    s.apply("addShape", { slot: "armL", name: "box", shape: "rect", fill: "#ff0000" });
    const pose = () => [s.doc.skeleton.slots.map((x) => x.name), [...setupWorld(s.doc).values()]];
    const before = pose();
    s.apply("setFolder", { kind: "slot", items: ["armL", "head"], folder: "body/parts" });
    expect(pose()).toEqual(before);
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    const bin = deserializeBinary(serializeBinary(s.doc));
    expect(bin.skeleton.slots[0].folder).toBe("body/parts");
    expect(JSON.parse(serialize(s.doc)).skeleton.slots[2].folder).toBe("body/parts");
  });
});

// ---------------- Import data ----------------

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function source(): OpenBoneDocument {
  const s = new DocumentStore(createDocument("hero"));
  s.apply("addBone", { name: "hip", y: 50, length: 40 });
  s.apply("addBone", { name: "leg", parent: "hip", rotation: -90, length: 60 });
  s.apply("addSlot", { bone: "leg", name: "legSlot" });
  s.apply("addImage", { id: "img_leg", name: "leg.png", src: PNG, width: 20, height: 60 });
  s.apply("addRegion", { slot: "legSlot", name: "leg", image: "img_leg" });
  s.apply("addMesh", { slot: "legSlot", name: "legMesh", image: "img_leg", activate: false });
  s.apply("autoWeights", { slot: "legSlot", attachment: "legMesh", bones: ["hip", "leg"] });
  s.apply("addSkin", { name: "armor" });
  s.apply("addRegion", { slot: "legSlot", skin: "armor", name: "leg", image: "img_leg", scaleX: 1.2 });
  s.apply("addEvent", { name: "footstep", int: 3 });
  s.apply("addAudio", { id: "aud_step", name: "step.wav", src: "data:audio/wav;base64,UklGRg==", duration: 0.2, sound: false });
  s.apply("addSound", { id: "snd_step", name: "step", asset: "aud_step" });
  s.apply("createAnimation", { name: "walk" });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "leg", property: "rotation", keys: [{ time: 0, value: -80 }, { time: 0.5, value: -100 }] });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "hip", property: "y", keys: [{ time: 0, value: 50 }] });
  s.apply("addEventKey", { animation: "walk", event: "footstep", time: 0.25 });
  s.apply("addAudioKey", { animation: "walk", sound: "step", time: 0.25 });
  s.apply("createAnimation", { name: "idle" });
  s.apply("setKeys", { animation: "idle", target: "bone", id: "hip", property: "y", keys: [{ time: 0, value: 52 }] });
  return s.doc;
}

function target() {
  const s = new DocumentStore(createDocument("game"));
  s.apply("addBone", { name: "hip", y: 40, length: 40 });
  s.apply("addSlot", { bone: "hip", name: "legSlot" });
  s.apply("createAnimation", { name: "walk" });
  return s;
}

describe("importData", () => {
  it("lists source items with their conflicts", () => {
    const c = importConflicts(target().doc, source());
    expect(c.animations.map((a) => [a.name, a.conflict])).toEqual([
      ["walk", true],
      ["idle", false],
    ]);
    expect(c.skins.find((k) => k.isDefault)!.conflict).toBe(false);
    expect(c.missingBones).toEqual(["root", "leg"].filter((n) => n !== "root"));
  });

  it("copies animations by bone and slot name, skipping what this project lacks, with events and sounds", () => {
    const s = target();
    const r = s.apply("importData", { document: source(), animations: ["walk", "idle"] }) as ImportReport;
    expect(r.animations.map((a) => [a.from, a.name])).toEqual([
      ["walk", "walk2"],
      ["idle", "idle"],
    ]);
    const walk = s.doc.animations.find((a) => a.name === "walk2")!;
    const hip = s.doc.skeleton.bones.find((b) => b.name === "hip")!;
    // The leg bone doesn't exist here: its keys are skipped and reported.
    expect(walk.timelines).toHaveLength(1);
    expect(walk.timelines[0]).toMatchObject({ target: "bone", id: hip.id, property: "y" });
    expect(r.skipped.join("\n")).toMatch(/bone "leg"/);
    // The event and the sound (with its audio file) come along.
    expect(s.doc.events.map((e) => e.name)).toEqual(["footstep"]);
    expect(walk.events[0].event).toBe(s.doc.events[0].id);
    expect(s.doc.audio!.sounds.map((x) => x.name)).toEqual(["step"]);
    expect(walk.audio![0].sound).toBe(s.doc.audio!.sounds[0].id);
    expect(s.doc.audio!.assets[0].id).toBe(s.doc.audio!.sounds[0].asset);
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    // One undo step removes it all.
    s.undo();
    expect(s.doc.animations.map((a) => a.name)).toEqual(["walk"]);
    expect(s.doc.events).toEqual([]);
  });

  it("replaces or skips a same-named animation", () => {
    const s = target();
    const id = s.doc.animations[0].id;
    s.apply("importData", { document: source(), animations: ["walk"], onConflict: "replace" });
    expect(s.doc.animations).toHaveLength(1);
    expect(s.doc.animations[0].id).toBe(id);
    expect(s.doc.animations[0].timelines).toHaveLength(1);
    const r = s.apply("importData", { document: serialize(source()), animations: ["walk"], onConflict: "skip" }) as ImportReport;
    expect(r.animations).toEqual([]);
    expect(r.skipped.join()).toMatch(/already exists/);
  });

  it("copies skins with their images; the default skin merges", () => {
    const s = target();
    s.apply("addBone", { name: "leg", parent: "hip", rotation: -90, length: 60 });
    const r = s.apply("importData", { document: source(), skins: ["default", "armor"] }) as ImportReport;
    const slot = s.doc.skeleton.slots[0].id;
    const def = s.doc.skeleton.skins[0];
    expect(Object.keys(def.attachments[slot]).sort()).toEqual(["leg", "legMesh"]);
    const mesh = def.attachments[slot].legMesh;
    expect(mesh.type === "mesh" && mesh.weights![0].every((w) => s.doc.skeleton.bones.some((b) => b.id === w.bone))).toBe(true);
    const armor = s.doc.skeleton.skins.find((k) => k.name === "armor")!;
    expect(armor.attachments[slot].leg).toMatchObject({ type: "region", scaleX: 1.2 });
    expect(s.doc.images.map((i) => i.name)).toEqual(["leg.png"]);
    expect(r.images).toEqual(["leg.png"]);
    // Again: the image is reused by name, the skin is renamed.
    s.apply("importData", { document: source(), skins: ["armor"] });
    expect(s.doc.images).toHaveLength(1);
    expect(s.doc.skeleton.skins.map((k) => k.name)).toEqual(["default", "armor", "armor2"]);
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("skips weighted meshes whose bones are missing", () => {
    const s = target();
    const r = s.apply("importData", { document: source(), skins: ["default"] }) as ImportReport;
    expect(Object.keys(s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id])).toEqual(["leg"]);
    expect(r.skipped.join()).toMatch(/weighted to bone "leg"/);
  });

  it("brings in a whole skeleton under a new root bone, with animations mapped onto it", () => {
    const s = target();
    const r = s.apply("importData", { document: source(), skeleton: true, animations: ["walk"] }) as ImportReport;
    const bones = s.doc.skeleton.bones;
    const root = bones.find((b) => b.name === "hero")!;
    expect(root.parent).toBe(bones[0].id);
    // Name conflicts are renamed: the target already has "hip" and "legSlot".
    const hip2 = bones.find((b) => b.name === "hip2")!;
    expect(bones.find((b) => b.name === "hip" && b.parent === root.id)).toBeUndefined();
    expect(bones.find((b) => b.name === "root2")!.parent).toBe(root.id);
    expect(s.doc.skeleton.slots.map((x) => x.name)).toEqual(["legSlot", "legSlot2"]);
    expect(r.bones).toBe(4);
    const walk = s.doc.animations.find((a) => a.name === "walk2")!;
    expect(walk.timelines).toHaveLength(2);
    expect(walk.timelines.some((t) => t.id === hip2.id)).toBe(true);
    const newSlot = s.doc.skeleton.slots[1].id;
    expect(Object.keys(s.doc.skeleton.skins[0].attachments[newSlot]).sort()).toEqual(["leg", "legMesh"]);
    expect(s.doc.skeleton.skins.find((k) => k.name === "armor")!.attachments[newSlot].leg).toBeDefined();
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    expect(setupWorld(s.doc).get(hip2.id)).toBeDefined();
  });

  it("refuses an empty pick and unknown names", () => {
    const s = target();
    expect(() => s.apply("importData", { document: source() })).toThrow(/Nothing to import/);
    expect(() => s.apply("importData", { document: source(), animations: ["fly"] })).toThrow(/not found/);
    expect(() => s.apply("importData", { document: { format: "x" }, animations: ["walk"] })).toThrow(/Not an OpenBone/);
  });
});

// ---------------- Weight tools ----------------

const m = (o: Record<string, number>) => new Map(Object.entries(o));
const obj = (x: Map<string, number>) => Object.fromEntries([...x].map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

describe("weight locks", () => {
  it("keeps locked bones and renormalises the others around them", () => {
    const v = m({ a: 0.5, b: 0.3, c: 0.2 });
    expect(setInfluence(v, "b", 0.4, new Set(["a"]))).toBe(true);
    expect(obj(v)).toEqual({ a: 0.5, b: 0.4, c: 0.1 });
    // Can't go beyond what the locked bones leave.
    setInfluence(v, "b", 1, new Set(["a"]));
    expect(obj(v)).toEqual({ a: 0.5, b: 0.5 });
    // Painting a locked bone does nothing.
    expect(setInfluence(v, "a", 0.1, new Set(["a"]))).toBe(false);
  });

  it("won't lower the only unlocked bone", () => {
    const v = m({ a: 0.6, b: 0.4 });
    expect(setInfluence(v, "b", 0.1, new Set(["a"]))).toBe(false);
    expect(obj(v)).toEqual({ a: 0.6, b: 0.4 });
    // Without locks it works as before.
    expect(setInfluence(v, "b", 0.1)).toBe(true);
    expect(obj(v)).toEqual({ a: 0.9, b: 0.1 });
  });

  it("puts locked weights back after a free-form tool", () => {
    const before = m({ a: 0.5, b: 0.5 });
    const after = m({ a: 0.2, b: 0.3, c: 0.5 });
    restoreLocked(after, before, new Set(["a"]));
    expect(after.get("a")).toBe(0.5);
    expect(after.get("b")!).toBeCloseTo(0.1875, 6);
    expect(after.get("c")!).toBeCloseTo(0.3125, 6);
    // Only locked bones left over: the vertex keeps its old weights.
    const lone = m({ a: 1 });
    restoreLocked(lone, m({ a: 0.5, b: 0.5 }), new Set(["a"]));
    expect(obj(lone)).toEqual({ a: 0.5, b: 0.5 });
  });

  it("swaps two bones on one vertex", () => {
    const v = m({ a: 0.7, b: 0.3 });
    expect(swapInfluence(v, "a", "b")).toBe(true);
    expect(obj(v)).toEqual({ a: 0.3, b: 0.7 });
    const w = m({ a: 1 });
    swapInfluence(w, "a", "c");
    expect(obj(w)).toEqual({ c: 1 });
    expect(swapInfluence(m({ x: 1 }), "a", "b")).toBe(false);
  });
});

describe("swapWeights op", () => {
  function meshDoc() {
    const s = new DocumentStore(createDocument("w"));
    s.apply("addBone", { name: "upper", rotation: -90, length: 50 });
    s.apply("addBone", { name: "lower", parent: "upper", x: 50, length: 50 });
    s.apply("addImage", { id: "img", name: "arm.png", src: PNG, width: 20, height: 100 });
    s.apply("addSlot", { bone: "upper", name: "arm" });
    s.apply("addMesh", { slot: "arm", name: "arm", image: "img" });
    s.apply("autoWeights", { slot: "arm", attachment: "arm", bones: ["upper", "lower"] });
    return s;
  }
  const weightsOf = (s: DocumentStore) => {
    const att = s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id].arm;
    if (att.type !== "mesh") throw new Error();
    const byName = new Map(s.doc.skeleton.bones.map((b) => [b.id, b.name]));
    return att.weights!.map((v) => Object.fromEntries(v.map((i) => [byName.get(i.bone), Math.round(i.weight * 1000) / 1000])));
  };

  it("swaps weights on every vertex or only the picked ones, keeping the mesh in place", () => {
    const s = meshDoc();
    const before = weightsOf(s);
    s.apply("swapWeights", { slot: "arm", attachment: "arm", from: "upper", to: "lower" });
    const after = weightsOf(s);
    after.forEach((w, i) => {
      expect(w.upper ?? 0).toBeCloseTo(before[i].lower ?? 0, 2);
      expect(w.lower ?? 0).toBeCloseTo(before[i].upper ?? 0, 2);
    });
    s.undo();
    s.apply("swapWeights", { slot: "arm", attachment: "arm", from: "upper", to: "lower", vertices: [0] });
    const one = weightsOf(s);
    expect(one[1]).toEqual(before[1]);
    expect(one[0].upper ?? 0).toBeCloseTo(before[0].lower ?? 0, 2);
    expect(() => s.apply("swapWeights", { slot: "arm", attachment: "arm", from: "upper", to: "upper" })).toThrow(/different/);
    expect(() => s.apply("swapWeights", { slot: "arm", attachment: "arm", from: "upper", to: "lower", vertices: [999] })).toThrow(/out of range/);
  });
});
