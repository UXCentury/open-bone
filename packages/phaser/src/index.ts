import { type OpenBoneDocument, parseDocument } from "@openbone/core";
import {
  type Batch,
  type DriverOptions,
  type InputValue,
  OpenBoneDriver,
  TextRasterizer,
  buildBatches,
  folderOf,
  particleDotCanvas,
  textureRequests,
} from "@openbone/engine-kit";
import { CanvasRenderer } from "@openbone/render-canvas";
import { type ClipRegion, PARTICLE_DOT_TEXTURE, type ScriptHost } from "@openbone/runtime";
import * as Phaser from "phaser";

export type { DriverOptions, InputValue } from "@openbone/engine-kit";

/** What `this.load.openbone(key, url)` leaves in the cache. */
export interface OpenBoneCacheEntry {
  doc: OpenBoneDocument;
  baseUrl: string;
  /** Phaser texture key per image / atlas page id. */
  textureKeys: Map<string, string>;
  /** Shared script sandbox, created while loading when the document has scripts. */
  scriptHost?: ScriptHost;
}

export interface OpenBoneFileConfig {
  /** Base URL for relative image and audio paths (default: the document's folder). */
  baseUrl?: string;
  /** Map an image path from the document to the URL to load. */
  resolveImageUrl?: (src: string) => string;
  /** Load the QuickJS sandbox for documents with scripts (default true). */
  scripts?: boolean;
  xhrSettings?: Phaser.Types.Loader.XHRSettingsObject;
}

/** Cache name used for loaded documents (`this.cache.custom.openbone`). */
export const CACHE_KEY = "openbone";

/** Texture key Phaser stores an image or atlas page under. */
export const textureKey = (fileKey: string, id: string) => `openbone:${fileKey}:${id}`;

/** Loader file type: fetches a .obone / .obonb document, then queues its images (or atlas pages) as Phaser textures. */
export class OpenBoneFile extends Phaser.Loader.File {
  private opts: OpenBoneFileConfig;

  constructor(loader: Phaser.Loader.LoaderPlugin, key: string, url: string, opts: OpenBoneFileConfig = {}) {
    super(loader, {
      type: "openbone",
      cache: loader.cacheManager.custom[CACHE_KEY] ?? loader.cacheManager.addCustom(CACHE_KEY),
      extension: "obone",
      responseType: "arraybuffer",
      key,
      url,
      xhrSettings: opts.xhrSettings,
    } as Phaser.Types.Loader.FileConfig);
    this.opts = opts;
  }

  override onProcess() {
    this.state = Phaser.Loader.FILE_PROCESSING;
    void this.process();
  }

  private async process() {
    try {
      const doc = parseDocument(new Uint8Array(this.xhrLoader!.response as ArrayBuffer));
      const baseUrl = this.opts.baseUrl ?? folderOf(this.src);
      const textureKeys = new Map<string, string>();
      const textures = this.loader.textureManager;
      for (const req of textureRequests(doc, baseUrl, this.opts.resolveImageUrl)) {
        const key = textureKey(this.key, req.id);
        textureKeys.set(req.id, key);
        // Queued while the loader runs: it finishes only after these images too.
        if (!textures.exists(key)) this.loader.image(key, req.url);
      }
      let scriptHost: ScriptHost | undefined;
      if (this.opts.scripts !== false && doc.scripts.length) {
        const { createQuickJsHost } = await import("@openbone/scripting");
        scriptHost = await createQuickJsHost();
      }
      this.data = { doc, baseUrl, textureKeys, scriptHost } satisfies OpenBoneCacheEntry;
      this.onProcessComplete();
    } catch (e) {
      console.error(`OpenBone: could not read ${this.src}`, e);
      this.onProcessError();
    }
  }
}

export interface OpenBoneObjectOptions extends DriverOptions {
  /** Route the scene's pointer events to the state machine's listeners (default true). */
  interactive?: boolean;
}

