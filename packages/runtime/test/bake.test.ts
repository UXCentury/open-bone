import { DocumentStore, type OpenBoneDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../conformance/fixtures.ts";
import { OpenBoneInstance, bakeConstraints } from "../src/index.ts";

/** World matrices of every bone at each grid time of `fps`, playing `anim` from 0. */
function worlds(doc: OpenBoneDocument, anim: string, fps: number, end: number) {
  const inst = new OpenBoneInstance(doc);
  inst.play(anim, false);
  inst.advance(0);
  const out: number[][][] = [inst.skeleton.bones.map((b) => [b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y])];
  let now = 0;
  for (let i = 1; now < end - 1e-6; i++) {
    const next = Math.min(i / fps, end);
    inst.advance(next - now);
    now = next;
    out.push(inst.skeleton.bones.map((b) => [b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y]));
  }
  return out;
}

function applyBake(doc: OpenBoneDocument, ops: ReturnType<typeof bakeConstraints>["ops"]) {
  const store = new DocumentStore(structuredClone(doc));
  store.transaction("bake", (s) => ops.forEach((o) => s.apply("setKeys", o)));
  return store.doc;
}

describe("bakeConstraints", () => {
  for (const [name, anim] of [["constraints", "reach"], ["mapping", "drive"]] as const) {
    it(`reproduces the constrained motion of the ${name} fixture with the constraints keyed off`, () => {
      const doc = FIXTURES[name]();
      const res = bakeConstraints(doc, { animation: anim, fps: 30, tolerance: 0 });
      expect(res.bones.length).toBeGreaterThan(0);
      expect(res.constraints.length).toBe(doc.skeleton.ik.length + doc.skeleton.transform.length + doc.skeleton.path.length + doc.skeleton.physics.length);
      const after = applyBake(doc, res.ops);
      const a = worlds(doc, anim, 30, 2);
      const b = worlds(after, anim, 30, 2);
      expect(b.length).toBe(a.length);
      for (let f = 0; f < a.length; f++)
        for (let i = 0; i < a[f].length; i++) for (let k = 0; k < 6; k++) expect(b[f][i][k]).toBeCloseTo(a[f][i][k], 2);
    });
  }

  it("simplifies linear runs and keeps keys outside a partial range", () => {
    const doc = FIXTURES.constraints();
    const res = bakeConstraints(doc, { animation: "reach", bones: ["follower-w"], start: 0.5, end: 1, fps: 60, tolerance: 0.5 });
    expect(res.bones).toEqual(["follower-w"]);
    expect(res.constraints).toEqual(["world"]);
    const rot = res.ops.find((o) => o.target === "bone" && o.property === "rotation")!;
    expect(rot.keys[0].time).toBe(0.5);
    expect(rot.keys.at(-1)!.time).toBe(1);
    expect(rot.keys.length).toBeLessThan(31);
    const mix = res.ops.find((o) => o.target === "transform")!;
    expect(mix.keys.map((k) => [k.time, k.value])).toEqual([[0, 1], [0.5, 0], [1, 0], [1.0167, 1]]);
  });

  it("refuses unknown animations and bones", () => {
    const doc = FIXTURES.constraints();
    expect(() => bakeConstraints(doc, { animation: "nope" })).toThrow(/not found/);
    expect(() => bakeConstraints(doc, { animation: "reach", bones: ["nope"] })).toThrow(/not found/);
  });
});
