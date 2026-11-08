import { describe, expect, it } from "vitest";
import {
  DocumentStore,
  busGain,
  createDocument,
  deserializeBinary,
  serializeBinary,
  exportDocument,
  registry,
  soundGain,
  validate,
} from "../src/index.ts";

const WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

function doc() {
  const s = new DocumentStore(createDocument("snd"));
  s.apply("addAudio", { name: "click", src: WAV, duration: 0.1 });
  s.apply("addAudio", { name: "hum", src: "assets/hum.ogg", duration: 2, loop: true, bus: "music" });
  return s;
}

describe("audio ops", () => {
  it("are registered in the audio group (MCP tools)", () => {
    for (const n of ["addAudio", "updateAudio", "deleteAudio", "addSound", "updateSound", "deleteSound", "addBus", "updateBus", "deleteBus", "setAudioMix", "addAudioKey", "updateAudioKey", "deleteAudioKey", "setEventSound", "setStateSound", "deleteStateSound"])
      expect(registry.get(n)?.group, n).toBe("audio");
  });

  it("addAudio creates the asset, a sound and the default buses", () => {
    const s = doc();
    const a = s.doc.audio!;
    expect(a.buses.map((b) => b.name)).toEqual(["sfx", "music", "ui"]);
    expect(a.assets.map((x) => x.name)).toEqual(["click", "hum"]);
    expect(a.sounds.find((x) => x.name === "click")).toMatchObject({ bus: "bus_sfx", loop: false, volume: 1, rate: 1 });
    expect(a.sounds.find((x) => x.name === "hum")).toMatchObject({ bus: "bus_music", loop: true });
    expect(() => s.apply("addAudio", { name: "click", src: WAV })).toThrow(/already exists/);
    expect(validate(s.doc)).toEqual([]);
  });

  it("sounds, buses and the mix can be edited and undone", () => {
    const s = doc();
    s.apply("addSound", { name: "click-soft", asset: "click", volume: 0.5, rate: 1.5, fadeOut: 0.1, bus: null });
    expect(s.doc.audio!.sounds.at(-1)).toMatchObject({ name: "click-soft", bus: null, volume: 0.5, rate: 1.5, fadeOut: 0.1 });
    s.apply("updateSound", { sound: "click-soft", bus: "ui", loop: true });
    expect(s.doc.audio!.sounds.at(-1)).toMatchObject({ bus: "bus_ui", loop: true });
    s.apply("addBus", { name: "voice", volume: 0.8 });
    s.apply("updateBus", { bus: "sfx", volume: 0.25, muted: true });
    s.apply("setAudioMix", { master: 0.5 });
    expect(s.doc.audio!.master).toBe(0.5);
    s.apply("deleteBus", { bus: "ui" });
    expect(s.doc.audio!.sounds.find((x) => x.name === "click-soft")!.bus).toBeNull();
    s.undo();
    expect(s.doc.audio!.sounds.find((x) => x.name === "click-soft")!.bus).toBe("bus_ui");
  });

  it("updateAudio replaces the shared asset object (undo keeps the old one)", () => {
    const s = doc();
    const before = s.doc.audio!.assets[0];
    s.apply("updateAudio", { asset: "click", name: "tick", duration: 0.2 });
    expect(s.doc.audio!.assets[0]).not.toBe(before);
    expect(before.name).toBe("click");
    s.undo();
    expect(s.doc.audio!.assets[0].name).toBe("click");
  });

  it("audio keys, event sounds, state hooks and listener actions; deleting a sound removes them all", () => {
    const s = doc();
    s.apply("createAnimation", { name: "walk", duration: 1 });
    s.apply("addAudioKey", { animation: "walk", sound: "click", time: 0.5, volume: 0.7 });
    s.apply("addAudioKey", { animation: "walk", sound: "click", time: 0.5, rate: 2 }); // replaces
    s.apply("addAudioKey", { animation: "walk", sound: "hum", time: 0 });
    expect(s.doc.animations[0].audio).toEqual([
      { time: 0, sound: s.doc.audio!.sounds[1].id },
      { time: 0.5, sound: s.doc.audio!.sounds[0].id, rate: 2 },
    ]);
    s.apply("updateAudioKey", { animation: "walk", sound: "click", time: 0.5, newTime: 0.25, rate: null, volume: 0.3 });
    expect(s.doc.animations[0].audio![1]).toEqual({ time: 0.25, sound: s.doc.audio!.sounds[0].id, volume: 0.3 });
    s.apply("addEvent", { name: "tap" });
    s.apply("setEventSound", { event: "tap", sound: "click", volume: 0.5 });
    expect(s.doc.events[0]).toMatchObject({ audio: s.doc.audio!.sounds[0].id, volume: 0.5 });
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addState", { stateMachine: "sm", name: "idle", animation: "walk" });
    s.apply("setStateSound", { stateMachine: "sm", state: "idle", sound: "hum" });
    s.apply("setStateSound", { stateMachine: "sm", state: "idle", sound: "click", on: "exit" });
    s.apply("addListener", { stateMachine: "sm", event: "down", actions: [{ type: "playSound", sound: "click", volume: 0.4 }, { type: "stopSound", sound: "hum", fade: 0.3 }] });
    const sm = s.doc.stateMachines[0];
    expect(sm.layers[0].states[0].sounds).toHaveLength(2);
    expect(sm.listeners[0].actions[0]).toEqual({ type: "playSound", sound: s.doc.audio!.sounds[0].id, volume: 0.4 });
    expect(validate(s.doc)).toEqual([]);

    s.apply("deleteSound", { sound: "click" });
    expect(s.doc.animations[0].audio!.map((k) => k.time)).toEqual([0]);
    expect(s.doc.events[0].audio).toBeUndefined();
    expect(sm.layers[0].states[0].sounds).toHaveLength(1);
    expect(s.doc.stateMachines[0].listeners[0].actions.map((a) => a.type)).toEqual(["stopSound"]);
    s.apply("deleteAudio", { asset: "hum" });
    expect(s.doc.audio!.sounds).toEqual([]);
    expect(s.doc.animations[0].audio).toEqual([]);
    expect(validate(s.doc)).toEqual([]);
  });

  it("listener actions reject unknown sounds", () => {
    const s = doc();
    s.apply("createStateMachine", { name: "sm" });
    expect(() => s.apply("addListener", { stateMachine: "sm", event: "down", actions: [{ type: "playSound", sound: "nope" }] })).toThrow(/Sound "nope" not found/);
  });

  it("bus volume math: master x bus x sound x play volume, mutes give 0", () => {
    const s = doc();
    s.apply("updateBus", { bus: "sfx", volume: 0.5 });
    s.apply("setAudioMix", { master: 0.8 });
    s.apply("updateSound", { sound: "click", volume: 0.5 });
    const click = s.doc.audio!.sounds[0];
    expect(busGain(s.doc, "bus_sfx")).toBeCloseTo(0.4);
    expect(busGain(s.doc, null)).toBeCloseTo(0.8);
    expect(soundGain(s.doc, click, 0.5)).toBeCloseTo(0.1);
    s.apply("updateBus", { bus: "sfx", muted: true });
    expect(soundGain(s.doc, click)).toBe(0);
    s.apply("updateBus", { bus: "sfx", muted: false });
    s.apply("setAudioMix", { muted: true });
    expect(soundGain(s.doc, click)).toBe(0);
  });

  it("exports keep used audio and binary round-trips embedded sounds", () => {
    const s = doc();
    s.apply("createAnimation", { name: "walk", duration: 1 });
    s.apply("addAudioKey", { animation: "walk", sound: "click", time: 0.5 });
    const { doc: out, stats } = exportDocument(s.doc);
    expect(out.audio!.assets.map((a) => a.name)).toEqual(["click"]);
    expect(out.audio!.sounds.map((a) => a.name)).toEqual(["click"]);
    expect(out.audio!.buses).toHaveLength(3);
    expect(stats.audio).toBe(1);
    expect(exportDocument(s.doc, { pruneUnused: false }).doc.audio!.assets).toHaveLength(2);
    const back = deserializeBinary(serializeBinary(out));
    expect(back.audio!.assets[0].src).toBe(WAV);
    expect(back.animations[0].audio).toEqual(out.animations[0].audio);
  });
});