/** Phaser blend mode index for each OpenBone blend mode (additive is registered as ONE, ONE like render-webgl). */
function blendModes(renderer: Phaser.Renderer.WebGL.WebGLRenderer): Record<string, number> {
  const r = renderer as Phaser.Renderer.WebGL.WebGLRenderer & { __openboneAdd?: number };
  if (r.__openboneAdd === undefined) r.__openboneAdd = r.addBlendMode([r.gl.ONE, r.gl.ONE], r.gl.FUNC_ADD);
  return { normal: Phaser.BlendModes.NORMAL, additive: r.__openboneAdd, multiply: Phaser.BlendModes.MULTIPLY, screen: Phaser.BlendModes.SCREEN };
}

/** Phaser's component mixins (runtime objects; the typings only describe them as interfaces). */
const Components = Phaser.GameObjects.Components as unknown as Record<string, Record<string, unknown>>;

/**
 * Copy Phaser components onto a class prototype, like Phaser.Class.mixin (which the ESM build does not export):
 * `{ get, set }` objects become accessors, everything else is copied.
 */
function mixin(ctor: { prototype: object }, mixins: Record<string, unknown>[]) {
  for (const m of mixins)
    for (const k of Object.keys(m)) {
      const v = m[k] as { get?: unknown; set?: unknown } | undefined;
      if (v && typeof v === "object" && (typeof v.get === "function" || typeof v.set === "function"))
        Object.defineProperty(ctor.prototype, k, { enumerable: true, configurable: true, ...(v as PropertyDescriptor) });
      else (ctor.prototype as Record<string, unknown>)[k] = v;
    }
}

/**
 * An OpenBone document as a Phaser 3 GameObject. The skeleton origin sits at the object's x/y; skeleton units are
 * pixels at scale 1 (y down, like Phaser). WebGL: geometry goes through Phaser's MultiPipeline in render-webgl's
 * batches (clipping masks use the stencil buffer). Canvas: drawn by @openbone/render-canvas.
 */
