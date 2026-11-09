import type { OpenBoneDocument } from "@openbone/core";
import {
  type Batch,
  type DriverOptions,
  type FetchOptions,
  type InputValue,
  OpenBoneDriver,
  type OpenBoneSource,
  TextRasterizer,
  buildBatches,
  loadDocument,
  loadTextures,
  particleDotCanvas,
} from "@openbone/engine-kit";
import { PARTICLE_DOT_TEXTURE, type ClipRegion } from "@openbone/runtime";
import {
  CanvasSource,
  Container,
  type FederatedPointerEvent,
  Geometry,
  GlProgram,
  Graphics,
  ImageSource,
  Mesh,
  Shader,
  Texture,
  Ticker,
} from "pixi.js";

export type { DriverOptions, InputValue, OpenBoneSource } from "@openbone/engine-kit";

/** A loaded document and its textures, shareable by many OpenBone objects. */
export interface OpenBoneAsset {
  doc: OpenBoneDocument;
  baseUrl: string;
  /** Pixi textures by image / atlas page id. */
  textures: Map<string, Texture>;
}

export interface LoadOptions extends FetchOptions {
  /** Map an image path from the document to the URL to load (overrides baseUrl). */
  resolveImageUrl?: (src: string) => string;
}

/** Load a .obone / .obonb document and its images (atlas pages when packed) as Pixi textures. */
export async function loadOpenBone(src: OpenBoneSource, opts: LoadOptions = {}): Promise<OpenBoneAsset> {
  const { doc, baseUrl } = await loadDocument(src, opts);
  const images = await loadTextures(doc, baseUrl, { resolveImageUrl: opts.resolveImageUrl });
  const textures = new Map<string, Texture>();
  for (const [id, img] of images) textures.set(id, new Texture({ source: new ImageSource({ resource: img }) }));
  return { doc, baseUrl, textures };
}

export interface OpenBoneOptions extends DriverOptions {
  /** Advance with Pixi's shared ticker (default true). Set false and call `update(dt)` yourself. */
  autoUpdate?: boolean;
  /** Ticker to use when autoUpdate is on (default Ticker.shared). */
  ticker?: Ticker;
  /** Route Pixi pointer events to the state machine's listeners (default true). */
  interactive?: boolean;
  /** Screen pixels per CSS pixel used to rasterise text (default devicePixelRatio). */
  resolution?: number;
}

const VERTEX = `
in vec2 aPosition;
in vec2 aUV;
in vec4 aColor;
out vec2 vUV;
out vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  // Straight vertex colour -> premultiplied, times the container's (premultiplied) tint and alpha.
  vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor * uWorldColorAlpha;
}`;

const FRAGMENT = `
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTexture;
out vec4 finalColor;
void main() {
  finalColor = texture(uTexture, vUV) * vColor;
}`;

// Two-colour tint (batches with a dark colour): rgb = dark + (light - dark) × texture rgb, on premultiplied texels.
// The container's tint colours the dark colour too; its alpha fades both.
const DARK_VERTEX = `
in vec2 aPosition;
in vec2 aUV;
in vec4 aColor;
in vec3 aDark;
out vec2 vUV;
out vec4 vColor;
out vec3 vDark;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vec4 tint = uColor * uWorldColorAlpha;
  vColor = vec4(aColor.rgb * aColor.a, aColor.a) * tint;
  vDark = aDark * (tint.a > 0.0 ? tint.rgb / tint.a : vec3(1.0));
}`;

const DARK_FRAGMENT = `
in vec2 vUV;
in vec4 vColor;
in vec3 vDark;
uniform sampler2D uTexture;
out vec4 finalColor;
void main() {
  vec4 t = texture(uTexture, vUV);
  finalColor = vec4(vDark * (t.a - t.rgb) * vColor.a + t.rgb * vColor.rgb, t.a * vColor.a);
}`;

/** render-webgl blend modes as Pixi's (premultiplied) blend modes: identical GL blend functions. */
export const PIXI_BLEND = { normal: "normal", additive: "add", multiply: "multiply", screen: "screen" } as const;

let program: GlProgram | null = null;
const glProgram = () => (program ??= GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: "openbone-mesh" }));
let darkProgram: GlProgram | null = null;
const glDarkProgram = () => (darkProgram ??= GlProgram.from({ vertex: DARK_VERTEX, fragment: DARK_FRAGMENT, name: "openbone-mesh-dark" }));

/**
 * One batch drawn as a Pixi Mesh with OpenBone's vertex-coloured shader. Batches with a dark colour switch to the
 * two-colour shader and fill the `aDark` attribute; the others never upload it.
 */
