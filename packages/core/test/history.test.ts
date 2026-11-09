import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, deserialize, encodeHistory, jsonDiff, jsonPatch, restoreHistory, serialize } from "../src/index.ts";

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("jsonDiff / jsonPatch", () => {
  it("turns one value into another without touching the source", () => {
    const a = { x: 1, list: [1, 2, { k: "a" }], gone: true, keep: { deep: [1] } };
    const b = { x: 2, list: [1, { k: "b" }], keep: a.keep, added: "y" };
    const before = JSON.stringify(a);
    const p = jsonDiff(a, b);
    expect(jsonPatch(a, roundTrip(p))).toEqual(b);
    expect(JSON.stringify(a)).toBe(before);
    expect(jsonDiff(a, structuredClone(a))).toBeNull();
    expect(JSON.stringify(p)).not.toContain("deep"); // the shared subtree is not in the patch
  });
});

describe("saved undo history", () => {
  function edited() {
    const s = new DocumentStore(createDocument("h"));
    s.apply("addImage", { name: "big", src: `data:image/png;base64,${"A".repeat(200_000)}`, width: 10, height: 10 });
    s.apply("addBone", { name: "arm", length: 50 });
    s.apply("updateBone", { bone: "arm", rotation: 30 });
    s.transaction("two", () => {
      s.apply("addBone", { name: "hand", parent: "arm", length: 10 });
      s.apply("updateBone", { bone: "hand", x: 50 });
    });
    s.apply("updateBone", { bone: "arm", rotation: 60 });
    s.undo(); // one step in the redo stack
    return s;
  }

  it("restores undo and redo after a reload, step by step", () => {
    const s = edited();
    const json = serialize(s.doc, false);
    const saved = roundTrip(encodeHistory(s));
    // Each step stores its change, not the 200 KB image again.
    expect(JSON.stringify(saved).length).toBeLessThan(200_000 + 5_000);
    const r = new DocumentStore(deserialize(json));
    expect(restoreHistory(r, saved)).toBe(true);
    expect(r.history().past.map((e) => e.label)).toEqual(["addImage", "addBone", "updateBone", "two"]);
    expect(r.canRedo).toBe(true);
    r.redo();
    expect(r.doc.skeleton.bones.find((b) => b.name === "arm")?.rotation).toBe(60);
    r.undo();
    expect(serialize(r.doc, false)).toBe(json);
    // Every undo step gives the same document as the original store's (compared by length to keep failures short).
    let steps = 0;
    while (s.canUndo) {
      s.undo();
      r.undo();
      steps++;
      const [want, got] = [serialize(s.doc, false), serialize(r.doc, false)];
      expect(got === want, `step ${steps}: ${got.length} vs ${want.length} chars`).toBe(true);
    }
    expect([steps, r.canUndo]).toEqual([4, false]);
  });

  it("restored snapshots are independent of later edits", () => {
    const s = edited();
    const r = new DocumentStore(deserialize(serialize(s.doc, false)));
    restoreHistory(r, roundTrip(encodeHistory(s)));
    const snapshot = serialize(r.history().past[2].doc, false);
    r.apply("updateBone", { bone: "arm", rotation: 99 });
    r.apply("addBone", { name: "extra" });
    expect(serialize(r.history().past[2].doc, false)).toBe(snapshot);
  });

  it("ignores a missing or unknown saved history", () => {
    const r = new DocumentStore(createDocument("x"));
    expect(restoreHistory(r, undefined)).toBe(false);
    expect(restoreHistory(r, { version: 2 } as never)).toBe(false);
    expect(r.canUndo).toBe(false);
  });
});

describe("applyQuiet and updateImage", () => {
  it("changes the document without an undo step and keeps the change through undo/redo", async () => {
    const { DocumentStore, createDocument } = await import("../src/index.ts");
    const s = new DocumentStore(createDocument("q"));
    s.apply("addImage", { id: "img", name: "art", src: "art.png", width: 40, height: 20 });
    s.apply("addSlot", { bone: "root", name: "a" });
    s.apply("addRegion", { slot: "a", image: "img" });
    s.apply("addRegion", { slot: "a", image: "img", name: "half", width: 20, height: 10 });
    s.apply("updateBone", { bone: "root", x: 5 });
    const undoable = s.history().past.length;
    const events: unknown[] = [];
    s.subscribe((_d, e) => events.push(e));
    const r = s.applyQuiet("updateImage", { image: "img", src: "art.png?v2", width: 80, height: 30 });
    expect(r).toEqual({ regions: 2 });
    expect(s.history().past.length).toBe(undoable);
    expect(events).toEqual([expect.objectContaining({ kind: "op", quiet: true })]);
    const atts = () => s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[0].id];
    expect(atts().art).toMatchObject({ width: 80, height: 30 });
    expect(atts().half).toMatchObject({ width: 40, height: 15 });
    // Undo the bone move: the image keeps its new size and src.
    s.undo();
    expect(s.doc.skeleton.bones[0].x).toBe(0);
    expect(s.doc.images[0]).toMatchObject({ src: "art.png?v2", width: 80, height: 30 });
    s.redo();
    expect(s.doc.images[0]).toMatchObject({ width: 80, height: 30 });
    // Snapshots from before the image existed are left alone.
    while (s.undo());
    expect(s.doc.images).toEqual([]);
  });
});
