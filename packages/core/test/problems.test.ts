import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, findProblems, validate } from "../src/index.ts";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function rig() {
  const s = new DocumentStore(createDocument("t"));
  s.apply("addBone", { name: "a", length: 40 });
  s.apply("addBone", { name: "b", x: 50, length: 40 });
  s.apply("addBone", { name: "c", x: 100, length: 40 });
  return s;
}

describe("transform mapping and volume ops", () => {
  it("stores only what changes the result, with defaults filled in", () => {
    const s = rig();
    s.apply("addTransformConstraint", { name: "tc", bones: ["b"], target: "a", map: [{ from: "x", to: "rotation" }] });
    const tc = s.doc.skeleton.transform[0];
    expect(tc.map).toEqual([{ from: "x", to: "rotation", scale: 1, offset: 0 }]);
    expect("localSource" in tc).toBe(false);
    s.apply("updateTransformConstraint", { constraint: "tc", localSource: true, map: [{ from: "y", to: "scaleX", scale: 0.01, offset: 1, min: 0.5, max: 2 }] });
    expect(tc.map).toEqual([{ from: "y", to: "scaleX", scale: 0.01, offset: 1, min: 0.5, max: 2 }]);
    expect(tc.localSource).toBe(true);
    s.apply("updateTransformConstraint", { constraint: "tc", map: [] });
    expect("map" in tc).toBe(false);
    expect("localSource" in tc).toBe(false);
  });

  it("keeps volume off the file unless it is on", () => {
    const s = rig();
    s.apply("addIkConstraint", { name: "ik", bones: ["b"], target: "c", stretch: true });
    s.apply("addPhysicsConstraint", { name: "ph", bone: "a", scaleX: 1, volume: true });
    expect("volume" in s.doc.skeleton.ik[0]).toBe(false);
    expect(s.doc.skeleton.physics[0].volume).toBe(true);
    s.apply("updateIkConstraint", { constraint: "ik", volume: true });
    expect(s.doc.skeleton.ik[0].volume).toBe(true);
    s.apply("updatePhysicsConstraint", { constraint: "ph", volume: false });
    expect("volume" in s.doc.skeleton.physics[0]).toBe(false);
  });
});

describe("problems", () => {
  it("offers a working fix for a reversed mapping clamp", () => {
    const s = rig();
    s.apply("addTransformConstraint", { name: "tc", bones: ["b"], target: "a", map: [{ from: "x", to: "rotation", min: 10, max: -10 }] });
    const issue = validate(s.doc).find((i) => i.message.includes("above max"))!;
    expect(issue.ref).toEqual({ kind: "transform", id: s.doc.skeleton.transform[0].id });
    expect(issue.fix!.tool).toBe("update_transform_constraint");
    s.apply(issue.fix!.op, issue.fix!.args);
    expect(s.doc.skeleton.transform[0].map![0]).toMatchObject({ min: -10, max: 10 });
    expect(validate(s.doc).some((i) => i.message.includes("above max"))).toBe(false);
  });

  it("removes keys left pointing at deleted things", () => {
    const s = rig();
    s.apply("createAnimation", { name: "go" });
    s.apply("setKeys", { animation: "go", target: "bone", id: "b", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 90 }] });
    s.apply("setKeys", { animation: "go", target: "bone", id: "c", property: "x", keys: [{ time: 0, value: 100 }] });
    // A hand edit (or a merge) deletes bone b without its timelines.
    s.doc.skeleton.bones = s.doc.skeleton.bones.filter((b) => b.name !== "b");
    const broken = validate(s.doc).filter((i) => i.fix?.op === "removeBrokenKeys");
    expect(broken.length).toBe(1);
    expect(s.apply(broken[0].fix!.op, broken[0].fix!.args)).toEqual({ removed: 1 });
    expect(s.doc.animations[0].timelines.map((t) => t.id)).toEqual([s.doc.skeleton.bones.find((b) => b.name === "c")!.id]);
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("hints at unused images, empty skins and settings with no effect, each with a fix", () => {
    const s = rig();
    s.apply("addImage", { name: "spare", src: PIXEL, width: 1, height: 1 });
    s.apply("addSkin", { name: "blue" });
    s.apply("addIkConstraint", { name: "ik", bones: ["b"], target: "c", stretch: true, uniform: true, volume: true });
    s.apply("addTransformConstraint", { name: "tc", bones: ["c"], target: "a", mixScale: 0, map: [{ from: "x", to: "scaleX" }] });
    const hints = findProblems(s.doc).filter((p) => p.hint);
    const fixes = hints.map((h) => h.fix?.op);
    expect(fixes).toEqual(expect.arrayContaining(["deleteImage", "deleteSkin", "updateIkConstraint", "updateTransformConstraint"]));
    for (const h of hints) if (h.fix) s.apply(h.fix.op, h.fix.args);
    expect(findProblems(s.doc).filter((p) => p.hint && p.fix)).toEqual([]);
    expect(s.doc.skeleton.transform[0].mixScale).toBe(1);
  });
});
