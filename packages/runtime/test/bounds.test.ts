import { DocumentStore, buildSpline, createDocument, serialize, deserialize, validate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, Skeleton, SkeletonBounds } from "../src/index.ts";

function rig() {
  const s = new DocumentStore(createDocument("boxes"));
  s.apply("addBone", { name: "a", x: 0, y: 0, length: 50 });
  s.apply("addBone", { name: "b", parent: "a", x: 50, length: 50 });
  s.apply("addSlot", { name: "one", bone: "a" });
  s.apply("addBoundingBox", { slot: "one", activate: true, x: 25, width: 60, height: 20 });
  s.apply("addSlot", { name: "two", bone: "b" });
  s.apply("addBoundingBox", { slot: "two", name: "box2", activate: true, x: 25, width: 50, height: 20 });
  s.apply("addSlot", { name: "off", bone: "a" });
  s.apply("addBoundingBox", { slot: "off", activate: false, width: 500, height: 500 });
  return s;
}

describe("SkeletonBounds", () => {
  it("lists the active bounding boxes in draw order with their world polygons and AABB", () => {
    const b = new Skeleton(rig().doc).boundingBoxes();
    expect(b.boxes.map((x) => [x.slot.data.name, x.attachment])).toEqual([["one", "hitbox"], ["two", "box2"]]);
    expect(Array.from(b.boxes[1].vertices)).toEqual([50, -10, 100, -10, 100, 10, 50, 10]);
    [-5, -10, 100, 10].forEach((v, i) => expect([b.minX, b.minY, b.maxX, b.maxY][i]).toBeCloseTo(v, 6));
  });

  it("answers point, segment and AABB queries", () => {
    const b = new Skeleton(rig().doc).boundingBoxes();
    expect(b.containsPoint(75, 0)?.attachment).toBe("box2");
    expect(b.containsPoint(75, 30)).toBeNull();
    expect(b.containsPointAll(52, 0).map((x) => x.attachment)).toEqual(["hitbox", "box2"]);
    expect(b.intersectsSegment(75, 50, 75, -50)?.attachment).toBe("box2");
    expect(b.intersectsSegmentAll(-10, 0, 110, 0)).toHaveLength(2);
    expect(b.intersectsSegment(70, 1, 80, 2)?.attachment).toBe("box2"); // inside, no edge crossed
    expect(b.intersectsSegment(0, 30, 100, 30)).toBeNull();
    expect(b.aabbIntersects(90, 5, 120, 40)).toBe(true);
    expect(b.aabbIntersects(110, 5, 120, 40)).toBe(false);
    expect(b.aabbContainsPoint(100, 10)).toBe(true);
  });

  it("follows the pose, weights and the skeleton placement, and finds overlaps between skeletons", () => {
    const s = rig();
    s.apply("autoWeights", { slot: "two", attachment: "box2", bones: ["a", "b"] });
    expect(validate(s.doc).filter((i) => i.level === "error")).toEqual([]);
    const doc = deserialize(serialize(s.doc));
    const me = new OpenBoneInstance(doc);
    me.advance(0);
    const other = new OpenBoneInstance(doc);
    other.skeleton.x = 95;
    other.advance(0);
    const hit = me.skeleton.boundingBoxes().intersectsBounds(other.skeleton.boundingBoxes());
    expect(hit?.map((x) => x.attachment)).toEqual(["box2", "hitbox"]);
    other.skeleton.x = 106;
    other.advance(0);
    expect(me.skeleton.boundingBoxes().intersectsBounds(other.skeleton.boundingBoxes())).toBeNull();
    // Bend the child: the weighted box follows both bones.
    me.skeleton.findBone("b")!.rotation = 90;
    me.skeleton.updateWorldTransform();
    const b = new SkeletonBounds(me.skeleton);
    expect(b.containsPoint(52, 40)?.attachment).toBe("box2");
    expect(b.containsPoint(80, 0)).toBeNull();
  });

  it("re-binds a weighted box's new vertices to its bones", () => {
    const s = rig();
    s.apply("autoWeights", { slot: "two", attachment: "box2", bones: ["a", "b"] });
    s.apply("updateAttachment", { slot: "two", attachment: "box2", props: { vertices: [0, -10, 60, -10, 60, 10, 0, 10] } });
    const att = s.doc.skeleton.skins[0].attachments[s.doc.skeleton.slots[1].id].box2 as { weights?: unknown[] };
    expect(att.weights).toHaveLength(4);
    const b = new Skeleton(s.doc).boundingBoxes();
    expect(b.boxes[1].maxX).toBeCloseTo(110, 3);
  });

  it("is empty (all zeros) when no box is active", () => {
    const s = new DocumentStore(createDocument("none"));
    const b = new Skeleton(s.doc).boundingBoxes();
    expect([b.boxes.length, b.minX, b.maxX]).toEqual([0, 0, 0]);
    expect(b.aabbIntersects(-1, -1, 1, 1)).toBe(false);
    expect(b.containsPoint(0, 0)).toBeNull();
  });
});

describe("path constraint constant speed", () => {
  // One segment with a long first handle and a tiny second one.
  const knots = [-10, 0, 0, 0, 90, 0, 99, 0, 100, 0, 101, 0];

  it("spline: arc length by default, raw bezier parameter without constant speed", () => {
    const even = buildSpline(knots, false);
    const raw = buildSpline(knots, false, false);
    expect(raw.length).toBe(even.length);
    expect(even.sample(even.length / 2).x).toBeCloseTo(50, 0);
    // t = 0.5: 3·0.25·0.5·90 + 3·0.5·0.25·99 + 0.125·100 = 83.375
    expect(raw.sample(raw.length / 2).x).toBeCloseTo(83.375, 1);
  });

  it("is stored only when off, and changes the pose only then", () => {
    const s = new DocumentStore(createDocument("p"));
    s.apply("addSlot", { name: "rail", bone: "root" });
    s.apply("addPath", { slot: "rail", vertices: [-180, 0, -150, 20, -40, 160, 0, 60, 10, 80, 20, 100, 150, 10, 170, 200, 190, 220] });
    s.apply("addBone", { name: "c1", length: 40 });
    s.apply("addBone", { name: "c2", parent: "c1", x: 40, length: 40 });
    s.apply("addPathConstraint", { name: "p", bones: ["c1", "c2"], target: "rail", constantSpeed: true, position: 0.2 });
    expect("constantSpeed" in s.doc.skeleton.path[0]).toBe(false);
    const before = new Skeleton(s.doc).findBone("c2")!.world.x;
    s.apply("updatePathConstraint", { constraint: "p", constantSpeed: false });
    expect(s.doc.skeleton.path[0].constantSpeed).toBe(false);
    expect(deserialize(serialize(s.doc)).skeleton.path[0].constantSpeed).toBe(false);
    expect(new Skeleton(s.doc).findBone("c2")!.world.x).not.toBeCloseTo(before, 1);
    s.apply("updatePathConstraint", { constraint: "p", constantSpeed: true });
    expect("constantSpeed" in s.doc.skeleton.path[0]).toBe(false);
    expect(new Skeleton(s.doc).findBone("c2")!.world.x).toBe(before);
  });
});
