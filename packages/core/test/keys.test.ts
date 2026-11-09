import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument } from "../src/index.ts";

function setup() {
  const s = new DocumentStore(createDocument("k"));
  s.apply("addBone", { name: "arm", length: 10 });
  s.apply("createAnimation", { name: "walk" });
  s.apply("createAnimation", { name: "run" });
  s.apply("setKeys", { animation: "walk", target: "bone", id: "arm", property: "rotation", keys: [{ time: 0, value: 0 }, { time: 0.5, value: 30, curve: "easeInOut" }, { time: 1, value: 0 }] });
  s.apply("addEventKey", { animation: "walk", event: "step", time: 0.5 });
  return s;
}
const times = (s: DocumentStore, anim = "walk") => s.doc.animations.find((a) => a.name === anim)!.timelines[0].keys.map((k) => [k.time, k.value]);
const pick = (times: number[]) => [{ target: "bone", id: "arm", property: "rotation", times }];

describe("batch key ops", () => {
  it("transformKeys shifts picked keys and events, replacing keys where they land", () => {
    const s = setup();
    s.apply("transformKeys", { animation: "walk", keys: pick([0.5]), events: [{ event: "step", time: 0.5 }], offset: 0.5 });
    expect(times(s)).toEqual([[0, 0], [1, 30]]);
    expect(s.doc.animations[0].events.map((e) => e.time)).toEqual([1]);
  });

  it("transformKeys scales around a pivot and snaps to frames", () => {
    const s = setup();
    s.apply("transformKeys", { animation: "walk", keys: pick([0, 0.5, 1]), scale: 0.5, pivot: 0, fps: 20 });
    expect(times(s)).toEqual([[0, 0], [0.25, 30], [0.5, 0]]);
    // curves travel with their keys
    expect(s.doc.animations[0].timelines[0].keys[1].curve).toEqual(expect.any(Array));
  });

  it("pasteKeys copies keys (relative times) into another animation, creating the timeline", () => {
    const s = setup();
    const walk = s.doc.animations[0];
    const keys = walk.timelines[0].keys.slice(1).map((k) => ({ target: "bone", id: "arm", property: "rotation", time: k.time - 0.5, value: k.value, curve: k.curve }));
    s.apply("pasteKeys", { animation: "run", at: 2, keys, events: [{ event: "step", time: 0 }] });
    expect(times(s, "run")).toEqual([[2, 30], [2.5, 0]]);
    expect(s.doc.animations[1].events.map((e) => e.time)).toEqual([2]);
  });

  it("deleteKeys removes many keys in one step and drops empty timelines", () => {
    const s = setup();
    s.apply("deleteKeys", { animation: "walk", keys: pick([0, 0.5, 1]), events: [{ event: "step", time: 0.5 }] });
    expect(s.doc.animations[0].timelines).toEqual([]);
    expect(s.doc.animations[0].events).toEqual([]);
    s.undo();
    expect(times(s)).toHaveLength(3);
  });
});
