import { createCanvas } from "@napi-rs/canvas";
import { DocumentStore, createDocument } from "@openbone/core";
import { Skeleton, applyAnimation } from "@openbone/runtime";
import { describe, expect, it } from "vitest";
import { CanvasRenderer, type Ctx2D } from "../src/index.ts";

/** A 20x10 image: left half black, right half white. */
function blackWhite() {
  const c = createCanvas(20, 10);
  const g = c.getContext("2d");
  g.fillStyle = "#000000";
  g.fillRect(0, 0, 10, 10);
  g.fillStyle = "#ffffff";
  g.fillRect(10, 0, 10, 10);
  return c;
}

function scene(dark?: string, color = "#ffffff") {
  const s = new DocumentStore(createDocument("dark"));
  s.apply("setDocument", { width: 40, height: 20, originX: 20, originY: 10 });
  s.apply("addImage", { id: "img", name: "bw", src: "bw.png", width: 20, height: 10 });
  s.apply("addSlot", { bone: "root", name: "s", color, ...(dark ? { dark } : {}) });
  s.apply("addRegion", { slot: "s", image: "img" });
  return s;
}

function render(s: DocumentStore, at?: { anim: string; time: number }) {
  const canvas = createCanvas(40, 20);
  const img = blackWhite();
  const sk = new Skeleton(s.doc);
  if (at) {
    applyAnimation(sk, s.doc.animations.find((a) => a.name === at.anim)!, at.time);
    sk.updateWorldTransform();
  }
  const r = new CanvasRenderer(canvas.getContext("2d") as unknown as Ctx2D, () => img as never);
  (r as unknown as { makeCanvas: (w: number, h: number) => unknown }).makeCanvas = (w, h) => createCanvas(w, h);
  r.render(sk);
  const px = (x: number, y: number) => Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data.slice(0, 3));
  return { dark: px(14, 10), light: px(25, 10) };
}

describe("two-colour tint (dark colour)", () => {
  it("maps the image's black to the dark colour and white to the slot colour", () => {
    expect(render(scene())).toEqual({ dark: [0, 0, 0], light: [255, 255, 255] });
    const out = render(scene("#ff0000", "#00ff00"));
    expect(out.dark[0]).toBeGreaterThan(240); // black became red
    expect(out.dark[1]).toBeLessThan(15);
    expect(out.light[1]).toBeGreaterThan(240); // white became green
    expect(out.light[0]).toBeLessThan(15);
  });

  it("is keyable: a dark timeline blends between keys", () => {
    const s = scene();
    s.apply("createAnimation", { name: "flash" });
    s.apply("setKeys", { animation: "flash", target: "slot", id: "s", property: "dark", keys: [{ time: 0, value: "#000000" }, { time: 1, value: "#0000ff" }] });
    const sk = new Skeleton(s.doc);
    applyAnimation(sk, s.doc.animations[0], 0.5);
    expect(sk.slots[0].dark?.[2]).toBeCloseTo(0.5, 2);
    expect(sk.drawList()[0].dark?.[2]).toBeCloseTo(0.5, 2);
    expect(render(s, { anim: "flash", time: 1 }).dark[2]).toBeGreaterThan(240);
    s.apply("updateSlot", { slot: "s", dark: null });
    expect(s.doc.skeleton.slots[0].dark).toBeUndefined();
  });
});
