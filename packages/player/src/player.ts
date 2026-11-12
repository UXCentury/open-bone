import { type AudioAsset, type OpenBoneDocument, parseDocument, textureAssets } from "@openbone/core";
import { CanvasRenderer } from "@openbone/render-canvas";
import { WebGLRenderer } from "@openbone/render-webgl";
import { type FiredEvent, OpenBoneInstance, loadDocumentFonts, type ScriptHost, type SkeletonBounds, type StateMachineInstance } from "@openbone/runtime";
import { WebAudioBackend } from "./audio.ts";

export interface PlayerOptions {
  canvas: HTMLCanvasElement;
  /** URL of a .obone file, or a parsed document. */
  src: string | OpenBoneDocument;
  /** Base URL for relative image paths (defaults to the src URL's folder). */
  baseUrl?: string;
  stateMachine?: string;
  animation?: string;
  /** Skin (outfit) to show, by name or id. Attachments not in it fall back to the default skin. */
  skin?: string;
  autoplay?: boolean;
  /** "quickjs" (sandboxed, default when the doc has scripts), "none", or a custom host. */
  scripts?: "quickjs" | "none" | ScriptHost;
  renderer?: "webgl" | "canvas";
  /** How the artboard fits the canvas (default "contain": all of it, with empty bars on the longer sides). */
  fit?: Fit;
  /**
   * Fit while the canvas is shown full screen (default "auto": fill the screen when that crops only a little of the
   * artboard, otherwise show all of it). null keeps `fit`.
   */
  fullscreenFit?: Fit | null;
  /**
   * Draw only inside the artboard (default true), like a camera: anything placed past its edges is cut off, the bars
   * around it stay clear (the page shows through) and clicks there are ignored. false draws everything on the canvas.
   */
  clip?: boolean;
  background?: string | null;
  /** Play the document's sounds (default true). "muted" loads them but starts muted. Audio unlocks on the first click or key press. */
  audio?: boolean | "muted";
  /** Share an existing AudioContext (e.g. one already unlocked by a click), instead of creating one. */
  audioContext?: AudioContext;
  /** Map an audio asset to the URL to load (overrides baseUrl), e.g. for files read from disk. */
  resolveAudioUrl?: (asset: AudioAsset) => string;
  /** Map a font src to the URL to load (overrides baseUrl). */
  resolveFontUrl?: (src: string) => string;
  /** Map an image src to the URL to load (overrides baseUrl). */
  resolveImageUrl?: (src: string) => string;
  onEvent?: (e: FiredEvent) => void;
  onStateChange?: (e: { layer: string; from: string | null; to: string }) => void;
  onLoad?: (p: Player) => void;
}

/**
 * contain: all of the artboard, with bars on the longer sides. cover: fill the canvas, cropping the artboard's edges.
 * auto: cover when that crops at most AUTO_CROP of the artboard's width or height, contain otherwise (so buttons near
 * the edges of the art never get cut off on a very different screen shape). none: actual size, centred.
 */
export type Fit = "contain" | "cover" | "auto" | "none";

/** The most of the artboard's width or height `auto` will crop to fill the canvas. */
export const AUTO_CROP = 0.15;

/** Where an artboard of aw × ah lands on a canvas of cw × ch (CSS pixels) for a fit: zoom and top-left offset. */
export function fitView(cw: number, ch: number, aw: number, ah: number, fit: Fit): { zoom: number; x: number; y: number } {
  const contain = Math.min(cw / aw, ch / ah);
  const cover = Math.max(cw / aw, ch / ah);
  const zoom = fit === "none" ? 1 : fit === "contain" ? contain : fit === "cover" || 1 - contain / cover <= AUTO_CROP + 1e-9 ? cover : contain;
  return { zoom, x: (cw - aw * zoom) / 2, y: (ch - ah * zoom) / 2 };
}

