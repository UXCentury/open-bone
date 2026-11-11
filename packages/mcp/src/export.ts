import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { type OpenBoneDocument, animationDuration, applyOp, exportDocument, serialize, serializeBinary } from "@openbone/core";
import {
  type Frame,
  type SheetEngine,
  buildSpriteSheets,
  createZip,
  encodeApng,
  encodeAviMjpeg,
  encodeGif,
  encodeMovMjpeg,
  encodePng,
  encodePsd,
  type TimedMixCommand,
  atlasExportFiles,
  floatToPcm,
  mixAudioCommands,
  enginePackZip,
  webIndexHtml,
  webPackZip,
} from "@openbone/export";
import { type AtlasSettings, CanvasRenderer, type Ctx2D, atlasBuildOptions, describeAtlas } from "@openbone/render-canvas";
import { OpenBoneInstance, type ScriptHost } from "@openbone/runtime";
import { decodeAudio, encodeVideoFfmpeg, findFfmpeg } from "./media.ts";
import { loadImages, packAtlasFull, packAtlasScales, useSkin } from "./render.ts";
import type { ProjectSession } from "./session.ts";

/**
 * Every export format, headless: the one code path behind the MCP `export_file` tool and `openbone export`, using
 * the same encoders, atlas packer and runtime-data export as the editor's Export dialog.
 */

