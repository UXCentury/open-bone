import { describe, expect, it } from "vitest";
import { artboardRect, fitView } from "../src/player.ts";

describe("fitting the artboard", () => {
  it("contain shows all of it with bars on the longer side", () => {
    // 1600×900 artboard on a 1920×900 canvas: bars left and right.
    expect(fitView(1920, 900, 1600, 900, "contain")).toEqual({ zoom: 1, x: 160, y: 0 });
  });

  it("cover fills the canvas, cropping top and bottom", () => {
    const v = fitView(1920, 900, 1600, 900, "cover");
    expect(v.zoom).toBeCloseTo(1.2);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(-90);
  });

  it("auto covers when the crop is small and contains when it is not", () => {
    // 16:9 art on a 1920×950 full-screen stage: cover crops ~12% of the height.
    expect(fitView(1920, 950, 1600, 900, "auto")).toEqual(fitView(1920, 950, 1600, 900, "cover"));
    // 16:9 art on a 4:3 screen: cover would crop 25% of the width.
    expect(fitView(1024, 768, 1600, 900, "auto")).toEqual(fitView(1024, 768, 1600, 900, "contain"));
  });

  it("none keeps actual size, centred", () => {
    expect(fitView(800, 600, 400, 300, "none")).toEqual({ zoom: 1, x: 200, y: 150 });
  });
});

describe("clip rectangle", () => {
  it("is the artboard's area when it fits inside the canvas", () => {
    expect(artboardRect({ x: 160, y: 0, zoom: 1 }, 1600, 900, 1920, 900)).toEqual({ x: 160, y: 0, w: 1600, h: 900 });
  });

  it("is cut to the canvas when the artboard overflows it (cover)", () => {
    expect(artboardRect({ x: 0, y: -90, zoom: 1.2 }, 1600, 900, 1920, 900)).toEqual({ x: 0, y: 0, w: 1920, h: 900 });
  });

  it("is null when the artboard is off the canvas", () => {
    expect(artboardRect({ x: 2000, y: 0, zoom: 1 }, 100, 100, 1920, 900)).toBeNull();
  });
});
