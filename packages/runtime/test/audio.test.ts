import { DocumentStore, createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { type AudioCommand, AudioDirector, OpenBoneInstance, audioKeysBetween } from "../src/index.ts";

function doc() {
  const s = new DocumentStore(createDocument("snd"));
  s.apply("addBone", { name: "b", length: 10 });
  s.apply("addAudio", { name: "click", src: "click.wav", duration: 0.1 });
  s.apply("addAudio", { name: "hum", src: "hum.ogg", duration: 2, loop: true });
  s.apply("updateSound", { sound: "hum", fadeOut: 0.25 });
  for (const n of ["idle", "walk"]) {
    s.apply("createAnimation", { name: n, duration: 1 });
    s.apply("setKeys", { animation: n, target: "bone", id: "b", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 1, value: 10 }] });
  }
  return s;
}

const record = (inst: { on(t: "audio", fn: (c: AudioCommand) => void): unknown }) => {
  const log: AudioCommand[] = [];
  inst.on("audio", (c) => log.push(c));
  return log;
};
const names = (s: DocumentStore, log: AudioCommand[]) =>
  log.map((c) => (c.type === "play" ? `play ${s.doc.audio!.sounds.find((x) => x.id === c.sound)!.name}${c.loop ? " loop" : ""}` : `${c.type} ${c.id}`));

