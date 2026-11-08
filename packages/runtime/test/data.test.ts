import { DocumentStore, createDocument, formatTemplate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, Skeleton, type TextContext, drawTextBox } from "../src/index.ts";

/** Crash-game flow: idle → flyout (once) → flying (loop) → crash | cashout (once) → idle. */
function crash() {
  const s = new DocumentStore(createDocument("crash"));
  s.apply("addBone", { name: "rocket", length: 40 });
  s.apply("addBone", { name: "aim", x: 100 });
  s.apply("addSlot", { bone: "rocket", name: "label" });
  s.apply("addText", { slot: "label", text: "{multiplier:0.00}x", width: 200, height: 50, x: 10 });
  const anim = (name: string, duration: number, y: number) => {
    s.apply("createAnimation", { name, duration });
    s.apply("setKeys", { animation: name, target: "bone", id: "rocket", property: "x", keys: [{ time: 0, value: y }, { time: duration, value: y }] });
  };
  anim("idle", 1, 0);
  anim("flyout", 0.5, 1);
  anim("flying", 1, 2);
  anim("crash", 0.4, 3);
  anim("cashout", 0.4, 4);
  s.apply("createStateMachine", { name: "game" });
  for (const n of ["start", "crash", "cashout"]) s.apply("addInput", { stateMachine: "game", name: n, type: "trigger" });
  s.apply("addInput", { stateMachine: "game", name: "multiplier", type: "number", default: 1 });
  s.apply("addInput", { stateMachine: "game", name: "player", type: "string", default: "Ada" });
  s.apply("addState", { stateMachine: "game", animation: "idle" });
  s.apply("addState", { stateMachine: "game", animation: "flying" });
  s.apply("addState", { stateMachine: "game", animation: "flyout", loop: false, onComplete: "flying" });
  s.apply("addState", { stateMachine: "game", animation: "crash", loop: false, onComplete: "idle" });
  s.apply("addState", { stateMachine: "game", animation: "cashout", loop: false, onComplete: "idle" });
  const t = (from: string, to: string, input: string) =>
    s.apply("addTransition", { stateMachine: "game", from, to, conditions: [{ input }], duration: 0 });
  t("idle", "flyout", "start");
  for (const from of ["flyout", "flying"]) {
    t(from, "crash", "crash");
    t(from, "cashout", "cashout");
  }
  return s;
}

const state = (sm: { activeStates: Record<string, string | null> }) => sm.activeStates["Layer 1"];

