import { DocumentStore, apply, buildSpline, createDocument, smoothKnots, validate, worldRotation } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { OpenBoneInstance, Skeleton } from "../src/index.ts";

const tipOf = (sk: Skeleton, bone: string) => {
  const b = sk.findBone(bone)!;
  return apply(b.world, b.data.length, 0);
};
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function arm(targetX: number, targetY: number) {
  const s = new DocumentStore(createDocument("arm"));
  s.apply("addBone", { name: "upper", length: 100 });
  s.apply("addBone", { name: "lower", parent: "upper", x: 100, length: 100 });
  s.apply("addBone", { name: "target", x: targetX, y: targetY, length: 0 });
  return s;
}

describe("IK softness / stretch / compress", () => {
  it("without stretch an out-of-reach target leaves the chain fully extended", () => {
    const s = arm(300, 0);
    s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target" });
    const sk = new Skeleton(s.doc);
    expect(dist(tipOf(sk, "lower"), [0, 0])).toBeCloseTo(200, 1);
  });

  it("2-bone stretch scales both bones so the tip reaches the target", () => {
    const s = arm(240, 120);
    s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target", stretch: true });
    const sk = new Skeleton(s.doc);
    const tip = tipOf(sk, "lower");
    expect(tip[0]).toBeCloseTo(240, 1);
    expect(tip[1]).toBeCloseTo(120, 1);
  });

  it("softness keeps the chain bent near full extension and eases smoothly", () => {
    const reachAt = (x: number, softness: number) => {
      const s = arm(x, 0);
      s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target", softness });
      return dist(tipOf(new Skeleton(s.doc), "lower"), [0, 0]);
    };
    // Far from full extension, softness changes nothing.
    expect(reachAt(120, 30)).toBeCloseTo(120, 1);
    // At exactly full reach the soft chain falls short, the hard one does not.
    expect(reachAt(200, 0)).toBeCloseTo(200, 1);
    const soft = reachAt(200, 30);
    expect(soft).toBeLessThan(195);
    expect(soft).toBeGreaterThan(170);
    // Monotonic and continuous as the target moves away.
    let prev = 0;
    for (let x = 150; x <= 400; x += 10) {
      const d = reachAt(x, 30);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(d).toBeLessThan(200);
      prev = d;
    }
  });

  it("softness with stretch still reaches the target", () => {
    const s = arm(205, 0);
    s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target", softness: 30, stretch: true });
    const tip = tipOf(new Skeleton(s.doc), "lower");
    expect(tip[0]).toBeCloseTo(205, 1);
    expect(tip[1]).toBeCloseTo(0, 1);
  });

  it("1-bone stretch and compress match the target distance", () => {
    for (const [x, opts] of [
      [180, { stretch: true }],
      [60, { compress: true }],
    ] as const) {
      const s = new DocumentStore(createDocument("one"));
      s.apply("addBone", { name: "b", length: 100 });
      s.apply("addBone", { name: "t", x: 0, y: x, length: 0 });
      s.apply("addIkConstraint", { bones: ["b"], target: "t", ...opts });
      const tip = tipOf(new Skeleton(s.doc), "b");
      expect(tip[0]).toBeCloseTo(0, 1);
      expect(tip[1]).toBeCloseTo(x, 1);
    }
  });

  it("softness is keyable", () => {
    const s = arm(200, 0);
    s.apply("addIkConstraint", { name: "ik", bones: ["upper", "lower"], target: "target" });
    s.apply("createAnimation", { name: "a", duration: 1 });
    s.apply("setKeys", { animation: "a", target: "ik", id: "ik", property: "softness", keys: [{ time: 0, value: 40 }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("a");
    inst.advance(0);
    expect(dist(tipOf(inst.skeleton, "lower"), [0, 0])).toBeLessThan(190);
  });
});

describe("IK keyed switches and uniform", () => {
  const elbowY = (sk: Skeleton) => sk.findBone("lower")!.world.y;

  it("bend direction keys in steps and flips the elbow", () => {
    const s = arm(120, 0);
    s.apply("addIkConstraint", { name: "ik", bones: ["upper", "lower"], target: "target", bendPositive: true });
    s.apply("createAnimation", { name: "a", duration: 1 });
    s.apply("setKeys", { animation: "a", target: "ik", id: "ik", property: "bend", keys: [{ time: 0, value: 1, curve: "stepped" }, { time: 0.5, value: -1, curve: "stepped" }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("a");
    inst.advance(0.25);
    const before = elbowY(inst.skeleton);
    inst.advance(0.5); // t = 0.75
    const after = elbowY(inst.skeleton);
    expect(Math.sign(before)).toBe(-Math.sign(after));
    expect(Math.abs(before)).toBeCloseTo(Math.abs(after), 3);
    // The tip still reaches the target either way.
    expect(dist(tipOf(inst.skeleton, "lower"), [120, 0])).toBeLessThan(0.01);
  });

  it("stretch can be keyed on and off", () => {
    const s = arm(260, 0);
    s.apply("addIkConstraint", { name: "ik", bones: ["upper", "lower"], target: "target" });
    s.apply("createAnimation", { name: "a", duration: 1 });
    s.apply("setKeys", { animation: "a", target: "ik", id: "ik", property: "stretch", keys: [{ time: 0, value: 0, curve: "stepped" }, { time: 0.5, value: 1, curve: "stepped" }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("a");
    inst.advance(0.2);
    expect(dist(tipOf(inst.skeleton, "lower"), [0, 0])).toBeCloseTo(200, 1);
    inst.advance(0.5);
    expect(dist(tipOf(inst.skeleton, "lower"), [0, 0])).toBeCloseTo(260, 1);
  });

  it("uniform stretch scales across the bone too", () => {
    const sy = (uniform: boolean) => {
      const s = arm(260, 0);
      s.apply("addIkConstraint", { bones: ["upper", "lower"], target: "target", stretch: true, uniform });
      const w = new Skeleton(s.doc).findBone("upper")!.world;
      return Math.hypot(w.b, w.d);
    };
    expect(sy(false)).toBeCloseTo(1, 5);
    expect(sy(true)).toBeCloseTo(1.3, 3);
  });
});

describe("transform constraint modes", () => {
  function pair() {
    const s = new DocumentStore(createDocument("tc"));
    s.apply("addBone", { name: "target", x: 50, y: 20, rotation: 30, length: 40 });
    s.apply("addBone", { name: "follower", x: -50, rotation: 0, length: 40 });
    return s;
  }

  it("world shear mix copies the angle between the target's axes", () => {
    const s = pair();
    s.apply("updateBone", { bone: "target", shearY: 25 });
    s.apply("addTransformConstraint", { bones: ["follower"], target: "target", mixRotate: 0, mixTranslate: 0, mixShear: 1 });
    const w = new Skeleton(s.doc).findBone("follower")!.world;
    const skew = (Math.atan2(w.d, w.b) - Math.atan2(w.c, w.a)) * (180 / Math.PI) - 90;
    expect(skew).toBeCloseTo(25, 3);
    // Half mix → half the shear.
    s.apply("updateTransformConstraint", { constraint: "transform", mixShear: 0.5 });
    const w2 = new Skeleton(s.doc).findBone("follower")!.world;
    expect((Math.atan2(w2.d, w2.b) - Math.atan2(w2.c, w2.a)) * (180 / Math.PI) - 90).toBeCloseTo(12.5, 3);
  });

  it("local absolute copies local values", () => {
    const s = pair();
    s.apply("addTransformConstraint", { bones: ["follower"], target: "target", local: true, mixTranslate: 0, offsetRotation: 5 });
    const sk = new Skeleton(s.doc);
    expect(sk.findBone("follower")!.applied.rotation).toBeCloseTo(35, 5);
    expect(sk.findBone("follower")!.worldRotation).toBeCloseTo(35, 5);
    expect(sk.findBone("follower")!.world.x).toBeCloseTo(-50, 5);
  });

  it("world relative adds the target's change from its setup pose", () => {
    const s = pair();
    s.apply("addTransformConstraint", { name: "rel", bones: ["follower"], target: "target", relative: true });
    // In setup pose nothing changes.
    let f = new Skeleton(s.doc).findBone("follower")!;
    expect(f.worldRotation).toBeCloseTo(0, 5);
    expect(f.world.x).toBeCloseTo(-50, 5);
    // Animate the target: +20° and +10 x → follower follows by the same deltas.
    s.apply("createAnimation", { name: "a", duration: 1 });
    s.apply("setKeys", { animation: "a", target: "bone", id: "target", property: "rotation", keys: [{ time: 0, value: 50 }] });
    s.apply("setKeys", { animation: "a", target: "bone", id: "target", property: "x", keys: [{ time: 0, value: 60 }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("a");
    inst.advance(0);
    f = inst.skeleton.findBone("follower")!;
    expect(f.worldRotation).toBeCloseTo(20, 4);
    expect(f.world.x).toBeCloseTo(-40, 4);
    expect(f.world.y).toBeCloseTo(0, 4);
  });

  it("local relative adds local deltas, and mix keys scale every channel", () => {
    const s = pair();
    s.apply("addTransformConstraint", { name: "lr", bones: ["follower"], target: "target", local: true, relative: true });
    s.apply("createAnimation", { name: "a", duration: 1 });
    s.apply("setKeys", { animation: "a", target: "bone", id: "target", property: "y", keys: [{ time: 0, value: 30 }] });
    s.apply("setKeys", { animation: "a", target: "transform", id: "lr", property: "mix", keys: [{ time: 0, value: 0.5 }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("a");
    inst.advance(0);
    expect(inst.skeleton.findBone("follower")!.world.y).toBeCloseTo(5, 4);
  });
});

describe("path geometry", () => {
  it("measures arc length independently of handle spacing", () => {
    // Straight line with deliberately uneven handles.
    const v = [0, 0, 0, 0, 10, 0, 250, 0, 300, 0, 300, 0];
    const sp = buildSpline(v, false);
    expect(sp.length).toBeCloseTo(300, 3);
    expect(sp.sample(150).x).toBeCloseTo(150, 1);
    expect(sp.sample(-20).x).toBeCloseTo(-20, 5); // extends past the start
    expect(sp.sample(320).x).toBeCloseTo(320, 5);
  });

  it("smoothKnots passes through the anchors; closed paths wrap", () => {
    const k = smoothKnots([0, 0, 100, 0, 100, 100, 0, 100], true);
    expect(k.length).toBe(24);
    expect([k[2], k[3], k[8], k[9]]).toEqual([0, 0, 100, 0]);
    const sp = buildSpline(k, true);
    expect(sp.segments).toBe(4);
    const a = sp.sample(10);
    const b = sp.sample(10 + sp.length);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });
});

function tail(opts: Record<string, unknown> = {}, anchors = [0, 0, 150, 0, 300, 0]) {
  const s = new DocumentStore(createDocument("tail"));
  s.apply("addBone", { name: "t1", length: 50 });
  s.apply("addBone", { name: "t2", parent: "t1", x: 50, length: 50 });
  s.apply("addBone", { name: "t3", parent: "t2", x: 50, length: 50 });
  s.apply("addBone", { name: "track", y: 100, length: 0 });
  s.apply("addSlot", { bone: "track", name: "track" });
  s.apply("addPath", { slot: "track", anchors });
  s.apply("addPathConstraint", { name: "p", bones: ["t1", "t2", "t3"], target: "track", positionMode: "fixed", ...opts });
  return s;
}

describe("path constraint", () => {
  it("places bones by length spacing along a straight path", () => {
    const sk = new Skeleton(tail().doc);
    ["t1", "t2", "t3"].forEach((n, i) => {
      const b = sk.findBone(n)!;
      expect(b.world.x).toBeCloseTo(i * 50, 2);
      expect(b.world.y).toBeCloseTo(100, 2);
      expect(b.worldRotation).toBeCloseTo(0, 3);
    });
    expect(validate(tail().doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("percent position, fixed / percent / proportional spacing", () => {
    let sk = new Skeleton(tail({ positionMode: "percent", position: 0.5 }).doc);
    expect(sk.findBone("t1")!.world.x).toBeCloseTo(150, 1);
    sk = new Skeleton(tail({ spacingMode: "fixed", spacing: 30 }).doc);
    expect(sk.findBone("t3")!.world.x).toBeCloseTo(60, 1);
    sk = new Skeleton(tail({ spacingMode: "percent", spacing: 0.25 }).doc);
    expect(sk.findBone("t3")!.world.x).toBeCloseTo(150, 1);
    sk = new Skeleton(tail({ spacingMode: "proportional", spacing: 0.9 }).doc);
    expect(sk.findBone("t2")!.world.x).toBeCloseTo(90, 1);
    expect(sk.findBone("t3")!.world.x).toBeCloseTo(180, 1);
  });

  // A smooth arc bending up: tangent and chain modes differ there.
  const arc = [0, 0, 100, 20, 180, 80, 230, 170];

  it("tangent mode follows the curve direction", () => {
    const sk = new Skeleton(tail({ rotateMode: "tangent", position: 40 }, arc).doc);
    const sp = buildSpline(sk.attachmentWorldVertices(sk.findSlot("track")!, sk.getAttachment(sk.findSlot("track")!)!), false);
    for (const [i, n] of ["t1", "t2", "t3"].entries()) {
      const at = sp.sample(40 + i * 50);
      const b = sk.findBone(n)!;
      expect(b.world.x).toBeCloseTo(at.x, 2);
      expect(b.world.y).toBeCloseTo(at.y, 2);
      expect(b.worldRotation).toBeCloseTo((at.angle * 180) / Math.PI, 2);
    }
  });

  it("chain mode points each bone at the next one; chainScale stretches to reach it", () => {
    const sk = new Skeleton(tail({ rotateMode: "chain", spacingMode: "fixed", spacing: 70 }, arc).doc);
    for (const [a, b] of [["t1", "t2"], ["t2", "t3"]]) {
      const A = sk.findBone(a)!.world;
      const B = sk.findBone(b)!.world;
      expect(worldRotation(A)).toBeCloseTo((Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI, 2);
    }
    // chain keeps bone length; with 70 spacing the tip of t1 falls short of t2.
    expect(dist(tipOf(sk, "t1"), [sk.findBone("t2")!.world.x, sk.findBone("t2")!.world.y])).toBeGreaterThan(5);
    const sk2 = new Skeleton(tail({ rotateMode: "chainScale", spacingMode: "fixed", spacing: 70 }, arc).doc);
    const t2 = sk2.findBone("t2")!.world;
    expect(dist(tipOf(sk2, "t1"), [t2.x, t2.y])).toBeLessThan(0.05);
  });

  it("mixes blend toward the path and a weighted path follows its control bone", () => {
    const s = tail({ mixX: 0.5, mixY: 0.5, mixRotate: 0 });
    // Bone t1 starts at y=0, path at y=100: half mix → y=50.
    expect(new Skeleton(s.doc).findBone("t1")!.world.y).toBeCloseTo(50, 2);

    const w = tail({ position: 120 });
    w.apply("addBone", { name: "ctrl", parent: "track", x: 300, length: 0 });
    w.apply("setWeights", { slot: "track", attachment: "path", vertex: 7, influences: [{ bone: "ctrl", weight: 1 }] });
    w.apply("setWeights", { slot: "track", attachment: "path", vertex: 8, influences: [{ bone: "ctrl", weight: 1 }] });
    w.apply("createAnimation", { name: "lift", duration: 1 });
    w.apply("setKeys", { animation: "lift", target: "bone", id: "ctrl", property: "y", keys: [{ time: 0, value: 120 }] });
    const inst = new OpenBoneInstance(w.doc);
    inst.play("lift");
    inst.advance(0);
    // The path's end rises, so the last bone is above the track line and rotated upward.
    expect(inst.skeleton.findBone("t3")!.world.y).toBeGreaterThan(105);
    expect(inst.skeleton.findBone("t3")!.worldRotation).toBeGreaterThan(5);
  });

  it("position, spacing and mixes are keyable", () => {
    const s = tail();
    s.apply("createAnimation", { name: "slide", duration: 1 });
    s.apply("setKeys", { animation: "slide", target: "path", id: "p", property: "position", keys: [{ time: 0, value: 0 }, { time: 1, value: 100 }] });
    s.apply("setKeys", { animation: "slide", target: "path", id: "p", property: "spacing", keys: [{ time: 0, value: 10 }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("slide", false);
    inst.advance(0.5);
    expect(inst.skeleton.findBone("t1")!.world.x).toBeCloseTo(50, 1);
    expect(inst.skeleton.findBone("t2")!.world.x).toBeCloseTo(110, 1);
    expect(() => s.apply("setKeys", { animation: "slide", target: "path", id: "p", property: "bogus", keys: [{ time: 0, value: 1 }] })).toThrow();
  });

  it("deleting the path slot removes the constraint and its timelines", () => {
    const s = tail();
    s.apply("createAnimation", { name: "a" });
    s.apply("setKeys", { animation: "a", target: "path", id: "p", property: "position", keys: [{ time: 0, value: 5 }] });
    s.apply("deleteSlot", { slot: "track" });
    expect(s.doc.skeleton.path).toEqual([]);
    expect(s.doc.animations[0].timelines).toEqual([]);
  });
});

describe("physics constraint", () => {
  function hair(opts: Record<string, unknown> = {}) {
    const s = new DocumentStore(createDocument("hair"));
    s.apply("addBone", { name: "head", length: 0 });
    s.apply("addBone", { name: "h1", parent: "head", length: 50 });
    s.apply("addBone", { name: "h2", parent: "h1", x: 50, length: 50 });
    s.apply("addPhysicsConstraint", { name: "p1", bone: "h1", ...opts });
    s.apply("addPhysicsConstraint", { name: "p2", bone: "h2", ...opts });
    return s;
  }
  /** Run frames, moving the head with `move(t)`. Returns the skeleton. */
  function run(doc: ReturnType<typeof hair>["doc"], dts: number[], move: (t: number) => number = () => 0) {
    const sk = new Skeleton(doc);
    let t = 0;
    for (const dt of dts) {
      t += dt;
      sk.setToSetupPose();
      sk.findBone("head")!.x = move(t);
      sk.update(dt);
      sk.updateWorldTransform();
    }
    return sk;
  }
  const frames = (n: number, dt: number) => new Array<number>(n).fill(dt);
  const pose = (sk: Skeleton) => sk.bones.map((b) => [b.world.a, b.world.b, b.world.c, b.world.d, b.world.x, b.world.y]);

  it("is deterministic: the same frame times give the same pose", () => {
    const doc = hair({ gravity: 200, wind: 30 }).doc;
    const dts = [1 / 60, 1 / 45, 1 / 120, 1 / 30, 1 / 60, 1 / 75].flatMap((d) => frames(20, d));
    const move = (t: number) => Math.sin(t * 7) * 40;
    expect(pose(run(doc, dts, move))).toEqual(pose(run(doc, dts, move)));
  });

  it("uses a fixed timestep: frame size does not change a held pose's result", () => {
    // Single simulated bone (in a chain, a child's spring target follows its parent's per-frame pose).
    const s = hair({ gravity: 300 });
    s.apply("deleteConstraint", { constraint: "p2" });
    const doc = s.doc;
    const a = pose(run(doc, frames(120, 1 / 60)));
    const b = pose(run(doc, frames(60, 1 / 30)));
    a.flat().forEach((v, i) => expect(v).toBeCloseTo(b.flat()[i], 6));
  });

  it("gravity makes the chain droop and settle", () => {
    const doc = hair({ gravity: 800, strength: 80 }).doc;
    const sk = run(doc, frames(600, 1 / 60));
    const r1 = sk.findBone("h1")!.worldRotation;
    expect(r1).toBeLessThan(-5);
    const later = run(doc, frames(660, 1 / 60)).findBone("h1")!.worldRotation;
    expect(later).toBeCloseTo(r1, 2);
  });

  it("wind pushes sideways", () => {
    const s = new DocumentStore(createDocument("flag"));
    s.apply("addBone", { name: "pole", rotation: 90, length: 60 });
    s.apply("addPhysicsConstraint", { bone: "pole", wind: 1200, strength: 60 });
    const sk = new Skeleton(s.doc);
    for (let i = 0; i < 300; i++) {
      sk.setToSetupPose();
      sk.update(1 / 60);
      sk.updateWorldTransform();
    }
    // Pointing up; wind toward +x tilts it clockwise (rotation below 90).
    expect(sk.findBone("pole")!.worldRotation).toBeLessThan(80);
  });

  it("inertia makes the chain lag behind movement, then return to the animated pose", () => {
    const doc = hair({ inertia: 1, damping: 4 }).doc;
    // Head jumps up after a few frames and stays.
    const sk = new Skeleton(doc);
    let lagged = 0;
    for (let i = 0; i < 400; i++) {
      sk.setToSetupPose();
      sk.findBone("head")!.y = i > 6 ? 80 : 0;
      sk.update(1 / 60);
      sk.updateWorldTransform();
      if (i === 9) lagged = sk.findBone("h1")!.worldRotation;
    }
    expect(lagged).toBeLessThan(-10); // tip left behind (below) as the head moved up
    expect(sk.findBone("h1")!.worldRotation).toBeCloseTo(0, 1);
    expect(sk.findBone("h1")!.world.y).toBeCloseTo(80, 3);

    // inertia 0: carried along, no lag.
    const sk0 = new Skeleton(hair({ inertia: 0 }).doc);
    for (let i = 0; i < 10; i++) {
      sk0.setToSetupPose();
      sk0.findBone("head")!.y = i > 6 ? 80 : 0;
      sk0.update(1 / 60);
      sk0.updateWorldTransform();
    }
    expect(sk0.findBone("h1")!.worldRotation).toBeCloseTo(0, 6);
  });

  it("mix 0 and keyed mix turn it off; reset returns to rest", () => {
    const doc = hair({ gravity: 400, mix: 0 }).doc;
    expect(run(doc, frames(60, 1 / 60)).findBone("h1")!.worldRotation).toBeCloseTo(0, 6);
    const s = hair({ gravity: 400 });
    s.apply("createAnimation", { name: "calm", duration: 1 });
    s.apply("setKeys", { animation: "calm", target: "physics", id: "p1", property: "gravity", keys: [{ time: 0, value: 0 }] });
    s.apply("setKeys", { animation: "calm", target: "physics", id: "p2", property: "mix", keys: [{ time: 0, value: 0 }] });
    const inst = new OpenBoneInstance(s.doc);
    inst.play("calm");
    for (let i = 0; i < 120; i++) inst.advance(1 / 60);
    expect(inst.skeleton.findBone("h1")!.worldRotation).toBeCloseTo(0, 3);
    const sk = run(hair({ gravity: 400 }).doc, frames(60, 1 / 60));
    sk.resetPhysics();
    sk.setToSetupPose();
    sk.updateWorldTransform();
    expect(sk.findBone("h1")!.worldRotation).toBeCloseTo(0, 6);
  });

  it("x/y channels let the bone origin bounce", () => {
    const doc = hair({ x: 1, y: 1, rotate: 0, inertia: 1 }).doc;
    const sk = new Skeleton(doc);
    let min = Infinity;
    for (let i = 0; i < 30; i++) {
      sk.setToSetupPose();
      sk.findBone("head")!.y = i > 2 ? 50 : 0;
      sk.update(1 / 60);
      sk.updateWorldTransform();
      if (i > 3) min = Math.min(min, sk.findBone("h1")!.world.y);
    }
    expect(min).toBeLessThan(40);
  });
});

describe("tail example", () => {
  it("the tail chain is driven by its path constraint", async () => {
    const { readFileSync } = await import("node:fs");
    const { deserialize } = await import("@openbone/core");
    const doc = deserialize(readFileSync(new URL("../../../examples/tail.obone", import.meta.url), "utf8"));
    expect(validate(doc).filter((i) => i.level === "error")).toEqual([]);
    expect(doc.skeleton.path).toHaveLength(1);
    const inst = new OpenBoneInstance(doc);
    inst.play("wag");
    const tipY: number[] = [];
    for (let i = 0; i < 96; i++) {
      inst.advance(1 / 60);
      const sk = inst.skeleton;
      const slot = sk.findSlot("tail-path")!;
      const sp = buildSpline(sk.attachmentWorldVertices(slot, sk.getAttachment(slot)!), false);
      // Every tail bone origin sits on the (animated) path, 32 units apart.
      for (let b = 1; b <= 8; b++) {
        const at = sp.sample((b - 1) * 32);
        const w = sk.findBone(`tail${b}`)!.world;
        expect(w.x).toBeCloseTo(at.x, 3);
        expect(w.y).toBeCloseTo(at.y, 3);
      }
      tipY.push(sk.findBone("tail8")!.world.y);
    }
    // The wag actually moves the tail tip.
    expect(Math.max(...tipY) - Math.min(...tipY)).toBeGreaterThan(40);
  });
});