describe("runtime audio", () => {
  it("event keys with audio play one-shots, once per loop", () => {
    const s = doc();
    s.apply("addEventKey", { animation: "walk", event: "step", time: 0.5 });
    s.apply("setEventSound", { event: "step", sound: "click", volume: 0.5 });
    const inst = new OpenBoneInstance(s.doc);
    const log = record(inst);
    const events: string[] = [];
    inst.on("event", (e) => events.push(`${e.name}:${e.audio ? "audio" : ""}`));
    inst.play("walk");
    for (let i = 0; i < 9; i++) inst.advance(0.25); // 2.25 s → steps at 0.5, 1.5
    expect(names(s, log)).toEqual(["play click", "play click"]);
    expect(log[0]).toMatchObject({ type: "play", volume: 0.5, loop: false, rate: 1, bus: "bus_sfx", source: "event:step" });
    expect(events).toEqual(["step:audio", "step:audio"]);
    expect(new Set(log.map((c) => c.id)).size).toBe(2);
  });

  it("audio keys on an animation: looping key starts once and stops when the animation is replaced", () => {
    const s = doc();
    s.apply("addAudioKey", { animation: "walk", sound: "hum", time: 0 });
    s.apply("addAudioKey", { animation: "walk", sound: "click", time: 0.5, rate: 1.5 });
    const inst = new OpenBoneInstance(s.doc);
    const log = record(inst);
    inst.play("walk");
    for (let i = 0; i < 9; i++) inst.advance(0.25); // 2.25 s
    // hum once (looping, not restarted each cycle), click at 0.5 and 1.5
    expect(names(s, log)).toEqual(["play hum loop", "play click", "play click"]);
    expect(log[1]).toMatchObject({ rate: 1.5 });
    const humId = log[0].id;
    log.length = 0;
    inst.animationState.setAnimation(0, "idle", true, 0.3);
    expect(log).toEqual([{ type: "stop", id: humId, fade: 0.3 }]);
  });

  it("a non-looping animation stops its looping sounds when it completes", () => {
    const s = doc();
    s.apply("addAudioKey", { animation: "walk", sound: "hum", time: 0 });
    const inst = new OpenBoneInstance(s.doc);
    const log = record(inst);
    inst.play("walk", false);
    inst.advance(0.5);
    expect(log.map((c) => c.type)).toEqual(["play"]);
    inst.advance(0.6);
    expect(log[1]).toEqual({ type: "stop", id: log[0].id, fade: 0.25 });
  });

  it("state machine: looping state sound starts on enter and stops on state change; exit hooks and listeners play", () => {
    const s = doc();
    s.apply("addEvent", { name: "noop" });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "go", type: "bool" });
    s.apply("addState", { stateMachine: "sm", name: "idle", animation: "idle" });
    s.apply("addState", { stateMachine: "sm", name: "walk", animation: "walk" });
    s.apply("setStateSound", { stateMachine: "sm", state: "walk", sound: "hum" });
    s.apply("setStateSound", { stateMachine: "sm", state: "walk", sound: "click", on: "exit" });
    s.apply("addTransition", { stateMachine: "sm", from: "idle", to: "walk", conditions: [{ input: "go", value: true }], duration: 0.1 });
    s.apply("addTransition", { stateMachine: "sm", from: "walk", to: "idle", conditions: [{ input: "go", value: false }], duration: 0.5 });
    s.apply("addListener", { stateMachine: "sm", event: "down", actions: [{ type: "playSound", sound: "click", volume: 0.2 }] });
    s.apply("addListener", { stateMachine: "sm", event: "up", actions: [{ type: "stopSound", sound: "hum", fade: 1 }] });
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("sm");
    const log = record(inst);
    inst.advance(0.1);
    expect(log).toEqual([]);
    sm.setBool("go", true);
    inst.advance(0.1);
    expect(names(s, log)).toEqual(["play hum loop"]);
    expect(log[0]).toMatchObject({ source: "state:walk" });
    for (let i = 0; i < 20; i++) inst.advance(0.1); // walk loops; the hum is not restarted
    expect(log).toHaveLength(1);
    sm.setBool("go", false);
    inst.advance(0.1);
    // Loop fades over the transition (0.5 s ≥ the sound's 0.25 s fadeOut), then the exit hook plays.
    expect(log[1]).toEqual({ type: "stop", id: log[0].id, fade: 0.5 });
    expect(names(s, log.slice(2))).toEqual(["play click"]);

    // Listener actions
    sm.setBool("go", true);
    inst.advance(0.1);
    log.length = 0;
    inst.pointer("down", 0, 0);
    inst.advance(0.01);
    expect(names(s, log)).toEqual(["play click"]);
    expect(log[0]).toMatchObject({ volume: 0.2, source: "listener:down" });
    inst.pointer("up", 0, 0);
    inst.advance(0.01);
    expect(log[1]).toMatchObject({ type: "stop", fade: 1 });
  });

  it("switching away from a state machine stops its sounds", () => {
    const s = doc();
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addState", { stateMachine: "sm", name: "walk", animation: "walk" });
    s.apply("setStateSound", { stateMachine: "sm", state: "walk", sound: "hum" });
    const inst = new OpenBoneInstance(s.doc);
    const log = record(inst);
    inst.useStateMachine("sm");
    inst.advance(0.1);
    inst.play("idle");
    expect(log.map((c) => c.type)).toEqual(["play", "stop"]);
  });

  it("director: fade, stopSound and one-shot bookkeeping", () => {
    const s = doc();
    const log: AudioCommand[] = [];
    const d = new AudioDirector(s.doc, (c) => log.push(c));
    const a = d.play("click")!;
    const b = d.play("hum", { volume: 0.5 })!;
    expect(d.playing.size).toBe(2);
    d.update(0.2); // click (0.1 s) is over
    expect([...d.playing.keys()]).toEqual([b]);
    d.fade(b, 0.1, 2);
    expect(log.at(-1)).toEqual({ type: "fade", id: b, volume: 0.1, duration: 2 });
    d.stopSound("hum");
    expect(log.at(-1)).toEqual({ type: "stop", id: b, fade: 0.25 });
    expect(d.play("nope")).toBeNull();
    // An audio asset name plays with defaults.
    expect(d.play(s.doc.audio!.assets[0].id)).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("audioKeysBetween crosses keys once per cycle", () => {
    const s = doc();
    s.apply("addAudioKey", { animation: "walk", sound: "click", time: 0 });
    const anim = s.doc.animations[1];
    expect(audioKeysBetween(anim, -1e-6, 0, true)).toHaveLength(1);
    expect(audioKeysBetween(anim, 0, 2.5, true)).toHaveLength(2);
    expect(audioKeysBetween(anim, 0, 2.5, false)).toHaveLength(0);
  });
});