/** The canvas rectangle (device pixels, y down) the artboard covers, cut to the canvas; null when none of it shows. */
export function artboardRect(view: { x: number; y: number; zoom: number }, aw: number, ah: number, cw: number, ch: number): { x: number; y: number; w: number; h: number } | null {
  const x0 = Math.max(0, Math.round(view.x));
  const y0 = Math.max(0, Math.round(view.y));
  const x1 = Math.min(cw, Math.round(view.x + aw * view.zoom));
  const y1 = Math.min(ch, Math.round(view.y + ah * view.zoom));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const fullscreenElement = (d: Document): Element | null => d.fullscreenElement ?? (d as unknown as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;

/** Whether `node` is the full-screen element or inside it, across shadow roots (a player element's canvas is in one). */
export function isInFullscreen(node: Node): boolean {
  const fs = node.ownerDocument ? fullscreenElement(node.ownerDocument) : null;
  if (!fs) return false;
  for (let n: Node | null = node; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === fs) return true;
  return false;
}

let scriptHostFactory: (() => Promise<ScriptHost | null>) | null = null;

/**
 * Replace how players create the sandbox for documents with scripts (default: load `@openbone/scripting`).
 * Bundles use it to supply an inlined QuickJS build, or `() => Promise.resolve(null)` to run without scripts.
 */
export function setScriptHostFactory(factory: (() => Promise<ScriptHost | null>) | null) {
  scriptHostFactory = factory;
}

/** Plays an OpenBone document on a canvas, with pointer input routed to its state machine. */
export class Player {
  instance!: OpenBoneInstance;
  doc!: OpenBoneDocument;
  private images = new Map<string, HTMLImageElement>();
  private raf = 0;
  private last = 0;
  private gl: WebGLRenderer | null = null;
  private c2d: CanvasRenderer | null = null;
  private view = { x: 0, y: 0, zoom: 1 };
  private ro: ResizeObserver | null = null;
  private onFullscreen = () => this.doc && this.resize();
  playing = false;
  /** Playback rate (1 = real time). */
  private _speed = 1;
  /** Playback speed (1 = normal). Sounds follow it: 2× plays them twice as fast and an octave higher. */
  get speed() {
    return this._speed;
  }
  set speed(v: number) {
    this._speed = v;
    this.audio?.setSpeed(v);
  }
  ready: Promise<void>;
  /** Web Audio playback of the document's sounds (null when audio is off or the document has none). */
  audio: WebAudioBackend | null = null;

  constructor(private opts: PlayerOptions) {
    this.ready = this.load();
  }

  get stateMachine(): StateMachineInstance | null {
    return this.instance?.stateMachine ?? null;
  }

  private async load() {
    const o = this.opts;
    let base = o.baseUrl ?? "";
    if (typeof o.src === "string") {
      const res = await fetch(o.src);
      if (!res.ok) throw new Error(`OpenBone: failed to load ${o.src} (${res.status})`);
      // .obone (JSON) or .obonb (binary), detected from the bytes.
      this.doc = parseDocument(new Uint8Array(await res.arrayBuffer()));
      if (!o.baseUrl) {
        // blob:/data: URLs have no folder to resolve relative image paths against.
        try {
          base = new URL(".", new URL(o.src, location.href)).href;
        } catch {
          base = "";
        }
      }
    } else this.doc = o.src;
    const abs = (src: string) => (/^(data:|https?:|blob:|\/)/.test(src) ? src : base + src);
    await Promise.all([
      // The document's own fonts, so the first frame already draws text with them.
      loadDocumentFonts(this.doc, (f) => (o.resolveFontUrl ? o.resolveFontUrl(f.src) : abs(f.src))),
      ...textureAssets(this.doc).map(
        (img) =>
          new Promise<void>((resolve) => {
            const el = new Image();
            el.crossOrigin = "anonymous";
            el.onload = () => {
              this.images.set(img.id, el);
              resolve();
            };
            el.onerror = () => resolve();
            el.src = o.resolveImageUrl ? o.resolveImageUrl(img.src) : abs(img.src);
          }),
      ),
    ]);
    // null: scripts off on purpose ("none", no scripts, or no sandbox in this build, which warns above).
    let scriptHost: ScriptHost | null = null;
    if (typeof o.scripts === "object") scriptHost = o.scripts;
    else if (o.scripts !== "none" && this.doc.scripts.length) {
      if (scriptHostFactory) {
        scriptHost = (await scriptHostFactory()) ?? null;
        if (!scriptHost) console.warn("OpenBone: this player build has no script sandbox; the document's scripts will not run.");
      } else {
        const { createQuickJsHost } = await import("@openbone/scripting");
        scriptHost = await createQuickJsHost();
      }
    }
    this.instance = new OpenBoneInstance(this.doc, { scriptHost });
    if (o.audio !== false && this.doc.audio?.assets.length && typeof AudioContext !== "undefined") {
      this.audio = new WebAudioBackend(this.doc, { baseUrl: base, context: o.audioContext, resolveUrl: o.resolveAudioUrl });
      this.audio.setMuted(o.audio === "muted");
      this.audio.setSpeed(this._speed);
      this.audio.unlock(o.canvas.ownerDocument?.defaultView ?? window);
      void this.audio.preload();
      this.instance.on("audio", this.audio.handle);
    }
    if (o.skin) this.instance.skeleton.setSkin(o.skin);
    if (o.onEvent) this.instance.on("event", o.onEvent);
    if (o.onStateChange) this.instance.on("stateChange", o.onStateChange);
    if (o.animation) this.instance.play(o.animation);
    else if (this.doc.stateMachines.length) this.instance.useStateMachine(o.stateMachine);
    else if (this.doc.animations.length) this.instance.play(this.doc.animations[0].name);
    this.setupRenderer();
    this.bindPointer();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(o.canvas);
    const d = o.canvas.ownerDocument ?? document;
    d.addEventListener("fullscreenchange", this.onFullscreen);
    d.addEventListener("webkitfullscreenchange", this.onFullscreen);
    this.resize();
    this.instance.advance(0);
    this.draw();
    if (o.autoplay !== false) this.play();
    o.onLoad?.(this);
  }

  private setupRenderer() {
    const img = (id: string) => this.images.get(id) ?? null;
    if (this.opts.renderer !== "canvas") {
      try {
        this.gl = new WebGLRenderer(this.opts.canvas, img);
        return;
      } catch {
        /* fall back to 2D */
      }
    }
    this.c2d = new CanvasRenderer(this.opts.canvas.getContext("2d")!, img);
  }

  private resize() {
    const c = this.opts.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || this.doc.width;
    const h = c.clientHeight || this.doc.height;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.view = fitView(w, h, this.doc.width, this.doc.height, this.currentFit);
    if (!this.playing) this.draw();
  }

  /** The fit in use now: `fullscreenFit` while the canvas is full screen, otherwise `fit`. */
  get currentFit(): Fit {
    const fs = this.opts.fullscreenFit === undefined ? "auto" : this.opts.fullscreenFit;
    return (fs && isInFullscreen(this.opts.canvas) ? fs : this.opts.fit) ?? "contain";
  }

  private get clipping() {
    return this.opts.clip !== false;
  }

  /** Whether page coordinates fall on the artboard (always true with clip off, where the whole canvas is live). */
  private onArtboard(clientX: number, clientY: number) {
    if (!this.clipping) return true;
    const r = this.opts.canvas.getBoundingClientRect();
    const ax = (clientX - r.left - this.view.x) / this.view.zoom;
    const ay = (clientY - r.top - this.view.y) / this.view.zoom;
    return ax >= 0 && ay >= 0 && ax <= this.doc.width && ay <= this.doc.height;
  }

  private toSkeleton(e: PointerEvent): [number, number] {
    return this.clientToSkeleton(e.clientX, e.clientY);
  }

  /** Page (client) coordinates, e.g. a pointer event's clientX/clientY, to skeleton space (y up), through the current fit. */
  clientToSkeleton(clientX: number, clientY: number): [number, number] {
    const r = this.opts.canvas.getBoundingClientRect();
    const ax = (clientX - r.left - this.view.x) / this.view.zoom;
    const ay = (clientY - r.top - this.view.y) / this.view.zoom;
    return this.instance.artboardToSkeleton(ax, ay);
  }

  /**
   * The active bounding boxes in the current pose (skeleton space), with point / segment / AABB / overlap queries:
   * `player.boundingBoxes().containsPoint(...player.clientToSkeleton(e.clientX, e.clientY))`.
   */
  boundingBoxes(): SkeletonBounds {
    return this.instance.boundingBoxes();
  }

  private bindPointer() {
    const c = this.opts.canvas;
    // Past the artboard's edges (with clip on) nothing is drawn, so nothing there can be hit: a move there leaves it.
    const send = (type: "down" | "up" | "move") => (e: PointerEvent) => {
      if (this.onArtboard(e.clientX, e.clientY)) this.instance.pointer(type, ...this.toSkeleton(e));
      else if (type === "move") this.instance.pointer("move", -1e9, -1e9);
    };
    c.addEventListener("pointerdown", send("down"));
    c.addEventListener("pointerup", send("up"));
    c.addEventListener("pointermove", send("move"));
    c.addEventListener("pointerleave", (e) => this.instance.pointer("move", -1e9, -1e9) ?? e);
  }

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const v = { x: this.view.x * dpr, y: this.view.y * dpr, zoom: this.view.zoom * dpr };
    const bg = this.opts.background === undefined ? this.doc.background : this.opts.background;
    const cw = this.opts.canvas.width;
    const ch = this.opts.canvas.height;
    // With clip on, the background and the art fill the artboard only; the bars around it stay transparent.
    const clip = this.clipping ? artboardRect(v, this.doc.width, this.doc.height, cw, ch) : null;
    if (this.clipping && !clip) {
      this.clearAll();
      return;
    }
    if (this.gl) {
      const col = bg ? colorToGl(bg) : ([0, 0, 0, 0] as GlColor);
      const gl = this.gl.gl;
      if (clip) {
        this.clearAll();
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(clip.x, ch - clip.y - clip.h, clip.w, clip.h); // GL counts y from the bottom
      }
      try {
        this.gl.render(this.instance.skeleton, v, col);
      } finally {
        if (clip) gl.disable(gl.SCISSOR_TEST);
      }
    } else if (this.c2d) {
      const ctx = this.c2d.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      if (clip) {
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
      }
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, cw, ch);
      }
      this.c2d.render(this.instance.skeleton, { view: v, clear: false });
      ctx.restore();
    }
  }

  private clearAll() {
    if (this.gl) {
      const gl = this.gl.gl;
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else if (this.c2d) {
      this.c2d.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.c2d.ctx.clearRect(0, 0, this.opts.canvas.width, this.opts.canvas.height);
    }
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.audio?.resumeAll();
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.instance.advance(dt * this.speed);
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Change how the artboard fits the canvas ("none" = actual size, centred). */
  setFit(fit: Fit) {
    this.opts.fit = fit;
    if (this.doc) this.resize();
  }
  /** Change the fit used while full screen (null = the same as `fit`). */
  setFullscreenFit(fit: Fit | null) {
    this.opts.fullscreenFit = fit;
    if (this.doc) this.resize();
  }
  /** Draw only inside the artboard (true, the default) or everything on the canvas (false). */
  setClip(clip: boolean) {
    this.opts.clip = clip;
    if (this.doc && !this.playing) this.draw();
  }

  /** Pause the animation and its sounds (play() continues both from where they were). */
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.audio?.pauseAll();
  }

  /** Mute or unmute this player's sounds. */
  setMuted(muted: boolean) {
    this.audio?.setMuted(muted);
  }
  get muted() {
    return this.audio?.muted ?? false;
  }

  /**
   * Mute, unmute or toggle one sound bus by name or id ("music", "sfx"…), or the master with null / "master", e.g.
   * from music and sound-effect buttons on your page. Same as a mute-button listener inside the artboard, so both
   * stay in step. Returns the new state, or null when the file has no such bus (or hasn't loaded yet).
   */
  setBusMuted(bus: string | null, muted: boolean | "toggle" = true): boolean | null {
    return this.instance?.setBusMuted(bus, muted) ?? null;
  }
  /** Flip a bus's mute (see setBusMuted). Returns the new state. */
  toggleBus(bus: string | null): boolean | null {
    return this.setBusMuted(bus, "toggle");
  }
  /** Whether a bus (name or id; null / "master" = master) is muted right now; null when there is no such bus. */
  isBusMuted(bus: string | null): boolean | null {
    return this.instance?.isBusMuted(bus) ?? null;
  }
  /** The file's sound buses with their current mute state. */
  get buses(): { name: string; muted: boolean }[] {
    return (this.doc?.audio?.buses ?? []).map((b) => ({ name: b.name, muted: this.isBusMuted(b.id) ?? b.muted }));
  }

  // ---- convenience API (Rive-like) ----
  setInput(name: string, value: boolean | number | string) {
    this.stateMachine?.setInput(name, value);
  }
  /**
   * Show fixed text (or a `{input}` template) in a slot's text attachment instead of its own; null restores it.
   * Works with or without a state machine.
   */
  setText(slot: string, text: string | null) {
    this.instance?.skeleton.setText(slot, text);
    if (!this.playing && this.instance) this.draw();
  }
  fire(name: string) {
    this.stateMachine?.fire(name);
  }
  getInput(name: string) {
    return this.stateMachine?.getInput(name);
  }
  /** Show a skin (outfit) by name or id; null shows the default skin only. */
  setSkin(name: string | null) {
    if (!this.instance) {
      this.opts.skin = name ?? undefined;
      return;
    }
    this.instance.skeleton.setSkin(name);
    if (name && !this.instance.skeleton.skin) console.warn(`OpenBone: skin "${name}" not found`);
    if (!this.playing) {
      this.instance.advance(0);
      this.draw();
    }
  }
  /** Names of the document's skins (the first is the default skin). */
  get skins(): string[] {
    return this.doc?.skeleton.skins.map((s) => s.name) ?? [];
  }
  playAnimation(name: string, loop = true) {
    this.instance.play(name, loop);
  }

  dispose() {
    this.pause();
    this.ro?.disconnect();
    const d = this.opts.canvas.ownerDocument ?? document;
    d.removeEventListener("fullscreenchange", this.onFullscreen);
    d.removeEventListener("webkitfullscreenchange", this.onFullscreen);
    this.instance?.dispose();
    this.audio?.dispose();
    this.gl?.dispose();
  }
}

type GlColor = [number, number, number, number];
const glColors = new Map<string, GlColor>();

/**
 * Any CSS colour (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/hsl(), named colours…) as premultiplied RGBA for WebGL.
 * Hex is parsed directly; anything else goes through a 2D context, which normalises it the way CSS does. Cached, since
 * draw() asks every frame.
 */
export function colorToGl(color: string): GlColor {
  const hit = glColors.get(color);
  if (hit) return hit;
  let rgba = parseHex(color);
  if (!rgba && typeof document !== "undefined") {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000000";
      ctx.fillStyle = color; // invalid colours leave it unchanged
      rgba = parseHex(ctx.fillStyle) ?? parseRgbFunction(ctx.fillStyle);
    }
  }
  const [r, g, b, a] = rgba ?? [0, 0, 0, 1];
  const out: GlColor = [r * a, g * a, b * a, a];
  glColors.set(color, out);
  return out;
}

function parseHex(color: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
}

/** "rgb(r, g, b)" / "rgba(r, g, b, a)", as a 2D context reports colours with transparency. */
function parseRgbFunction(color: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(color.trim());
  return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])] : null;
}
