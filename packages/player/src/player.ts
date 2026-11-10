import { type AudioAsset, type OpenBoneDocument, parseDocument, textureAssets } from "@openbone/core";
import { CanvasRenderer } from "@openbone/render-canvas";
import { WebGLRenderer } from "@openbone/render-webgl";
import { type FiredEvent, OpenBoneInstance, type ScriptHost, type SkeletonBounds, type StateMachineInstance } from "@openbone/runtime";
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
  fit?: "contain" | "cover" | "none";
  background?: string | null;
  /** Play the document's sounds (default true). "muted" loads them but starts muted. Audio unlocks on the first click or key press. */
  audio?: boolean | "muted";
  /** Share an existing AudioContext (e.g. one already unlocked by a click), instead of creating one. */
  audioContext?: AudioContext;
  /** Map an audio asset to the URL to load (overrides baseUrl), e.g. for files read from disk. */
  resolveAudioUrl?: (asset: AudioAsset) => string;
  /** Map an image src to the URL to load (overrides baseUrl). */
  resolveImageUrl?: (src: string) => string;
  onEvent?: (e: FiredEvent) => void;
  onStateChange?: (e: { layer: string; from: string | null; to: string }) => void;
  onLoad?: (p: Player) => void;
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
    await Promise.all(
      textureAssets(this.doc).map(
        (img) =>
          new Promise<void>((resolve) => {
            const el = new Image();
            el.crossOrigin = "anonymous";
            el.onload = () => {
              this.images.set(img.id, el);
              resolve();
            };
            el.onerror = () => resolve();
            el.src = o.resolveImageUrl ? o.resolveImageUrl(img.src) : /^(data:|https?:|blob:|\/)/.test(img.src) ? img.src : base + img.src;
          }),
      ),
    );
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
    const fit = this.opts.fit ?? "contain";
    const z = fit === "none" ? 1 : (fit === "cover" ? Math.max : Math.min)(w / this.doc.width, h / this.doc.height);
    this.view = { zoom: z, x: (w - this.doc.width * z) / 2, y: (h - this.doc.height * z) / 2 };
    if (!this.playing) this.draw();
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
    const send = (type: "down" | "up" | "move") => (e: PointerEvent) => this.instance.pointer(type, ...this.toSkeleton(e));
    c.addEventListener("pointerdown", send("down"));
    c.addEventListener("pointerup", send("up"));
    c.addEventListener("pointermove", send("move"));
    c.addEventListener("pointerleave", (e) => this.instance.pointer("move", -1e9, -1e9) ?? e);
  }

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const v = { x: this.view.x * dpr, y: this.view.y * dpr, zoom: this.view.zoom * dpr };
    const bg = this.opts.background === undefined ? this.doc.background : this.opts.background;
    if (this.gl) {
      const col = bg ? colorToGl(bg) : ([0, 0, 0, 0] as GlColor);
      this.gl.render(this.instance.skeleton, v, col);
    } else if (this.c2d) {
      const ctx = this.c2d.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      }
      this.c2d.render(this.instance.skeleton, { view: v, clear: false });
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
  setFit(fit: "contain" | "cover" | "none") {
    this.opts.fit = fit;
    if (this.doc) this.resize();
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
