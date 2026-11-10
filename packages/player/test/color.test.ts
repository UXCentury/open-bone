import { describe, expect, it } from "vitest";
import { colorToGl } from "../src/player.ts";

describe("background colours for WebGL", () => {
  it("parses every hex form as premultiplied RGBA", () => {
    expect(colorToGl("#ffffff")).toEqual([1, 1, 1, 1]);
    expect(colorToGl("#fff")).toEqual([1, 1, 1, 1]);
    expect(colorToGl("#f008")).toEqual([0.5333333333333333, 0, 0, 0.5333333333333333]);
    expect(colorToGl("#00ff0080")[3]).toBeCloseTo(0.502, 3);
    expect(colorToGl("#336699").map((v) => Math.round(v * 255))).toEqual([51, 102, 153, 255]);
  });
});
