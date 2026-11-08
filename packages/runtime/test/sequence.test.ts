import { DocumentStore, createDocument, layoutAtlas } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { AnimationState, OpenBoneInstance, Skeleton, applyAnimation } from "../src/index.ts";

function project() {
  const s = new DocumentStore(createDocument("seq"));
  for (let i = 0; i < 4; i++) s.apply("addImage", { id: `f${i}`, name: `f${i}`, src: `f${i}.png`, width: 20, height: 10 });
  s.apply("addImage", { id: "sheet", name: "sheet", src: "sheet.png", width: 40, height: 20 });
  s.apply("addSlot", { bone: "root", name: "fx" });
  s.apply("addSequence", { slot: "fx", name: "fire", frames: ["f0", "f1", "f2", "f3"], fps: 10 });
  return s;
}
const frameImage = (sk: Skeleton) => sk.drawList().find((d) => d.attachment.type === "sequence")?.image?.id ?? null;

describe("sequence playback", () => {
  it("advances with the skeleton clock when nothing plays", () => {
    const sk = new Skeleton(project().doc);
    expect(frameImage(sk)).toBe("f0");
    sk.update(0.25);
    expect(frameImage(sk)).toBe("f2");
    sk.update(0.2);
    expect(frameImage(sk)).toBe("f0"); // 0.45s = frame 4 -> loops to 0
  });

  it("follows animation time and applies mode and offset", () => {
    const s = project();
    s.apply("createAnimation", { name: "a", duration: 2 });
    s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { mode: "once", offset: 1 } });
    const sk = new Skeleton(s.doc);
    const anim = s.doc.animations[0];
    const at = (t: number) => {
      sk.setToSetupPose();
      applyAnimation(sk, anim, t);
      return frameImage(sk);
    };
    expect(at(0)).toBe("f1");
    expect(at(0.2)).toBe("f3");
    expect(at(0.3)).toBeNull(); // once: hidden after the last frame
    s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { mode: "holdLast" } });
    const sk2 = new Skeleton(s.doc);
    sk2.setToSetupPose();
    applyAnimation(sk2, anim, 1.5);
    expect(frameImage(sk2)).toBe("f3");
  });

  it("uses keyed frames over time", () => {
    const s = project();
    s.apply("createAnimation", { name: "a" });
    s.apply("setKeys", { animation: "a", target: "sequence", id: "fx", attachment: "fire", keys: [{ time: 0, value: 0 }, { time: 1, value: 3 }] });
    const sk = new Skeleton(s.doc);
    const state = new AnimationState(sk);
    state.setAnimation(0, "a", false, 0);
    state.update(0.5);
    sk.setToSetupPose();
    state.apply();
    expect(frameImage(sk)).toBe("f1"); // 1.5 -> frame 1
    state.update(0.5);
    sk.setToSetupPose();
    state.apply();
    expect(frameImage(sk)).toBe("f3");
  });

  it("reads a bound number input from the state machine", () => {
    const s = project();
    s.apply("createStateMachine", { name: "sm" });
    s.apply("addInput", { stateMachine: "sm", name: "level", type: "number", default: 2 });
    s.apply("updateAttachment", { slot: "fx", attachment: "fire", props: { input: "level", mode: "holdLast" } });
    expect(frameImage(new Skeleton(s.doc))).toBe("f2"); // default value without a running machine
    const inst = new OpenBoneInstance(s.doc);
    const sm = inst.useStateMachine("sm");
    sm.setInput("level", 1);
    inst.advance(1 / 60);
    expect(frameImage(inst.skeleton)).toBe("f1");
    sm.setInput("level", 99);
    inst.advance(1 / 60);
    expect(frameImage(inst.skeleton)).toBe("f3");
  });

  it("draws sheet cells with their own uvs, rect and trimmed quad", () => {
    const s = project();
    s.apply("addSequence", {
      slot: "fx",
      name: "cells",
      width: 20,
      height: 20,
      frames: [{ image: "sheet", rect: { x: 20, y: 0, width: 10, height: 20 }, trim: { x: 10, y: 0, sourceWidth: 20, sourceHeight: 20 } }],
    });
    const [it] = new Skeleton(s.doc).drawList();
    expect(Array.from(it.uvs)).toEqual([0.5, 0, 0.75, 0, 0.75, 1, 0.5, 1]);
    expect(it.textureRect).toEqual({ x: 20, y: 0, width: 10, height: 20 });
    // Right half of a 20x20 quad centred on the bone: x from 0 to 10.
    expect(Array.from(it.vertices)).toEqual([0, 10, 10, 10, 10, -10, 0, -10]);
  });

  it("draws packed frames from the atlas page and inside clipping masks", () => {
    const s = project();
    s.apply("addSlot", { bone: "root", name: "mask", index: 0 });
    s.apply("addClipping", { slot: "mask", shape: "rect", width: 100, height: 100 });
    const atlas = layoutAtlas(s.doc.images);
    atlas.pages.forEach((p) => (p.src = "page.png"));
    s.apply("setAtlas", { atlas });
    const sk = new Skeleton(s.doc);
    sk.update(0.1);
    const [it] = sk.drawList();
    const region = atlas.regions.find((r) => r.image === "f1")!;
    const page = atlas.pages[0];
    expect(it.texture?.id).toBe(page.id);
    expect(it.image?.id).toBe("f1");
    expect(it.uvs[0]).toBeCloseTo(region.x / page.width);
    expect(it.uvs[5]).toBeCloseTo((region.y + region.height) / page.height);
    expect(it.textureRect?.width).toBeCloseTo(region.width);
    expect(it.clip).toBeDefined();
  });
});
