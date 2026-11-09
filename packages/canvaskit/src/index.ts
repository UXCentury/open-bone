import { type OpenBoneDocument, premultipliedTextures } from "@openbone/core";
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
  particleDotPixels,
} from "@openbone/engine-kit";
import { type ClipRegion, type OpenBoneInstance, PARTICLE_DOT_SIZE, PARTICLE_DOT_TEXTURE, type Skeleton, type TextContext, type TextDraw, drawTextBox } from "@openbone/runtime";
import type { BlendMode, Canvas, CanvasKit, Font, Image, Paint, Shader, Surface, Typeface } from "canvaskit-wasm";

export type { DriverOptions, InputValue, OpenBoneSource } from "@openbone/engine-kit";

/** A loaded document and its images decoded as CanvasKit images (atlas pages when packed). */
export interface OpenBoneAsset {
  doc: OpenBoneDocument;
  baseUrl: string;
  images: Map<string, Image>;
}

export interface LoadOptions extends FetchOptions {
  resolveImageUrl?: (src: string) => string;
}

/** Load a .obone / .obonb document and decode its images with CanvasKit (works in browsers and Node). */
export async function loadOpenBone(ck: CanvasKit, src: OpenBoneSource, opts: LoadOptions = {}): Promise<OpenBoneAsset> {
  const { doc, baseUrl } = await loadDocument(src, opts);
  const fetchFn = opts.fetch ?? fetch;
  const pma = premultipliedTextures(doc);
  const images = await loadTextures<Image>(doc, baseUrl, {
    resolveImageUrl: opts.resolveImageUrl,
    load: async (url, req) => {
      try {
        const res = await fetchFn(url);
        if (!res.ok) return null;
        const img = ck.MakeImageFromEncoded(new Uint8Array(await res.arrayBuffer()));
        if (!img || !pma.has(req.id)) return img;
        // A premultiplied atlas page: Skia decodes PNGs as straight alpha, so take its bytes as they are in the
        // file and label them premultiplied (Skia's own format), which draws them with the matching blend.
        const info = { width: img.width(), height: img.height(), colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB };
        const px = img.readPixels(0, 0, { ...info, alphaType: ck.AlphaType.Unpremul });
        img.delete();
        return px ? ck.MakeImage({ ...info, alphaType: ck.AlphaType.Premul }, px as Uint8Array, info.width * 4) : null;
      } catch {
        return null;
      }
    },
  });
  return { doc, baseUrl, images };
}

export interface CanvasKitRendererOptions {
  /**
   * Fonts for text attachments, drawn natively by Skia: return a typeface for a CSS family and weight. Without it
   * (or when it returns null), text is rasterised with a 2D canvas like the other renderers, where one exists.
   */
  fonts?: (family: string, weight: number) => Typeface | null | undefined;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Draws OpenBone skeletons on a CanvasKit (Skia) canvas, in render-webgl's batches: one `drawVertices` per
 * texture / blend mode run (vertex colours modulate the image shader), clipping masks as clip paths.
 */
export class CanvasKitRenderer {
  private paint: Paint;
  private shaders = new Map<Image, Shader>();
  private dot: Image | null = null;
  private text = new TextRasterizer();
  private textImages = new Map<string, { img: Image; version: number }>();
  private fontCache = new Map<string, Font | null>();
  private blend: Record<Batch["blend"], BlendMode>;
  /** drawVertices calls in the last render. */
  drawCalls = 0;

  constructor(
    public ck: CanvasKit,
    public images: (id: string) => Image | null | undefined,
    private opts: CanvasKitRendererOptions = {},
  ) {
    this.paint = new ck.Paint();
    this.paint.setAntiAlias(true);
    this.blend = { normal: ck.BlendMode.SrcOver, additive: ck.BlendMode.Plus, multiply: ck.BlendMode.Multiply, screen: ck.BlendMode.Screen };
  }

