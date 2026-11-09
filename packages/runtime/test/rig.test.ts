import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DocumentStore, apply, constraintOrder, createDocument, validate, worldRotation } from "@openbone/core";
import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.ts";
import { Skeleton, applyAnimation } from "../src/index.ts";
import { exampleDocs, poseFingerprint } from "./fingerprint.ts";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

/** root → body → cape (→ cape-tip); a slot on the cape; an IK on the cape aiming at "aim". */
function caped() {
  const s = new DocumentStore(createDocument("caped"));
  s.apply("addBone", { name: "body", length: 50 });
  s.apply("addBone", { name: "cape", parent: "body", x: 50, length: 40 });
  s.apply("addBone", { name: "cape-tip", parent: "cape", x: 40, length: 20 });
  s.apply("addBone", { name: "aim", parent: "body", x: 0, y: 80, length: 0 });
  s.apply("addSlot", { name: "cape-slot", bone: "cape" });
  s.apply("addShape", { slot: "cape-slot", shape: "rect", width: 10, height: 10 });
  s.apply("addIkConstraint", { name: "cape-ik", bones: ["cape"], target: "aim" });
  s.apply("addSkin", { name: "knight" });
  s.apply("addSkin", { name: "peasant" });
  return s;
}
const drawn = (sk: Skeleton) => sk.drawList().map((i) => i.slot.data.name);

