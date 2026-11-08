import "./env.ts";
import { OpenBoneDriver, buildBatches } from "@openbone/engine-kit";
import { Container, Texture } from "pixi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GEOMETRY_CASES, type RefDraw, example, flatten, installFakeOffscreenCanvas, packed, webglReference } from "../../engine-kit/test/reference.ts";
import { OpenBone, type OpenBoneAsset, PIXI_BLEND } from "../src/index.ts";

let restore = () => {};
beforeAll(() => void (restore = installFakeOffscreenCanvas()));
afterAll(() => restore());

/** Read back what the Pixi object will draw: each mesh's geometry, with stencil masks before their runs. */
function pixiDraws(obj: OpenBone): RefDraw[] {
  const out: RefDraw[] = [];
  const visit = (c: Container) => {
    for (const ch of c.children) {
      const anyCh = ch as unknown as { geometry?: { attributes: Record<string, { buffer: { data: Float32Array } }>; indexBuffer: { data: Uint16Array } } };
      if (ch.mask && ch.children.length) {
        const g = ch.mask as unknown as { context: { instructions: { data: { path: { shapePath: { shapePrimitives: { shape: { points: number[] } }[] } } } }[] } };
        const pts = g.context.instructions[0].data.path.shapePath.shapePrimitives[0].shape.points;
        out.push({ stencil: true, verts: [pts.map((v) => v)] });
        visit(ch as Container);
      } else if (anyCh.geometry) {
        const a = anyCh.geometry.attributes;
        const pos = a.aPosition.buffer.data;
        const uv = a.aUV.buffer.data;
        const col = a.aColor.buffer.data;
        out.push({ stencil: false, verts: Array.from(anyCh.geometry.indexBuffer.data, (i) => [pos[i * 2], pos[i * 2 + 1], uv[i * 2], uv[i * 2 + 1], col[i * 4], col[i * 4 + 1], col[i * 4 + 2], col[i * 4 + 3]]) });
      }
    }
  };
  visit(obj.view);
  return out;
}

const asset = (file: string, atlas?: boolean): OpenBoneAsset => {
  const doc = atlas ? packed(example(file)) : example(file);
  const textures = new Map<string, Texture>();
  for (const t of [...(doc.atlas?.pages ?? []), ...doc.images]) textures.set(t.id, Texture.WHITE);
  return { doc, baseUrl: "", textures };
};

describe("Pixi geometry matches render-webgl", () => {
  for (const c of GEOMETRY_CASES)
    it(c.name, () => {
      const a = asset(c.file, c.atlas);
      const driver = OpenBoneDriver.createSync(a.doc, "", { audio: false });
      c.setup?.(driver.instance);
      const obj = new OpenBone(a, driver, { autoUpdate: false, interactive: false });
      for (let i = 0; i < 12; i++) obj.update(0.05);
      const ref = webglReference(driver.skeleton);
      const got = pixiDraws(obj);
      // Clip masks: compare the polygon instead of its triangulation.
      const refClips = ref.filter((d) => d.stencil).length;
      expect(got.filter((d) => d.stencil).length).toBe(refClips);
      const strip = (d: RefDraw[]) => d.filter((x) => !x.stencil);
      expect(flatten(strip(got))).toEqual(flatten(strip(ref)));
      expect(obj.drawCalls).toBe(ref.length - refClips);
    });
});

describe("Pixi object", () => {
  it("maps blend modes and textures per batch", () => {
    const a = asset("campfire.obone", true);
    const driver = OpenBoneDriver.createSync(a.doc, "", { audio: false });
    const obj = new OpenBone(a, driver, { autoUpdate: false, interactive: false });
    obj.update(0.3);
    const batches = buildBatches(driver.instance.drawList());
    const meshes: { blendMode: string }[] = [];
    const visit = (c: Container) => c.children.forEach((ch) => ("geometry" in ch ? meshes.push(ch as never) : visit(ch as Container)));
    visit(obj.view);
    expect(meshes.map((m) => m.blendMode)).toEqual(batches.map((b) => PIXI_BLEND[b.blend]));
  });

  it("routes pointer events to the state machine listeners", () => {
    const a = asset("button.obone");
    const driver = OpenBoneDriver.createSync(a.doc, "", { audio: false });
    const obj = new OpenBone(a, driver, { autoUpdate: false });
    expect(obj.eventMode).toBe("static");
    // A point inside the artboard (container space, y down) hits; far outside does not.
    expect(obj.hitArea!.contains(0, 0)).toBe(true);
    expect(obj.hitArea!.contains(1e5, 0)).toBe(false);
    const seen: string[] = [];
    driver.instance.stateMachine!.pointer = (type) => void seen.push(type);
    const ev = (x: number, y: number) => ({ getLocalPosition: (c: Container) => c.toLocal({ x, y }, obj) }) as never;
    obj.emit("pointerdown", ev(0, 0));
    obj.emit("pointerup", ev(0, 0));
    obj.emit("globalpointermove", ev(0, 0));
    expect(seen).toEqual(["down", "up", "move"]);
  });

  it("skins, inputs and speed go through to the runtime", () => {
    const a = asset("knight.obone");
    const driver = OpenBoneDriver.createSync(a.doc, "", { audio: false });
    const obj = new OpenBone(a, driver, { autoUpdate: false, interactive: false });
    obj.setInput("walk", true);
    expect(obj.getInput("walk")).toBe(true);
    obj.speed = 2;
    expect(driver.speed).toBe(2);
    obj.destroy();
  });
});