  private image(id: string): Image | null {
    if (id === PARTICLE_DOT_TEXTURE) {
      const ck = this.ck;
      this.dot ??= ck.MakeImage(
        { width: PARTICLE_DOT_SIZE, height: PARTICLE_DOT_SIZE, alphaType: ck.AlphaType.Premul, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB },
        particleDotPixels(true),
        PARTICLE_DOT_SIZE * 4,
      );
      return this.dot;
    }
    return this.images(id) ?? null;
  }

  private shader(img: Image): Shader {
    let s = this.shaders.get(img);
    if (!s) {
      const ck = this.ck;
      s = img.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None);
      this.shaders.set(img, s);
    }
    return s;
  }

  /** Skeleton (y up) → canvas pixels for a view (artboard pan/zoom, like render-webgl's `view`). */
  static matrix(doc: OpenBoneDocument, view: View = { x: 0, y: 0, zoom: 1 }): number[] {
    const z = view.zoom;
    return [z, 0, view.x + doc.originX * z, 0, -z, view.y + doc.originY * z, 0, 0, 1];
  }

  /**
   * Draw a skeleton (or an instance's skeleton). `view` maps the artboard onto the canvas; the canvas's current
   * matrix applies on top, so you can also position it yourself with `view` left at its default.
   */
  render(canvas: Canvas, target: Skeleton | OpenBoneInstance, view: View = { x: 0, y: 0, zoom: 1 }) {
    const sk = "skeleton" in target ? target.skeleton : target;
    const ck = this.ck;
    canvas.save();
    canvas.concat(CanvasKitRenderer.matrix(sk.doc, view));
    // Device pixels per skeleton unit (view and the canvas's own matrix), for text rasters.
    const zoom = Math.sqrt(Math.abs(determinant(canvas.getTotalMatrix())));
    const batches = buildBatches(sk.drawList(), { hasTexture: (id) => !!this.image(id) });
    for (const id of this.text.nextFrame()) {
      this.textImages.get(id)?.img.delete();
      this.textImages.delete(id);
    }
    let clip: ClipRegion | undefined;
    this.drawCalls = 0;
    for (const b of batches) {
      if (b.clip !== clip) {
        if (clip) canvas.restore();
        clip = b.clip;
        if (clip) {
          canvas.save();
          const path = new ck.Path();
          path.addPoly(clip.polygon, true);
          canvas.clipPath(path, ck.ClipOp.Intersect, true);
          path.delete();
        }
      }
      this.paint.setBlendMode(this.blend[b.blend] ?? ck.BlendMode.SrcOver);
      if (b.text) {
        if (this.drawNativeText(canvas, b.text.draw, b.text.item.color)) continue;
        const r = this.text.get(b.text.id, b.text.draw, zoom);
        if (!r || typeof ck.MakeImageFromCanvasImageSource !== "function") continue;
        let e = this.textImages.get(b.text.id);
        if (!e || e.version !== r.version) {
          e?.img.delete();
          e = { img: ck.MakeImageFromCanvasImageSource(r.canvas as unknown as CanvasImageSource), version: r.version };
          this.textImages.set(b.text.id, e);
        }
        this.drawBatch(canvas, b, e.img);
        continue;
      }
      this.drawBatch(canvas, b, b.texture ? this.image(b.texture) : null);
    }
    if (clip) canvas.restore();
    canvas.restore();
  }

  private drawBatch(canvas: Canvas, b: Batch, img: Image | null) {
    const ck = this.ck;
    let texs: Float32Array | null = null;
    if (img) {
      const w = img.width();
      const h = img.height();
      texs = new Float32Array(b.uvs.length);
      for (let i = 0; i < texs.length; i += 2) {
        texs[i] = b.uvs[i] * w;
        texs[i + 1] = b.uvs[i + 1] * h;
      }
    }
    const verts = ck.MakeVertices(ck.VertexMode.Triangles, b.vertices, texs, b.colors, Array.from(b.indices), true);
    this.paint.setShader(img ? this.shader(img) : null);
    // Modulate: image × vertex colour (straight colours, Skia premultiplies them), like render-webgl's shader.
    canvas.drawVertices(verts, ck.BlendMode.Modulate, this.paint);
    verts.delete();
    this.drawCalls++;
  }

