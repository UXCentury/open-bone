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

describe("constraints (ops, validation, migration)", () => {
  function rig() {
    const s = new DocumentStore(createDocument("c"));
    s.apply("addBone", { name: "a", length: 40 });
    s.apply("addBone", { name: "b", parent: "a", x: 40, length: 40 });
    s.apply("addBone", { name: "guide", y: 50, length: 0 });
    s.apply("addSlot", { bone: "guide", name: "track" });
    s.apply("addPath", { slot: "track", anchors: [0, 0, 100, 0] });
    return s;
  }

  it("old documents get the new constraint lists and fields", () => {
    const d = createDocument("old") as unknown as { skeleton: Record<string, unknown> };
    delete d.skeleton.path;
    delete d.skeleton.physics;
    (d.skeleton.ik as unknown[]).push({ id: "ik1", name: "ik", bones: [], target: "x", mix: 1, bendPositive: true });
    const back = deserialize(JSON.stringify(d));
    expect(back.skeleton.path).toEqual([]);
    expect(back.skeleton.physics).toEqual([]);
    expect(back.skeleton.ik[0]).toMatchObject({ softness: 0, stretch: false, compress: false });
  });

  it("path constraint ops sort bones, reject cycles, update and delete with timelines", () => {
    const s = rig();
    s.apply("addPathConstraint", { name: "p", bones: ["b", "a"], target: "track" });
    const id = (n: string) => s.doc.skeleton.bones.find((b) => b.name === n)!.id;
    expect(s.doc.skeleton.path[0].bones).toEqual([id("a"), id("b")]);
    expect(() => s.apply("addPathConstraint", { bones: ["guide"], target: "track" })).toThrow(/slot bone/);
    s.apply("updatePathConstraint", { constraint: "p", rotateMode: "chain", spacing: 3 });
    expect(s.doc.skeleton.path[0]).toMatchObject({ rotateMode: "chain", spacing: 3 });
    s.apply("createAnimation", { name: "anim" });
    s.apply("setKeys", { animation: "anim", target: "path", id: "p", property: "mixX", keys: [{ time: 0, value: 0.5 }] });
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    s.apply("deleteConstraint", { constraint: "p" });
    expect(s.doc.skeleton.path).toEqual([]);
    expect(s.doc.animations[0].timelines).toEqual([]);
  });

  it("physics and transform ops; deleting a bone drops its constraints", () => {
    const s = rig();
    s.apply("addPhysicsConstraint", { name: "ph", bone: "b", gravity: 50 });
    s.apply("updatePhysicsConstraint", { constraint: "ph", wind: 10, mix: 0.5 });
    expect(s.doc.skeleton.physics[0]).toMatchObject({ gravity: 50, wind: 10, mix: 0.5, fps: 60 });
    s.apply("addTransformConstraint", { name: "tc", bones: ["b"], target: "guide", mixShear: 0.5, local: true });
    s.apply("updateTransformConstraint", { constraint: "tc", relative: true, offsetShear: 4 });
    expect(s.doc.skeleton.transform[0]).toMatchObject({ mixShear: 0.5, local: true, relative: true, offsetShear: 4 });
    expect(() => s.apply("updateTransformConstraint", { constraint: "tc", target: "b" })).toThrow();
    s.apply("deleteBone", { bone: "b" });
    expect(s.doc.skeleton.physics).toEqual([]);
    expect(s.doc.skeleton.transform).toEqual([]);
  });

  it("validate flags broken path constraints", () => {
    const s = rig();
    s.apply("addPathConstraint", { name: "p", bones: ["a", "b"], target: "track" });
    s.doc.skeleton.path[0].bones.reverse();
    s.doc.skeleton.path[0].target = "nope";
    const msgs = validate(s.doc).map((i) => i.message);
    expect(msgs.some((m) => m.includes("target slot"))).toBe(true);
    s.doc.skeleton.path[0].target = s.doc.skeleton.slots[0].id;
    expect(validate(s.doc).some((i) => i.message.includes("parent before child"))).toBe(true);
    expect(summarize(s.doc)).toContain("Path p");
  });
});
