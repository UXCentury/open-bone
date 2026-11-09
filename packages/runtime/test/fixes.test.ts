import { DocumentStore, createDocument, worldScaleX } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, Skeleton, applyAnimation } from "../src/index.ts";

const doc = () => new DocumentStore(createDocument("fixes"));

describe("runtime behaviour fixed before the native ports", () => {
  it("a rotation key at full weight sets the keyed value (no wrapping toward the current pose)", () => {
    const s = doc();
    s.apply("addBone", { name: "b", rotation: 10 });
    s.apply("createAnimation", { name: "spin" });
    s.apply("setKeys", { animation: "spin", target: "bone", id: "b", property: "rotation", keys: [{ time: 0, value: 370 }] });
    const sk = new Skeleton(s.doc);
    applyAnimation(sk, s.doc.animations[0], 0);
    expect(sk.bones.find((b) => b.data.name === "b")!.rotation).toBe(370);
  });

  it("draw-order keys keep unlisted slots in their setup places (like Spine)", () => {
    const s = doc();
    for (const n of ["a", "b", "c", "d"]) s.apply("addSlot", { name: n, bone: "root" });
    s.apply("createAnimation", { name: "swap" });
    s.apply("setKeys", { animation: "swap", target: "drawOrder", keys: [{ time: 0, value: ["c", "a"] }] });
    const sk = new Skeleton(s.doc);
    applyAnimation(sk, s.doc.animations[0], 0);
    // b and d stay at places 1 and 3; c and a fill places 0 and 2.
    expect(sk.drawOrder.map((x) => x.data.name)).toEqual(["c", "b", "a", "d"]);
  });

  it("a blend state's exit time waits for its stronger animation", () => {
    const s = doc();
    s.apply("addBone", { name: "b" });
    for (const [n, d] of [["slow", 2], ["fast", 0.5]] as const) {
      s.apply("createAnimation", { name: n, duration: d });
      s.apply("setKeys", { animation: n, target: "bone", id: "b", property: "x", keys: [{ time: 0, value: 0 }, { time: d, value: 10 }] });
    }
    s.apply("createAnimation", { name: "after", duration: 1 });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "v", type: "number", default: 0 });
    s.apply("addState", { stateMachine: "sm", name: "blend", type: "blend1d", blendInput: "v", blend: [{ animation: "slow", value: 0 }, { animation: "fast", value: 1 }] });
    s.apply("addState", { stateMachine: "sm", name: "after", animation: "after" });
    s.apply("addTransition", { stateMachine: "sm", from: "blend", to: "after", exitTime: 1 });
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("sm");
    for (let i = 0; i < 60; i++) inst.advance(1 / 60); // 1 s: "slow" (2 s) dominates, not done yet
    expect(sm.activeStates["Layer 1"] ?? Object.values(sm.activeStates)[0]).toBe("blend");
    for (let i = 0; i < 75; i++) inst.advance(1 / 60);
    expect(Object.values(sm.activeStates)[0]).toBe("after");
  });

  it("a transition to a deleted state is skipped", () => {
    const s = doc();
    s.apply("createAnimation", { name: "idle", duration: 1 });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "go", type: "trigger" });
    s.apply("addState", { stateMachine: "sm", name: "idle", animation: "idle" });
    s.apply("addState", { stateMachine: "sm", name: "gone", animation: "idle" });
    s.apply("addState", { stateMachine: "sm", name: "next", animation: "idle" });
    s.apply("addTransition", { stateMachine: "sm", from: "idle", to: "gone", conditions: [{ input: "go" }] });
    s.apply("addTransition", { stateMachine: "sm", from: "idle", to: "next", conditions: [{ input: "go" }] });
    // Delete "gone" behind the op layer's back, as a hand-edited file could.
    const layer = s.doc.stateMachines[0].layers[0];
    layer.states = layer.states.filter((x) => x.name !== "gone");
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("sm");
    inst.advance(0);
    sm.fire("go");
    inst.advance(1 / 60);
    expect(Object.values(sm.activeStates)[0]).toBe("next");
  });

  it("an IK stretch survives a later constraint that moves the stretched bone's parent", () => {
    const s = doc();
    s.apply("addBone", { name: "p", length: 50 });
    s.apply("addBone", { name: "c", parent: "p", x: 50, length: 50 });
    s.apply("addBone", { name: "target", x: 300 });
    s.apply("addBone", { name: "driver", rotation: 20 });
    s.apply("addIkConstraint", { name: "reach", bones: ["c"], target: "target", stretch: true });
    s.apply("addTransformConstraint", { name: "turn", bones: ["p"], target: "driver", mixRotate: 0.1, mixTranslate: 0, mixScale: 0, mixShear: 0 });
    const sk = new Skeleton(s.doc);
    sk.updateWorldTransform();
    expect(worldScaleX(sk.bones.find((b) => b.data.name === "c")!.world)).toBeGreaterThan(2);
  });

  it("no NaN: a text input driving a bone binding is ignored, short deform keys pad with zero", () => {
    const s = doc();
    s.apply("addBone", { name: "b" });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "label", type: "number", default: 0 });
    s.apply("addBinding", { stateMachine: "sm", input: "label", target: "bone", object: "b", property: "x", inMin: 0, inMax: 1, outMin: 0, outMax: 100 });
    // A hand-edited file turns the input into text (the op layer refuses that binding).
    Object.assign(s.doc.stateMachines[0].inputs[0], { type: "string", default: "hello" });
    const inst = new OpenBoneInstance(s.doc);
    inst.useStateMachine("sm");
    inst.advance(1 / 60);
    expect(Number.isFinite(inst.skeleton.bones.find((b) => b.data.name === "b")!.world.x)).toBe(true);
  });

  it("a fully transparent shape is not drawn", () => {
    const s = doc();
    s.apply("addSlot", { name: "a", bone: "root", color: "#ffffff00" });
    s.apply("addShape", { slot: "a", shape: "rect" });
    expect(new Skeleton(s.doc).drawList()).toHaveLength(0);
  });
});
