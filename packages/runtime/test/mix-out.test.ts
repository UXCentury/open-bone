import { DocumentStore, createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { AnimationState, OpenBoneInstance, Skeleton } from "../src/index.ts";

/** An idle that doesn't key the foot and a walk that strides it (±60 px), like the knight before its workaround. */
function walker() {
  const s = new DocumentStore(createDocument("walker"));
  s.apply("addBone", { name: "hip", y: 100 });
  s.apply("addBone", { name: "foot", parent: "hip", y: -100 });
  s.apply("addSlot", { name: "body", bone: "hip" });
  s.apply("createAnimation", { name: "idle", duration: 1 });
  s.apply("setKeys", { animation: "idle", target: "bone", id: "hip", property: "y", keys: [{ time: 0, value: 100 }, { time: 0.5, value: 96 }, { time: 1, value: 100 }] });
  s.apply("createAnimation", { name: "walk", duration: 1 });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "hip", property: "y", keys: [{ time: 0, value: 104 }, { time: 1, value: 104 }] });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "foot", property: "x", keys: [{ time: 0, value: -60 }, { time: 0.5, value: 60 }, { time: 1, value: -60 }] });
  s.apply("setKeys", { animation: "walk", target: "slot", id: "body", property: "color", keys: [{ time: 0, value: "#ff0000ff" }] });
  s.apply("createStateMachine", { name: "sm" });
  s.apply("addInput", { stateMachine: "sm", name: "walking", type: "bool", default: true });
  s.apply("addState", { stateMachine: "sm", name: "walk", animation: "walk" });
  s.apply("addState", { stateMachine: "sm", name: "idle", animation: "idle" });
  s.apply("addTransition", { stateMachine: "sm", from: "walk", to: "idle", duration: 0.2, conditions: [{ input: "walking", op: "==", value: false }] });
  return s.doc;
}

const DT = 1 / 600; // the stride moves 0.4 px per step, the 0.2 s fade back to the stance at most ~0.6 px

describe("cross-fades: what only the outgoing animation keys fades back to the pose underneath", () => {
  it("walk → idle in a state machine eases the foot to its setup place (no snap when the fade ends)", () => {
    const doc = walker();
    const inst = new OpenBoneInstance(doc);
    const sm = inst.useStateMachine("sm");
    const foot = () => inst.skeleton.bones.find((b) => b.data.name === "foot")!;
    for (let i = 0; i < 0.45 / DT; i++) inst.advance(DT); // near the end of the stride: foot at about +48
    expect(foot().x).toBeGreaterThan(40);
    sm.setInput("walking", false);
    let prev = foot().worldX;
    let maxJump = 0;
    for (let i = 0; i < 0.5 / DT; i++) {
      inst.advance(DT);
      maxJump = Math.max(maxJump, Math.abs(foot().worldX - prev));
      prev = foot().worldX;
    }
    expect(Object.values(sm.activeStates)[0]).toBe("idle");
    expect(maxJump).toBeLessThan(1);
    expect(foot().x).toBe(0);
    // The slot colour only walk keys fades back to white the same way.
    expect(inst.skeleton.slots[0].color).toEqual([1, 1, 1, 1]);
  });

  it("half-way through the fade an un-keyed value is half-way between the old value and setup", () => {
    const doc = walker();
    const inst = new OpenBoneInstance(doc);
    const sm = inst.useStateMachine("sm");
    inst.advance(0.25); // foot x = 0 at 0.25 s; step to the peak
    inst.advance(0.25); // foot x = 60
    sm.setInput("walking", false);
    inst.advance(0); // take the transition
    inst.advance(0.1); // half the fade; walk keeps playing (0.6 s: x = 60 - 24 = 36)
    const foot = inst.skeleton.bones.find((b) => b.data.name === "foot")!;
    expect(foot.x).toBeCloseTo(18, 6);
    const [r, g] = inst.skeleton.slots[0].color;
    expect(r).toBeCloseTo(1, 6);
    expect(g).toBeCloseTo(0.5, 6);
  });

  it("AnimationState mixes fade the outgoing animation's own timelines the same way", () => {
    const doc = walker();
    const sk = new Skeleton(doc);
    const state = new AnimationState(sk);
    state.setAnimation(0, "walk");
    const foot = sk.bones.find((b) => b.data.name === "foot")!;
    const pose = () => {
      sk.setToSetupPose();
      state.apply();
      sk.updateWorldTransform();
      return foot.worldX;
    };
    for (let i = 0; i < 0.3 / DT; i++) {
      state.update(DT);
      pose();
    }
    state.setAnimation(0, "idle", true, 0.2);
    let prev = pose();
    let maxJump = 0;
    for (let i = 0; i < 0.5 / DT; i++) {
      state.update(DT);
      const x = pose();
      maxJump = Math.max(maxJump, Math.abs(x - prev));
      prev = x;
    }
    expect(maxJump).toBeLessThan(1);
    expect(foot.x).toBe(0);
  });
});
