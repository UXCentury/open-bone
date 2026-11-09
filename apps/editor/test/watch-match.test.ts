import { createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { assetFolders, assetsForFile } from "../src/watch-match.ts";

const doc = () => {
  const d = createDocument("w");
  d.images = [
    { id: "a", name: "arm", src: "assets/arm.png", width: 1, height: 1 },
    { id: "b", name: "Head", src: "data:image/png;base64,xx", width: 1, height: 1 },
    { id: "c", name: "packed", src: "", width: 1, height: 1 },
    { id: "d", name: "leg", src: "/abs/art/leg.png", width: 1, height: 1 },
  ];
  d.audio = { assets: [{ id: "s", name: "step", src: "sfx/step.wav", duration: 1 }], sounds: [], buses: [] } as never;
  return d;
};

describe("live art reload matching", () => {
  it("matches file paths by their ending, embedded art by name", () => {
    const d = doc();
    expect(assetsForFile(d, "/home/me/game/assets/arm.png").images.map((i) => i.id)).toEqual(["a"]);
    expect(assetsForFile(d, "assets/arm.png").images.map((i) => i.id)).toEqual(["a"]);
    expect(assetsForFile(d, "arm.png").images.map((i) => i.id)).toEqual(["a"]);
    expect(assetsForFile(d, "C:\\art\\head.PNG").images.map((i) => i.id)).toEqual(["b"]);
    expect(assetsForFile(d, "/x/notarm.png").images).toEqual([]);
    expect(assetsForFile(d, "/x/packed.png").images).toEqual([]);
    expect(assetsForFile(d, "/abs/art/leg.png").images.map((i) => i.id)).toEqual(["d"]);
    expect(assetsForFile(d, "/game/sfx/step.wav").audio.map((a) => a.id)).toEqual(["s"]);
    expect(assetsForFile(d, "/game/sfx/step.wav").images).toEqual([]);
  });

  it("lists the folders file-based assets live in", () => {
    expect(assetFolders(doc(), "/home/me/game")).toEqual(["/abs/art", "/home/me/game/assets", "/home/me/game/sfx"]);
  });
});
