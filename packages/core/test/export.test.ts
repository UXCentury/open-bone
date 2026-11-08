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