export class BatchMesh extends Mesh<Geometry, Shader> {
  private plainShader: Shader;
  private darkShader: Shader | null = null;
  /** True while this mesh draws a two-colour (dark) tint batch. */
  twoColor = false;

  constructor() {
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: new Float32Array(8), format: "float32x2" },
        aUV: { buffer: new Float32Array(8), format: "float32x2" },
        aColor: { buffer: new Float32Array(16), format: "float32x4" },
        aDark: { buffer: new Float32Array(12), format: "float32x3" },
      },
      indexBuffer: new Uint16Array(6),
    });
    const shader = new Shader({ glProgram: glProgram(), resources: { uTexture: Texture.WHITE.source } });
    super({ geometry, shader, texture: Texture.WHITE });
    this.plainShader = shader;
  }

  set(b: Batch, texture: Texture) {
    const g = this.geometry;
    g.attributes.aPosition.buffer.data = b.vertices;
    g.attributes.aUV.buffer.data = b.uvs;
    g.attributes.aColor.buffer.data = b.colors;
    g.indexBuffer.data = b.indices;
    this.twoColor = !!b.dark;
    if (b.dark) {
      g.attributes.aDark.buffer.data = b.dark;
      this.darkShader ??= new Shader({ glProgram: glDarkProgram(), resources: { uTexture: texture.source } });
    }
    const shader = b.dark ? this.darkShader! : this.plainShader;
    if (this.shader !== shader) this.shader = shader;
    if (this.texture !== texture || shader.resources.uTexture !== texture.source) {
      this.texture = texture;
      shader.resources.uTexture = texture.source;
    }
    this.blendMode = PIXI_BLEND[b.blend] ?? "normal";
  }
}

/** A clipping mask's run of batches: drawn inside a Graphics stencil mask of the clip polygon. */
class ClipRun extends Container {
  readonly maskShape = new Graphics();
  set(clip: ClipRegion) {
    const g = this.maskShape;
    g.clear();
    g.poly(Array.from(clip.polygon), true).fill(0xffffff);
    this.mask = g;
  }
}

/**
 * An OpenBone document as a Pixi v8 display object. Skeleton origin is at the container's position, y down like
 * the rest of Pixi (skeleton units = pixels at scale 1). Draws one Mesh per batch (same batches as render-webgl:
 * one per atlas page / texture and blend mode), clipping masks as stencil masks, text through canvas textures.
 */
export class OpenBone extends Container {
  readonly driver: OpenBoneDriver;
  readonly asset: OpenBoneAsset;
  /** Holds the meshes in skeleton space (y up): scale.y = -1. */
  readonly view = new Container();
  private meshes: BatchMesh[] = [];
  private runs: ClipRun[] = [];
  private text = new TextRasterizer();
  private textTextures = new Map<string, { tex: Texture; version: number }>();
  private dot: Texture | null = null;
  private ticker: Ticker | null = null;
  private resolution: number;
  /** Draw calls (batches) in the last update. */
  drawCalls = 0;

