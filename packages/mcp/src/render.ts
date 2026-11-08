import { type Image, createCanvas, loadImage } from "@napi-rs/canvas";
import { type AtlasData, type AtlasLayoutOptions, type OpenBoneDocument, atlasRegion, layoutAtlas, textureAssets } from "@openbone/core";
import { CanvasRenderer, type Ctx2D, drawAtlasPage } from "@openbone/render-canvas";
import { OpenBoneInstance, type ScriptHost } from "@openbone/runtime";
// @ts-expect-error gifenc ships without types (CommonJS)
import gifenc from "gifenc";
import type { ProjectSession } from "./session.ts";

const { GIFEncoder, applyPalette, quantize } = gifenc as {
  GIFEncoder: () => { writeFrame(i: Uint8Array, w: number, h: number, o: object): void; finish(): void; bytes(): Uint8Array };
  quantize: (d: Uint8ClampedArray, n: number) => number[][];
  applyPalette: (d: Uint8ClampedArray, p: number[][]) => Uint8Array;
};

export interface Step {
  /** Seconds to advance after applying this step's inputs. */
  advance?: number;
  setInputs?: Record<string, boolean | number>;
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

async function loadImages(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument) {
  const map = new Map<string, Image>();
  // Atlas pages and loose images, keyed by id (the renderers ask for page ids when images are packed).
  for (const img of textureAssets(doc)) {
    try {
      map.set(img.id, await loadImage(await session.readImageSrc(img.src)));
    } catch {
      /* missing images render as placeholders */
    }
  }
  return map;
}

function useSkin(inst: OpenBoneInstance, skin?: string) {
  if (!skin) return;
  inst.skeleton.setSkin(skin);
  if (!inst.skeleton.skin) throw new Error(`Skin "${skin}" not found. Available: ${inst.doc.skeleton.skins.map((k) => k.name).join(", ")}`);
}

/** Build a posed instance for the request. Returns logs from state machine simulation. */
export function pose(doc: OpenBoneDocument, req: PoseRequest, scriptHost?: ScriptHost) {
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

export async function renderPng(session: ProjectSession, req: RenderRequest, scriptHost?: ScriptHost) {
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

export async function renderGif(
  session: ProjectSession,
  req: { animation?: string; stateMachine?: string; skin?: string; duration: number; fps: number; scale?: number; showBones?: boolean; steps?: Step[] },
  scriptHost?: ScriptHost,
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
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: Math.round(1000 / req.fps) });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Lay out every image of `doc` on atlas pages and compose the page PNGs (as data: URIs). Images that already
 * live only in an atlas are cut back out of their page. The result is ready for the `setAtlas` op.
 */
export async function packAtlas(session: Pick<ProjectSession, "readImageSrc">, doc: OpenBoneDocument, opts: AtlasLayoutOptions = {}): Promise<AtlasData> {
  const loaded = await loadImages(session, doc);
  const sources = new Map<string, unknown>();
  for (const img of doc.images) {
    if (img.src) {
      const el = loaded.get(img.id);
      if (!el) throw new Error(`Could not load image "${img.name}" (${img.src.slice(0, 60)})`);
      sources.set(img.id, el);
      continue;
    }
    const hit = atlasRegion(doc, img.id);
    const page = hit && loaded.get(hit.page.id);
    if (!hit || !page) throw new Error(`Image "${img.name}" has no pixels`);
    const { region: r } = hit;
    const c = createCanvas(r.originalWidth, r.originalHeight);
    c.getContext("2d").drawImage(page, r.x, r.y, r.width, r.height, r.offsetX, r.offsetY, r.width, r.height);
    sources.set(img.id, c);
  }
  const atlas = layoutAtlas(doc.images, opts);
  for (const page of atlas.pages) {
    const c = createCanvas(page.width, page.height);
    const missing = drawAtlasPage(c.getContext("2d") as unknown as Ctx2D, atlas, page.id, (id) => sources.get(id) as CanvasImageSource);
    if (missing.length) throw new Error(`Missing image pixels: ${missing.join(", ")}`);
    page.src = `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`;
  }
  return atlas;
}
