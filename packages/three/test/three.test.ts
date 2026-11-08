import { OpenBoneDriver } from "@openbone/engine-kit";
import * as THREE from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GEOMETRY_CASES, type RefDraw, example, flatten, installFakeOffscreenCanvas, packed, webglReference } from "../../engine-kit/test/reference.ts";
import { BLEND_FACTORS, type OpenBoneAsset, OpenBoneObject3D } from "../src/index.ts";

let restore = () => {};
beforeAll(() => void (restore = installFakeOffscreenCanvas()));
afterAll(() => restore());

function make(file: string, atlas?: boolean, setup?: (i: OpenBoneDriver["instance"]) => void) {
  const doc = atlas ? packed(example(file)) : example(file);
  const textures = new Map<string, THREE.Texture>();
  for (const t of [...(doc.atlas?.pages ?? []), ...doc.images]) textures.set(t.id, new THREE.Texture());
  const asset: OpenBoneAsset = { doc, baseUrl: "", textures };
  const driver = OpenBoneDriver.createSync(doc, "", { audio: false });
  setup?.(driver.instance);
  const obj = new OpenBoneObject3D(asset, driver);
  for (let i = 0; i < 12; i++) obj.update(0.05);
  return obj;
}

describe("Three.js geometry matches render-webgl", () => {
  for (const c of GEOMETRY_CASES)
    it(c.name, () => {
      const obj = make(c.file, c.atlas, c.setup);
      const ref = webglReference(obj.skeleton);
      const got: RefDraw[] = obj.drawnMeshes().map((m) => ({ stencil: m.mask, verts: m.vertices.map((v) => (m.mask ? [v[0], v[1], 1, 1, 1, 1, 1, 1] : v)) }));
      expect(got.map((d) => d.stencil)).toEqual(ref.map((d) => d.stencil));
      expect(flatten(got)).toEqual(flatten(ref));
    });
});

describe("Three.js object", () => {
  it("shares one material per atlas page and blend mode", () => {
    const obj = make("campfire.obone", true);
    const draws = obj.drawnMeshes().filter((m) => !m.mask);
    const keys = new Set(draws.map((m) => `${m.material.uniforms.map.value.uuid}|${m.material.blendSrc}|${m.material.blendDst}|${m.material.stencilRef}`));
    expect(new Set(draws.map((m) => m.material)).size).toBe(keys.size);
    // Packed: the page plus the white texture of the mask; additive batches use ONE, ONE.
    expect(draws.some((m) => m.material.blendDst === BLEND_FACTORS.additive[1])).toBe(true);
  });

  it("draws in order, clipped batches test the mask's stencil value", () => {
    const obj = make("button.obone");
    const meshes = obj.children as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
    expect(meshes.map((m) => m.renderOrder)).toEqual(meshes.map((_, i) => i));
    const mask = meshes.find((m) => !m.material.colorWrite)!;
    expect(mask.material.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    const clipped = meshes.filter((m) => m.material.stencilFunc === THREE.EqualStencilFunc);
    expect(clipped.length).toBeGreaterThan(0);
    for (const m of clipped) expect(m.material.stencilRef).toBe(mask.material.stencilRef);
    // Materials are reused from frame to frame.
    const before = new Set(meshes.map((m) => m.material));
    obj.update(0.1);
    for (const m of obj.children as typeof meshes) expect(before.has(m.material)).toBe(true);
  });

  it("raycasts pointers onto the skeleton plane", () => {
    const obj = make("knight.obone");
    obj.position.set(100, 0, 0);
    obj.scale.setScalar(0.5);
    const seen: [string, number, number][] = [];
    obj.stateMachine!.pointer = (t, x, y) => void seen.push([t, x, y]);
    const ray = new THREE.Ray(new THREE.Vector3(110, 20, 100), new THREE.Vector3(0, 0, -1));
    obj.pointer("down", ray);
    obj.pointer("move", new THREE.Ray(new THREE.Vector3(1e5, 0, 100), new THREE.Vector3(0, 0, -1)));
    expect(seen.map(([t, x, y]) => [t, Math.round(x), Math.round(y)])).toEqual([
      ["down", 20, 40],
      ["move", -1e9, -1e9],
    ]);
  });

  it("disposes", () => {
    const obj = make("rocket.obone");
    obj.dispose();
    expect(obj.children.length).toBe(0);
  });
});
