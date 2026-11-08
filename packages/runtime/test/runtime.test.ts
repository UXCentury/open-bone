import { DocumentStore, createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, Skeleton, trustedFunctionHost } from "../src/index.ts";

function rig() {
  const s = new DocumentStore(createDocument("rig"));
  s.apply("addBone", { name: "upper", rotation: 0, length: 100 });
  s.apply("addBone", { name: "lower", parent: "upper", x: 100, length: 100 });
  s.apply("addBone", { name: "target", x: 120, y: 80, length: 0 });
  return s;
}

describe("skeleton", () => {
  it("2-bone IK reaches a reachable target", () => {
    const s = rig();
    s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target" });
    const sk = new Skeleton(s.doc);
    const lower = sk.findBone("lower")!;
    const tip = [lower.world.a * 100 + lower.world.x, lower.world.c * 100 + lower.world.y];
    expect(tip[0]).toBeCloseTo(120, 1);
    expect(tip[1]).toBeCloseTo(80, 1);
  });

  it("bendPositive flips the elbow side", () => {
    const s = rig();
    s.apply("addIkConstraint", { name: "ik", bones: ["upper", "lower"], target: "target" });
    const e1 = new Skeleton(s.doc).findBone("lower")!.world;
    s.apply("updateIkConstraint", { constraint: "ik", bendPositive: false });
    const e2 = new Skeleton(s.doc).findBone("lower")!.world;
    // Elbows are mirrored across the shoulder→target line.
    const side = (x: number, y: number) => Math.sign(120 * y - 80 * x);
    expect(side(e1.x, e1.y)).toBe(-side(e2.x, e2.y));
  });

  it("1-bone IK aims", () => {
    const s = rig();
    s.apply("addIkConstraint", { bones: ["upper"], target: "target" });
    const sk = new Skeleton(s.doc);
    expect(sk.findBone("upper")!.worldRotation).toBeCloseTo((Math.atan2(80, 120) * 180) / Math.PI, 3);
  });

  it("weighted mesh follows bones", () => {
    const s = rig();
    s.apply("addImage", { name: "arm", src: "data:,", width: 200, height: 20 });
    s.apply("addSlot", { bone: "upper", name: "arm" });
    s.apply("addMesh", { slot: "arm", image: "arm", x: 100, cols: 4, rows: 1 });
    s.apply("autoWeights", { slot: "arm", attachment: "arm", bones: ["upper", "lower"] });
    s.apply("updateBone", { bone: "lower", rotation: 90 });
    const sk = new Skeleton(s.doc);
    const [item] = sk.drawList();
    // Rightmost vertices should have moved up (bent by lower bone).
    let maxY = -Infinity;
    for (let i = 1; i < item.vertices.length; i += 2) maxY = Math.max(maxY, item.vertices[i]);
    expect(maxY).toBeGreaterThan(50);
  });
});

describe("animation", () => {
  it("samples keys with curves and fires events once per loop", () => {
    const s = rig();
    s.apply("createAnimation", { name: "swing", duration: 1 });
    s.apply("setKeys", { animation: "swing", target: "bone", id: "upper", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 90 }] });
    s.apply("addEventKey", { animation: "swing", event: "step", time: 0.5 });
    const inst = new OpenBoneInstance(s.doc);
    const events: string[] = [];
    inst.on("event", (e) => events.push(e.name));
    inst.play("swing");
    inst.advance(0.25);
    expect(inst.skeleton.findBone("upper")!.rotation).toBeCloseTo(22.5);
    for (let i = 0; i < 10; i++) inst.advance(0.25); // 2.75s total
    expect(events).toEqual(["step", "step", "step"]);
  });

  it("crossfades between tracks", () => {
    const s = rig();
    for (const [n, v] of [["a", 0], ["b", 100]] as const) {
      s.apply("createAnimation", { name: n });
      s.apply("setKeys", { animation: n, target: "bone", id: "upper", property: "x", keys: [{ time: 0, value: v }] });
    }
    const inst = new OpenBoneInstance(s.doc);
    inst.play("a");
    inst.advance(0.1);
    inst.animationState.setAnimation(0, "b", true, 1);
    inst.advance(0.5);
    expect(inst.skeleton.findBone("upper")!.x).toBeCloseTo(50);
  });
});

