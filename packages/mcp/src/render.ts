import { type Canvas, GlobalFonts, type Image, createCanvas } from "@napi-rs/canvas";
import { decodeImage } from "./image-load.ts";
import { type AtlasData, type OpenBoneDocument, textureAssets } from "@openbone/core";
import { encodePng } from "@openbone/export";
import { type AtlasCanvas, type AtlasEnv, type AtlasScaleVariant, type BuildAtlasOptions, type BuiltAtlas, CanvasRenderer, type Ctx2D, buildAtlas, buildAtlasScales } from "@openbone/render-canvas";
import { OpenBoneInstance, type ScriptHost } from "@openbone/runtime";
// @ts-expect-error gifenc ships without types (CommonJS)
import * as gifenc from "gifenc";
import type { ProjectSession } from "./session.ts";

interface GifEnc {
  GIFEncoder: () => { writeFrame(i: Uint8Array, w: number, h: number, o: object): void; finish(): void; bytes(): Uint8Array };
  quantize: (d: Uint8ClampedArray, n: number) => number[][];
  applyPalette: (d: Uint8ClampedArray, p: number[][]) => Uint8Array;
}
// Node loads the CommonJS build (the functions sit on `default`); bundlers such as Vite and Vitest load the ESM build
// (the functions are named exports, and `default` is the encoder alone). Take them from whichever has them.
const gifNs = gifenc as Partial<GifEnc> & { default?: GifEnc };
const { GIFEncoder, applyPalette, quantize } = (typeof gifNs.GIFEncoder === "function" ? gifNs : gifNs.default) as GifEnc;

export interface Step {
  /** Seconds to advance after applying this step's inputs. */
  advance?: number;
  setInputs?: Record<string, boolean | number | string>;
  fire?: string[];
  /** Pointer in artboard pixels (y-down, top-left origin). */
  pointer?: { type: "down" | "up" | "move"; x: number; y: number };
}

export interface PoseRequest {
  /** Skin to show (name or id); defaults to the default skin only. */
  skin?: string;
  animation?: string;
  time?: number;
  stateMachine?: string;
  steps?: Step[];
}

export interface RenderRequest extends PoseRequest {
  scale?: number;
  showBones?: boolean;
  showBoundingBoxes?: boolean;
  wireframe?: boolean;
  background?: string | null;
}

/** Font files registered with @napi-rs/canvas, by family and source, so a render can draw text in them. */
const registeredFonts = new Set<string>();

/** Register the document's fonts so server-side renders (render_frame, GIF and video exports) draw text with them. */
export async function loadFonts(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument) {
  for (const f of doc.fonts ?? []) {
    const key = `${f.family}|${f.src.length > 200 ? f.src.slice(0, 200) + f.src.length : f.src}`;
    if (registeredFonts.has(key)) continue;
    try {
      GlobalFonts.register(Buffer.from(await session.readImageSrc(f.src)), f.family);
      registeredFonts.add(key);
    } catch {
      /* unreadable font: installed fonts apply */
    }
  }
}

export async function loadImages(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument) {
  await loadFonts(session, doc);
  const map = new Map<string, Image>();
  // Atlas pages and loose images, keyed by id (the renderers ask for page ids when images are packed).
  for (const img of textureAssets(doc)) {
    try {
      map.set(img.id, await decodeImage(await session.readImageSrc(img.src)));
    } catch {
      /* missing images render as placeholders */
    }
  }
  return map;
}

export function useSkin(inst: OpenBoneInstance, skin?: string) {
  if (!skin) return;
  inst.skeleton.setSkin(skin);
  if (!inst.skeleton.skin) throw new Error(`Skin "${skin}" not found. Available: ${inst.doc.skeleton.skins.map((k) => k.name).join(", ")}`);
}

