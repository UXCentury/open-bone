import { describe, expect, it } from "vitest";
import { DocumentStore, createDocument, getAttachment } from "../src/index.ts";
import { Skeleton, applyAnimation } from "../../runtime/src/index.ts";

function rig() {
  const s = new DocumentStore(createDocument("l"));
  s.apply("addImage", { name: "red", src: "red.png", width: 100, height: 40 });
  s.apply("addImage", { name: "blue", src: "blue.png", width: 100, height: 40 });
  s.apply("addBone", { name: "arm", length: 100 });
  s.apply("addSlot", { name: "sleeve", bone: "arm" });
  s.apply("addMesh", { slot: "sleeve", name: "sleeve-red", image: "red", cols: 2, rows: 1 });
  s.apply("addSkin", { name: "blue" });
  s.apply("addLinkedMesh", { slot: "sleeve", skin: "blue", name: "sleeve-red", image: "blue", parent: "sleeve-red", parentSkin: "default" });
  return s;
}
const mesh = (s: DocumentStore, skin = "default") => {
  const k = s.doc.skeleton.skins.find((x) => x.name === skin)!;
  return k.attachments[s.doc.skeleton.slots[0].id]["sleeve-red"] as Extract<ReturnType<typeof getAttachment>, { type: "mesh" }>;
};

describe("linked meshes", () => {
  it("copies the parent's geometry and follows edits to it", () => {
    const s = rig();
    const linked = mesh(s, "blue");
    expect(linked.linked).toMatchObject({ mesh: "sleeve-red", deform: true });
    expect(linked.vertices).toEqual(mesh(s).vertices);
    expect(linked.image).not.toBe(mesh(s).image);
    const moved = mesh(s).vertices.map((v, i) => (i === 0 ? v + 7 : v));
    s.apply("updateAttachment", { slot: "sleeve", attachment: "sleeve-red", skin: "default", props: { vertices: moved } });
    expect(mesh(s, "blue").vertices[0]).toBe(moved[0]);
    s.undo();
    expect(mesh(s, "blue").vertices[0]).toBe(mesh(s).vertices[0]);
  });

  it("refuses geometry edits on the linked mesh itself, and unlinks on request", () => {
    const s = rig();
    expect(() => s.apply("updateAttachment", { slot: "sleeve", attachment: "sleeve-red", skin: "blue", props: { vertices: mesh(s).vertices } })).toThrow(/linked mesh/);
    s.apply("updateAttachment", { slot: "sleeve", attachment: "sleeve-red", skin: "blue", props: { linked: null } });
    expect(mesh(s, "blue").linked).toBeUndefined();
  });

  it("becomes a normal mesh when its parent is deleted", () => {
    const s = rig();
    s.apply("deleteAttachment", { slot: "sleeve", attachment: "sleeve-red", skin: "default" });
    expect(mesh(s, "blue").linked).toBeUndefined();
    expect(mesh(s, "blue").vertices.length).toBeGreaterThan(0);
  });

  it("follows the parent's deform keys when deform is on", () => {
    const s = rig();
    const n = mesh(s).vertices.length;
    s.apply("createAnimation", { name: "wave" });
    s.apply("setKeys", { animation: "wave", target: "deform", id: "sleeve", attachment: "sleeve-red", keys: [{ time: 0, value: Array.from({ length: n }, (_, i) => (i % 2 ? 10 : 0)) }] });
    const sk = new Skeleton(s.doc);
    sk.setSkin("blue");
    sk.setToSetupPose();
    applyAnimation(sk, s.doc.animations[0], 0);
    sk.updateWorldTransform();
    const slot = sk.slots[0];
    const att = sk.getAttachment(slot)!;
    expect(att).toBe(mesh(s, "blue"));
    const v = sk.attachmentWorldVertices(slot, att)!;
    const rest = new Skeleton(s.doc);
    rest.setSkin("blue");
    rest.updateWorldTransform();
    const v0 = rest.attachmentWorldVertices(rest.slots[0], att)!;
    expect(v[1] - v0[1]).toBeCloseTo(10, 4);
  });
});
