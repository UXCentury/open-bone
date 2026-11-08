import { DocumentStore, type ParticlesAttachment, createDocument, deserialize, deserializeBinary, gradientColor, serialize, serializeBinary, validate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, PARTICLE_STEP, ParticleEmitter, Skeleton, seekAnimation } from "../src/index.ts";

function rig(props: Record<string, unknown> = {}) {
  const s = new DocumentStore(createDocument("fx"));
  s.apply("addBone", { name: "nozzle", length: 20 });
  s.apply("addSlot", { name: "fx", bone: "nozzle" });
  s.apply("addParticles", { slot: "fx", name: "fx", ...props });
  return s;
}

const particlesOf = (sk: Skeleton) => sk.drawList().find((i) => i.particles);
const snapshot = (sk: Skeleton) => {
  const it = particlesOf(sk);
  return it ? { n: it.particles!.count, v: Array.from(it.vertices), c: Array.from(it.colors!) } : null;
};

const settings = (s: DocumentStore) => s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id].fx as ParticlesAttachment;

describe("particle ops", () => {
  it("addParticles fills defaults, applies presets and overrides", () => {
    const s = rig({ preset: "fire", rate: 33 });
    const a = settings(s);
    expect(a.type).toBe("particles");
    expect(a.blend).toBe("additive");
    expect(a.rate).toBe(33);
    expect(a.colors.length).toBeGreaterThan(1);
    expect(s.doc.skeleton.slots[0].attachment).toBe("fx");
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("updateParticles validates fields and resolves images", () => {
    const s = rig();
    s.apply("updateParticles", { slot: "fx", attachment: "fx", rate: 5, speed: [1, 2], shape: "cone" });
    expect(settings(s).rate).toBe(5);
    expect(settings(s).shape).toBe("cone");
    expect(() => s.apply("updateParticles", { slot: "fx", attachment: "fx", speed: [3, 1] })).toThrow();
    expect(() => s.apply("updateParticles", { slot: "fx", attachment: "fx", look: "image" })).toThrow(/image/);
    s.apply("addImage", { name: "coin", src: "data:image/png;base64,", width: 8, height: 8 });
    s.apply("updateParticles", { slot: "fx", attachment: "fx", look: "image", image: "coin" });
    expect(settings(s).image).toBe(s.doc.images[0].id);
    expect(() => s.apply("deleteImage", { image: "coin" })).toThrow(/used/);
    s.undo();
    expect(settings(s).look).toBe("circle");
  });

  it("round-trips through the binary format and fills missing fields on load", () => {
    const s = rig({ preset: "confetti" });
    const back = deserializeBinary(serializeBinary(s.doc, { precision: "float64" }));
    expect(back.skeleton.skins[0].attachments).toEqual(s.doc.skeleton.skins[0].attachments);
    const json = JSON.parse(serialize(s.doc));
    const a = json.skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id].fx;
    delete a.stretch;
    delete a.colors;
    const loaded = deserialize(JSON.stringify(json)).skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id].fx as ParticlesAttachment;
    expect(loaded.stretch).toBe(0.05);
    expect(loaded.colors.length).toBe(2);
  });

  it("updateParticles with a preset resets fields but keeps the seed", () => {
    const s = rig({ seed: 42, rate: 3 });
    s.apply("updateParticles", { slot: "fx", attachment: "fx", preset: "smoke" });
    expect(settings(s).seed).toBe(42);
    expect(settings(s).rate).toBe(14);
  });

  it("emitting/rate keys, listener actions and state toggles", () => {
    const s = rig();
    s.apply("createAnimation", { name: "a" });
    s.apply("setKeys", { animation: "a", target: "particles", id: "fx", property: "emitting", keys: [{ time: 0, value: true }, { time: 1, value: false }] });
    s.apply("setKeys", { animation: "a", target: "particles", id: "fx", property: "rate", keys: [{ time: 0, value: 10 }] });
    expect(() => s.apply("setKeys", { animation: "a", target: "particles", id: "fx", property: "emitting", keys: [{ time: 0, value: 1 }] })).toThrow();
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addState", { stateMachine: "sm", name: "idle" });
    s.apply("setStateEmitter", { stateMachine: "sm", state: "idle", slot: "fx", emitting: false });
    s.apply("addListener", { stateMachine: "sm", event: "down", actions: [{ type: "emitParticles", slot: "fx", count: 5 }, { type: "setEmitter", slot: "fx", emitting: true }] });
    const sm = s.doc.stateMachines[0];
    expect(sm.layers[0].states[0].emitters).toEqual([{ slot: s.doc.skeleton.slots[0].id, emitting: false }]);
    expect(sm.listeners[0].actions[0]).toEqual({ type: "emitParticles", slot: s.doc.skeleton.slots[0].id, count: 5 });
    // Survives a JSON round trip, and deleting the slot cleans up timelines and actions.
    expect(deserialize(serialize(s.doc)).animations[0].timelines.length).toBe(2);
    s.apply("deleteSlot", { slot: "fx" });
    expect(s.doc.animations[0].timelines).toEqual([]);
    expect(s.doc.stateMachines[0].listeners[0].actions).toEqual([]);
    expect(s.doc.stateMachines[0].layers[0].states[0].emitters).toEqual([]);
  });
});

