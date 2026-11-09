import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument } from "../src/index.ts";

describe("importData with skin bones and skin constraints", () => {
  it("maps a skin's bones and constraints onto this project's", () => {
    const src = new DocumentStore(createDocument("src"));
    src.apply("addBone", { name: "cape", length: 20 });
    src.apply("addBone", { name: "aim" });
    src.apply("addIkConstraint", { name: "cape-ik", bones: ["cape"], target: "aim" });
    src.apply("addSkin", { name: "hero" });
    const skin = src.doc.skeleton.skins.find((k) => k.name === "hero")!;
    skin.bones = [src.doc.skeleton.bones.find((b) => b.name === "cape")!.id];
    skin.constraints = [src.doc.skeleton.ik[0].id];

    const dst = new DocumentStore(createDocument("dst"));
    dst.apply("addBone", { name: "cape", length: 20 });
    dst.apply("addBone", { name: "aim" });
    dst.apply("addIkConstraint", { name: "cape-ik", bones: ["cape"], target: "aim" });
    dst.apply("importData", { document: src.doc, skins: ["hero"] });
    const hero = dst.doc.skeleton.skins.find((k) => k.name === "hero")!;
    expect(hero.bones).toEqual([dst.doc.skeleton.bones.find((b) => b.name === "cape")!.id]);
    expect(hero.constraints).toEqual([dst.doc.skeleton.ik[0].id]);
  });
});
