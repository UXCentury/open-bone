import { createDocument, deserialize, deserializeBinary } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { atlasExportFiles } from "../src/index.ts";

const png = "data:image/png;base64,iVBORw0KGgo=";
const jpg = "data:image/jpeg;base64,/9j/4AAQ";

function packed(pages: string[], scale?: number) {
  const d = createDocument("hero");
  d.images = [{ id: "i", name: "i", src: "", width: 10, height: 10 }];
  d.atlas = {
    pages: pages.map((src, k) => ({ id: `atlas_page${k}`, name: `atlas ${k + 1}`, src, width: 16, height: 16 })),
    regions: [{ image: "i", page: "atlas_page0", x: 1, y: 1, width: 10, height: 10, offsetX: 0, offsetY: 0, originalWidth: 10, originalHeight: 10 }],
    padding: 1,
    ...(scale ? { scale } : {}),
    filterMin: "mipmap",
    wrapX: "repeat",
  };
  return d;
}

describe("atlas export files", () => {
  it("writes one data file + page set per scale, named by suffix, pointing at its own pages", () => {
    const files = atlasExportFiles("hero", [
      { suffix: "", doc: packed([png, png]) },
      { suffix: "@0.5x", doc: packed([jpg], 0.5) },
    ]);
    expect(files.map((f) => f.name)).toEqual(["hero.json", "hero@0.5x.json", "hero.png", "hero_2.png", "hero@0.5x.jpg"]);
    const full = deserialize(new TextDecoder().decode(files[0].data));
    const half = deserialize(new TextDecoder().decode(files[1].data));
    expect(full.atlas!.pages.map((p) => p.src)).toEqual(["hero.png", "hero_2.png"]);
    expect(half.atlas!.pages.map((p) => p.src)).toEqual(["hero@0.5x.jpg"]);
    expect(half.atlas).toMatchObject({ scale: 0.5, filterMin: "mipmap", wrapX: "repeat" });
    // Page bytes are the data: URI's bytes.
    expect(Array.from(files[2].data.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(Array.from(files[4].data.subarray(0, 2))).toEqual([0xff, 0xd8]);
  });

  it("writes binary data and refuses clashing names", () => {
    const files = atlasExportFiles("hero", [{ suffix: "", doc: packed([png]) }], { binary: true });
    expect(files.map((f) => f.name)).toEqual(["hero.obonb", "hero.png"]);
    expect(deserializeBinary(files[0].data).atlas!.pages[0].src).toBe("hero.png");
    expect(() => atlasExportFiles("hero", [{ suffix: "", doc: packed([png]) }, { suffix: "", doc: packed([png]) }])).toThrow(/suffix/);
  });

  it("leaves the documents as they were", () => {
    const d = packed([png]);
    atlasExportFiles("hero", [{ suffix: "", doc: d }]);
    expect(d.atlas!.pages[0].src).toBe(png);
  });
});