describe("staged flow", () => {
  it("plays flyout once, loops flying, then branches to crash or cashout and back to idle", () => {
    const inst = new OpenBoneInstance(crash().doc);
    const sm = inst.useStateMachine("game");
    const seen: string[] = [];
    inst.on("stateChange", (e) => seen.push(e.to));
    sm.advance(0.1);
    expect(state(sm)).toBe("idle");
    sm.fire("start");
    sm.advance(0.1);
    expect(state(sm)).toBe("flyout");
    for (let i = 0; i < 5; i++) sm.advance(0.1);
    expect(state(sm)).toBe("flying");
    for (let i = 0; i < 30; i++) sm.advance(0.1); // loops for 3 s, stays
    expect(state(sm)).toBe("flying");
    sm.fire("crash");
    sm.advance(0.05);
    expect(state(sm)).toBe("crash");
    for (let i = 0; i < 5; i++) sm.advance(0.1);
    expect(state(sm)).toBe("idle");

    sm.fire("start");
    sm.advance(0.1);
    sm.fire("cashout"); // interrupts the flyout
    sm.advance(0.05);
    expect(state(sm)).toBe("cashout");
    expect(seen).toEqual(["idle", "flyout", "flying", "crash", "idle", "flyout", "cashout"]);
  });

  it("a state can reset inputs when entered (back to idle after a round)", () => {
    const s = crash();
    s.apply("setStateInput", { stateMachine: "game", state: "idle", input: "multiplier", value: 1 });
    s.apply("setStateInput", { stateMachine: "game", state: "idle", input: "player", value: "Next" });
    expect(() => s.apply("setStateInput", { stateMachine: "game", state: "idle", input: "start", value: true })).toThrow(/trigger/);
    const sm = new OpenBoneInstance(s.doc).useStateMachine("game");
    sm.advance(0.1);
    sm.fire("start");
    sm.advance(0.6);
    sm.setInput("multiplier", 4.2);
    sm.setInput("player", "Ada");
    sm.fire("crash");
    sm.advance(0.05);
    expect(sm.getInput("multiplier")).toBe(4.2);
    for (let i = 0; i < 5; i++) sm.advance(0.1);
    expect(state(sm)).toBe("idle");
    expect(sm.getInput("multiplier")).toBe(1);
    expect(sm.getInput("player")).toBe("Next");
    // value null removes the reset; deleting the input removes it too
    s.apply("setStateInput", { stateMachine: "game", state: "idle", input: "player", value: null });
    s.apply("deleteInput", { stateMachine: "game", input: "multiplier" });
    expect(s.doc.stateMachines[0].layers[0].states.find((x) => x.name === "idle")!.inputs).toBeUndefined();
  });

  it("a zero-length step does not fire keys at 0 twice", () => {
    const s = crash();
    s.apply("addEvent", { name: "go" });
    s.apply("addEventKey", { animation: "flyout", event: "go", time: 0 });
    const sm = new OpenBoneInstance(s.doc).useStateMachine("game");
    const fired: string[] = [];
    sm.on("event", (e) => fired.push(e.name));
    sm.advance(0.1);
    sm.fire("start");
    sm.advance(0);
    sm.advance(1 / 60);
    sm.advance(0);
    sm.advance(1 / 60);
    expect(fired).toEqual(["go"]);
  });

  it("onComplete leaves a looping state after its first cycle", () => {
    const s = crash();
    s.apply("updateState", { stateMachine: "game", state: "idle", onComplete: "flying" });
    const sm = new OpenBoneInstance(s.doc).useStateMachine("game");
    sm.advance(0.5);
    expect(state(sm)).toBe("idle");
    sm.advance(0.6);
    sm.advance(0.01);
    expect(state(sm)).toBe("flying");
  });

  it("string inputs drive conditions", () => {
    const s = crash();
    s.apply("addTransition", { stateMachine: "game", from: "idle", to: "flying", conditions: [{ input: "player", op: "==", value: "Bob" }], duration: 0 });
    const sm = new OpenBoneInstance(s.doc).useStateMachine("game");
    sm.advance(0.1);
    sm.setInput("player", "Bo");
    sm.advance(0.1);
    expect(state(sm)).toBe("idle");
    sm.setString("player", "Bob");
    sm.advance(0.1);
    expect(state(sm)).toBe("flying");
    expect(sm.getInput("player")).toBe("Bob");
  });
});

