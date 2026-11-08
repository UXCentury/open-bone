import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, getAttachment, slotAttachments, validate } from "../src/index.ts";

function rig() {
  const s = new DocumentStore(createDocument("skins"));
  s.apply("addBone", { name: "body" });
  s.apply("addSlot", { bone: "body", name: "torso" });
  s.apply("addShape", { slot: "torso", name: "shirt", shape: "rect", fill: "#3366ff" });
  s.apply("addSkin", { name: "red" });
  s.apply("addSkin", { name: "green" });
  return s;
}

const skin = (s: DocumentStore, name: string) => s.doc.skeleton.skins.find((k) => k.name === name)!;
const slotId = (s: DocumentStore) => s.doc.skeleton.slots[0].id;

describe("skins", () => {
  it("renames skins, rejects duplicates and the default skin", () => {
    const s = rig();
    s.apply("renameSkin", { skin: "red", name: "crimson" });
    expect(skin(s, "crimson")).toBeDefined();
    expect(() => s.apply("renameSkin", { skin: "crimson", name: "green" })).toThrow(/already exists/);
    expect(() => s.apply("renameSkin", { skin: "default", name: "base" })).toThrow(/default skin/);
    expect(() => s.apply("addSkin", { name: "green" })).toThrow(/already exists/);
  });

  it("deletes a skin with its attachments, but never the default skin", () => {
    const s = rig();
    s.apply("addShape", { slot: "torso", skin: "red", name: "shirt", shape: "rect", fill: "#ff0000" });
    s.apply("deleteSkin", { skin: "red" });
    expect(s.doc.skeleton.skins.map((k) => k.name)).toEqual(["default", "green"]);
    expect(() => s.apply("deleteSkin", { skin: "default" })).toThrow(/default skin/);
    s.undo();
    expect(skin(s, "red").attachments[slotId(s)].shirt).toBeDefined();
  });

  it("copies an attachment into another skin as an independent override", () => {
    const s = rig();
    s.apply("copyAttachment", { slot: "torso", attachment: "shirt", toSkin: "red" });
    s.apply("updateAttachment", { slot: "torso", attachment: "shirt", skin: "red", props: { fill: "#ff0000" } });
    const id = slotId(s);
    expect(getAttachment(s.doc, id, "shirt", skin(s, "red").id)).toMatchObject({ fill: "#ff0000" });
    expect(getAttachment(s.doc, id, "shirt")).toMatchObject({ fill: "#3366ff" });
    // green has no override, so it falls back to the default skin.
    expect(getAttachment(s.doc, id, "shirt", skin(s, "green").id)).toMatchObject({ fill: "#3366ff" });
    expect(() => s.apply("copyAttachment", { slot: "torso", attachment: "shirt", fromSkin: "green", toSkin: "red" })).toThrow(/not found/);
    s.apply("copyAttachment", { slot: "torso", attachment: "shirt", fromSkin: "red", toSkin: "red", name: "shirt2" });
    expect(Object.keys(skin(s, "red").attachments[id])).toEqual(["shirt", "shirt2"]);
    expect(validate(s.doc)).toEqual([]);
  });

  it("duplicates a skin deeply", () => {
    const s = rig();
    s.apply("addShape", { slot: "torso", skin: "red", name: "shirt", shape: "rect", fill: "#ff0000" });
    s.apply("duplicateSkin", { skin: "red", name: "red2" });
    s.apply("updateAttachment", { slot: "torso", attachment: "shirt", skin: "red2", props: { fill: "#aa0000" } });
    expect(getAttachment(s.doc, slotId(s), "shirt", skin(s, "red").id)).toMatchObject({ fill: "#ff0000" });
    expect(getAttachment(s.doc, slotId(s), "shirt", skin(s, "red2").id)).toMatchObject({ fill: "#aa0000" });
  });

  it("updateAttachment edits the skin that owns the attachment", () => {
    const s = rig();
    // With a skin given but no override in it, the edit lands on the default-skin attachment it resolves to.
    s.apply("updateAttachment", { slot: "torso", attachment: "shirt", skin: "red", props: { name: "tee" } });
    expect(Object.keys(s.doc.skeleton.skins[0].attachments[slotId(s)])).toEqual(["tee"]);
    expect(s.doc.skeleton.slots[0].attachment).toBe("tee");
    expect(skin(s, "red").attachments[slotId(s)]).toBeUndefined();
  });

  it("deleting a skin override keeps the slot's setup attachment", () => {
    const s = rig();
    s.apply("copyAttachment", { slot: "torso", attachment: "shirt", toSkin: "red" });
    s.apply("deleteAttachment", { slot: "torso", attachment: "shirt", skin: "red" });
    expect(s.doc.skeleton.slots[0].attachment).toBe("shirt");
    expect(skin(s, "red").attachments[slotId(s)]).toBeUndefined();
    s.apply("deleteAttachment", { slot: "torso", attachment: "shirt" });
    expect(s.doc.skeleton.slots[0].attachment).toBeNull();
  });

  it("slotAttachments merges default and active skin with ownership", () => {
    const s = rig();
    s.apply("copyAttachment", { slot: "torso", attachment: "shirt", toSkin: "red" });
    s.apply("addShape", { slot: "torso", skin: "red", name: "cape", shape: "rect", activate: false });
    const red = skin(s, "red");
    const list = slotAttachments(s.doc, slotId(s), red.id);
    expect(list.map((e) => [e.name, e.skin.name, e.overrides])).toEqual([
      ["shirt", "red", true],
      ["cape", "red", false],
    ]);
    expect(slotAttachments(s.doc, slotId(s), null).map((e) => e.name)).toEqual(["shirt"]);
  });

  it("an attachment that only exists in a non-default skin is valid as the setup attachment", () => {
    const s = rig();
    s.apply("addShape", { slot: "torso", skin: "red", name: "armor", shape: "rect" });
    expect(s.doc.skeleton.slots[0].attachment).toBe("armor");
    expect(validate(s.doc)).toEqual([]);
  });
});