  constructor(asset: OpenBoneAsset, driver: OpenBoneDriver, opts: OpenBoneOptions = {}) {
    super();
    this.asset = asset;
    this.driver = driver;
    this.resolution = opts.resolution ?? (typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    this.view.scale.y = -1;
    this.addChild(this.view);
    if (opts.interactive !== false && asset.doc.stateMachines.length) this.bindPointer();
    if (opts.autoUpdate !== false) {
      this.ticker = opts.ticker ?? Ticker.shared;
      this.ticker.add(this.tick, this);
    }
    this.redraw();
  }

  /** Load a document (URL, bytes or parsed) and create the display object; waits for images and the script sandbox. */
  static async from(src: OpenBoneSource | OpenBoneAsset, opts: OpenBoneOptions & LoadOptions = {}): Promise<OpenBone> {
    const asset = isAsset(src) ? src : await loadOpenBone(src, opts);
    const driver = await OpenBoneDriver.create(asset.doc, asset.baseUrl, opts);
    return new OpenBone(asset, driver, opts);
  }

  private tick(t: Ticker) {
    this.update(t.deltaMS / 1000);
  }

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
  /** True while paused (update() keeps drawing but time stands still). */
  paused = false;
  /** Pause the animation and its sounds. */
  pause() {
    this.paused = true;
    this.driver.pause();
  }
  /** Continue after pause(). */
  resume() {
    this.paused = false;
    this.driver.resume();
  }

  /** Advance by `dt` seconds and rebuild the meshes. */
  update(dt: number) {
    if (!this.paused) this.driver.advance(dt);
    this.redraw();
  }

  setInput(name: string, value: InputValue) {
    this.driver.setInput(name, value);
  }
  getInput(name: string) {
    return this.driver.getInput(name);
  }
  fire(name: string) {
    this.driver.fire(name);
  }
  setText(slot: string, text: string | null) {
    this.driver.setText(slot, text);
  }
  setSkin(name: string | null) {
    this.driver.setSkin(name);
    this.redraw();
  }
  play(animation: string, loop = true) {
    this.driver.play(animation, loop);
  }
  useStateMachine(name?: string) {
    return this.driver.useStateMachine(name);
  }
  /** Listen to "event", "stateChange" or "audio"; returns an unsubscribe function. */
  onOpenBone: OpenBoneDriver["on"] = (name, fn) => this.driver.on(name, fn);

  private textureFor(b: Batch): Texture {
    if (b.text) {
      const wt = this.view.worldTransform;
      const r = this.text.get(b.text.id, b.text.draw, Math.sqrt(Math.abs(wt.a * wt.d - wt.b * wt.c)) * this.resolution);
      if (!r) return Texture.EMPTY;
      let e = this.textTextures.get(b.text.id);
      if (!e || e.version !== r.version) {
        e?.tex.destroy(true);
        e = { tex: new Texture({ source: new CanvasSource({ resource: r.canvas as HTMLCanvasElement }) }), version: r.version };
        this.textTextures.set(b.text.id, e);
      }
      return e.tex;
    }
    if (!b.texture) return Texture.WHITE;
    if (b.texture === PARTICLE_DOT_TEXTURE) {
      if (!this.dot) {
        const c = particleDotCanvas();
        this.dot = c ? new Texture({ source: new CanvasSource({ resource: c as HTMLCanvasElement }) }) : Texture.WHITE;
      }
      return this.dot;
    }
    return this.asset.textures.get(b.texture) ?? Texture.WHITE;
  }

  /** Rebuild the meshes from the current pose (call after changing the pose by hand). */
  redraw() {
    const tex = this.asset.textures;
    const batches = buildBatches(this.driver.instance.drawList(), {
      hasTexture: (id) => id === PARTICLE_DOT_TEXTURE || tex.has(id),
    });
    for (const id of this.text.nextFrame()) {
      this.textTextures.get(id)?.tex.destroy(true);
      this.textTextures.delete(id);
    }
    this.view.removeChildren();
    for (const r of this.runs) r.removeChildren();
    let run: ClipRun | null = null;
    let clip: ClipRegion | undefined;
    let runCount = 0;
    batches.forEach((b, i) => {
      const mesh = (this.meshes[i] ??= new BatchMesh());
      mesh.set(b, this.textureFor(b));
      if (b.clip !== clip) {
        clip = b.clip;
        run = null;
        if (clip) {
          run = this.runs[runCount] ??= new ClipRun();
          runCount++;
          run.set(clip);
          this.view.addChild(run.maskShape, run);
        }
      }
      (run ?? this.view).addChild(mesh);
    });
    for (let i = batches.length; i < this.meshes.length; i++) this.meshes[i].destroy({ children: true });
    this.meshes.length = batches.length;
    for (let i = runCount; i < this.runs.length; i++) {
      this.runs[i].maskShape.destroy();
      this.runs[i].destroy();
    }
    this.runs.length = runCount;
    this.drawCalls = batches.length;
  }

  /** The artboard rectangle in this container's space (y down). */
  get artboard() {
    const d = this.asset.doc;
    return { x: -d.originX, y: -d.originY, width: d.width, height: d.height };
  }

  private bindPointer() {
    this.eventMode = "static";
    const a = this.artboard;
    this.hitArea = { contains: (x: number, y: number) => x >= a.x && y >= a.y && x <= a.x + a.width && y <= a.y + a.height };
    const send = (type: "down" | "up" | "move") => (e: FederatedPointerEvent) => {
      const p = e.getLocalPosition(this.view);
      const inside = this.hitArea!.contains(p.x, -p.y);
      if (type === "move" && !inside) return this.driver.pointerLeave();
      this.driver.pointer(type, p.x, p.y);
    };
    this.on("pointerdown", send("down"));
    this.on("pointerup", send("up"));
    this.on("pointerupoutside", send("up"));
    this.on("globalpointermove", send("move"));
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]) {
    this.ticker?.remove(this.tick, this);
    this.driver.dispose();
    for (const e of this.textTextures.values()) e.tex.destroy(true);
    this.dot?.destroy(true);
    for (const r of this.runs) r.maskShape.destroy();
    super.destroy(options ?? { children: true });
  }
}

function isAsset(x: unknown): x is OpenBoneAsset {
  return !!x && typeof x === "object" && "textures" in x && "doc" in x;
}
