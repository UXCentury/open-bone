import { DocumentStore, createDocument, layoutAtlas } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { Skeleton } from "../src/index.ts";

function project() {
  const s = new DocumentStore(createDocument("atlas"));
  s.apply("addImage", { id: "img_a", name: "a", src: "a.png", width: 40, height: 20 });
  s.apply("addImage", { id: "img_b", name: "b", src: "b.png", width: 16, height: 64 });
  s.apply("addSlot", { bone: "root", name: "a" });
  s.apply("addRegion", { slot: "a", image: "a", x: 5, y: 7, rotation: 30 });
  s.apply("addSlot", { bone: "root", name: "b" });
  s.apply("addMesh", { slot: "b", image: "b", cols: 2, rows: 3 });
  s.apply("addSlot", { bone: "root", name: "c" });
  s.apply("addShape", { slot: "c", shape: "rect", fill: "#ff0000" });
  return s;
}

const page = { id: "pg", name: "pg", src: "pg.png", width: 128, height: 128 };

describe("atlas uv remapping in the draw list", () => {
  it("leaves unpacked documents alone", () => {
    const [a, b, c] = new Skeleton(project().doc).drawList();
    expect(a.texture?.id).toBe("img_a");
    expect(Array.from(a.uvs)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(b.texture?.id).toBe("img_b");
    expect(c.texture).toBeNull();
  });

  it("maps region and mesh uvs into their page rect and keeps the geometry", () => {
    const s = project();
    const before = new Skeleton(s.doc).drawList();
    s.apply("setAtlas", {
      atlas: {
        pages: [page],
        regions: [
          { image: "a", page: "pg", x: 2, y: 2, width: 40, height: 20 },
          { image: "b", page: "pg", x: 44, y: 2, width: 16, height: 64 },
        ],
        white: { page: "pg", x: 2, y: 30, width: 4, height: 4 },
      },
    });
    const after = new Skeleton(s.doc).drawList();
    const [a, b, c] = after;
    for (const it of after) expect(it.texture?.id).toBe("pg");
    expect(a.image?.id).toBe("img_a");
    // Region corners land on the packed rect corners.
    const ua = Array.from(a.uvs).map((x, i) => x * (i % 2 ? page.height : page.width));
    expect(ua.map((x) => +x.toFixed(4))).toEqual([2, 2, 42, 2, 42, 22, 2, 22]);
    // Mesh uvs: same linear map, per vertex.
    const src = s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[1].id].b;
    if (src.type !== "mesh") throw new Error("expected mesh");
    for (let i = 0; i < src.uvs.length; i += 2) {
      expect(b.uvs[i] * 128).toBeCloseTo(44 + src.uvs[i] * 16, 4);
      expect(b.uvs[i + 1] * 128).toBeCloseTo(2 + src.uvs[i + 1] * 64, 4);
    }
    // Shapes sample the centre of the white block.
    for (let i = 0; i < c.uvs.length; i += 2) expect([c.uvs[i] * 128, c.uvs[i + 1] * 128]).toEqual([4, 32]);
    expect(c.image).toBeNull();
    // Geometry is unchanged.
    after.forEach((it, i) => expect(Array.from(it.vertices)).toEqual(Array.from(before[i].vertices)));
    // The document's own mesh uvs are not touched.
    expect(src.uvs.every((u) => u >= 0 && u <= 1)).toBe(true);
  });

  it("shrinks a trimmed region quad to the packed part of the image", () => {
    const s = project();
    s.apply("updateAttachment", { slot: "a", attachment: "a", props: { rotation: 0, x: 0, y: 0 } });
    const full = new Skeleton(s.doc).drawList()[0].vertices;
    // Only the 20x10 block at (10, 5) of the 40x20 image is packed.
    s.apply("setAtlas", {
      atlas: { pages: [page], regions: [{ image: "a", page: "pg", x: 0, y: 0, width: 20, height: 10, offsetX: 10, offsetY: 5 }] },
    });
    const [it] = new Skeleton(s.doc).drawList();
    // Untrimmed quad spans x -20..20, y 10..-10 (TL, TR, BR, BL); the trimmed one spans x -10..10, y 5..-5.
    expect(Array.from(full)).toEqual([-20, 10, 20, 10, 20, -10, -20, -10]);
    expect(Array.from(it.vertices).map((x) => +x.toFixed(4))).toEqual([-10, 5, 10, 5, 10, -5, -10, -5]);
    expect(Array.from(it.uvs).map((x) => +(x * 128).toFixed(4))).toEqual([0, 0, 20, 0, 20, 10, 0, 10]);
  });

  it("keeps images without a region drawing from their own texture", () => {
    const s = project();
    const atlas = layoutAtlas([s.doc.images[0]]);
    atlas.pages[0].src = "p.png";
    s.apply("setAtlas", { atlas });
    const [a, b] = new Skeleton(s.doc).drawList();
    expect(a.texture?.id).toBe(atlas.pages[0].id);
    expect(b.texture?.id).toBe("img_b");
    expect(Array.from(b.uvs).every((u) => u >= 0 && u <= 1)).toBe(true);
  });
});
