import { describe, expect, it } from "vitest";
import { DocumentStore, apply as applyM, createDocument, getAttachment, registry, setupWorld, triangulate } from "../src/index.ts";
import type { MeshAttachment } from "../src/index.ts";

function rig() {
  const s = new DocumentStore(createDocument("m"));
  s.apply("addBone", { name: "a", rotation: 0, length: 100 });
  s.apply("addBone", { name: "b", parent: "a", x: 100, rotation: 30, length: 100 });
  s.apply("addImage", { name: "img", src: "data:,", width: 200, height: 40 });
  s.apply("addSlot", { bone: "a", name: "skin" });
  s.apply("addMesh", { slot: "skin", image: "img", x: 100, cols: 4, rows: 1 });
  const mesh = () => getAttachment(s.doc, s.doc.skeleton.slots[0].id, "img") as MeshAttachment;
  return { s, mesh };
}

/** Setup-pose world positions of every vertex, whether weighted or not. */
function worldVerts(s: DocumentStore, m: MeshAttachment): number[] {
  const w = setupWorld(s.doc);
  const out: number[] = [];
  for (let v = 0; v < m.vertices.length / 2; v++) {
    if (m.weights) {
      let x = 0;
      let y = 0;
      for (const inf of m.weights[v]) {
        const [px, py] = applyM(w.get(inf.bone)!, inf.x, inf.y);
        x += px * inf.weight;
        y += py * inf.weight;
      }
      out.push(x, y);
    } else out.push(...applyM(w.get(s.doc.skeleton.slots[0].bone)!, m.vertices[v * 2], m.vertices[v * 2 + 1]));
  }
  return out;
}

describe("setMeshWeights", () => {
  it("is registered (so it becomes an MCP tool)", () => {
    expect(registry.get("setMeshWeights")?.group).toBe("attachment");
  });

  it("binds an unweighted mesh, normalises, and keeps the setup shape", () => {
    const { s, mesh } = rig();
    const before = worldVerts(s, mesh());
    s.apply("setMeshWeights", {
      slot: "skin",
      attachment: "img",
      vertices: [
        { vertex: 0, influences: [{ bone: "a", weight: 3 }, { bone: "b", weight: 1 }] },
        { vertex: 3, influences: [{ bone: "b", weight: 2 }] },
      ],
    });
    const m = mesh();
    expect(m.weights).toHaveLength(m.vertices.length / 2);
    const bId = s.doc.skeleton.bones.find((b) => b.name === "b")!.id;
    expect(m.weights![0].map((i) => i.weight)).toEqual([0.75, 0.25]);
    expect(m.weights![3]).toEqual([expect.objectContaining({ bone: bId, weight: 1 })]);
    // Untouched vertices are bound 100% to the slot bone.
    expect(m.weights![1]).toEqual([expect.objectContaining({ bone: s.doc.skeleton.slots[0].bone, weight: 1 })]);
    const after = worldVerts(s, m);
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
  });

  it("drops zero weights, merges duplicate bones and is one undo step", () => {
    const { s, mesh } = rig();
    s.apply("setMeshWeights", {
      slot: "skin",
      attachment: "img",
      vertices: [{ vertex: 2, influences: [{ bone: "a", weight: 1 }, { bone: "b", weight: 0 }, { bone: "a", weight: 1 }] }],
    });
    expect(mesh().weights![2]).toHaveLength(1);
    expect(mesh().weights![2][0].weight).toBe(1);
    s.undo();
    expect(mesh().weights).toBeUndefined();
  });

  it("rejects out-of-range vertices, all-zero influences and non-mesh attachments", () => {
    const { s, mesh } = rig();
    expect(() => s.apply("setMeshWeights", { slot: "skin", attachment: "img", vertices: [{ vertex: 999, influences: [{ bone: "a", weight: 1 }] }] })).toThrow(/out of range/);
    expect(() => s.apply("setMeshWeights", { slot: "skin", attachment: "img", vertices: [{ vertex: 0, influences: [{ bone: "a", weight: 0 }] }] })).toThrow(/weight > 0/);
    expect(() => s.apply("setMeshWeights", { slot: "skin", attachment: "img", vertices: [] })).toThrow(/Invalid args/);
    s.apply("addShape", { slot: "skin", shape: "rect", name: "box" });
    expect(() => s.apply("setMeshWeights", { slot: "skin", attachment: "box", vertices: [{ vertex: 0, influences: [{ bone: "a", weight: 1 }] }] })).toThrow(/mesh/);
    expect(mesh().weights).toBeUndefined();
  });

  it("reweights an already-weighted mesh without moving it", () => {
    const { s, mesh } = rig();
    s.apply("autoWeights", { slot: "skin", attachment: "img", bones: ["a", "b"] });
    const before = worldVerts(s, mesh());
    s.apply("setMeshWeights", { slot: "skin", attachment: "img", vertices: [{ vertex: 1, influences: [{ bone: "b", weight: 1 }] }] });
    const after = worldVerts(s, mesh());
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 6));
  });

  it("setWeights still works through the shared code", () => {
    const { s, mesh } = rig();
    s.apply("setWeights", { slot: "skin", attachment: "img", vertex: 0, influences: [{ bone: "b", weight: 5 }] });
    expect(mesh().weights![0][0].weight).toBe(1);
  });
});