export const EXPORT_FORMATS = ["obone", "json", "obonb", "atlas", "png", "jpeg", "apng", "gif", "psd", "avi", "mov", "mp4", "webm", "spritesheet", "web"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type Step = { advance?: number; setInputs?: Record<string, boolean | number | string>; fire?: string[]; pointer?: { type: "down" | "up" | "move"; x: number; y: number } };

/** Texture atlas settings (the Export dialog's "Texture atlas" group): the packer settings shared with the CLI and editor. */
export type AtlasExportOptions = AtlasSettings;

export interface ExportRequest {
  format: ExportFormat;
  animation?: string;
  stateMachine?: string;
  steps?: Step[];
  skin?: string;
  /** json/obonb/atlas: animations to keep (names; default all marked for export). spritesheet: clips. */
  animations?: string[];
  stateMachines?: string[];
  duration?: number;
  fps?: number;
  scale?: number;
  transparent?: boolean;
  /** png/jpeg: every frame in a ZIP instead of one frame. */
  sequence?: boolean;
  /** png/jpeg single frame: time in the animation. */
  time?: number;
  engine?: SheetEngine;
  singleFile?: boolean;
  minify?: boolean;
  binary?: boolean;
  /** avi/mov/mp4/webm: include the sound the run plays (default true). */
  audio?: boolean;
  /** mp4/webm: quality 0..1 (default 0.85). */
  quality?: number;
  /** json/obonb: pack images into an embedded texture atlas (like the dialog's Pack option). */
  pack?: boolean;
  /** obone/json/obonb: embed every image and audio file as data: URIs, so the file opens anywhere on its own. */
  embed?: boolean;
  atlas?: AtlasExportOptions;
}

export interface ExportResult {
  bytes: Uint8Array;
  /** File extension (without the dot), e.g. "png" or "zip"; APNG is "png" with `suffix` ".apng". */
  ext: string;
  /** Extra name part before the extension: ".apng", or "-atlas", "-web", "-png", "-spritesheet-unity" … for ZIPs. */
  suffix: string;
  /** Human summary: frames, sheets, warnings. */
  note: string;
}

/** Render frames of an animation or a state machine run (RGBA, artboard size × scale). */
export async function renderFrames(
  session: ProjectSession,
  req: { animation?: string; stateMachine?: string; steps?: Step[]; skin?: string; duration?: number; fps: number; scale: number; background: string | null },
  scriptHost?: ScriptHost | null,
  /** Filled with the audio commands the run emits, with their time (for the sound track of a video). */
  audioOut?: TimedMixCommand[],
): Promise<Frame[]> {
  const doc = session.doc;
  const images = await loadImages(session, doc);
  const w = Math.max(1, Math.round(doc.width * req.scale));
  const h = Math.max(1, Math.round(doc.height * req.scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as Ctx2D;
  const renderer = new CanvasRenderer(ctx, (id) => images.get(id) as unknown as CanvasImageSource);
  const inst = new OpenBoneInstance(doc, { scriptHost });
  useSkin(inst, req.skin);
  const sm = req.stateMachine !== undefined || req.steps ? inst.useStateMachine(req.stateMachine || undefined) : null;
  let duration = req.duration;
  if (!sm) {
    const anim = doc.animations.find((a) => a.name === req.animation || a.id === req.animation) ?? doc.animations[0];
    if (!anim) throw new Error("No animation to render");
    inst.animationState.setAnimation(0, anim.name, true, 0);
    duration ??= Math.max(animationDuration(anim), 1 / req.fps);
  }
  duration ??= 2;
  const schedule: { at: number; step: Step }[] = [];
  let acc = 0;
  for (const s of req.steps ?? []) {
    schedule.push({ at: acc, step: s });
    acc += s.advance ?? 0;
  }
  const frames: Frame[] = [];
  const count = Math.max(1, Math.round(duration * req.fps));
  let t = 0;
  // Commands emitted while advancing to a frame are stamped with that frame's time.
  let stamp = 0;
  if (audioOut) inst.on("audio", (c) => audioOut.push({ time: stamp, command: c as TimedMixCommand["command"] }));
  for (let f = 0; f < count; f++) {
    stamp = f === 0 ? 0 : t + 1 / req.fps;
    if (sm)
      while (schedule.length && schedule[0].at <= t + 1e-9) {
        const { step } = schedule.shift()!;
        for (const [k, v] of Object.entries(step.setInputs ?? {})) sm.setInput(k, v);
        for (const n of step.fire ?? []) sm.fire(n);
        if (step.pointer) sm.pointer(step.pointer.type, ...inst.artboardToSkeleton(step.pointer.x, step.pointer.y));
      }
    inst.advance(f === 0 ? 0 : 1 / req.fps);
    if (f) t += 1 / req.fps;
    ctx.clearRect(0, 0, w, h);
    renderer.render(inst.skeleton, { view: { x: 0, y: 0, zoom: req.scale }, bones: false, background: req.background });
    frames.push({ width: w, height: h, data: new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data) });
  }
  return frames;
}

/** A frame as JPEG (flattened onto `bg`). */
export function jpegOf(f: Frame, bg: string, quality = 90): Uint8Array {
  const c = createCanvas(f.width, f.height);
  const g = c.getContext("2d");
  const tmp = createCanvas(f.width, f.height);
  const tg = tmp.getContext("2d");
  const id = tg.createImageData(f.width, f.height);
  id.data.set(f.data);
  tg.putImageData(id, 0, 0);
  g.fillStyle = bg;
  g.fillRect(0, 0, f.width, f.height);
  g.drawImage(tmp, 0, 0);
  return new Uint8Array(c.toBuffer("image/jpeg", quality));
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" };

/** Bytes of a document asset src (data: URI or a path relative to the project). */
export async function assetBytes(session: ProjectSession, src: string): Promise<Buffer> {
  if (src.startsWith("data:")) return Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  if (/^https?:/.test(src)) return Buffer.from(await (await fetch(src)).arrayBuffer());
  return readFile(path.isAbsolute(src) ? src : path.join(session.baseDir, src));
}

/** Copy of a document with every image, atlas page and audio file embedded as data: URIs (for self-contained exports). */
export async function embedAssets(session: ProjectSession, d: OpenBoneDocument): Promise<OpenBoneDocument> {
  const out = structuredClone(d);
  const embed = async (src: string) => {
    if (!src || src.startsWith("data:")) return src;
    const ext = src.split(".").pop()!.toLowerCase();
    return `data:${MIME[ext] ?? "application/octet-stream"};base64,${(await assetBytes(session, src)).toString("base64")}`;
  };
  for (const img of out.images) if (img.src) img.src = await embed(img.src);
  for (const p of out.atlas?.pages ?? []) p.src = await embed(p.src);
  for (const a of out.audio?.assets ?? []) a.src = await embed(a.src);
  return out;
}

/** Pack a (runtime) document's images into atlas pages with the dialog's settings; returns a packed copy and any warnings. */
export async function packDocument(session: ProjectSession, d: OpenBoneDocument, o: AtlasExportOptions = {}): Promise<{ doc: OpenBoneDocument; warnings: string[] }> {
  const out = structuredClone(d);
  if (!out.images.length) return { doc: out, warnings: [] };
  const { atlas, warnings } = await packAtlasFull(session, out, atlasBuildOptions(o));
  applyOp(out, "setAtlas", { atlas, stripImageSources: true });
  return { doc: out, warnings };
}

/** One packed copy per scale variant (`o.scales`), images loaded once. */
export async function packDocumentScales(session: ProjectSession, d: OpenBoneDocument, o: AtlasExportOptions): Promise<{ suffix: string; doc: OpenBoneDocument; warnings: string[] }[]> {
  const built = await packAtlasScales(session, d, atlasBuildOptions(o), o.scales ?? []);
  return built.map((b) => {
    const out = structuredClone(d);
    applyOp(out, "setAtlas", { atlas: b.atlas, stripImageSources: true });
    return { suffix: b.suffix, doc: out, warnings: b.warnings };
  });
}

/** Base name for exported files: the project file's name, else the document name. */
export function exportBaseName(session: ProjectSession): string {
  return (session.filePath ? path.basename(session.filePath).replace(/\.\w+$/, "") : session.doc.name || "openbone").replace(/[^\w.-]+/g, "_");
}

/** Export the session's document in one format. Pure apart from reading assets: the caller writes the bytes. */
export async function exportFile(session: ProjectSession, a: ExportRequest, scriptHost: () => Promise<ScriptHost>): Promise<ExportResult> {
  const doc = session.doc;
  const fps = a.fps ?? 30;
  const scale = a.scale ?? 1;
  const time = a.time ?? 0;
  const base = exportBaseName(session);
  const bg = a.transparent ? null : (doc.background ?? "#ffffff");
  const ids = (list: { id: string; name: string }[], names?: string[]) => (names ? list.filter((x) => names.includes(x.name) || names.includes(x.id)).map((x) => x.id) : undefined);
  const runtimeData = () =>
    exportDocument(doc, {
      animations: ids(doc.animations, a.animations) ?? doc.animations.filter((x) => x.export !== false).map((x) => x.id),
      stateMachines: ids(doc.stateMachines, a.stateMachines),
      nonessential: false,
    });
  const ext: Record<ExportFormat, string> = {
    obone: "obone",
    json: "json",
    obonb: "obonb",
    atlas: "zip",
    png: a.sequence ? "zip" : "png",
    jpeg: a.sequence ? "zip" : "jpg",
    apng: "png",
    gif: "gif",
    psd: "psd",
    avi: "avi",
    mov: "mov",
    mp4: "mp4",
    webm: "webm",
    spritesheet: "zip",
    web: a.singleFile ? "html" : "zip",
  };
  // Every ZIP format gets its own suffix, so exporting several formats into one folder never overwrites a file.
  const suffix =
    a.format === "apng" ? ".apng"
    : a.format === "spritesheet" ? `-spritesheet-${a.engine ?? "generic"}`
    : ext[a.format] === "zip" ? `-${a.format}`
    : "";
  const done = (bytes: Uint8Array, note = ""): ExportResult => ({ bytes, ext: ext[a.format], suffix, note });

  if (a.format === "obone") {
    // Paths are relative to the project folder: embedded, the file can be opened from anywhere (also in the web editor,
    // which can't read the files next to an opened file).
    const out = a.embed ? await embedAssets(session, doc) : doc;
    return done(new TextEncoder().encode(serialize(out)), a.embed ? " · images and audio embedded" : "");
  }
  if (a.format === "json" || a.format === "obonb") {
    const r = runtimeData();
    let d = r.doc;
    const warnings = [...r.warnings];
    if (a.pack && d.images.length) {
      const p = await packDocument(session, d, a.atlas);
      d = p.doc;
      warnings.push(...p.warnings);
    }
    if (a.embed) d = await embedAssets(session, d);
    const bytes = a.format === "json" ? new TextEncoder().encode(serialize(d)) : serializeBinary(d, { precision: "float32" });
    return done(bytes, warnings.length ? ` · ${warnings.join("; ")}` : "");
  }
  if (a.format === "atlas") {
    // Runtime data next to its atlas pages as separate image files (smaller JSON, cacheable textures); one set per scale.
    const r = runtimeData();
    if (!r.doc.images.length) throw new Error("No images to pack");
    const variants = a.atlas?.scales?.length ? await packDocumentScales(session, r.doc, a.atlas) : [{ suffix: "", ...(await packDocument(session, r.doc, a.atlas)) }];
    const files = atlasExportFiles(base, variants, { binary: a.binary ?? false });
    const warnings = [...new Set(variants.flatMap((v) => v.warnings))];
    const desc = variants.map((v) => `${variants.length > 1 ? `${v.suffix || "(base)"}: ` : ""}${describeAtlas(v.doc.atlas!)}`).join(" · ");
    return done(createZip(files), ` · ${desc}${warnings.length ? ` · ${warnings.join("; ")}` : ""}`);
  }
  if (a.format === "web") {
    const { buildWebBundle } = await import("@openbone/player/bundle");
    const minify = a.minify ?? true;
    const binary = a.binary ?? true;
    let rd = exportDocument(doc, { pruneUnused: true, nonessential: false }).doc;
    if (a.pack && rd.images.length) rd = (await packDocument(session, rd, a.atlas)).doc;
    const d = await embedAssets(session, rd);
    const docBytes = binary ? serializeBinary(d, { precision: "float32" }) : new TextEncoder().encode(serialize(d));
    const sm = (a.stateMachine ? d.stateMachines.find((m) => m.name === a.stateMachine) : null) ?? d.stateMachines[0];
    const hasScripts = d.scripts.length > 0;
    const lazy = hasScripts && !a.singleFile;
    const playerCode = await buildWebBundle({ format: "iife", minify, scripts: lazy ? "lazy" : hasScripts });
    let scriptsAddon: { code: string; wasm: Uint8Array } | undefined;
    if (lazy) {
      const { buildScriptsAddon, quickJsWasmBytes } = await import("@openbone/player/bundle");
      scriptsAddon = { code: await buildScriptsAddon({ minify }), wasm: quickJsWasmBytes() };
    }
    const pack = {
      title: doc.name || base,
      baseName: base,
      playerCode,
      format: "iife" as const,
      minified: minify,
      scripts: hasScripts,
      scriptsAddon,
      doc: docBytes,
      docExt: (binary ? "obonb" : "obone") as "obonb" | "obone",
      singleFile: !!a.singleFile,
      demoControls: true,
      stateMachine: sm?.name,
      animation: sm ? undefined : (a.animation ?? d.animations[0]?.name),
      width: d.width,
      height: d.height,
      background: a.transparent ? "transparent" : undefined,
      inputs: sm?.inputs.map((i) => ({ name: i.name, type: i.type })) ?? [],
      hasScripts,
      hasAudio: !!d.audio?.assets.length,
      buses: d.audio?.buses.map((b) => b.name) ?? [],
    };
    return done(a.singleFile ? new TextEncoder().encode(webIndexHtml(pack)) : webPackZip(pack));
  }
  if (a.format === "spritesheet") {
    const names = a.animations ?? doc.animations.filter((x) => x.export !== false).map((x) => x.name);
    if (!names.length) throw new Error("No animations to put on the sheet");
    const clips = [];
    for (const name of names) {
      const frames = await renderFrames(session, { animation: name, skin: a.skin, fps, scale, background: bg }, await scriptHost());
      clips.push({ name, fps, loop: true, frames });
    }
    const set = buildSpriteSheets(clips, { trim: true, padding: 2, maxSize: 2048 });
    const bytes = await enginePackZip(a.engine ?? "generic", set, { name: base, scale });
    return done(bytes, ` · ${set.pages.length} sheet(s), ${clips.reduce((n, c) => n + c.frames.length, 0)} frames`);
  }
  const single = (a.format === "png" || a.format === "jpeg") && !a.sequence;
  const video = a.format === "avi" || a.format === "mov" || a.format === "mp4" || a.format === "webm";
  const timed: TimedMixCommand[] | undefined = video && a.audio !== false ? [] : undefined;
  const flat = doc.background ?? "#ffffff";
  const frames = single
    ? await (async () => {
        // One frame at `time`: run up to it at the export frame rate (one big step would skip the state machine steps
        // scheduled in between, e.g. a trigger fired at 0.5 s for a frame at 2 s) and keep the last frame.
        const fr = await renderFrames(
          session,
          { animation: a.animation, stateMachine: a.stateMachine, steps: a.steps, skin: a.skin, duration: time + 1 / fps, fps, scale, background: a.format === "jpeg" ? flat : bg },
          await scriptHost(),
        );
        return [fr[fr.length - 1]];
      })()
    : await renderFrames(
        session,
        { animation: a.animation, stateMachine: a.stateMachine, steps: a.steps, skin: a.skin, duration: a.duration, fps, scale, background: a.format === "jpeg" || video ? flat : bg },
        await scriptHost(),
        timed,
      );
  const { width, height } = frames[0];
  const delayMs = Math.round(1000 / fps);
  let bytes: Uint8Array;
  if (a.format === "png") bytes = single ? await encodePng(frames[0]) : createZip(await Promise.all(frames.map(async (f, i) => ({ name: `${base}_${String(i + 1).padStart(4, "0")}.png`, data: await encodePng(f) }))));
  else if (a.format === "jpeg") bytes = single ? jpegOf(frames[0], flat) : createZip(frames.map((f, i) => ({ name: `${base}_${String(i + 1).padStart(4, "0")}.jpg`, data: jpegOf(f, flat) })));
  else if (a.format === "apng") bytes = await encodeApng(frames, { delayMs });
  else if (a.format === "gif") bytes = encodeGif(frames, { delayMs, transparent: !!a.transparent });
  else if (a.format === "psd") bytes = encodePsd(frames.map((f, i) => ({ name: `frame ${i + 1}`, frame: f })));
  let sound = "";
  if (video) {
    // The sound track: what the run played, mixed like the players mix it.
    let mix: ReturnType<typeof mixAudioCommands> = null;
    if (timed?.length) {
      const decoded = new Map<string, Awaited<ReturnType<typeof decodeAudio>>>();
      for (const c of timed)
        if (c.command.type === "play" && !decoded.has(c.command.asset)) {
          const asset = doc.audio?.assets.find((x) => x.id === (c.command as { asset: string }).asset);
          decoded.set(c.command.asset, asset ? await decodeAudio(await assetBytes(session, asset.src)).catch(() => null) : null);
        }
      const missing = new Set<string>();
      mix = mixAudioCommands(doc, timed, frames.length / fps, (id) => decoded.get(id) ?? null, { missing });
      const names = [...missing].map((id) => doc.audio?.assets.find((x) => x.id === id)?.name ?? id);
      if (names.length) sound = ` · without ${names.join(", ")} (${findFfmpeg() ? "could not be decoded" : "only WAV decodes without ffmpeg on the PATH"})`;
      if (mix) sound = ` · with sound${sound}`;
    }
    if (a.format === "mp4" || a.format === "webm") bytes = await encodeVideoFfmpeg(frames, { format: a.format, fps, quality: a.quality, audio: mix });
    else bytes = (a.format === "avi" ? encodeAviMjpeg : encodeMovMjpeg)(frames.map((f) => jpegOf(f, flat)), { width, height, fps, audio: mix ? floatToPcm(mix.channels, mix.sampleRate) : null });
  } else if (!bytes!) throw new Error(`Unknown format ${a.format}`);
  return done(bytes, single ? "" : ` · ${frames.length} frames at ${fps} fps, ${width}×${height}${sound}`);
}
