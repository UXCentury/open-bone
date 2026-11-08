import { DocumentStore, createDocument, validate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, Skeleton } from "../src/index.ts";

/** A shoulder (driver) and a shadow bone moved by the "shadow" animation (x 0 → 100 over 1 s). */
function rig() {
  const s = new DocumentStore(createDocument("slider"));
  s.apply("addBone", { name: "shoulder", length: 50 });
  s.apply("addBone", { name: "shadow", x: 10, length: 20 });
  s.apply("createAnimation", { name: "shadow", duration: 1 });
  s.apply("setKeys", { animation: "shadow", target: "bone", id: "shadow", property: "x", keys: [{ time: 0, value: 0, curve: "linear" }, { time: 1, value: 100, curve: "linear" }] });
  return s;
}
const shadowX = (sk: Skeleton) => sk.findBone("shadow")!.world.x;

describe("sliders", () => {
  it("a bone's rotation scrubs the animation (range maps to time, clamped)", () => {
    const s = rig();
    s.apply("addSlider", { name: "sh", animation: "shadow", bone: "shoulder", property: "rotation", from: 0, to: 90 });
    const sk = new Skeleton(s.doc);
    const at = (deg: number) => {
      sk.setToSetupPose();
      sk.findBone("shoulder")!.rotation = deg;
      sk.updateWorldTransform();
      return shadowX(sk);
    };
    expect(at(0)).toBeCloseTo(0, 5);
    expect(at(45)).toBeCloseTo(50, 5);
    expect(at(90)).toBeCloseTo(100, 5);
    expect(at(180)).toBeCloseTo(100, 5); // clamped
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("time range, loop, mix and additive", () => {
    const s = rig();
    s.apply("addSlider", { name: "sh", animation: "shadow", bone: "shoulder", from: 0, to: 100, timeFrom: 0.5, timeTo: 1, mix: 0.5 });
    const sk = new Skeleton(s.doc);
    const at = (deg: number) => {
      sk.setToSetupPose();
      sk.findBone("shoulder")!.rotation = deg;
      sk.updateWorldTransform();
      return shadowX(sk);
    };
    // driver 0 → time 0.5 → x 50, mixed 50% with setup x 10 → 30
    expect(at(0)).toBeCloseTo(30, 5);
    s.apply("updateSlider", { slider: "sh", loop: true, mix: 1, timeFrom: null, timeTo: null });
    const sk2 = new Skeleton(s.doc);
    sk2.findBone("shoulder")!.rotation = 150; // wraps to 0.5 of the range
    sk2.updateWorldTransform();
    expect(shadowX(sk2)).toBeCloseTo(50, 5);
    // Additive: the change from setup (x 10 → 50 = +40) on top of a posed shadow at x 200.
    s.apply("updateSlider", { slider: "sh", loop: false, additive: true });
    const sk3 = new Skeleton(s.doc);
    sk3.findBone("shoulder")!.rotation = 50;
    sk3.findBone("shadow")!.x = 200;
    sk3.updateWorldTransform();
    expect(shadowX(sk3)).toBeCloseTo(200 + 50 - 10, 5);
  });

  it("a number input drives a slider through a state machine; deleting things cleans up", () => {
    const s = rig();
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "amount", type: "number", default: 0 });
    s.apply("addSlider", { name: "byInput", animation: "shadow", input: "amount", from: 0, to: 10 });
    expect(() => s.apply("addSlider", { animation: "shadow" })).toThrow(/driver/);
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("sm");
    sm.setInput("amount", 2.5);
    sm.advance(1 / 60);
    expect(shadowX(inst.skeleton)).toBeCloseTo(25, 5);
    s.apply("deleteInput", { stateMachine: "sm", input: "amount" });
    expect(s.doc.skeleton.sliders).toBeUndefined();
    s.apply("addSlider", { name: "b", animation: "shadow", bone: "shoulder" });
    s.apply("deleteAnimation", { animation: "shadow" });
    expect(s.doc.skeleton.sliders).toBeUndefined();
  });
});
