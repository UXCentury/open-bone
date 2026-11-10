import { describe, expect, it } from "vitest";
import { buildSpline } from "@openbone/core";
import {
  type Mat,
  applyMode,
  blendInfluences,
  cubicAt,
  deleteKnots,
  deletePoints,
  ellipsePolygon,
  inferMode,
  insertKnot,
  insertPoint,
  localOffset,
  moveAnchor,
  moveHandle,
  nearestEdge,
  nearestOnPath,
  placedKnot,
  rebindWorld,
  rectPolygon,
  resetHandles,
  segmentPoints,
  splitCubic,
  weightedOffset,
  weightedWorld,
} from "../src/tools/knots.ts";

// Two knots: (0,0) → (100,0) with handles bulging up.
const PATH = [-30, -20, 0, 0, 30, 40, 70, 40, 100, 0, 130, -20];

const close = (a: number[], b: number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));
};

describe("Bézier split", () => {
  it("splits a cubic into two halves that trace the same curve", () => {
    const P: [number, number][] = [[0, 0], [30, 40], [70, 40], [100, 0]];
    const [l0, l1, l2, m, r1, r2, r3] = splitCubic(P[0], P[1], P[2], P[3], 0.3);
    close(m, cubicAt(P[0], P[1], P[2], P[3], 0.3));
    for (const u of [0, 0.25, 0.5, 1]) {
      close(cubicAt(l0, l1, l2, m, u), cubicAt(P[0], P[1], P[2], P[3], 0.3 * u));
      close(cubicAt(m, r1, r2, r3, u), cubicAt(P[0], P[1], P[2], P[3], 0.3 + 0.7 * u));
    }
  });

  it("inserting a knot keeps the path's shape and length", () => {
    const { vertices, knot } = insertKnot(PATH, 0, 0.5);
    expect(knot).toBe(1);
    expect(vertices.length).toBe(18);
    expect(vertices.slice(8, 10)).toEqual(cubicAt([0, 0], [30, 40], [70, 40], [100, 0], 0.5));
    // Outer handles are untouched; inner ones shortened.
    expect(vertices.slice(0, 2)).toEqual([-30, -20]);
    expect(vertices.slice(16, 18)).toEqual([130, -20]);
    expect(inferMode(vertices, 1)).toBe("mirrored");
    const a = buildSpline(PATH, false);
    const b = buildSpline(vertices, false);
    expect(b.length).toBeCloseTo(a.length, 0);
    for (const d of [10, 50, 90]) {
      const sa = a.sample((a.length * d) / 100);
      const sb = b.sample((b.length * d) / 100);
      expect(Math.hypot(sa.x - sb.x, sa.y - sb.y)).toBeLessThan(0.5);
    }
  });

  it("inserts on the closing segment of a closed path", () => {
    const tri = [0, 0, 0, 0, 0, 0, 100, 0, 100, 0, 100, 0, 50, 80, 50, 80, 50, 80];
    const { vertices, knot } = insertKnot(tri, 2, 0.5);
    expect(knot).toBe(3);
    expect(vertices.slice(20, 22)).toEqual([25, 40]);
    expect(segmentPoints(vertices, 3)[3]).toEqual([0, 0]);
  });

  it("finds the nearest point on the curve", () => {
    const top = cubicAt([0, 0], [30, 40], [70, 40], [100, 0], 0.5);
    const hit = nearestOnPath(PATH, false, top[0], top[1] + 5)!;
    expect(hit.segment).toBe(0);
    expect(hit.t).toBeCloseTo(0.5, 2);
    expect(hit.dist).toBeCloseTo(5, 1);
    expect(nearestOnPath(PATH.slice(0, 6), false, 0, 0)).toBeNull();
  });

  it("deletes knots", () => {
    const three = insertKnot(PATH, 0, 0.5).vertices;
    expect(deleteKnots(three, [1])).toEqual(three.slice(0, 6).concat(three.slice(12)));
  });
});