/** Build a posed instance for the request. Returns logs from state machine simulation. */
export function pose(doc: OpenBoneDocument, req: PoseRequest, scriptHost?: ScriptHost | null) {
  const inst = new OpenBoneInstance(doc, { scriptHost });
  useSkin(inst, req.skin);
  const log: string[] = [];
  if (req.stateMachine !== undefined || req.steps?.length) {
    const sm = inst.useStateMachine(req.stateMachine || undefined);
    sm.on("stateChange", (e) => log.push(`t=${t.toFixed(3)} [${e.layer}] ${e.from ?? "∅"} → ${e.to}`));
    sm.on("event", (e) => log.push(`t=${t.toFixed(3)} event ${e.name}${e.animation ? ` (from ${e.animation})` : ""} int=${e.int} float=${e.float}${e.string ? ` "${e.string}"` : ""}`));
    sm.on("inputChange", (e) => log.push(`t=${t.toFixed(3)} input ${e.name} = ${e.value}`));
    sm.on("log", (a) => log.push(`t=${t.toFixed(3)} script: ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`));
    sm.on("error", (e) => log.push(`t=${t.toFixed(3)} ERROR ${e.message}`));
    const soundName = (id: string) => doc.audio?.sounds.find((x) => x.id === id)?.name ?? id;
    sm.on("audio", (c) =>
      log.push(
        `t=${t.toFixed(3)} audio ${c.type === "play" ? `play ${soundName(c.sound)} [${c.id}]${c.loop ? " loop" : ""} vol ${c.volume} (${c.source})` : c.type === "stop" ? `stop [${c.id}]${c.fade ? ` fade ${c.fade}s` : ""}` : c.type === "fade" ? `fade [${c.id}] → ${c.volume}` : `${c.muted ? "mute" : "unmute"} ${c.bus === null ? "master" : (doc.audio?.buses.find((b) => b.id === c.bus)?.name ?? c.bus)}`}`,
      ),
    );
    let t = 0;
    sm.advance(0);
    for (const s of req.steps ?? [{ advance: req.time ?? 0 }]) {
      for (const [k, v] of Object.entries(s.setInputs ?? {})) sm.setInput(k, v);
      for (const f of s.fire ?? []) sm.fire(f);
      if (s.pointer) {
        const [x, y] = inst.artboardToSkeleton(s.pointer.x, s.pointer.y);
        sm.pointer(s.pointer.type, x, y);
      }
      const dt = s.advance ?? 1 / 30;
      // Advance in small steps so transitions/events resolve like real playback.
      let rem = dt;
      sm.advance(0);
      while (rem > 1e-9) {
        const h = Math.min(rem, 1 / 60);
        sm.advance(h);
        t += h;
        rem -= h;
      }
    }
    log.push(`final states: ${JSON.stringify(sm.activeStates)}; inputs: ${JSON.stringify(Object.fromEntries([...sm.inputs].map(([id, v]) => [sm.data.inputs.find((i) => i.id === id)?.name ?? id, v])))}`);
  } else if (req.animation) {
    inst.animationState.setAnimation(0, req.animation, true, 0);
    // Step at 60 Hz so physics constraints are simulated up to the requested time.
    inst.advance(0);
    let rem = req.time ?? 0;
    while (rem > 1e-9) {
      const h = Math.min(rem, 1 / 60);
      inst.advance(h);
      rem -= h;
    }
  } else {
    inst.skeleton.updateWorldTransform();
  }
  return { inst, log };
}