describe("state machine", () => {
  function interactive() {
    const s = rig();
    s.apply("createAnimation", { name: "idle" });
    s.apply("setKeys", { animation: "idle", target: "bone", id: "upper", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 0 }] });
    s.apply("createAnimation", { name: "wave" });
    s.apply("setKeys", { animation: "wave", target: "bone", id: "upper", property: "rotation", keys: [{ time: 0, value: 45 }, { time: 0.5, value: 45 }] });
    s.apply("addEventKey", { animation: "wave", event: "waved", time: 0.25 });
    s.apply("createStateMachine", { name: "main" });
    s.apply("addInput", { stateMachine: "main", name: "hover", type: "bool" });
    s.apply("addInput", { stateMachine: "main", name: "poke", type: "trigger" });
    s.apply("addState", { stateMachine: "main", animation: "idle" });
    s.apply("addState", { stateMachine: "main", animation: "wave", loop: false });
    s.apply("addTransition", { stateMachine: "main", from: "idle", to: "wave", conditions: [{ input: "poke" }], duration: 0 });
    s.apply("addTransition", { stateMachine: "main", from: "wave", to: "idle", duration: 0 });
    s.apply("addSlot", { bone: "upper", name: "button" });
    s.apply("addBoundingBox", { slot: "button", x: 50, width: 100, height: 40 });
    s.apply("addListener", { stateMachine: "main", slot: "button", event: "click", actions: [{ type: "fireTrigger", input: "poke" }] });
    s.apply("addListener", { stateMachine: "main", slot: "button", event: "enter", actions: [{ type: "setInput", input: "hover", value: true }] });
    s.apply("addListener", { stateMachine: "main", slot: "button", event: "exit", actions: [{ type: "setInput", input: "hover", value: false }] });
    return s;
  }

  it("trigger → transition → exit-time return, with events", () => {
    const inst = new OpenBoneInstance(interactive().doc);
    const sm = inst.useStateMachine("main");
    const events: string[] = [];
    inst.on("event", (e) => events.push(e.name));
    sm.advance(0.1);
    expect(sm.activeStates["Layer 1"]).toBe("idle");
    sm.fire("poke");
    sm.advance(0.1);
    expect(sm.activeStates["Layer 1"]).toBe("wave");
    expect(inst.skeleton.findBone("upper")!.rotation).toBeCloseTo(45);
    sm.advance(0.3);
    expect(events).toEqual(["waved"]);
    sm.advance(0.2); // wave done (0.6 > 0.5) → back to idle next frame
    sm.advance(0.01);
    expect(sm.activeStates["Layer 1"]).toBe("idle");
  });

  it("pointer listeners: enter/exit/click on bounding box", () => {
    const inst = new OpenBoneInstance(interactive().doc);
    const sm = inst.useStateMachine();
    sm.advance(0);
    sm.pointer("move", 50, 0);
    sm.advance(0.01);
    expect(sm.getInput("hover")).toBe(true);
    sm.pointer("down", 50, 0);
    sm.pointer("up", 50, 0);
    sm.advance(0.01);
    expect(sm.activeStates["Layer 1"]).toBe("wave");
    sm.pointer("move", 500, 500);
    sm.advance(0.01);
    expect(sm.getInput("hover")).toBe(false);
  });

  it("scripts drive inputs and bones", () => {
    const s = interactive();
    s.apply("addScript", {
      name: "brain",
      code: `let t = 0; function onUpdate(dt){ t += dt; ob.setBone("lower", {rotation: 30}); if (t > 0.2 && !ob.input("hover")) ob.setInput("hover", true); }
             function onEvent(e){ ob.log("got", e.name); }`,
    });
    s.apply("attachScript", { stateMachine: "main", script: "brain" });
    const inst = new OpenBoneInstance(s.doc, { scriptHost: trustedFunctionHost });
    const sm = inst.useStateMachine();
    const logs: unknown[][] = [];
    sm.on("log", (a) => logs.push(a));
    sm.on("error", (e) => {
      throw e;
    });
    sm.advance(0.1);
    expect(inst.skeleton.findBone("lower")!.rotation).toBe(30);
    sm.advance(0.15);
    expect(sm.getInput("hover")).toBe(true);
    sm.fire("poke");
    for (let i = 0; i < 5; i++) sm.advance(0.1);
    expect(logs).toContainEqual(["got", "waved"]);
  });

  it("blend1d mixes by number input", () => {
    const s = rig();
    for (const [n, v] of [["slow", 0], ["fast", 100]] as const) {
      s.apply("createAnimation", { name: n });
      s.apply("setKeys", { animation: n, target: "bone", id: "upper", property: "x", keys: [{ time: 0, value: v }] });
    }
    s.apply("createStateMachine", { name: "loco" });
    s.apply("addInput", { stateMachine: "loco", name: "speed", type: "number" });
    s.apply("addState", { stateMachine: "loco", name: "move", type: "blend1d", blendInput: "speed", blend: [{ animation: "slow", value: 0 }, { animation: "fast", value: 1 }] });
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine();
    sm.setNumber("speed", 0.25);
    sm.advance(0.1);
    expect(inst.skeleton.findBone("upper")!.x).toBeCloseTo(25);
  });
});

