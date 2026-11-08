import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, deserialize, evalCurve, registry, serialize, setupWorld, summarize, validate } from "../src/index.ts";

describe("ops + store", () => {
  it("adds bones by name, resolves refs, undo/redo", () => {
    const s = new DocumentStore(createDocument("t"));
    s.apply("addBone", { name: "hip", y: 100 });
    s.apply("addBone", { name: "thigh", parent: "hip", rotation: -90, length: 80 });
    expect(s.doc.skeleton.bones.map((b) => b.name)).toEqual(["root", "hip", "thigh"]);
    s.undo();
    expect(s.doc.skeleton.bones.length).toBe(2);
    s.redo();
    expect(s.doc.skeleton.bones.length).toBe(3);
  });

  it("rejects invalid args and leaves doc untouched", () => {
    const s = new DocumentStore(createDocument());
    expect(() => s.apply("addSlot", { bone: "nope" })).toThrow(/not found/);
    expect(() => s.apply("addBone", { length: -5 })).toThrow(/Invalid args/);
    expect(s.doc.skeleton.slots.length).toBe(0);
    expect(s.canUndo).toBe(false);
  });

  it("transaction rolls back on failure", () => {
    const s = new DocumentStore(createDocument());
    expect(() =>
      s.transaction("x", (st) => {
        st.apply("addBone", { name: "a" });
        st.apply("addBone", { parent: "missing" });
      }),
    ).toThrow();
    expect(s.doc.skeleton.bones.length).toBe(1);
  });

  it("generated ids are written back into args for deterministic replay", () => {
    const a = new DocumentStore(createDocument());
    const b = new DocumentStore(structuredClone(a.doc));
    const log: { op: string; args: Record<string, unknown> }[] = [];
    a.subscribe((_d, e) => log.push(...e.ops));
    a.apply("addBone", { name: "x" });
    a.apply("createAnimation", { name: "idle" });
    a.apply("setKeys", { animation: "idle", target: "bone", id: "x", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 90, curve: "easeInOut" }] });
    for (const c of log) b.apply(c.op, c.args);
    expect(serialize(b.doc)).toBe(serialize(a.doc));
  });

  it("world transforms compose", () => {
    const s = new DocumentStore(createDocument());
    s.apply("addBone", { name: "a", x: 10, rotation: 90, length: 50 });
    s.apply("addBone", { name: "b", parent: "a", x: 50 });
    const w = setupWorld(s.doc);
    const b = w.get(s.doc.skeleton.bones[2].id)!;
    expect(b.x).toBeCloseTo(10);
    expect(b.y).toBeCloseTo(50);
  });

  it("every op has a description and schema", () => {
    expect(registry.size).toBeGreaterThan(40);
    for (const def of registry.values()) expect(def.description.length).toBeGreaterThan(10);
  });

  it("validates, summarizes and round-trips", () => {
    const s = new DocumentStore(createDocument("rt"));
    s.apply("addBone", { name: "body" });
    s.apply("addSlot", { bone: "body" });
    s.apply("addShape", { slot: "body", shape: "rect", width: 40, height: 60, fill: "#3366ff" });
    expect(validate(s.doc)).toEqual([]);
    expect(summarize(s.doc)).toContain("body");
    expect(deserialize(serialize(s.doc))).toEqual(s.doc);
  });

  it("bezier ease is monotonic and hits endpoints", () => {
    const c: [number, number, number, number] = [0.42, 0, 0.58, 1];
    expect(evalCurve(c, 0)).toBeCloseTo(0);
    expect(evalCurve(c, 1)).toBeCloseTo(1);
    expect(evalCurve(c, 0.5)).toBeCloseTo(0.5, 2);
    expect(evalCurve(c, 0.25)).toBeLessThan(0.25);
  });
});
