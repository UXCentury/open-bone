/** The few parts of Phaser 3 the OpenBone plugin touches, enough to run it in Node (vi.mock("phaser")). */
class File {
  state = 0;
  data: unknown;
  key: string;
  src: string;
  constructor(
    public loader: unknown,
    cfg: { key: string; url: string },
  ) {
    this.key = cfg.key;
    this.src = cfg.url;
  }
  onProcessComplete() {}
  onProcessError() {}
}

class GameObject {
  active = true;
  constructor(
    public scene: unknown,
    public type: string,
  ) {}
  destroy() {}
}

// Components as plain objects with the fields the plugin reads.
const Components = {
  Alpha: { alpha: 1 },
  BlendMode: { blendMode: 0 },
  ComputedSize: { setSize(this: Record<string, number>, w: number, h: number) { this.width = w; this.height = h; return this; } },
  Depth: { depth: 0 },
  Pipeline: { initPipeline(this: Record<string, unknown>) { this.pipeline = "MultiPipeline"; } },
  ScrollFactor: { scrollFactorX: 1, scrollFactorY: 1 },
  Transform: {
    x: 0,
    y: 0,
    setPosition(this: Record<string, number>, x: number, y: number) { this.x = x; this.y = y; return this; },
    getWorldTransformMatrix(this: Record<string, number>) {
      // Translation only (enough for pointer tests).
      return { applyInverse: (x: number, y: number) => ({ x: x - this.x, y: y - this.y }) };
    },
  },
  Visible: { visible: true },
};

export const Loader = { File, FILE_PROCESSING: 3 };
export const GameObjects = { GameObject, Components, GetCalcMatrix: () => ({ calc: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }) };
export const BlendModes = { NORMAL: 0, ADD: 1, MULTIPLY: 2, SCREEN: 3 };
export const Renderer = {
  WebGL: { Utils: { getTintAppendFloatAlpha: (rgb: number, a: number) => ((((a * 255) | 0) & 0xff) << 24 | rgb) >>> 0 } },
  Canvas: { SetTransform: () => true },
};
export const Plugins = { ScenePlugin: class {} };
