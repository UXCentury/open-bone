import type { MeshAttachment } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { deformFor } from "../src/ffd-math.ts";
import { weightedWorld } from "../src/tools/knots.ts";

const I = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
const mesh = (o: Partial<MeshAttachment>) => ({ type: "mesh", name: "m", image: "i", vertices: [0, 0, 10, 0, 10, 10], uvs: [], triangles: [0, 1, 2], hull: 3, color: "#ffffff", ...o }) as MeshAttachment;

describe("free-form deformation offsets", () => {
  it("unweighted: the offset in the slot bone's space, other vertices keep theirs", () => {
    const att = mesh({});
    const bone = { a: 0, b: -1, c: 1, d: 0, x: 100, y: 0 }; // turned 90°, at x = 100
    // Vertex 1 is at local (10, 0) → world (100, 10). Drag it to world (100, 13): local (13, 0), offset (3, 0).
    const out = deformFor(att, () => bone, bone, [0, 0, 1, 1, 0, 0], new Map([[1, [100, 13]]]));
    expect(out[0]).toBe(0);
    expect(out[2]).toBeCloseTo(3);
    expect(out[3]).toBeCloseTo(0);
    expect(out.slice(4)).toEqual([0, 0]);
  });

  it("weighted: the same offset on every influence lands the vertex exactly where it was dropped", () => {
    const bones: Record<string, typeof I> = { a: { ...I, x: 0 }, b: { a: 2, b: 0, c: 0, d: 2, x: 50, y: 0 } };
    const inf = [
      { bone: "a", x: 10, y: 0, weight: 0.5 },
      { bone: "b", x: -20, y: 0, weight: 0.5 },
    ];
    const att = mesh({ vertices: [0, 0], weights: [inf], hull: 1, triangles: [] });
    const off = deformFor(att, (id) => bones[id], I, [0, 0], new Map([[0, [20, 8]]]));
    const moved = inf.map((i) => ({ ...i, x: i.x + off[0], y: i.y + off[1] }));
    const [wx, wy] = weightedWorld(moved, (id) => bones[id]);
    expect(wx).toBeCloseTo(20);
    expect(wy).toBeCloseTo(8);
  });
});