export class OpenBoneGameObject extends Phaser.GameObjects.GameObject {
  readonly driver: OpenBoneDriver;
  readonly entry: OpenBoneCacheEntry;
  private text = new TextRasterizer();
  private textTextures = new Map<string, { key: string; version: number }>();
  private canvasRenderer: CanvasRenderer | null = null;
  private static uid = 0;
  private readonly uid = ++OpenBoneGameObject.uid;
  private unbindPointer: (() => void) | null = null;
  /** True while paused: time stands still (the pose is still drawn). */
  paused = false;
  /** Batches drawn in the last WebGL frame. */
  batches = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, entry: OpenBoneCacheEntry, opts: OpenBoneObjectOptions = {}) {
    super(scene, "OpenBone");
    this.entry = entry;
    const sound = scene.sound as Partial<Phaser.Sound.WebAudioSoundManager>;
    this.driver = OpenBoneDriver.createSync(entry.doc, entry.baseUrl, {
      audioContext: sound.context,
      ...opts,
      scripts: opts.scripts ?? entry.scriptHost ?? "none",
    });
    this.setPosition(x, y);
    this.initPipeline();
    const d = entry.doc;
    this.setSize(d.width, d.height);
    if (opts.interactive !== false && d.stateMachines.length) this.bindPointer();
  }

  // ---- runtime API ----
  get instance() {
    return this.driver.instance;
  }
  get skeleton() {
    return this.driver.skeleton;
  }
  get stateMachine() {
    return this.driver.stateMachine;
  }
  get speed() {
    return this.driver.speed;
  }
  set speed(v: number) {
    this.driver.speed = v;
  }
  setInput(name: string, value: InputValue) {
    this.driver.setInput(name, value);
    return this;
  }
  getInput(name: string) {
    return this.driver.getInput(name);
  }
  fire(name: string) {
    this.driver.fire(name);
    return this;
  }
  setText(slot: string, text: string | null) {
    this.driver.setText(slot, text);
    return this;
  }
  setSkin(name: string | null) {
    this.driver.setSkin(name);
    return this;
  }
  play(animation: string, loop = true) {
    this.driver.play(animation, loop);
    return this;
  }
  useStateMachine(name?: string) {
    return this.driver.useStateMachine(name);
  }
  /** Listen to "event", "stateChange" or "audio" from the runtime; returns an unsubscribe function. */
  onOpenBone: OpenBoneDriver["on"] = (name, fn) => this.driver.on(name, fn);
  pause() {
    this.paused = true;
    this.driver.pause();
    return this;
  }
  resume() {
    this.paused = false;
    this.driver.resume();
    return this;
  }

  /** The artboard rectangle in the object's local space (y down). */
  get artboard() {
    const d = this.entry.doc;
    return { x: -d.originX, y: -d.originY, width: d.width, height: d.height };
  }

  // ---- Phaser lifecycle ----
  override addedToScene() {
    this.scene.sys.updateList.add(this);
  }
  override removedFromScene() {
    this.scene.sys.updateList.remove(this);
  }
  preUpdate(_time: number, delta: number) {
    if (!this.paused) this.driver.advance(delta / 1000);
  }

  override destroy(fromScene?: boolean) {
    this.unbindPointer?.();
    this.driver.dispose();
    for (const t of this.textTextures.values()) this.scene?.textures.remove(t.key);
    super.destroy(fromScene);
  }

  /** Scene pointer → skeleton space; only points over the artboard reach the state machine. */
  private bindPointer() {
    const input = this.scene.input;
    const send = (type: "down" | "up" | "move") => (pointer: Phaser.Input.Pointer) => {
      if (!this.active || !this.visible) return;
      const cam = pointer.camera ?? this.scene.cameras.main;
      const world = cam.getWorldPoint(pointer.x, pointer.y);
      const p = this.getWorldTransformMatrix().applyInverse(world.x, world.y);
      const a = this.artboard;
      const inside = p.x >= a.x && p.y >= a.y && p.x <= a.x + a.width && p.y <= a.y + a.height;
      if (!inside) return type === "move" ? this.driver.pointerLeave() : undefined;
      this.driver.pointer(type, p.x, -p.y);
    };
    const down = send("down");
    const up = send("up");
    const move = send("move");
    input.on("pointerdown", down);
    input.on("pointerup", up);
    input.on("pointermove", move);
    this.unbindPointer = () => {
      input.off("pointerdown", down);
      input.off("pointerup", up);
      input.off("pointermove", move);
    };
  }

  // ---- WebGL ----
  private glTexture(b: Batch, renderer: Phaser.Renderer.WebGL.WebGLRenderer, pixelsPerUnit: number) {
    const textures = this.scene.sys.textures;
    if (b.text) {
      const r = this.text.get(b.text.id, b.text.draw, pixelsPerUnit);
      if (!r) return renderer.whiteTexture;
      let e = this.textTextures.get(b.text.id);
      if (!e || e.version !== r.version) {
        const key = `openbone:text:${this.uid}:${b.text.id}`;
        if (textures.exists(key)) textures.remove(key);
        textures.addCanvas(key, r.canvas as HTMLCanvasElement);
        e = { key, version: r.version };
        this.textTextures.set(b.text.id, e);
      }
      return textures.get(e.key).source[0].glTexture ?? renderer.whiteTexture;
    }
    if (!b.texture) return renderer.whiteTexture;
    if (b.texture === PARTICLE_DOT_TEXTURE) {
      const key = "openbone:particle-dot";
      if (!textures.exists(key)) {
        const c = particleDotCanvas();
        if (!c) return renderer.whiteTexture;
        textures.addCanvas(key, c as HTMLCanvasElement);
      }
      return textures.get(key).source[0].glTexture ?? renderer.whiteTexture;
    }
    const key = this.entry.textureKeys.get(b.texture);
    return (key && textures.exists(key) && textures.get(key).source[0].glTexture) || renderer.whiteTexture;
  }

  /** The batches for the current pose (exactly render-webgl's). */
  currentBatches(): Batch[] {
    const textures = this.scene.sys.textures;
    return buildBatches(this.driver.instance.drawList(), {
      hasTexture: (id) => {
        if (id === PARTICLE_DOT_TEXTURE) return true;
        const key = this.entry.textureKeys.get(id);
        return !!key && textures.exists(key);
      },
    });
  }

  renderWebGL(renderer: Phaser.Renderer.WebGL.WebGLRenderer, src: OpenBoneGameObject, camera: Phaser.Cameras.Scene2D.Camera, parentMatrix?: Phaser.GameObjects.Components.TransformMatrix) {
    camera.addToRenderList(src);
    const pipeline = renderer.pipelines.set(src.pipeline, src) as Phaser.Renderer.WebGL.Pipelines.MultiPipeline;
    const calc = Phaser.GameObjects.GetCalcMatrix(src, camera, parentMatrix).calc;
    const gl = renderer.gl;
    const modes = blendModes(renderer);
    const alpha = camera.alpha * src.alpha;
    const round = camera.roundPixels;
    const ppu = Math.sqrt(Math.abs(calc.a * calc.d - calc.b * calc.c));
    const batches = src.currentBatches();
    for (const id of src.text.nextFrame()) {
      const t = src.textTextures.get(id);
      if (t && src.scene.sys.textures.exists(t.key)) src.scene.sys.textures.remove(t.key);
      src.textTextures.delete(id);
    }
    pipeline.flush();
    renderer.pipelines.preBatch(src);
    let clip: ClipRegion | undefined;
    const vert = (x: number, y: number, u: number, v: number, unit: number, r: number, g: number, b: number, a: number) => {
      // Skeleton (y up) -> local (y down) -> camera.
      let tx = x * calc.a - y * calc.c + calc.e;
      let ty = x * calc.b - y * calc.d + calc.f;
      if (round) {
        tx = Math.round(tx);
        ty = Math.round(ty);
      }
      const rgb = (Math.round(clamp01(r) * 255) << 16) | (Math.round(clamp01(g) * 255) << 8) | Math.round(clamp01(b) * 255);
      pipeline.batchVert(tx, ty, u, v, unit, 0, Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha(rgb, clamp01(a * alpha)));
    };
    for (const b of batches) {
      if (b.clip !== clip) {
        pipeline.flush();
        clip = b.clip;
        if (clip) {
          gl.enable(gl.STENCIL_TEST);
          gl.clearStencil(0);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.stencilMask(0xff);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.colorMask(false, false, false, false);
          const unit = pipeline.setTexture2D(renderer.whiteTexture);
          const p = clip.polygon;
          for (const i of clip.indices) vert(p[i * 2], p[i * 2 + 1], 1, 1, unit, 1, 1, 1, 1);
          pipeline.flush();
          gl.colorMask(true, true, true, true);
          gl.stencilFunc(gl.EQUAL, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        } else gl.disable(gl.STENCIL_TEST);
      }
      renderer.setBlendMode(modes[b.blend] ?? Phaser.BlendModes.NORMAL);
      const tex = src.glTexture(b, renderer, ppu);
      let unit = pipeline.setTexture2D(tex);
      const { vertices: p, uvs, colors: c, indices } = b;
      for (let k = 0; k < indices.length; k += 3) {
        if (pipeline.shouldFlush(3)) {
          pipeline.flush();
          unit = pipeline.setTexture2D(tex);
        }
        for (let j = 0; j < 3; j++) {
          const i = indices[k + j];
          vert(p[i * 2], p[i * 2 + 1], uvs[i * 2], uvs[i * 2 + 1], unit, c[i * 4], c[i * 4 + 1], c[i * 4 + 2], c[i * 4 + 3]);
        }
      }
    }
    pipeline.flush();
    if (clip) gl.disable(gl.STENCIL_TEST);
    renderer.setBlendMode(Phaser.BlendModes.NORMAL);
    src.batches = batches.length;
    renderer.pipelines.postBatch(src);
  }

  // ---- Canvas ----
  renderCanvas(renderer: Phaser.Renderer.Canvas.CanvasRenderer, src: OpenBoneGameObject, camera: Phaser.Cameras.Scene2D.Camera, parentMatrix?: Phaser.GameObjects.Components.TransformMatrix) {
    camera.addToRenderList(src);
    const ctx = renderer.currentContext;
    ctx.save();
    if (!Phaser.Renderer.Canvas.SetTransform(renderer, ctx, src, camera, parentMatrix)) {
      ctx.restore();
      return;
    }
    // render-canvas sets absolute transforms; compose them with the object's so it draws in local space.
    const base = ctx.getTransform();
    const local = new Proxy(ctx, {
      get(t, k) {
        if (k === "setTransform")
          return (a: number, b: number, c: number, d: number, e: number, f: number) => t.setTransform(base.multiply(new DOMMatrix([a, b, c, d, e, f])));
        if (k === "resetTransform") return () => t.setTransform(base);
        const v = Reflect.get(t, k, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
      set: (t, k, v) => Reflect.set(t, k, v, t),
    });
    const textures = src.scene.sys.textures;
    src.canvasRenderer ??= new CanvasRenderer(local, (id) => {
      const key = src.entry.textureKeys.get(id);
      return key && textures.exists(key) ? (textures.get(key).getSourceImage() as CanvasImageSource) : null;
    });
    src.canvasRenderer.ctx = local;
    const d = src.entry.doc;
    src.canvasRenderer.render(src.driver.skeleton, { view: { x: -d.originX, y: -d.originY, zoom: 1 }, clear: false });
    ctx.restore();
  }
}

export interface OpenBoneGameObject
  extends Phaser.GameObjects.Components.Alpha,
    Phaser.GameObjects.Components.BlendMode,
    Phaser.GameObjects.Components.ComputedSize,
    Phaser.GameObjects.Components.Depth,
    Phaser.GameObjects.Components.Pipeline,
    Phaser.GameObjects.Components.ScrollFactor,
    Phaser.GameObjects.Components.Transform,
    Phaser.GameObjects.Components.Visible {}

mixin(OpenBoneGameObject, [
  Components.Alpha,
  // The object's own blend mode is what Phaser sets before rendering it; slots then set theirs per batch.
  Components.BlendMode,
  Components.ComputedSize,
  Components.Depth,
  Components.Pipeline,
  Components.ScrollFactor,
  Components.Transform,
  Components.Visible,
]);

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Scene plugin. Registers `this.load.openbone(key, url, config?)` and `this.add.openbone(x, y, key, options?)`.
 *
 * ```ts
 * new Phaser.Game({ plugins: { scene: [{ key: "OpenBonePlugin", plugin: OpenBonePlugin, mapping: "openbone" }] } });
 * ```
 */
export class OpenBonePlugin extends Phaser.Plugins.ScenePlugin {
  constructor(scene: Phaser.Scene, pluginManager: Phaser.Plugins.PluginManager, pluginKey: string) {
    super(scene, pluginManager, pluginKey);
    pluginManager.registerFileType(
      "openbone",
      function (this: Phaser.Loader.LoaderPlugin, key: string, url: string, config?: OpenBoneFileConfig) {
        this.addFile(new OpenBoneFile(this, key, url, config));
        return this;
      },
      scene,
    );
    pluginManager.registerGameObject("openbone", function (this: Phaser.GameObjects.GameObjectFactory, x: number, y: number, key: string, opts?: OpenBoneObjectOptions) {
      const entry = this.scene.cache.custom[CACHE_KEY]?.get(key) as OpenBoneCacheEntry | undefined;
      if (!entry) throw new Error(`OpenBone: "${key}" is not loaded (this.load.openbone("${key}", url) in preload)`);
      return this.displayList.add(new OpenBoneGameObject(this.scene, x, y, entry, opts));
    });
  }

  /** The cached document for a key loaded with `this.load.openbone`. */
  get(key: string): OpenBoneCacheEntry | undefined {
    return this.game.cache.custom[CACHE_KEY]?.get(key);
  }
}

declare global {
  namespace Phaser.Loader {
    interface LoaderPlugin {
      /** Load an OpenBone document (.obone / .obonb) and its images. Needs OpenBonePlugin. */
      openbone(key: string, url: string, config?: OpenBoneFileConfig): this;
    }
  }
  namespace Phaser.GameObjects {
    interface GameObjectFactory {
      /** Add an OpenBone object (loaded with `this.load.openbone`). Needs OpenBonePlugin. */
      openbone(x: number, y: number, key: string, options?: OpenBoneObjectOptions): OpenBoneGameObject;
    }
  }
}
