import { describe, expect, it } from "vitest";
import { artboardTargets, pointTargets, snapPoint } from "../src/index.ts";

const board = artboardTargets({ width: 400, height: 200, originX: 200, originY: 100 });

describe("snapPoint", () => {
  it("snaps each axis independently to the artboard centre within the threshold", () => {
    const r = snapPoint(3, 47, board, 5);
    // x 3 → origin/centre 0 (same line here); y 47 is far from 0 and from edges ±100
    expect(r.x).toBe(0);
    expect(r.y).toBe(47);
    expect(r.lines).toHaveLength(1);
  });

  it("leaves points alone outside the threshold", () => {
    expect(snapPoint(20, 30, board, 5)).toEqual({ x: 20, y: 30, lines: [] });
  });

  it("snaps to the grid and prefers guides over the grid when both are close", () => {
    expect(snapPoint(23, 51, [], 4, 25)).toMatchObject({ x: 25, y: 50 });
    const r = snapPoint(23, 0, [{ axis: "x", value: 22, kind: "guide" }], 4, 25);
    expect(r.x).toBe(22);
    expect(r.lines[0].kind).toBe("guide");
  });

  it("aligns with other points and reports the point for drawing", () => {
    const r = snapPoint(52, -80, pointTargets([[50, 10]]), 4);
    expect(r.x).toBe(50);
    expect(r.lines[0]).toMatchObject({ axis: "x", kind: "point", other: 10 });
  });

  it("artboard targets cover edges, centre and origin in skeleton space (y-up)", () => {
    const xs = board.filter((t) => t.axis === "x").map((t) => t.value).sort((a, b) => a - b);
    const ys = board.filter((t) => t.axis === "y").map((t) => t.value).sort((a, b) => a - b);
    expect(xs).toEqual([-200, 0, 0, 200]);
    expect(ys).toEqual([-100, 0, 0, 100]);
  });
});