describe("skin bones and skin constraints", () => {
  it("a skin bone (and the bones below it) is active only while a skin listing it is set", () => {
    const s = caped();
    s.apply("addToSkin", { skin: "knight", bones: ["cape"] });
    const sk = new Skeleton(s.doc);
    expect(sk.findBone("cape")!.active).toBe(false);
    expect(sk.findBone("cape-tip")!.active).toBe(false);
    expect(sk.findBone("body")!.active).toBe(true);
    expect(drawn(sk)).not.toContain("cape-slot");
    sk.setSkin("knight");
    sk.updateWorldTransform();
    expect(sk.findBone("cape-tip")!.active).toBe(true);
    expect(drawn(sk)).toContain("cape-slot");
    sk.setSkin("peasant");
    expect(sk.findBone("cape")!.active).toBe(false);
    expect(drawn(sk)).not.toContain("cape-slot");
  });

  it("inactive bones skip the world update", () => {
    const s = caped();
    s.apply("addToSkin", { skin: "knight", bones: ["cape"] });
    const sk = new Skeleton(s.doc);
    const before = { ...sk.findBone("cape")!.world };
    sk.findBone("body")!.rotation = 45;
    sk.updateWorldTransform();
    expect(sk.findBone("cape")!.world).toEqual(before);
    sk.setSkin("knight");
    sk.updateWorldTransform();
    expect(sk.findBone("cape")!.world).not.toEqual(before);
  });

  it("a skin constraint is applied only while a skin listing it is set", () => {
    const s = caped();
    s.apply("addToSkin", { skin: "knight", constraints: ["cape-ik"] });
    const sk = new Skeleton(s.doc);
    // Without the IK the cape points along +x; with it, up at the aim bone.
    expect(near(worldRotation(sk.findBone("cape")!.world), 0, 1e-3)).toBe(true);
    expect(sk.isConstraintActive(s.doc.skeleton.ik[0].id)).toBe(false);
    sk.setSkin("knight");
    sk.updateWorldTransform();
    expect(worldRotation(sk.findBone("cape")!.world)).toBeGreaterThan(30);
  });

  it("a constraint whose bones are inactive is skipped too", () => {
    const s = caped();
    s.apply("addToSkin", { skin: "knight", bones: ["cape"] });
    const sk = new Skeleton(s.doc);
    expect(sk.isConstraintActive(s.doc.skeleton.ik[0].id)).toBe(false);
    sk.setSkin("knight");
    expect(sk.isConstraintActive(s.doc.skeleton.ik[0].id)).toBe(true);
  });

  it("ops: add/remove, default skin refused, duplicates copy, deletes prune", () => {
    const s = caped();
    expect(() => s.apply("addToSkin", { skin: "default", bones: ["cape"] })).toThrow(/default skin/);
    s.apply("addToSkin", { skin: "knight", bones: ["cape", "cape"], constraints: ["cape-ik"] });
    const knight = () => s.doc.skeleton.skins.find((k) => k.name === "knight")!;
    expect(knight().bones).toHaveLength(1);
    expect(knight().constraints).toHaveLength(1);
    s.apply("duplicateSkin", { skin: "knight", name: "knight2" });
    expect(s.doc.skeleton.skins.find((k) => k.name === "knight2")!.bones).toEqual(knight().bones);
    s.apply("removeFromSkin", { skin: "knight", constraints: ["cape-ik"] });
    expect(knight().constraints).toBeUndefined();
    s.apply("deleteBone", { bone: "cape" });
    expect(knight().bones).toBeUndefined();
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("validate reports missing skin bones", () => {
    const s = caped();
    s.doc.skeleton.skins[1].bones = ["nope"];
    expect(validate(s.doc).some((i) => i.message.includes("skin bone nope"))).toBe(true);
  });
});

describe("inherit timeline", () => {
  function rig() {
    const s = new DocumentStore(createDocument("inherit"));
    s.apply("addBone", { name: "parent", rotation: 90, length: 50 });
    s.apply("addBone", { name: "child", parent: "parent", x: 50, rotation: 10, length: 30 });
    s.apply("createAnimation", { name: "switch" });
    s.apply("setKeys", {
      animation: "switch",
      target: "bone",
      id: "child",
      property: "inherit",
      keys: [
        { time: 0, value: "normal" },
        { time: 1, value: "noRotation", curve: "linear" },
      ],
    });
    return s;
  }

  it("stores stepped string keys and rejects other values", () => {
    const s = rig();
    const tl = s.doc.animations[0].timelines[0];
    expect(tl.property).toBe("inherit");
    expect(tl.keys.map((k) => k.curve)).toEqual(["stepped", "stepped"]);
    expect(() =>
      s.apply("setKeys", { animation: "switch", target: "bone", id: "child", property: "inherit", keys: [{ time: 2, value: "sideways" }] }),
    ).toThrow(/Invalid value/);
    expect(() => s.apply("setKeys", { animation: "switch", target: "bone", id: "child", property: "inherit", keys: [{ time: 2, value: 1 }] })).toThrow();
  });

  it("switches the bone's inherit mode per frame", () => {
    const s = rig();
    const sk = new Skeleton(s.doc);
    const anim = s.doc.animations[0];
    const childRot = (t: number) => {
      sk.setToSetupPose();
      applyAnimation(sk, anim, t);
      sk.updateWorldTransform();
      return worldRotation(sk.findBone("child")!.world);
    };
    expect(childRot(0)).toBeCloseTo(100, 4);
    expect(childRot(0.99)).toBeCloseTo(100, 4); // stepped: no blend before the key
    expect(childRot(1)).toBeCloseTo(10, 4);
    expect(sk.findBone("child")!.inherit).toBe("noRotation");
    sk.setToSetupPose();
    expect(sk.findBone("child")!.inherit).toBe("normal");
  });
});

describe("constraint order", () => {
  /** "a" is aimed by IK; "b" copies a's world rotation with a transform constraint. */
  function rig() {
    const s = new DocumentStore(createDocument("order"));
    s.apply("addBone", { name: "a", length: 50 });
    s.apply("addBone", { name: "target", x: 0, y: 100, length: 0 });
    s.apply("addBone", { name: "b", x: 200, length: 50 });
    s.apply("addTransformConstraint", { name: "copy", bones: ["b"], target: "a", mixTranslate: 0 });
    s.apply("addIkConstraint", { name: "aim", bones: ["a"], target: "target" });
    return s;
  }
  const rotB = (s: DocumentStore) => worldRotation(new Skeleton(s.doc).findBone("b")!.world);

  it("defaults to ik, transform, path, physics", () => {
    const s = rig();
    expect(constraintOrder(s.doc.skeleton).map((e) => e.data.name)).toEqual(["aim", "copy"]);
    expect(rotB(s)).toBeCloseTo(90, 3); // the copy sees the IK's result
  });

  it("setConstraintOrder changes which constraint sees the other's result", () => {
    const s = rig();
    s.apply("setConstraintOrder", { constraints: ["copy", "aim"] });
    expect(constraintOrder(s.doc.skeleton).map((e) => e.data.name)).toEqual(["copy", "aim"]);
    expect(rotB(s)).toBeCloseTo(0, 3);
    // New constraints go last once the order is custom.
    s.apply("addPhysicsConstraint", { name: "spring", bone: "b" });
    expect(constraintOrder(s.doc.skeleton).map((e) => e.data.name)).toEqual(["copy", "aim", "spring"]);
  });

  it("refuses incomplete or repeated lists", () => {
    const s = rig();
    expect(() => s.apply("setConstraintOrder", { constraints: ["copy"] })).toThrow(/missing: aim/);
    expect(() => s.apply("setConstraintOrder", { constraints: ["copy", "copy", "aim"] })).toThrow(/twice/);
  });

  /** Pose fingerprints of the examples made with the runtime before constraint order existed, by file hash. */
  const GOLDEN: Record<string, [string, string]> = {
    "button.obone": ["d012a9ad2c14", "a4b45d5044a71a98a1b36cb4c92b41185197e0cd"],
    "campfire.obone": ["4ef8edddb6db", "b126d5319a8413dc3f4a29a1b792a361e81d3778"],
    "crash.obone": ["9dd8981a0bf6", "8cefb553c5b94b0be8afe19ebeaaec5d5fd3f51d"],
    "fox.obone": ["174666cc1e5e", "2d2b2ed28cebef3cd10d2d03ea858464104e1de5"],
    "knight.obone": ["7db93216683a", "8a0dea2a5b30fc9816929ef32276563694c3b7bf"],
    "robot.obone": ["1f435706249a", "09d58b6d4a5ab42b327a34d5b265dc08499d79f4"],
    "rocket.obone": ["5329a078cf4c", "5a0f4862e77ae622b52f66781810551599c63e07"],
    "tail.obone": ["e5a5b72c8855", "3b7d0c598bb69c37b783aaf960c271a688c96c5c"],
    "walker.obone": ["029ee24f02dc", "cbd81aee5facc703e38c2cd1a3ae69a054389610"],
  };

  it("every example poses exactly as before, with or without an explicit default order", () => {
    for (const [name, doc] of exampleDocs()) {
      const fp = poseFingerprint(runtime as never, doc);
      const file = createHash("sha1").update(readFileSync(new URL(`../../../examples/${name}`, import.meta.url))).digest("hex").slice(0, 12);
      // Only comparable while the example file is unchanged since the fingerprint was recorded.
      if (GOLDEN[name]?.[0] === file) expect(fp, name).toBe(GOLDEN[name][1]);
      const s = new DocumentStore(structuredClone(doc));
      const all = constraintOrder(s.doc.skeleton).map((e) => e.data.id);
      if (all.length) s.apply("setConstraintOrder", { constraints: all });
      expect(poseFingerprint(runtime as never, s.doc), `${name} with explicit order`).toBe(fp);
    }
  });
});

describe("reference scale", () => {
  function hair(gravity: number, referenceScale?: number) {
    const s = new DocumentStore(createDocument("hair"));
    s.apply("addBone", { name: "hair", length: 100 });
    s.apply("addPhysicsConstraint", { bone: "hair", gravity, strength: 50, rotate: 1, inertia: 1 });
    if (referenceScale !== undefined) s.apply("setDocument", { referenceScale });
    return s;
  }
  /** Tip of the hair bone, relative to the skeleton scale, after a second of simulation. */
  function settle(s: DocumentStore, scale = 1) {
    const sk = new Skeleton(s.doc);
    sk.scaleX = sk.scaleY = scale;
    sk.resetPhysics(); // the constructor already posed it at scale 1
    for (let i = 0; i < 60; i++) {
      sk.update(1 / 60);
      sk.setToSetupPose();
      sk.updateWorldTransform();
    }
    const [x, y] = apply(sk.findBone("hair")!.world, 100, 0);
    return [x / scale, y / scale];
  }

  it("physics gravity scales with the skeleton, so a scaled rig behaves the same", () => {
    const a = settle(hair(400), 1);
    const b = settle(hair(400), 3);
    expect(a[1]).toBeLessThan(-5); // it sags
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });

  it("referenceScale multiplies gravity and wind (default 100)", () => {
    const a = settle(hair(400, 200));
    const b = settle(hair(800));
    expect(a[1]).toBeCloseTo(b[1], 6);
    const s = hair(400, 100);
    expect(s.doc.skeleton.referenceScale).toBeUndefined();
    s.apply("setDocument", { referenceScale: 50 });
    expect(s.doc.skeleton.referenceScale).toBe(50);
  });

  it("IK softness scales with the skeleton", () => {
    const reach = (scale: number, refScale = 100) => {
      const s = new DocumentStore(createDocument("arm"));
      s.apply("addBone", { name: "upper", length: 100 });
      s.apply("addBone", { name: "lower", parent: "upper", x: 100, length: 100 });
      s.apply("addBone", { name: "target", x: 195, y: 0, length: 0 });
      s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target", softness: 20 });
      s.apply("setDocument", { referenceScale: refScale });
      const sk = new Skeleton(s.doc);
      sk.scaleX = sk.scaleY = scale;
      sk.updateWorldTransform();
      const [x, y] = apply(sk.findBone("lower")!.world, 100, 0);
      return Math.hypot(x, y) / scale;
    };
    expect(reach(1)).toBeLessThan(194.9); // softness pulls the reach in
    expect(reach(2.5)).toBeCloseTo(reach(1), 6);
    expect(reach(1, 50)).toBeGreaterThan(reach(1)); // half the softness
  });
});