describe("handle modes", () => {
  const knot = (inH: number[], a: number[], out: number[]) => [...inH, ...a, ...out];
  it("infers mirrored, smooth and broken", () => {
    expect(inferMode(knot([-10, 0], [0, 0], [10, 0]), 0)).toBe("mirrored");
    expect(inferMode(knot([-10, 0], [0, 0], [30, 0]), 0)).toBe("smooth");
    expect(inferMode(knot([-10, 0], [0, 0], [0, 10]), 0)).toBe("broken");
    expect(inferMode(knot([0, 0], [0, 0], [0, 0]), 0)).toBe("broken");
  });

  it("smooth keeps the other handle's length, mirrored matches it, broken leaves it", () => {
    const k = knot([-10, 0], [0, 0], [30, 0]);
    close(moveHandle(k, 0, 2, [0, 20], "smooth"), [0, -10, 0, 0, 0, 20]);
    close(moveHandle(k, 0, 2, [0, 20], "mirrored"), [0, -20, 0, 0, 0, 20]);
    close(moveHandle(k, 0, 0, [0, 5], "broken"), [0, 5, 0, 0, 30, 0]);
  });

  it("moving an anchor carries both handles", () => {
    close(moveAnchor(knot([-10, 0], [0, 0], [30, 0]), 0, [5, 5]), [-5, 5, 5, 5, 35, 5]);
  });

  it("applies a mode to a broken knot", () => {
    const k = knot([-10, 0], [0, 0], [0, 20]);
    const smooth = applyMode(k, 0, "smooth");
    expect(inferMode(smooth, 0)).toBe("smooth");
    expect(Math.hypot(smooth[0], smooth[1])).toBeCloseTo(10);
    const mirrored = applyMode(knot([-10, 0], [0, 0], [0, 30]), 0, "mirrored");
    expect(inferMode(mirrored, 0)).toBe("mirrored");
  });

  it("resets handles to a smooth curve through the neighbours", () => {
    const three = [0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 100, 0, 100, 0, 100, 0];
    const r = resetHandles(three, false, 1);
    expect(inferMode(r, 1)).not.toBe("broken");
    expect(r[7]).toBeCloseTo(50); // handles level at the peak
    expect(r[11]).toBeCloseTo(50);
  });

  it("places knots with mirrored handles (backwards when prepending)", () => {
    expect(placedKnot([0, 0], null)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(placedKnot([0, 0], [10, 5])).toEqual([-10, -5, 0, 0, 10, 5]);
    expect(placedKnot([0, 0], [10, 5], true)).toEqual([10, 5, 0, 0, -10, -5]);
  });
});

describe("polygon points", () => {
  const sq = rectPolygon(0, 0, 100, 100);
  it("builds rectangles and ellipses", () => {
    expect(sq).toEqual([-50, -50, 50, -50, 50, 50, -50, 50]);
    const e = ellipsePolygon(0, 0, 20, 10, 8);
    expect(e.length).toBe(16);
    expect(e.slice(0, 2)).toEqual([20, 0]);
    expect(e[5]).toBeCloseTo(10);
  });
  it("inserts on the nearest edge and deletes", () => {
    const hit = nearestEdge(sq, 0, -52)!;
    expect(hit.edge).toBe(0);
    expect(hit.dist).toBeCloseTo(2);
    expect(nearestEdge(sq, -51, 0)!.edge).toBe(3); // the closing edge
    const { vertices, index } = insertPoint(sq, 0, 0, -50);
    expect(index).toBe(1);
    expect(vertices).toEqual([-50, -50, 0, -50, 50, -50, 50, 50, -50, 50]);
    expect(deletePoints(vertices, [1])).toEqual(sq);
  });
});

describe("weighted points", () => {
  const bones: Record<string, Mat> = {
    a: { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 },
    // rotated 90° and moved
    b: { a: 0, b: -1, c: 1, d: 0, x: 100, y: 0 },
  };
  const get = (id: string) => bones[id];

  it("re-binds a point through its weights so it lands where it was dragged", () => {
    const inf = rebindWorld([{ bone: "a", weight: 1 }, { bone: "b", weight: 3 }], get, 40, 25);
    expect(inf.map((i) => i.weight)).toEqual([0.25, 0.75]);
    close(weightedWorld(inf, get), [40, 25]);
    // Each influence alone also maps there (positions are the same world point in each bone's space).
    for (const i of inf) close(weightedWorld([{ ...i, weight: 1 }], get), [40, 25]);
  });

  it("finds the deform offset that moves a weighted point", () => {
    const inf = rebindWorld([{ bone: "a", weight: 0.5 }, { bone: "b", weight: 0.5 }], get, 10, 10);
    const off = weightedOffset(inf, get, 30, -5);
    close(weightedWorld(inf, get, off), [30, -5]);
  });

  it("finds the offset for an unweighted point", () => {
    const m = bones.b;
    const off = localOffset(m, 5, 5, 90, 20);
    const [x, y] = [5 + off[0], 5 + off[1]];
    close([m.a * x + m.b * y + m.x, m.c * x + m.d * y + m.y], [90, 20]);
  });

  it("blends influences", () => {
    const m = blendInfluences(new Map([["a", 1]]), new Map([["b", 1]]), 0.25);
    expect(m.get("a")).toBeCloseTo(0.75);
    expect(m.get("b")).toBeCloseTo(0.25);
  });
});
