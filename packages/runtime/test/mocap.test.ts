import fs from "node:fs";
import { DocumentStore, type OpenBoneDocument, guessPoseMapping, poseToKeys, smoothTrack } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance } from "../src/index.ts";
import { D, figure, poseTrack as track } from "./pose-figure.ts";

const knight = (): OpenBoneDocument => JSON.parse(fs.readFileSync(new URL("../../../examples/knight.obone", import.meta.url), "utf8"));

function applyOps(doc: OpenBoneDocument, ops: ReturnType<typeof poseToKeys>["ops"]) {
  const store = new DocumentStore(structuredClone(doc));
  store.transaction("video", (s) => ops.forEach((o) => s.apply(o.op, o.args)));
  return store.doc;
}

function pose(doc: OpenBoneDocument, anim: string, t: number) {
  const inst = new OpenBoneInstance(doc);
  inst.play(anim, false);
  inst.advance(t);
  return new Map(inst.skeleton.bones.map((b) => [b.data.name, b]));
}

const angle = (b: { world: { a: number; c: number } }) => (Math.atan2(b.world.c, b.world.a) * 180) / Math.PI;
const near = (a: number, b: number, tol: number) => expect(Math.abs(((a - b + 540) % 360) - 180)).toBeLessThan(tol);

describe("video to animation", () => {
  it("guesses the knight's mapping: limbs by side, IK feet follow the ankles", () => {
    const doc = knight();
    const names = Object.fromEntries(Object.entries(guessPoseMapping(doc)).map(([id, s]) => [doc.skeleton.bones.find((b) => b.id === id)!.name, s]));
    expect(names).toEqual({
      hip: "hips",
      torso: "spine",
      head: "head",
      "back-arm": "rightUpperArm",
      "back-forearm": "rightForearm",
      "back-hand": "rightHand",
      "back-foot": "rightAnkle",
      "front-arm": "leftUpperArm",
      "front-forearm": "leftForearm",
      "front-hand": "leftHand",
      "front-foot": "leftAnkle",
    });
    expect(guessPoseMapping(doc, { frontSide: "right" })[doc.skeleton.bones.find((b) => b.name === "front-arm")!.id]).toBe("rightUpperArm");
  });

  it("keys bones to point along their body segments, under their parents' new poses", () => {
    const doc = knight();
    const res = poseToKeys(doc, track(2), { animation: "from video", fps: 30, tolerance: 0, smoothing: 0 });
    expect(res.ops[0]).toEqual({ op: "createAnimation", args: { name: "from video" } });
    expect(res.samples).toBe(61);
    expect(res.warnings).toEqual([]);
    const after = applyOps(doc, res.ops);
    for (const t of [0, 0.5, 1.2, 2]) {
      const b = pose(after, "from video", t);
      const f = figure(t);
      near(angle(b.get("torso")!), f.spine, 0.05);
      near(angle(b.get("front-arm")!), f.leftUpperArm, 0.05);
      near(angle(b.get("front-forearm")!), f.leftForearm, 0.05);
      near(angle(b.get("back-arm")!), f.rightUpperArm, 0.05);
      near(angle(b.get("back-hand")!), f.rightHand, 0.05);
      // The IK feet sit where the ankles are, relative to the hips, at the video's scale.
      const hip = b.get("hip")!;
      const foot = b.get("front-foot")!;
      const knee: [number, number] = [f.hips[0] + Math.cos(f.leftThigh * D) * 90, -f.hips[1] + Math.sin(f.leftThigh * D) * 90];
      const ankle = [knee[0] + Math.cos(f.leftShin * D) * 95, knee[1] + Math.sin(f.leftShin * D) * 95];
      expect(foot.world.x - hip.world.x).toBeCloseTo((ankle[0] - f.hips[0]) * res.scale, 2);
      expect(foot.world.y - hip.world.y).toBeCloseTo((ankle[1] + f.hips[1]) * res.scale, 2);
    }
  });

  it("moves the hips with the body, in place or not at all", () => {
    const doc = knight();
    const hipX = (rootMotion: "full" | "inPlace" | "off", t: number) => {
      const res = poseToKeys(doc, track(1), { animation: "a", rootMotion, tolerance: 0, smoothing: 0 });
      const b = pose(applyOps(doc, res.ops), "a", t).get("hip")!;
      return [b.world.x, b.world.y, res.scale] as const;
    };
    const [x0] = hipX("full", 0);
    const [x1, , s] = hipX("full", 1);
    expect(x1 - x0).toBeCloseTo(60 * s, 3);
    const [i0, iy0] = hipX("inPlace", 0);
    const [i1, iy1] = hipX("inPlace", 0.2);
    expect(i1).toBeCloseTo(i0, 3);
    expect(iy1 - iy0).toBeCloseTo(-10 * Math.sin(1.2) * s, 2);
    const res = poseToKeys(doc, track(1), { animation: "a", rootMotion: "off" });
    const hipId = doc.skeleton.bones.find((b) => b.name === "hip")!.id;
    expect(res.ops.some((o) => o.op === "setKeys" && o.args.id === hipId)).toBe(false);
  });

  it("mirrors left to right", () => {
    const doc = knight();
    const res = poseToKeys(doc, track(1), { animation: "m", mirror: true, tolerance: 0, smoothing: 0 });
    const b = pose(applyOps(doc, res.ops), "m", 0.5);
    const f = figure(0.5);
    // The front arm (left) now follows the right arm, seen in a mirror.
    near(angle(b.get("front-arm")!), 180 - f.rightUpperArm, 0.05);
    near(angle(b.get("back-arm")!), 180 - f.leftUpperArm, 0.05);
  });

  it("relative mode keeps the setup angle at the first frame", () => {
    const doc = knight();
    const res = poseToKeys(doc, track(1), { animation: "r", mode: "relative", tolerance: 0, smoothing: 0 });
    const after = applyOps(doc, res.ops);
    const setup = new OpenBoneInstance(doc);
    setup.advance(0);
    const setupAngle = angle(setup.skeleton.bones.find((x) => x.data.name === "front-arm")!);
    const b0 = pose(after, "r", 0).get("front-arm")!;
    const b1 = pose(after, "r", 0.6).get("front-arm")!;
    near(angle(b0), setupAngle, 0.05);
    near(angle(b1) - angle(b0), figure(0.6).leftUpperArm - figure(0).leftUpperArm, 0.05);
  });

  it("simplifies keys within the tolerance and replaces only the clip's range in an existing animation", () => {
    const doc = knight();
    const full = poseToKeys(doc, track(2), { animation: "clip", tolerance: 0, smoothing: 0 });
    const lean = poseToKeys(doc, track(2), { animation: "clip", tolerance: 1, smoothing: 0 });
    expect(lean.keys).toBeLessThan(full.keys / 2);
    const after = applyOps(doc, lean.ops);
    // Each bone stays within the tolerance of its own samples; the arm's world angle adds the torso's error.
    for (let i = 0; i <= 20; i++) (t => near(angle(pose(after, "clip", t).get("front-arm")!), figure(t).leftUpperArm, 2.05))(i / 10);
    // clip exists now: a clip placed at 3 s keeps the keys before it.
    const before = after.animations.find((a) => a.name === "clip")!;
    const again = poseToKeys(after, track(1), { animation: "clip", at: 3, tolerance: 1, smoothing: 0 });
    expect(again.ops.some((o) => o.op === "createAnimation")).toBe(false);
    const merged = applyOps(after, again.ops).animations.find((a) => a.name === "clip")!;
    const armId = doc.skeleton.bones.find((b) => b.name === "front-arm")!.id;
    const keysOf = (a: typeof before) => a.timelines.find((x) => x.target === "bone" && x.id === armId && x.property === "rotation")!.keys;
    expect(keysOf(merged).filter((k) => k.time <= 2 + 1e-6)).toEqual(keysOf(before));
    expect(keysOf(merged).some((k) => k.time >= 3)).toBe(true);
    // The knight's own 1 s "walk" grows to fit a 2 s clip.
    const walk = applyOps(doc, poseToKeys(doc, track(2), { animation: "walk" }).ops).animations.find((a) => a.name === "walk")!;
    expect(walk.duration === 0 || walk.duration >= 2).toBe(true);
  });

  it("holds hidden joints and warns about them", () => {
    const doc = knight();
    const res = poseToKeys(doc, track(1, 30, [16]), { animation: "h" });
    expect(res.warnings.join(" ")).toMatch(/right wrist was hidden in 100% of frames/);
    const sm = smoothTrack(track(1, 30, [15]), { minVisibility: 0.5 });
    expect(sm.frames[10].points[15]).toBeNull();
  });
});
