import { OpenBoneDriver } from "@openbone/engine-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GEOMETRY_CASES, type GeometryCase, type RefDraw, caseDoc, flatten, installFakeOffscreenCanvas, webglReference } from "../../engine-kit/test/reference.ts";

vi.mock("phaser", () => import("./phaser-stub.ts"));
const { DARK_PIPELINE, OpenBoneGameObject, textureKey } = await import("../src/index.ts");
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

/** Phaser's packed 0xAARRGGBB colour as straight 0..1 r, g, b, a. */
const unpack = (c: number) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255];

/**
 * A WebGL renderer + MultiPipeline that record every vertex batched (decoding Phaser's packed tint), and the
 * two-colour pipeline's vertices as its flush would upload them.
 */
function fakeRenderer() {
  const verts: { stencil: boolean; v: number[]; tex: unknown; pipeline: string }[] = [];
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
      verts.push({ stencil: !colorWrite, tex: bound, pipeline: "multi", v: [x, -y, u, v, ...unpack(tint), 0, 0, 0] });
    },
  };
  const added = new Map<string, unknown>();
  const switches: string[] = [];
  let current: { flush(): void } | null = null;
  const pipelines = {
    // Like PipelineManager.set: switching flushes the pipeline being left.
    set: (p: unknown) => {
      const next = (typeof p === "string" ? pipeline : p) as { flush(): void };
      if (current && current !== next) current.flush();
      current = next;
      const name = next === pipeline ? "multi" : DARK_PIPELINE;
      if (switches.at(-1) !== name) switches.push(name);
      return next;
    },
    preBatch() {},
    postBatch() {},
    has: (k: string) => added.has(k),
    get: (k: string) => added.get(k),
    add(k: string, p: { setTexture2D: unknown; flush: () => void; vertexCount: number; vertexViewF32: Float32Array; vertexViewU32: Uint32Array; currentShader: { vertexComponentCount: number } }) {
      p.setTexture2D = (t: unknown) => ((bound = t), 0);
      const flush = p.flush.bind(p);
      // Decode the vertex buffer: x, y, u, v, unit, effect, tint, dark.
      p.flush = () => {
        const n = p.currentShader.vertexComponentCount;
        for (let i = 0; i < p.vertexCount; i++) {
          const f = p.vertexViewF32.subarray(i * n, i * n + n);
          const u = p.vertexViewU32.subarray(i * n, i * n + n);
          verts.push({ stencil: !colorWrite, tex: bound, pipeline: DARK_PIPELINE, v: [f[0], -f[1], f[2], f[3], ...unpack(u[6]), ...unpack(u[7]).slice(0, 3)] });
        }
        flush();
      };
      added.set(k, p);
      return p;
    },
  };
  const renderer = {
    gl,
    game: {},
    whiteTexture: { key: "white" },
    pipelines,
    addBlendMode: () => 4,
    setBlendMode: (m: number) => void blends.push(m),
  };
  return { renderer, verts, blends, switches };
}
const camera = { alpha: 1, roundPixels: false, addToRenderList() {} };

function make(c: Pick<GeometryCase, "file" | "doc" | "atlas" | "setup">) {
  const doc = caseDoc(c);
  const textureKeys = new Map([...(doc.atlas?.pages ?? []), ...doc.images].map((t) => [t.id, textureKey("k", t.id)] as const));
  const entry: Entry = { doc, baseUrl: "", textureKeys };
  const scene = fakeScene(entry);
  const obj = new OpenBoneGameObject(scene as never, 0, 0, entry, { audio: false });
  c.setup?.(obj.instance);
  for (let i = 0; i < 12; i++) obj.preUpdate(0, 50);
  return { obj, scene };
}

describe("Phaser geometry matches render-webgl", () => {
  for (const c of GEOMETRY_CASES)
    it(c.name, () => {
      const { obj } = make(c);
      const { renderer, verts } = fakeRenderer();
      obj.renderWebGL(renderer as never, obj, camera as never);
      const ref = flatten(webglReference(obj.skeleton));
      const got: RefDraw[] = verts.map((x) => ({ stencil: x.stencil, verts: [x.v] }));
      const flat = flatten(got);
      expect(flat.length).toBe(ref.length);
      // Positions and uvs exactly; light and dark colours within Phaser's 8-bit tint.
      expect(flat.map((v) => v.slice(0, 5))).toEqual(ref.map((v) => v.slice(0, 5)));
      for (let i = 0; i < ref.length; i++)
        for (let k = 5; k < 12; k++) expect(Math.abs(flat[i][k] - Math.min(1, Math.max(0, ref[i][k])))).toBeLessThanOrEqual(1 / 255 + 1e-3);
      expect(obj.batches).toBe(webglReference(obj.skeleton).filter((d) => !d.stencil).length);
    });
});

describe("Phaser object", () => {
  it("binds each batch's texture and blend mode", () => {
    const { obj } = make({ file: "campfire.obone" });
    const { renderer, verts, blends } = fakeRenderer();
    obj.renderWebGL(renderer as never, obj, camera as never);
    const batches = obj.currentBatches();
    expect(blends.slice(0, -1)).toEqual(batches.map((b) => (b.blend === "additive" ? 4 : 0)));
    expect(new Set(verts.filter((v) => !v.stencil).map((v) => (v.tex as { key: string }).key)).size).toBeGreaterThan(2);
  });

  it("draws dark batches through the two-colour pipeline only", () => {
    const plain = fakeRenderer();
    const { obj: knight } = make({ file: "knight.obone" });
    knight.renderWebGL(plain.renderer as never, knight, camera as never);
    expect(plain.switches).toEqual(["multi"]);
    const dark = fakeRenderer();
    const { obj } = make({ file: "", doc: GEOMETRY_CASES.at(-1)!.doc });
    obj.renderWebGL(dark.renderer as never, obj, camera as never);
    expect(dark.switches).toEqual(["multi", DARK_PIPELINE, "multi"]);
    expect(dark.verts.every((v) => v.pipeline === DARK_PIPELINE)).toBe(true);
    // Fixture: the first slot's dark colour is red.
    expect(dark.verts[0].v.slice(8)).toEqual([1, 0, 0]);
  });

  it("maps scene pointer events into skeleton space", () => {
    const { obj, scene } = make({ file: "knight.obone" });
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