describe("text attachments", () => {
  it("draws the template filled from the live inputs, and setText overrides it", () => {
    const inst = new OpenBoneInstance(crash().doc);
    const sm = inst.useStateMachine("game");
    sm.advance(0);
    const text = () => inst.drawList().find((d) => d.text)!.text!.content;
    expect(text()).toBe("1.00x");
    sm.setInput("multiplier", 2.349);
    sm.advance(0.016);
    expect(text()).toBe("2.35x");
    sm.setText("label", "{player} cashed out at {multiplier:0.0}x");
    expect(text()).toBe("Ada cashed out at 2.3x");
    sm.setText("label", null);
    expect(text()).toBe("2.35x");
  });

  it("has a box quad, a world matrix and a hit area", () => {
    const s = crash();
    s.apply("updateBone", { bone: "rocket", x: 100, rotation: 90 });
    const sk = new Skeleton(s.doc);
    const item = sk.drawList().find((d) => d.text)!;
    // Box centre (10, 0) in bone space → (100, 10) in world after a 90° turn.
    expect(item.text!.matrix.x).toBeCloseTo(100);
    expect(item.text!.matrix.y).toBeCloseTo(10);
    expect(item.vertices).toHaveLength(8);
    const slot = sk.findSlot("label")!;
    expect(sk.hitTest(slot, 100, 10 + 90)).toBe(true); // 200-wide box now runs vertically
    expect(sk.hitTest(slot, 100 + 40, 10)).toBe(false);
  });

  it("text without a state machine shows the inputs' default values (names with no input stay as written)", () => {
    const inst = new OpenBoneInstance(crash().doc);
    inst.advance(0);
    expect(inst.drawList().find((d) => d.text)!.text!.content).toBe("1.00x");
    expect(formatTemplate("{nope} {multiplier:0.0}", inst.skeleton.textValues)).toBe("{nope} 1.0");
  });

  it("drawTextBox aligns lines inside the box and draws the outline first", () => {
    const calls: string[] = [];
    const ctx = {
      font: "",
      textAlign: "start",
      textBaseline: "alphabetic",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineJoin: "miter",
      fillText: (t: string, x: number, y: number) => calls.push(`fill ${t} ${x} ${y}`),
      strokeText: (t: string, x: number, y: number) => calls.push(`stroke ${t} ${x} ${y}`),
    } as TextContext;
    drawTextBox(ctx, {
      content: "a\nb",
      font: "serif",
      size: 10,
      weight: 700,
      align: "left",
      width: 100,
      height: 40,
      fill: [1, 0, 0, 1],
      outline: [0, 0, 0, 1],
      outlineWidth: 2,
      matrix: { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 },
    });
    expect(ctx.font).toBe("700 10px serif");
    expect(calls).toEqual(["stroke a -50 -6", "stroke b -50 6", "fill a -50 -6", "fill b -50 6"]);
    expect(ctx.fillStyle).toBe("rgba(255,0,0,1)");
  });
});

describe("input bindings", () => {
  it("map number inputs onto bones, slot colours and constraint values after animations", () => {
    const s = crash();
    s.apply("addIkConstraint", { name: "ik", bones: ["rocket"], target: "aim", mix: 0.2 });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "rocket", property: "y", inMin: 1, inMax: 11, outMin: 0, outMax: 500 });
    // Animations key rocket x; this binding overrides it.
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "bone", object: "rocket", property: "x", inMin: 1, inMax: 2, outMin: -10, outMax: -20 });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "label", property: "color", inMin: 1, inMax: 3, outMin: "#ffffff", outMax: "#ff0000" });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "slot", object: "label", property: "alpha", inMin: 1, inMax: 3, outMin: 1, outMax: 0.5 });
    s.apply("addBinding", { stateMachine: "game", input: "multiplier", target: "ik", object: "ik", property: "mix", inMin: 1, inMax: 2, outMin: 0, outMax: 1 });
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("game");
    const rocket = inst.skeleton.findBone("rocket")!;
    const slot = inst.skeleton.findSlot("label")!;
    const ikId = s.doc.skeleton.ik[0].id;
    sm.advance(0.1);
    expect(rocket.y).toBe(0);
    expect(rocket.x).toBe(-10);
    expect(inst.skeleton.constraintValues.get(ikId)!.mix).toBe(0);
    sm.setInput("multiplier", 2);
    sm.advance(0.1);
    expect(rocket.y).toBeCloseTo(50);
    expect(rocket.x).toBe(-20);
    expect(slot.color[1]).toBeCloseTo(0.5);
    expect(slot.color[0]).toBeCloseTo(1);
    expect(slot.color[3]).toBeCloseTo(0.75);
    expect(inst.skeleton.constraintValues.get(ikId)!.mix).toBe(1);
    sm.setInput("multiplier", 1000); // clamped
    sm.advance(0.1);
    expect(rocket.y).toBe(500);
    expect(rocket.world.y).toBeCloseTo(500);
  });
});
