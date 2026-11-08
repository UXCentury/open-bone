import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, exportDocument, validate } from "../src/index.ts";

function project() {
  const s = new DocumentStore(createDocument("exp"));
  s.apply("addBone", { name: "arm" });
  s.apply("addImage", { name: "used", src: "data:,a", width: 10, height: 10 });
  s.apply("addImage", { name: "unused", src: "data:,b", width: 10, height: 10 });
  s.apply("addSlot", { bone: "arm", name: "arm" });
  s.apply("addRegion", { slot: "arm", image: "used" });
  s.apply("addEvent", { name: "step" });
  s.apply("addEvent", { name: "orphan" });
  s.apply("createAnimation", { name: "idle" });
  s.apply("createAnimation", { name: "walk" });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "arm", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 30 }] });
  s.apply("addEventKey", { animation: "walk", event: "step", time: 0.5 });
  s.apply("addScript", { name: "fx", code: "function onStart(){}" });
  s.apply("createStateMachine", { name: "ui" });
  s.apply("addState", { stateMachine: "ui", animation: "idle" });
  s.apply("addState", { stateMachine: "ui", animation: "walk" });
  s.apply("attachScript", { stateMachine: "ui", script: "fx" });
  const id = (list: { id: string; name: string }[], n: string) => list.find((x) => x.name === n)!.id;
  return { doc: s.doc, id };
}

describe("exportDocument", () => {
  it("exports everything by default, pruning only unused images and events", () => {
    const { doc } = project();
    const r = exportDocument(doc);
    expect(r.warnings).toEqual([]);
    expect(r.doc.animations).toHaveLength(2);
    expect(r.doc.images.map((i) => i.name)).toEqual(["used"]);
    expect(r.doc.events.map((e) => e.name)).toEqual(["step"]);
    expect(validate(r.doc).filter((i) => i.level === "error")).toEqual([]);
    expect(r.stats).toMatchObject({ animations: 2, stateMachines: 1, scripts: 1, images: 1 });
  });

  it("does not modify the source document", () => {
    const { doc } = project();
    const before = JSON.stringify(doc);
    exportDocument(doc, { animations: [], stateMachines: [], scripts: [] });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("animations only: drops state machines and scripts, keeps the rig", () => {
    const { doc, id } = project();
    const r = exportDocument(doc, { animations: [id(doc.animations, "walk")], stateMachines: [], scripts: [] });
    expect(r.doc.animations.map((a) => a.name)).toEqual(["walk"]);
    expect(r.doc.stateMachines).toEqual([]);
    expect(r.doc.scripts).toEqual([]);
    expect(r.doc.skeleton.bones.map((b) => b.name)).toEqual(["root", "arm"]);
    expect(r.warnings).toEqual([]);
  });

  it("cuts references to left-out animations and scripts with warnings, staying valid", () => {
    const { doc, id } = project();
    const r = exportDocument(doc, { animations: [id(doc.animations, "idle")], scripts: [] });
    const states = r.doc.stateMachines[0].layers[0].states;
    expect(states.find((s) => s.name === "walk")!.animation).toBeUndefined();
    expect(r.doc.stateMachines[0].scripts).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/played animation "walk"/);
    expect(r.warnings.join("\n")).toMatch(/ran script "fx"/);
    expect(r.doc.events).toEqual([]);
    expect(validate(r.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("can keep unused assets", () => {
    const { doc } = project();
    const r = exportDocument(doc, { pruneUnused: false });
    expect(r.doc.images).toHaveLength(2);
    expect(r.doc.events).toHaveLength(2);
  });
});

describe("export options", () => {
  it("animation clean up drops redundant keys and setup-pose timelines", async () => {
    const { DocumentStore, createDocument, exportDocument } = await import("../src/index.ts");
    const s = new DocumentStore(createDocument("c"));
    s.apply("addBone", { name: "arm", rotation: 10 });
    s.apply("createAnimation", { name: "a" });
    const k = (property: string, keys: [number, number][]) =>
      s.apply("setKeys", { animation: "a", target: "bone", id: "arm", property, keys: keys.map(([time, value]) => ({ time, value })) });
    k("rotation", [[0, 0], [0.5, 30], [1, 30], [1.5, 30], [2, 0]]); // the key at 1 is redundant
    k("x", [[0, 0], [1, 0]]); // equals setup x = 0 → whole timeline removed
    k("scaleX", [[0, 2], [1, 2]]); // constant but not setup → kept
    const r = exportDocument(s.doc, { cleanUpAnimations: true });
    const tls = r.doc.animations[0].timelines;
    expect(tls.map((t) => t.property).sort()).toEqual(["rotation", "scaleX"]);
    expect(tls.find((t) => t.property === "rotation")!.keys.map((x) => x.time)).toEqual([0, 0.5, 1.5, 2]);
    expect(r.stats.removedKeys).toBe(3);
    // Off by default.
    expect(exportDocument(s.doc).doc.animations[0].timelines).toHaveLength(3);
  });

  it("nonessential data can be left out", async () => {
    const { DocumentStore, createDocument, exportDocument } = await import("../src/index.ts");
    const s = new DocumentStore(createDocument("n"));
    s.apply("addBone", { name: "arm", color: "#ff0000" });
    s.apply("createStateMachine", { name: "ui" });
    s.apply("addState", { stateMachine: "ui", name: "idle", x: 300, y: 120 });
    const lean = exportDocument(s.doc, { nonessential: false }).doc;
    expect(lean.skeleton.bones[1].color).toBeUndefined();
    expect(lean.stateMachines[0].layers[0].states[0]).toMatchObject({ x: 0, y: 0 });
    expect(exportDocument(s.doc).doc.skeleton.bones[1].color).toBe("#ff0000");
  });
});