describe("blend events", () => {
  it("only the dominant blend entry reports events", () => {
    const s = rig();
    for (const n of ["idle", "walk"]) {
      s.apply("createAnimation", { name: n, duration: 1 });
      s.apply("setKeys", { animation: n, target: "bone", id: "upper", property: "x", keys: [{ time: 0, value: 0 }] });
    }
    s.apply("addEventKey", { animation: "walk", event: "step", time: 0.5 });
    s.apply("createStateMachine", { name: "m" });
    s.apply("addInput", { stateMachine: "m", name: "speed", type: "number" });
    s.apply("addState", { stateMachine: "m", name: "loco", type: "blend1d", blendInput: "speed", blend: [{ animation: "idle", value: 0 }, { animation: "walk", value: 1 }] });
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine();
    const ev: string[] = [];
    sm.on("event", (e) => ev.push(e.name));
    for (let i = 0; i < 30; i++) sm.advance(0.1);
    expect(ev).toEqual([]);
    sm.setNumber("speed", 0.8);
    for (let i = 0; i < 10; i++) sm.advance(0.1);
    expect(ev).toEqual(["step"]);
  });
});

describe("clipping masks", () => {
  function clipRig(end: string | null) {
    const s = new DocumentStore(createDocument("clip"));
    for (const name of ["before", "mask", "a", "b", "after"]) {
      s.apply("addSlot", { bone: "root", name });
      if (name !== "mask") s.apply("addShape", { slot: name, shape: "rect", width: 40, height: 40 });
    }
    s.apply("addClipping", { slot: "mask", width: 20, height: 20, end });
    return new Skeleton(s.doc);
  }
  const clipped = (sk: Skeleton) => sk.drawList().map((it) => [it.slot.data.name, !!it.clip]);

  it("clips the slots after the mask through the end slot, and does not draw the mask", () => {
    expect(clipped(clipRig("b"))).toEqual([
      ["before", false],
      ["a", true],
      ["b", true],
      ["after", false],
    ]);
  });

  it("clips to the end of the draw order when end is null, sharing one region", () => {
    const sk = clipRig(null);
    expect(clipped(sk).slice(1).every(([, c]) => c)).toBe(true);
    const list = sk.drawList();
    expect(list[1].clip).toBe(list[2].clip);
    const r = list[1].clip!;
    expect(r.polygon.length).toBe(8);
    expect(r.indices.length).toBe(6);
  });

  it("follows the mask slot's bone in world space", () => {
    const s = new DocumentStore(createDocument("clip"));
    s.apply("addBone", { name: "m", x: 50, y: 10 });
    s.apply("addSlot", { bone: "m", name: "mask" });
    s.apply("addSlot", { bone: "root", name: "a" });
    s.apply("addShape", { slot: "a", shape: "rect" });
    s.apply("addClipping", { slot: "mask", width: 20, height: 20 });
    const p = new Skeleton(s.doc).drawList()[0].clip!.polygon;
    expect(Math.min(p[0], p[2], p[4], p[6])).toBeCloseTo(40);
    expect(Math.max(p[1], p[3], p[5], p[7])).toBeCloseTo(20);
  });
});