export async function renderPng(session: ProjectSession, req: RenderRequest, scriptHost?: ScriptHost | null) {
  const doc = session.doc;
  const images = await loadImages(session, doc);
  const { inst, log } = pose(doc, req, scriptHost);
  const scale = req.scale ?? 1;
  const canvas = createCanvas(Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
  const ctx = canvas.getContext("2d") as unknown as Ctx2D;
  const r = new CanvasRenderer(ctx, (id) => images.get(id) as unknown as CanvasImageSource);
  r.render(inst.skeleton, {
    view: { x: 0, y: 0, zoom: scale },
    bones: req.showBones ?? true,
    boundingBoxes: req.showBoundingBoxes ?? true,
    wireframe: req.wireframe ?? false,
    background: req.background === undefined ? (doc.background ?? "#f4f4f6") : req.background,
  });
  return { png: canvas.toBuffer("image/png"), log };
}

/**
 * Largest GIF returned inline by render_gif. A tool result travels as one JSON-RPC message (the image as base64, a
 * third bigger), and MCP clients drop the connection on very large messages: a 14 MB GIF (19 MB of base64) did. Bigger
 * GIFs are still saved to disk; the result then carries a contact sheet of a few frames instead.
 */
export const MAX_INLINE_GIF = 4 * 1024 * 1024;

/** A grid of evenly spaced frames, for a preview of a long render. */
export function contactSheet(frameW: number, frameH: number, count: number, cols = 3, rows = 2) {
  const n = cols * rows;
  const tw = Math.min(frameW, 480);
  const th = Math.round((frameH * tw) / frameW);
  const sheet = createCanvas(cols * tw, rows * th);
  const sctx = sheet.getContext("2d");
  const picks = Array.from({ length: n }, (_, i) => Math.round((i * (count - 1)) / Math.max(1, n - 1)));
  return {
    add(canvas: Canvas, index: number) {
      const k = picks.indexOf(index);
      if (k >= 0) sctx.drawImage(canvas, (k % cols) * tw, Math.floor(k / cols) * th, tw, th);
    },
    png: () => sheet.toBuffer("image/png"),
    picks,
  };
}

export async function renderGif(
  session: ProjectSession,
  req: { animation?: string; stateMachine?: string; skin?: string; duration: number; fps: number; scale?: number; showBones?: boolean; steps?: Step[] },
  scriptHost?: ScriptHost | null,
  /** Called with each rendered frame (e.g. to build a preview); the canvas is reused, so copy what you need. */
  onFrame?: (canvas: Canvas, index: number, count: number) => void,
) {
  const doc = session.doc;
  const images = await loadImages(session, doc);
  const scale = req.scale ?? 0.5;
  const w = Math.max(1, Math.round(doc.width * scale));
  const h = Math.max(1, Math.round(doc.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as Ctx2D;
  const renderer = new CanvasRenderer(ctx, (id) => images.get(id) as unknown as CanvasImageSource);
  const inst = new OpenBoneInstance(doc, { scriptHost });
  useSkin(inst, req.skin);
  const sm = req.stateMachine !== undefined || req.steps ? inst.useStateMachine(req.stateMachine || undefined) : null;
  if (!sm) {
    if (!req.animation) throw new Error("Give animation or stateMachine");
    inst.animationState.setAnimation(0, req.animation, true, 0);
  }
  const gif = GIFEncoder();
  const frames = Math.max(1, Math.round(req.duration * req.fps));
  const dt = 1 / req.fps;
  // Steps (state machine) are scheduled by cumulative time.
  const schedule: { at: number; step: Step }[] = [];
  let acc = 0;
  for (const s of req.steps ?? []) {
    schedule.push({ at: acc, step: s });
    acc += s.advance ?? 0;
  }
  let t = 0;
  for (let f = 0; f < frames; f++) {
    if (sm)
      while (schedule.length && schedule[0].at <= t + 1e-9) {
        const { step } = schedule.shift()!;
        for (const [k, v] of Object.entries(step.setInputs ?? {})) sm.setInput(k, v);
        for (const n of step.fire ?? []) sm.fire(n);
        if (step.pointer) {
          const [x, y] = inst.artboardToSkeleton(step.pointer.x, step.pointer.y);
          sm.pointer(step.pointer.type, x, y);
        }
      }
    inst.advance(f === 0 ? 0 : dt);
    t += f === 0 ? 0 : dt;
    renderer.render(inst.skeleton, {
      view: { x: 0, y: 0, zoom: scale },
      bones: req.showBones ?? false,
      background: doc.background ?? "#ffffff",
    });
    onFrame?.(canvas, f, frames);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: Math.round(1000 / req.fps) });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Lay out every image of `doc` on atlas pages and compose the page PNGs (as data: URIs), with the same code the
 * editor uses (`buildAtlas`). Images that already live only in an atlas are cut back out of their page. The result
 * is ready for the `setAtlas` op.
 */
export async function packAtlas(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument, opts: BuildAtlasOptions = {}): Promise<AtlasData> {
  return (await buildAtlas(doc, opts, atlasEnv(session))).atlas;
}

/** `packAtlas` with the scale used and any warnings (e.g. JPEG pages losing transparency). */
export async function packAtlasFull(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument, opts: BuildAtlasOptions = {}): Promise<BuiltAtlas> {
  return buildAtlas(doc, opts, atlasEnv(session));
}

/** One atlas per scale variant (multi-scale packs), images loaded once. */
export async function packAtlasScales(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument, opts: BuildAtlasOptions, variants: AtlasScaleVariant[]) {
  return buildAtlasScales(doc, opts, variants, atlasEnv(session));
}

/** Canvases, image loading and PNG / JPEG encoding for the atlas packer, in Node (@napi-rs/canvas). */
export function atlasEnv(session: Pick<ProjectSession, "readImageSrc">): AtlasEnv {
  return {
    createCanvas: (w, h) => createCanvas(w, h) as unknown as AtlasCanvas,
    load: async (src, name) => {
      try {
        return (await decodeImage(await session.readImageSrc(src))) as unknown as CanvasImageSource;
      } catch {
        throw new Error(`Could not load image "${name}" (${src.slice(0, 60)})`);
      }
    },
    encodePng: (data, width, height) => encodePng({ width, height, data }),
    encodeJpeg: async (data, width, height, quality) => {
      const c = createCanvas(width, height);
      const g = c.getContext("2d");
      const id = g.createImageData(width, height);
      id.data.set(data);
      g.putImageData(id, 0, 0);
      return new Uint8Array(c.toBuffer("image/jpeg", quality));
    },
  };
}
