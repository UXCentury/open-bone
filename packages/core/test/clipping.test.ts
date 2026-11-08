import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, getAttachment, registry, validate } from "../src/index.ts";
import type { ClippingAttachment } from "../src/index.ts";

function doc() {
  const s = new DocumentStore(createDocument("clip"));
  for (const name of ["mask", "a", "b", "c"]) {
    s.apply("addSlot", { bone: "root", name });
    if (name !== "mask") s.apply("addShape", { slot: name, shape: "rect", width: 40, height: 40 });
  }
  const clip = () => getAttachment(s.doc, s.doc.skeleton.slots[0].id, "mask") as ClippingAttachment;
  return { s, clip };
}

describe("addClipping", () => {
  it("is registered (so it becomes an MCP tool)", () => {
    expect(registry.get("addClipping")?.group).toBe("attachment");
  });

  it("builds a rounded-rect outline and resolves the end slot by name", () => {
    const { s, clip } = doc();
    s.apply("addClipping", { slot: "mask", width: 200, height: 80, radius: 20, end: "b" });
    const c = clip();
    expect(c.type).toBe("clipping");
    expect(c.vertices.length).toBeGreaterThan(16);
    expect(Math.max(...c.vertices.filter((_, i) => i % 2 === 0))).toBeCloseTo(100);
    expect(c.end).toBe(s.doc.skeleton.slots.find((x) => x.name === "b")!.id);
    expect(s.doc.skeleton.slots[0].attachment).toBe("mask");
    expect(validate(s.doc)).toEqual([]);
  });

  it("accepts raw vertices and rejects bad outlines / unknown end slots", () => {
    const { s, clip } = doc();
    s.apply("addClipping", { slot: "mask", vertices: [0, 0, 10, 0, 0, 10] });
    expect(clip().vertices).toEqual([0, 0, 10, 0, 0, 10]);
    expect(clip().end).toBeNull();
    expect(() => s.apply("addClipping", { slot: "mask", name: "bad", vertices: [0, 0, 1, 1] })).toThrow(/3 points/);
    expect(() => s.apply("addClipping", { slot: "mask", name: "bad", end: "nope" })).toThrow(/not found/);
  });

  it("updateAttachment resolves end refs and validates vertices", () => {
    const { s, clip } = doc();
    s.apply("addClipping", { slot: "mask" });
    s.apply("updateAttachment", { slot: "mask", attachment: "mask", props: { end: "c" } });
    expect(clip().end).toBe(s.doc.skeleton.slots.find((x) => x.name === "c")!.id);
    s.apply("updateAttachment", { slot: "mask", attachment: "mask", props: { end: null } });
    expect(clip().end).toBeNull();
    expect(() => s.apply("updateAttachment", { slot: "mask", attachment: "mask", props: { vertices: [1, 2] } })).toThrow(/3 points/);
  });

  it("deleting the end slot makes the mask clip to the end of the draw order", () => {
    const { s, clip } = doc();
    s.apply("addClipping", { slot: "mask", end: "b" });
    s.apply("deleteSlot", { slot: "b" });
    expect(clip().end).toBeNull();
    expect(validate(s.doc)).toEqual([]);
  });
});