describe("particle simulation", () => {
  it("is deterministic: the same seed and time give the same particles however you get there", () => {
    const s = rig({ preset: "fire", seed: 7 });
    const a = new Skeleton(s.doc);
    seekAnimation(a, null, 1.25);
    const b = new Skeleton(s.doc);
    for (const t of [0.1, 0.5, 0.9, 1.1, 1.25]) seekAnimation(b, null, t);
    const c = new Skeleton(s.doc);
    seekAnimation(c, null, 3); // seek backwards replays from 0
    seekAnimation(c, null, 1.25);
    expect(snapshot(a)).not.toBeNull();
    expect(snapshot(b)).toEqual(snapshot(a));
    expect(snapshot(c)).toEqual(snapshot(a));
    // Another seed gives other particles.
    s.apply("updateParticles", { slot: "fx", attachment: "fx", seed: 8 });
    const d = new Skeleton(s.doc);
    seekAnimation(d, null, 1.25);
    expect(snapshot(d)).not.toEqual(snapshot(a));
  });

  it("follows a moving bone deterministically while seeking an animation", () => {
    const s = rig({ space: "world" });
    s.apply("createAnimation", { name: "fly" });
    s.apply("setKeys", { animation: "fly", target: "bone", id: "nozzle", property: "x", keys: [{ time: 0, value: 0 }, { time: 2, value: 400 }] });
    const anim = s.doc.animations[0];
    const a = new Skeleton(s.doc);
    seekAnimation(a, anim, 1.5);
    const b = new Skeleton(s.doc);
    for (let t = 0; t <= 1.5 + 1e-9; t += 1 / 30) seekAnimation(b, anim, t);
    seekAnimation(b, anim, 1.5);
    expect(snapshot(b)).toEqual(snapshot(a));
    // World-space particles trail behind: some are well left of the nozzle.
    const v = particlesOf(a)!.vertices;
    const xs = Array.from(v).filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeLessThan(250);
  });

  it("fires bursts once per cycle and respects maxParticles", () => {
    const s = rig({ rate: 0, bursts: [{ time: 0, count: 10 }, { time: 0.5, count: 5 }], duration: 1, loop: true, lifetime: [5, 5] });
    const sk = new Skeleton(s.doc);
    const count = (t: number) => {
      seekAnimation(sk, null, t);
      return sk.emitter("fx")!.alive;
    };
    expect(count(PARTICLE_STEP)).toBe(10);
    expect(count(0.49)).toBe(10);
    expect(count(0.52)).toBe(15);
    expect(count(1.02)).toBe(25); // next cycle's burst at 0
    s.apply("updateParticles", { slot: "fx", attachment: "fx", maxParticles: 12 });
    const capped = new Skeleton(s.doc);
    seekAnimation(capped, null, 1.02);
    expect(capped.emitter("fx")!.alive).toBe(12);
  });

  it("non-looping emitters stop after their duration", () => {
    const s = rig({ rate: 60, duration: 0.5, loop: false, lifetime: [10, 10] });
    const sk = new Skeleton(s.doc);
    seekAnimation(sk, null, 0.5);
    const n = sk.emitter("fx")!.alive;
    expect(n).toBeGreaterThanOrEqual(29);
    expect(n).toBeLessThanOrEqual(31);
    seekAnimation(sk, null, 2);
    expect(sk.emitter("fx")!.alive).toBe(n);
  });

  it("particles die after their lifetime", () => {
    const s = rig({ rate: 0, bursts: [{ time: 0, count: 8 }], lifetime: [0.5, 0.5], duration: 10 });
    const sk = new Skeleton(s.doc);
    seekAnimation(sk, null, 0.45);
    expect(sk.emitter("fx")!.alive).toBe(8);
    seekAnimation(sk, null, 0.6);
    expect(sk.emitter("fx")!.alive).toBe(0);
    expect(particlesOf(sk)).toBeUndefined();
  });

  it("interpolates colour and size over a particle's life", () => {
    expect(gradientColor([{ t: 0, color: "#ff0000ff" }, { t: 1, color: "#0000ff00" }], 0.5)).toEqual([0.5, 0, 0.5, 0.5]);
    expect(gradientColor([{ t: 1, color: "#000000" }, { t: 0.5, color: "#ffffff" }], 0.25)).toEqual([1, 1, 1, 1]);
    const s = rig({
      rate: 0,
      bursts: [{ time: 0, count: 1 }],
      lifetime: [1, 1],
      speed: [0, 0],
      startSize: [10, 10],
      endSize: [30, 30],
      colors: [{ t: 0, color: "#ff0000ff" }, { t: 1, color: "#0000ff00" }],
      duration: 10,
    });
    const sk = new Skeleton(s.doc);
    // Born during the first step, so at t its age is t - PARTICLE_STEP.
    seekAnimation(sk, null, 0.5 + PARTICLE_STEP);
    const it = particlesOf(sk)!;
    expect(it.colors![0]).toBeCloseTo(0.5, 5);
    expect(it.colors![2]).toBeCloseTo(0.5, 5);
    expect(it.colors![3]).toBeCloseTo(0.5, 5);
    const v = it.vertices;
    expect(Math.hypot(v[2] - v[0], v[3] - v[1])).toBeCloseTo(20, 4);
  });

  it("emitting timeline switches the emitter on and off", () => {
    const s = rig({ rate: 60, lifetime: [10, 10], emitting: false });
    s.apply("createAnimation", { name: "a", duration: 3 });
    s.apply("setKeys", {
      animation: "a",
      target: "particles",
      id: "fx",
      property: "emitting",
      keys: [
        { time: 0, value: false, curve: "stepped" },
        { time: 1, value: true },
        { time: 2, value: false },
      ],
    });
    const anim = s.doc.animations[0];
    const sk = new Skeleton(s.doc);
    const at = (t: number) => {
      seekAnimation(sk, anim, t);
      return sk.emitter("fx")?.alive ?? 0;
    };
    expect(at(0.9)).toBe(0);
    const on = at(1.5);
    expect(on).toBeGreaterThan(25);
    expect(on).toBeLessThan(35);
    const off = at(2.05);
    expect(at(2.9)).toBe(off);
    // Keyed rate.
    s.apply("setKeys", { animation: "a", target: "particles", id: "fx", property: "rate", keys: [{ time: 0, value: 120 }] });
    const fast = new Skeleton(s.doc);
    seekAnimation(fast, s.doc.animations[0], 1.5);
    expect(fast.emitter("fx")!.alive).toBeGreaterThan(on * 1.6);
  });

  it("prewarm starts with a settled effect", () => {
    const s = rig({ rate: 50, lifetime: [1, 1], prewarm: true, duration: 1 });
    const sk = new Skeleton(s.doc);
    seekAnimation(sk, null, PARTICLE_STEP);
    expect(sk.emitter("fx")!.alive).toBeGreaterThan(40);
  });

  it("local-space particles move with the bone", () => {
    const s = rig({ space: "local", rate: 0, bursts: [{ time: 0, count: 1 }], speed: [0, 0], lifetime: [5, 5], duration: 10 });
    const sk = new Skeleton(s.doc);
    seekAnimation(sk, null, 0.5);
    const x0 = particlesOf(sk)!.vertices[0];
    sk.findBone("nozzle")!.x = 100;
    sk.updateWorldTransform();
    expect(particlesOf(sk)!.vertices[0]).toBeCloseTo(x0 + 100, 4);
  });

  it("runs in realtime under a state machine with emitter actions", () => {
    const s = rig({ rate: 0, emitting: false, bursts: [{ time: 0, count: 6 }], loop: false, lifetime: [10, 10] });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addState", { stateMachine: "sm", name: "idle" });
    s.apply("addInput", { stateMachine: "sm", name: "go", type: "trigger" });
    s.apply("addState", { stateMachine: "sm", name: "boom" });
    s.apply("addTransition", { stateMachine: "sm", from: "idle", to: "boom", conditions: [{ input: "go" }] });
    s.apply("setStateEmitter", { stateMachine: "sm", state: "boom", slot: "fx", emitting: true });
    s.apply("addListener", { stateMachine: "sm", event: "down", actions: [{ type: "emitParticles", slot: "fx", count: 3 }] });
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("sm");
    for (let i = 0; i < 10; i++) inst.advance(1 / 30);
    expect(inst.skeleton.emitter("fx")?.alive ?? 0).toBe(0);
    sm.fire("go");
    for (let i = 0; i < 5; i++) inst.advance(1 / 30);
    expect(inst.skeleton.emitter("fx")!.alive).toBe(6);
    sm.pointer("down", 0, 0);
    for (let i = 0; i < 2; i++) inst.advance(1 / 30);
    expect(inst.skeleton.emitter("fx")!.alive).toBe(9);
  });

  it("ParticleEmitter steps without a skeleton", () => {
    const s = rig({ preset: "sparks" });
    const em = new ParticleEmitter(settings(s), 0);
    const m = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
    em.step(PARTICLE_STEP, m);
    expect(em.alive).toBe(30);
    const g = em.geometry(0, m, [1, 1, 1, 1]);
    expect(g.vertices.length).toBe(g.count * 8);
    expect(g.indices.length).toBe(g.count * 6);
  });
});
