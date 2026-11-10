import { describe, expect, it } from "vitest";
import { dragAmount, partOrigin, partProps, type PartState } from "../src/part-transform.ts";

const region = (o: Partial<{ x: number; y: number; rotation: number; scaleX: number; scaleY: number }> = {}) =>
  ({ type: "region", name: "r", image: "img", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 10, height: 10, color: "#ffffff", ...o }) as PartState["att"];
const at = (att: PartState["att"], world = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }): PartState => ({ slotId: "s", name: att.name, att, world });

describe("part rotate / scale", () => {
  it("turns a part around its own origin without moving it", () => {
    const p = at(region({ x: 5, y: 2, rotation: 10 }));
    expect(partProps(p, "rotate", partOrigin(p), 30)).toEqual({ rotation: 40 });
  });

  it("turns the other way on a mirrored bone", () => {
    const p = at(region({ rotation: 10 }), { a: -1, b: 0, c: 0, d: 1, x: 0, y: 0 });
    expect(partProps(p, "rotate", partOrigin(p), 30).rotation).toBe(-20);
  });

  it("moves other parts round the pivot, in their own bone space", () => {
    // Bone turned 90°: local x is world up.
    const p = at(region({ x: 10, y: 0 }), { a: 0, b: -1, c: 1, d: 0, x: 0, y: 0 });
    expect(partOrigin(p)).toEqual([0, 10]);
    const props = partProps(p, "rotate", [0, 0], 90); // world (0,10) → (-10,0)
    expect(props.rotation).toBe(90);
    expect(props.x).toBeCloseTo(0);
    expect(props.y).toBeCloseTo(10);
  });

  it("scales regions by scale, shapes and text by size, positions round the pivot", () => {
    expect(partProps(at(region({ scaleX: 1, scaleY: -1 })), "scale", [0, 0], 2)).toEqual({ scaleX: 2, scaleY: -2 });
    const shape = { type: "shape", name: "s", shape: "rect", x: 4, y: 0, rotation: 0, width: 10, height: 6, radius: 2, fill: "#fff" } as unknown as PartState["att"];
    expect(partProps(at(shape), "scale", [0, 0], 1.5)).toEqual({ width: 15, height: 9, radius: 3, x: 6, y: 0 });
  });

  it("snaps the drag with Shift", () => {
    expect(dragAmount("rotate", [0, 0], [10, 0], [10, 3], true)).toBe(15);
    expect(dragAmount("rotate", [0, 0], [10, 0], [0, 10], false)).toBeCloseTo(90);
    expect(dragAmount("scale", [0, 0], [10, 0], [17.4, 0], true)).toBe(1.7);
  });
});