describe("updateAttachment on meshes", () => {
  it("moves vertices of a weighted mesh (re-binds instead of silently ignoring them)", () => {
    const { s, mesh } = rig();
    s.apply("autoWeights", { slot: "skin", attachment: "img", bones: ["a", "b"] });
    const before = worldVerts(s, mesh());
    const vertices = mesh().vertices.slice();
    vertices[0] += 25;
    vertices[1] -= 10;
    const bonesBefore = mesh().weights!.map((l) => l.map((i) => [i.bone, i.weight]));
    s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { vertices } });
    const after = worldVerts(s, mesh());
    expect(after[0]).toBeCloseTo(before[0] + 25, 6);
    expect(after[1]).toBeCloseTo(before[1] - 10, 6);
    after.slice(2).forEach((v, i) => expect(v).toBeCloseTo(before[i + 2], 6));
    // Same influences, only positions changed.
    expect(mesh().weights!.map((l) => l.map((i) => [i.bone, i.weight]))).toEqual(bonesBefore);
  });

  it("adds a vertex: requires uvs, re-triangulates and weights it like its nearest neighbour", () => {
    const { s, mesh } = rig();
    s.apply("autoWeights", { slot: "skin", attachment: "img", bones: ["a", "b"] });
    const m = mesh();
    const vertices = [...m.vertices, m.vertices[0] + 1, m.vertices[1] - 1];
    expect(() => s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { vertices } })).toThrow(/also pass uvs/);
    s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { vertices, uvs: [...m.uvs, 0.01, 0.01] } });
    const n = mesh().vertices.length / 2;
    expect(mesh().weights).toHaveLength(n);
    expect(new Set(mesh().triangles).has(n - 1)).toBe(true);
    expect(mesh().weights![n - 1].map((i) => i.bone)).toEqual(mesh().weights![0].map((i) => i.bone));
  });

  it("rejects inconsistent mesh data and leaves the mesh untouched", () => {
    const { s, mesh } = rig();
    const snapshot = structuredClone(mesh());
    expect(() => s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { uvs: [0, 0] } })).toThrow(/uvs/);
    expect(() => s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { triangles: [0, 1, 999] } })).toThrow(/triangles/);
    expect(() => s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { hull: 1 } })).toThrow(/hull/);
    expect(() => s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { vertices: [0, 0, 1] } })).toThrow(/vertices/);
    expect(mesh()).toEqual(snapshot);
  });

  it("still updates plain fields", () => {
    const { s, mesh } = rig();
    s.apply("updateAttachment", { slot: "skin", attachment: "img", props: { color: "#ff0000" } });
    expect(mesh().color).toBe("#ff0000");
  });
});

describe("triangulate", () => {
  it("uses earcut for a plain polygon", () => {
    expect(triangulate([0, 0, 10, 0, 10, 10, 0, 10])).toHaveLength(6);
  });

  it("includes interior points and stays inside a concave hull", () => {
    // L-shaped hull plus two interior points.
    const hull = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
    const interior = [5, 5, 15, 5];
    const tris = triangulate(hull, interior);
    const used = new Set(tris);
    expect(used.has(6)).toBe(true);
    expect(used.has(7)).toBe(true);
    // Total area equals the L area (300) → full coverage, no triangles outside.
    const pts = [...hull, ...interior];
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i] * 2, tris[i + 1] * 2, tris[i + 2] * 2];
      area += Math.abs((pts[b] - pts[a]) * (pts[c + 1] - pts[a + 1]) - (pts[b + 1] - pts[a + 1]) * (pts[c] - pts[a])) / 2;
    }
    expect(area).toBeCloseTo(300, 6);
  });
});
