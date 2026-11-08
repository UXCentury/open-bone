import { OpenBoneDriver } from "@openbone/engine-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GEOMETRY_CASES, type RefDraw, example, flatten, installFakeOffscreenCanvas, packed, webglReference } from "../../engine-kit/test/reference.ts";

vi.mock("phaser", () => import("./phaser-stub.ts"));
const { OpenBoneGameObject, textureKey } = await import("../src/index.ts");
type Entry = import("../src/index.ts").OpenBoneCacheEntry;

let restore = () => {};
beforeAll(() => void (restore = installFakeOffscreenCanvas()));
afterAll(() => restore());

/** A scene whose texture manager has every texture of the entry (and canvases added at render time). */
function fakeScene(entry: Entry) {
  const keys = new Set(entry.textureKeys.values());
  const tex = (key: string) => ({ source: [{ glTexture: { key } }], getSourceImage: () => ({}) });
  const textures = { exists: (k: string) => keys.has(k), get: tex, addCanvas: (k: string) => keys.add(k), remove: (k: string) => keys.delete(k) };
  const handlers = new Map<string, (p: unknown) => void>();
  return {
    sys: { textures, updateList: { add() {}, remove() {} } },
    textures,
    sound: {},
    input: { on: (n: string, f: (p: unknown) => void) => handlers.set(n, f), off: (n: string) => handlers.delete(n) },
    cameras: { main: { getWorldPoint: (x: number, y: number) => ({ x, y }) } },
    handlers,
  };
}

/** A WebGL renderer + MultiPipeline that record every vertex batched (decoding Phaser's packed tint). */
function fakeRenderer() {
  const verts: { stencil: boolean; v: number[]; tex: unknown }[] = [];
  let colorWrite = true;
  let bound: unknown = null;
  const blends: number[] = [];
  const gl = new Proxy({ ONE: 1, FUNC_ADD: 2 } as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === "colorMask" ? (r: boolean) => void (colorWrite = r) : () => {}),
  });
  const pipeline = {
    flush() {},
    setTexture2D: (t: unknown) => ((bound = t), 0),
    shouldFlush: () => false,
    batchVert(x: number, y: number, u: number, v: number, _unit: number, _fx: number, tint: number) {
      const a = (tint >>> 24) / 255;
      verts.push({ stencil: !colorWrite, tex: bound, v: [x, -y, u, v, ((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255, a] });
    },
  };
  const renderer = {
    gl,
    whiteTexture: { key: "white" },
    pipelines: { set: () => pipeline, preBatch() {}, postBatch() {} },
    addBlendMode: () => 4,
    setBlendMode: (m: number) => void blends.push(m),
  };
  return { renderer, verts, blends };
}
const camera = { alpha: 1, roundPixels: false, addToRenderList() {} };

function make(file: string, atlas?: boolean, setup?: (i: OpenBoneDriver["instance"]) => void) {
  const doc = atlas ? packed(example(file)) : example(file);
  const textureKeys = new Map([...(doc.atlas?.pages ?? []), ...doc.images].map((t) => [t.id, textureKey("k", t.id)] as const));
  const entry: Entry = { doc, baseUrl: "", textureKeys };
  const scene = fakeScene(entry);
  const obj = new OpenBoneGameObject(scene as never, 0, 0, entry, { audio: false });
  setup?.(obj.instance);
  for (let i = 0; i < 12; i++) obj.preUpdate(0, 50);
  return { obj, scene };
}

describe("Phaser geometry matches render-webgl", () => {
  for (const c of GEOMETRY_CASES)
    it(c.name, () => {
      const { obj } = make(c.file, c.atlas, c.setup);
      const { renderer, verts } = fakeRenderer();
      obj.renderWebGL(renderer as never, obj, camera as never);
      const ref = flatten(webglReference(obj.skeleton));
      const got: RefDraw[] = verts.map((x) => ({ stencil: x.stencil, verts: [x.v] }));
      const flat = flatten(got);
      expect(flat.length).toBe(ref.length);
      // Positions and uvs exactly; colours within Phaser's 8-bit tint.
      expect(flat.map((v) => v.slice(0, 5))).toEqual(ref.map((v) => v.slice(0, 5)));
      for (let i = 0; i < ref.length; i++)
        for (let k = 5; k < 9; k++) expect(Math.abs(flat[i][k] - Math.min(1, Math.max(0, ref[i][k])))).toBeLessThanOrEqual(1 / 255 + 1e-3);
      expect(obj.batches).toBe(webglReference(obj.skeleton).filter((d) => !d.stencil).length);
    });
});

describe("Phaser object", () => {
  it("binds each batch's texture and blend mode", () => {
    const { obj } = make("campfire.obone");
    const { renderer, verts, blends } = fakeRenderer();
    obj.renderWebGL(renderer as never, obj, camera as never);
    const batches = obj.currentBatches();
    expect(blends.slice(0, -1)).toEqual(batches.map((b) => (b.blend === "additive" ? 4 : 0)));
    expect(new Set(verts.filter((v) => !v.stencil).map((v) => (v.tex as { key: string }).key)).size).toBeGreaterThan(2);
  });

  it("maps scene pointer events into skeleton space", () => {
    const { obj, scene } = make("knight.obone");
    obj.setPosition(400, 530);
    const seen: [string, number, number][] = [];
    obj.stateMachine!.pointer = (t, x, y) => void seen.push([t, x, y]);
    scene.handlers.get("pointerdown")!({ x: 410, y: 500 });
    scene.handlers.get("pointermove")!({ x: 5000, y: 500 }); // outside the artboard: leave
    expect(seen).toEqual([
      ["down", 10, 30],
      ["move", -1e9, -1e9],
    ]);
  });
});