  private font(t: TextDraw): Font | null {
    if (!this.opts.fonts) return null;
    const key = `${t.font}|${t.weight}|${t.size}`;
    if (!this.fontCache.has(key)) {
      const tf = this.opts.fonts(t.font, t.weight);
      this.fontCache.set(key, tf ? new this.ck.Font(tf, t.size) : null);
    }
    return this.fontCache.get(key) ?? null;
  }

  /** Text with Skia's own font rendering (when `fonts` gives a typeface). */
  private drawNativeText(canvas: Canvas, t: TextDraw, tint: readonly number[]): boolean {
    const font = this.font(t);
    if (!font) return false;
    const ck = this.ck;
    const m = t.matrix;
    canvas.save();
    // Box frame (y up) → y down, as drawTextBox expects.
    canvas.concat([m.a, m.b, m.x, m.c, m.d, m.y, 0, 0, 1]);
    canvas.scale(1, -1);
    const paint = this.paint.copy();
    paint.setShader(null);
    const metrics = font.getMetrics();
    const ctx: TextContext = {
      font: "",
      textAlign: "center",
      textBaseline: "middle",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineJoin: "round",
      fillText: (s, x, y) => draw(s, x, y, false),
      strokeText: (s, x, y) => draw(s, x, y, true),
    };
    const draw = (s: string, x: number, y: number, stroke: boolean) => {
      const widths = font.getGlyphWidths(font.getGlyphIDs(s));
      const w = widths.reduce((a, b) => a + b, 0);
      const dx = ctx.textAlign === "center" ? -w / 2 : ctx.textAlign === "right" || ctx.textAlign === "end" ? -w : 0;
      paint.setColor(ck.parseColorString(String(stroke ? ctx.strokeStyle : ctx.fillStyle)));
      paint.setStyle(stroke ? ck.PaintStyle.Stroke : ck.PaintStyle.Fill);
      paint.setStrokeWidth(ctx.lineWidth);
      paint.setStrokeJoin(ck.StrokeJoin.Round);
      // "middle" baseline: centre the ascent..descent box on y.
      canvas.drawText(s, x + dx, y - (metrics.ascent + metrics.descent) / 2, paint, font);
    };
    drawTextBox(ctx, t, tint as [number, number, number, number]);
    paint.delete();
    canvas.restore();
    return true;
  }

  dispose() {
    for (const s of this.shaders.values()) s.delete();
    this.shaders.clear();
    for (const e of this.textImages.values()) e.img.delete();
    for (const f of this.fontCache.values()) f?.delete();
    this.dot?.delete();
    this.paint.delete();
  }
}

/** Determinant of the 2×2 part of a row-major 3×3 matrix. */
const determinant = (m: ArrayLike<number>) => m[0] * m[4] - m[1] * m[3];

export interface PlayerOptions extends DriverOptions, LoadOptions, CanvasKitRendererOptions {
  /** How the artboard fits the canvas (default "contain"). */
  fit?: "contain" | "cover" | "none";
  /** Background colour (CSS); default the document's, null for transparent. */
  background?: string | null;
  /** Start playing right away (default true). */
  autoplay?: boolean;
  /** "webgl" (default, falls back to software) or "software". */
  surface?: "webgl" | "software";
}

/** Plays a document on an HTML canvas with CanvasKit: render loop, fit, pointer input to the state machine. */
export class CanvasKitPlayer {
  readonly renderer: CanvasKitRenderer;
  private surface: Surface;
  private raf = 0;
  private last = 0;
  private view: View = { x: 0, y: 0, zoom: 1 };
  private unbind: () => void;
  playing = false;

