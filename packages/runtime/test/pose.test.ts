import { DocumentStore, apply, createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { Skeleton, poseChainFrom, poseEffector, poseGrabPoint, solvePose } from "../src/index.ts";

/** root → shoulder (fixed) → upper → lower → hand, a horizontal arm. */
function arm() {
  const s = new DocumentStore(createDocument("arm"));
  s.apply("addBone", { name: "shoulder", length: 10 });
  s.apply("addBone", { name: "upper", parent: "shoulder", x: 10, length: 100 });
  s.apply("addBone", { name: "lower", parent: "upper", x: 100, length: 100 });
  s.apply("addBone", { name: "hand", parent: "lower", x: 100, length: 30 });
  return new Skeleton(s.doc);
}

describe("pose tool solver", () => {
  it("bends a chain so the grabbed tip reaches a reachable target", () => {
    const sk = arm();
    const hand = sk.findBone("hand")!;
    const chain = { bones: poseChainFrom(hand, 3), local: [30, 0] as [number, number] };
    expect(chain.bones.map((b) => b.data.name)).toEqual(["hand", "lower", "upper"]);
    const miss = solvePose(chain, 120, 120);
    expect(miss).toBeLessThan(0.01);
    const [ex, ey] = poseEffector(chain);
    expect(ex).toBeCloseTo(120, 2);
    expect(ey).toBeCloseTo(120, 2);
  });

  it("leaves bones outside the chain alone and stops at the root", () => {
    const sk = arm();
    const shoulder = sk.findBone("shoulder")!;
    const before = shoulder.rotation;
    const chain = { bones: poseChainFrom(sk.findBone("hand")!, 10), local: [30, 0] as [number, number] };
    // The chain climbs to the shoulder but never the parentless root bone.
    expect(chain.bones.map((b) => b.data.name)).toEqual(["hand", "lower", "upper", "shoulder"]);
    solvePose({ bones: chain.bones.slice(0, 2), local: chain.local }, 180, 60);
    expect(shoulder.rotation).toBe(before);
    expect(sk.findBone("upper")!.rotation).toBe(0);
  });

  it("points straight at an unreachable target", () => {
    const sk = arm();
    const chain = { bones: poseChainFrom(sk.findBone("hand")!, 3), local: [30, 0] as [number, number] };
    solvePose(chain, 0, 1000);
    const [ex, ey] = poseEffector(chain);
    // Fully extended toward the target: about 230 from the elbow chain's base at (10, 0).
    expect(Math.hypot(ex - 10, ey)).toBeCloseTo(230, 0);
    expect(Math.atan2(ey, ex - 10)).toBeCloseTo(Math.PI / 2, 1);
  });

  it("works under a flipped parent", () => {
    const s = new DocumentStore(createDocument("flip"));
    s.apply("addBone", { name: "mirror", scaleX: -1, length: 10 });
    s.apply("addBone", { name: "a", parent: "mirror", x: 10, length: 100 });
    s.apply("addBone", { name: "b", parent: "a", x: 100, length: 100 });
    const sk = new Skeleton(s.doc);
    const chain = { bones: poseChainFrom(sk.findBone("b")!, 2), local: [100, 0] as [number, number] };
    expect(solvePose(chain, -60, 120)).toBeLessThan(0.01);
  });

  it("grabbing near a joint uses the bone's tip", () => {
    const sk = arm();
    const lower = sk.findBone("lower")!;
    const [jx, jy] = apply(lower.world, 5, 1);
    expect(poseGrabPoint(lower, jx, jy)).toEqual([100, 0]);
    const [mx, my] = apply(lower.world, 80, 3);
    const g = poseGrabPoint(lower, mx, my);
    expect(g[0]).toBeCloseTo(80, 6);
    expect(g[1]).toBeCloseTo(3, 6);
  });
});
