import { DocumentStore, createDocument } from "@openbone/core";
import { Skeleton } from "@openbone/runtime";
import { describe, expect, it } from "vitest";
import { CanvasRenderer, type Ctx2D } from "../src/index.ts";

/** A 2D context stand-in that records method calls (and accepts any property writes). */
function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy({ canvas: { width: 100, height: 100 } } as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        calls.push(String(k));
        void args;
      };
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as Ctx2D, calls };
}

describe("CanvasRenderer clipping", () => {
  it("wraps clipped items in save/clip/restore and draws the rest unclipped", () => {
    const s = new DocumentStore(createDocument("clip"));
    for (const name of ["mask", "a", "b", "after"]) {
      s.apply("addSlot", { bone: "root", name });
      if (name !== "mask") s.apply("addShape", { slot: name, shape: "rect" });
    }
    s.apply("addClipping", { slot: "mask", end: "b" });
    const { ctx, calls } = recorder();
    new CanvasRenderer(ctx, () => null).render(new Skeleton(s.doc), { clear: false });
    const seq = calls.filter((c) => ["save", "clip", "restore", "fill"].includes(c));
    // mask opens once, a + b are filled inside it, then it closes before "after" is filled.
    expect(seq).toEqual(["save", "clip", "fill", "fill", "restore", "fill"]);
  });
});