  private constructor(
    readonly ck: CanvasKit,
    readonly canvas: HTMLCanvasElement,
    readonly asset: OpenBoneAsset,
    readonly driver: OpenBoneDriver,
    private opts: PlayerOptions,
  ) {
    this.renderer = new CanvasKitRenderer(ck, (id) => asset.images.get(id), opts);
    this.surface = this.makeSurface();
    this.unbind = this.bindPointer();
    if (opts.autoplay !== false) this.play();
    else this.draw();
  }

  static async create(ck: CanvasKit, canvas: HTMLCanvasElement, src: OpenBoneSource | OpenBoneAsset, opts: PlayerOptions = {}): Promise<CanvasKitPlayer> {
    const asset = isAsset(src) ? src : await loadOpenBone(ck, src, opts);
    const driver = await OpenBoneDriver.create(asset.doc, asset.baseUrl, { unlockTarget: canvas.ownerDocument?.defaultView ?? undefined, ...opts });
    return new CanvasKitPlayer(ck, canvas, asset, driver, opts);
  }

  private makeSurface(): Surface {
    const dpr = devicePixelRatio || 1;
    const c = this.canvas;
    c.width = Math.round((c.clientWidth || this.asset.doc.width) * dpr);
    c.height = Math.round((c.clientHeight || this.asset.doc.height) * dpr);
    const s = (this.opts.surface !== "software" && this.ck.MakeWebGLCanvasSurface(c)) || this.ck.MakeSWCanvasSurface(c);
    if (!s) throw new Error("CanvasKit: could not create a surface");
    const d = this.asset.doc;
    const w = c.width / dpr;
    const h = c.height / dpr;
    const fit = this.opts.fit ?? "contain";
    const z = fit === "none" ? 1 : (fit === "cover" ? Math.max : Math.min)(w / d.width, h / d.height);
    this.view = { zoom: z, x: (w - d.width * z) / 2, y: (h - d.height * z) / 2 };
    return s;
  }

  /** Call after the canvas changed size. */
  resize() {
    this.surface.delete();
    this.surface = this.makeSurface();
    if (!this.playing) this.draw();
  }

  private bindPointer() {
    const c = this.canvas;
    const send = (type: "down" | "up" | "move") => (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      const ax = (e.clientX - r.left - this.view.x) / this.view.zoom;
      const ay = (e.clientY - r.top - this.view.y) / this.view.zoom;
      this.driver.pointer(type, ...this.driver.instance.artboardToSkeleton(ax, ay));
    };
    const down = send("down");
    const up = send("up");
    const move = send("move");
    const leave = () => this.driver.pointerLeave();
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerleave", leave);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerleave", leave);
    };
  }

  draw() {
    const canvas = this.surface.getCanvas();
    const dpr = devicePixelRatio || 1;
    const bg = this.opts.background === undefined ? this.asset.doc.background : this.opts.background;
    canvas.clear(bg ? this.ck.parseColorString(bg) : this.ck.TRANSPARENT);
    this.renderer.render(canvas, this.driver.skeleton, { x: this.view.x * dpr, y: this.view.y * dpr, zoom: this.view.zoom * dpr });
    this.surface.flush();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.driver.resume();
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing) return;
      this.driver.advance(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.driver.pause();
  }

  get instance() {
    return this.driver.instance;
  }
  get stateMachine() {
    return this.driver.stateMachine;
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
    if (!this.playing) this.draw();
  }
  playAnimation(name: string, loop = true) {
    this.driver.play(name, loop);
  }
  /** Listen to "event", "stateChange" or "audio"; returns an unsubscribe function. */
  on: OpenBoneDriver["on"] = (name, fn) => this.driver.on(name, fn);

  dispose() {
    this.pause();
    this.unbind();
    this.driver.dispose();
    this.renderer.dispose();
    this.surface.delete();
  }
}

function isAsset(x: unknown): x is OpenBoneAsset {
  return !!x && typeof x === "object" && "images" in x && "doc" in x;
}
