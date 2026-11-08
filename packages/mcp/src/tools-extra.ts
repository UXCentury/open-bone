import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  type MouthShape,
  type OpenBoneDocument,
  animationDuration,
  exportDocument,
  guessMouthMapping,
  lipSync,
  serialize,
  serializeBinary,
  slotAttachments,
  traceMesh,
} from "@openbone/core";
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
  enginePackZip,
  webPackZip,
  webIndexHtml,
} from "@openbone/export";
import { CanvasRenderer, type Ctx2D } from "@openbone/render-canvas";
import { OpenBoneInstance, type ScriptHost, Skeleton, applyAnimation, poseChainFrom, solvePose } from "@openbone/runtime";
import { z } from "zod";
import { loadImages, useSkin } from "./render.ts";
import type { ProjectSession } from "./session.ts";

/**
 * MCP tools for what the editor does beyond plain ops: every export format, automatic mesh tracing, lip sync, the
 * Pose tool (IK drag) and skeleton stats.
 */

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });

type Step = { advance?: number; setInputs?: Record<string, boolean | number | string>; fire?: string[]; pointer?: { type: "down" | "up" | "move"; x: number; y: number } };

/** Render frames of an animation or a state machine run (RGBA, artboard size × scale). */
async function renderFrames(
  session: ProjectSession,
  req: { animation?: string; stateMachine?: string; steps?: Step[]; skin?: string; duration?: number; fps: number; scale: number; background: string | null },
  scriptHost?: ScriptHost,
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
  for (let f = 0; f < count; f++) {
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
function jpegOf(f: Frame, bg: string, quality = 90): Uint8Array {
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
async function assetBytes(session: ProjectSession, src: string): Promise<Buffer> {
  if (src.startsWith("data:")) return Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  if (/^https?:/.test(src)) return Buffer.from(await (await fetch(src)).arrayBuffer());
  return readFile(path.isAbsolute(src) ? src : path.join(session.baseDir, src));
}

/** Copy of a document with every image, atlas page and audio file embedded as data: URIs (for self-contained exports). */
async function embedAssets(session: ProjectSession, d: OpenBoneDocument): Promise<OpenBoneDocument> {
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

/** Mono samples of a PCM WAV (8/16/24/32-bit int or 32-bit float). */
function decodeWav(b: Buffer): { samples: Float32Array; rate: number } {
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Lip sync reads WAV files (convert MP3/OGG to WAV first)");
  let p = 12;
  let fmt = { format: 1, channels: 1, rate: 44100, bits: 16 };
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    else if (id === "data") {
      const bytes = fmt.bits / 8;
      const n = Math.floor(size / bytes / fmt.channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = p + 8 + (i * fmt.channels + c) * bytes;
          v +=
            fmt.format === 3 ? b.readFloatLE(o) : fmt.bits === 8 ? (b[o] - 128) / 128 : fmt.bits === 16 ? b.readInt16LE(o) / 32768 : fmt.bits === 24 ? b.readIntLE(o, 3) / 8388608 : b.readInt32LE(o) / 2147483648;
        }
        samples[i] = v / fmt.channels;
      }
      return { samples, rate: fmt.rate };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no audio data");
}

const stepSchema = z.object({
  advance: z.number().min(0).optional(),
  setInputs: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
  fire: z.array(z.string()).optional(),
  pointer: z.object({ type: z.enum(["down", "up", "move"]), x: z.number(), y: z.number() }).optional(),
});

export function registerExtraTools(server: McpServer, session: ProjectSession, scriptHost: () => Promise<ScriptHost>) {
  const commit = async () => session.maybeAutosave();

  // ---------------- export ----------------
  server.registerTool(
    "export_file",
    {
      description:
        "Export the project like the editor's Export dialog. Formats: obone (whole project), json / obonb (runtime data: picked animations, state machines; obonb is binary), png / jpeg (one frame, or a ZIP of every frame with sequence: true), apng, gif, psd (one layer per frame), avi / mov (Motion-JPEG video), spritesheet (engine packs: engine unity | godot | flutter | generic; one clip per animation), web (the <openbone-player> library + animation + demo page as a ZIP, or one self-contained HTML file with singleFile). Frames come from `animation` (default the first) or a state machine run (`stateMachine` + `steps`). Writes to `out` (default next to the project) and returns the path and size.",
      inputSchema: {
        format: z.enum(["obone", "json", "obonb", "png", "jpeg", "apng", "gif", "psd", "avi", "mov", "spritesheet", "web"]),
        out: z.string().optional().describe("Output path (default <project>.<ext> next to the project)"),
        animation: z.string().optional(),
        stateMachine: z.string().optional(),
        steps: z.array(stepSchema).optional(),
        skin: z.string().optional(),
        animations: z.array(z.string()).optional().describe("json/obonb: animations to keep (names; default all marked for export). spritesheet: clips (default all exported animations)"),
        stateMachines: z.array(z.string()).optional().describe("json/obonb: state machines to keep (default all)"),
        duration: z.number().positive().max(60).optional().describe("Seconds (default the animation's length, or 2 for state machines)"),
        fps: z.number().int().min(1).max(60).default(30),
        scale: z.number().positive().max(4).default(1),
        transparent: z.boolean().default(false).describe("Transparent background (png, apng, gif, psd, spritesheet)"),
        sequence: z.boolean().default(false).describe("png/jpeg: every frame in a ZIP instead of one frame"),
        time: z.number().min(0).default(0).describe("png/jpeg single frame: time in the animation"),
        engine: z.enum(["unity", "godot", "flutter", "generic"]).default("generic"),
        singleFile: z.boolean().default(false).describe("web: one HTML file (works from file://)"),
        minify: z.boolean().default(true).describe("web: minified player"),
        binary: z.boolean().default(true).describe("web: animation as .obonb (smaller)"),
      },
    },
    async (a) => {
      try {
        const doc = session.doc;
        const base = (session.filePath ? path.basename(session.filePath).replace(/\.\w+$/, "") : doc.name || "openbone").replace(/[^\w.-]+/g, "_");
        const extOf: Record<string, string> = { obone: "obone", json: "json", obonb: "obonb", png: a.sequence ? "zip" : "png", jpeg: a.sequence ? "zip" : "jpg", apng: "png", gif: "gif", psd: "psd", avi: "avi", mov: "mov", spritesheet: "zip", web: a.singleFile ? "html" : "zip" };
        const out = path.resolve(session.baseDir, a.out ?? `${base}${a.format === "apng" ? ".apng" : ""}.${extOf[a.format]}`);
        const bg = a.transparent ? null : (doc.background ?? "#ffffff");
        const ids = (list: { id: string; name: string }[], names?: string[]) => (names ? list.filter((x) => names.includes(x.name) || names.includes(x.id)).map((x) => x.id) : undefined);
        let bytes: Uint8Array;
        let note = "";
        if (a.format === "obone") bytes = new TextEncoder().encode(serialize(doc));
        else if (a.format === "json" || a.format === "obonb") {
          const r = exportDocument(doc, {
            animations: ids(doc.animations, a.animations) ?? doc.animations.filter((x) => x.export !== false).map((x) => x.id),
            stateMachines: ids(doc.stateMachines, a.stateMachines),
            nonessential: false,
          });
          bytes = a.format === "json" ? new TextEncoder().encode(serialize(r.doc)) : serializeBinary(r.doc, { precision: "float32" });
          note = r.warnings.length ? ` · ${r.warnings.join("; ")}` : "";
        } else if (a.format === "web") {
          const { buildWebBundle } = await import("../../player/src/bundle/build.ts");
          const d = await embedAssets(session, exportDocument(doc, { pruneUnused: true, nonessential: false }).doc);
          const docBytes = a.binary ? serializeBinary(d, { precision: "float32" }) : new TextEncoder().encode(serialize(d));
          const sm = (a.stateMachine ? d.stateMachines.find((m) => m.name === a.stateMachine) : null) ?? d.stateMachines[0];
          const hasScripts = d.scripts.length > 0;
          const lazy = hasScripts && !a.singleFile;
          const playerCode = await buildWebBundle({ format: "iife", minify: a.minify, scripts: lazy ? "lazy" : hasScripts });
          let scriptsAddon: { code: string; wasm: Uint8Array } | undefined;
          if (lazy) {
            const { buildScriptsAddon, quickJsWasmBytes } = await import("../../player/src/bundle/build.ts");
            scriptsAddon = { code: await buildScriptsAddon({ minify: a.minify }), wasm: quickJsWasmBytes() };
          }
          const pack = {
            title: doc.name || base,
            baseName: base,
            playerCode,
            format: "iife" as const,
            minified: a.minify,
            scripts: hasScripts,
            scriptsAddon,
            doc: docBytes,
            docExt: (a.binary ? "obonb" : "obone") as "obonb" | "obone",
            singleFile: a.singleFile,
            demoControls: true,
            stateMachine: sm?.name,
            animation: sm ? undefined : (a.animation ?? d.animations[0]?.name),
            width: d.width,
            height: d.height,
            background: a.transparent ? "transparent" : undefined,
            inputs: sm?.inputs.map((i) => ({ name: i.name, type: i.type })) ?? [],
            hasScripts,
            hasAudio: !!d.audio?.assets.length,
          };
          bytes = a.singleFile ? new TextEncoder().encode(webIndexHtml(pack)) : webPackZip(pack);
        } else if (a.format === "spritesheet") {
          const names = a.animations ?? doc.animations.filter((x) => x.export !== false).map((x) => x.name);
          if (!names.length) throw new Error("No animations to put on the sheet");
          const clips = [];
          for (const name of names) {
            const frames = await renderFrames(session, { animation: name, skin: a.skin, fps: a.fps, scale: a.scale, background: bg }, await scriptHost());
            clips.push({ name, fps: a.fps, loop: true, frames });
          }
          const set = buildSpriteSheets(clips, { trim: true, padding: 2, maxSize: 2048 });
          bytes = await enginePackZip(a.engine as SheetEngine, set, { name: base, scale: a.scale });
          note = ` · ${set.pages.length} sheet(s), ${clips.reduce((n, c) => n + c.frames.length, 0)} frames`;
        } else {
          const single = (a.format === "png" || a.format === "jpeg") && !a.sequence;
          const frames = single
            ? await (async () => {
                // One frame at `time`: advance a single step to it.
                const fps = a.time > 0 ? 1 / a.time : a.fps;
                const fr = await renderFrames(session, { animation: a.animation, stateMachine: a.stateMachine, steps: a.steps, skin: a.skin, duration: a.time > 0 ? 2 / fps : 1 / a.fps, fps, scale: a.scale, background: a.format === "jpeg" ? (doc.background ?? "#ffffff") : bg }, await scriptHost());
                return [fr[fr.length - 1]];
              })()
            : await renderFrames(session, { animation: a.animation, stateMachine: a.stateMachine, steps: a.steps, skin: a.skin, duration: a.duration, fps: a.fps, scale: a.scale, background: a.format === "jpeg" || a.format === "avi" || a.format === "mov" ? (doc.background ?? "#ffffff") : bg }, await scriptHost());
          const { width, height } = frames[0];
          const delayMs = Math.round(1000 / a.fps);
          const flat = doc.background ?? "#ffffff";
          if (a.format === "png") bytes = single ? await encodePng(frames[0]) : createZip(await Promise.all(frames.map(async (f, i) => ({ name: `${base}_${String(i + 1).padStart(4, "0")}.png`, data: await encodePng(f) }))));
          else if (a.format === "jpeg") bytes = single ? jpegOf(frames[0], flat) : createZip(frames.map((f, i) => ({ name: `${base}_${String(i + 1).padStart(4, "0")}.jpg`, data: jpegOf(f, flat) })));
          else if (a.format === "apng") bytes = await encodeApng(frames, { delayMs });
          else if (a.format === "gif") bytes = encodeGif(frames, { delayMs, transparent: a.transparent });
          else if (a.format === "psd") bytes = encodePsd(frames.map((f, i) => ({ name: `frame ${i + 1}`, frame: f })));
          else bytes = (a.format === "avi" ? encodeAviMjpeg : encodeMovMjpeg)(frames.map((f) => jpegOf(f, flat)), { width, height, fps: a.fps });
          if (!single) note = ` · ${frames.length} frames at ${a.fps} fps, ${width}×${height}`;
        }
        await writeFile(out, bytes);
        return text(`Saved ${out} (${(bytes.length / 1024).toFixed(1)} KB)${note}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- trace mesh ----------------
  server.registerTool(
    "trace_mesh",
    {
      description:
        "Replace a region attachment with a mesh traced from its image's visible pixels (like the editor's Trace mesh): less transparent area is drawn and the mesh can bend. Keeps the region's place, size, rotation and tint. maxHull: outline detail (16 simple, 48 balanced, 96 detailed); interior: about N×N inner vertices for bending (0 = outline only).",
      inputSchema: {
        slot: z.string(),
        attachment: z.string().optional().describe("Region attachment name (default the slot's current one)"),
        maxHull: z.number().int().min(3).max(200).default(48),
        interior: z.number().int().min(0).max(32).default(4),
        padding: z.number().min(0).max(32).default(2),
        threshold: z.number().int().min(0).max(254).default(8).describe("Alpha above this counts as visible"),
      },
    },
    async (a) => {
      try {
        const doc = session.doc;
        const slot = doc.skeleton.slots.find((s) => s.name === a.slot || s.id === a.slot);
        if (!slot) throw new Error(`Slot "${a.slot}" not found`);
        const name = a.attachment ?? slot.attachment;
        const found = slotAttachments(doc, slot.id).find((x) => x.name === name);
        const r = found?.attachment;
        if (!r || r.type !== "region") throw new Error(`"${name}" on slot "${slot.name}" is not a region attachment`);
        const img = doc.images.find((i) => i.id === r.image);
        if (!img?.src) throw new Error("The image has no file of its own (packed in an atlas)");
        const el = await loadImage(await session.readImageSrc(img.src));
        const c = createCanvas(el.width, el.height);
        const g = c.getContext("2d");
        g.drawImage(el, 0, 0);
        const px = g.getImageData(0, 0, el.width, el.height).data;
        const alpha = new Uint8ClampedArray(el.width * el.height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
        const spacing = a.interior ? Math.max(6, Math.min(el.width, el.height) / a.interior) : 0;
        const mesh = traceMesh(alpha, el.width, el.height, { x: r.x, y: r.y, width: r.width, height: r.height, scaleX: r.scaleX, scaleY: r.scaleY, rotation: r.rotation }, { maxHull: a.maxHull, padding: a.padding, threshold: a.threshold, interior: spacing });
        if (!mesh) throw new Error("Nothing visible to trace in this image");
        session.store.transaction("trace mesh", (s) => {
          s.apply("deleteAttachment", { slot: slot.id, attachment: r.name, skin: found!.skin.id });
          s.apply("addMesh", { slot: slot.id, skin: found!.skin.id, name: r.name, image: r.image, ...mesh, color: r.color });
        });
        await commit();
        return text({ ok: true, outline: mesh.hull, inner: mesh.vertices.length / 2 - mesh.hull, triangles: mesh.triangles.length / 3 });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- lip sync ----------------
  server.registerTool(
    "lip_sync",
    {
      description:
        "Lip sync: analyse a sound (WAV) and key a mouth slot's attachments to it, stepped, starting at `start` seconds in `animation` (created if missing); the sound is added to the animation's audio track. Six shapes: rest, closed (M/B/P), small, open, wide, round; the slot's attachment names are guessed per shape unless `mapping` is given.",
      inputSchema: {
        sound: z.string().describe("Sound name or id"),
        slot: z.string().describe("Mouth slot with one attachment per mouth shape"),
        animation: z.string().optional().describe("Animation name (default: a new 'lipsync <sound>' animation)"),
        start: z.number().min(0).default(0),
        mapping: z.record(z.enum(["rest", "closed", "small", "open", "wide", "round"]), z.string()).optional().describe("Shape → attachment name"),
      },
    },
    async (a) => {
      try {
        const doc = session.doc;
        const sound = doc.audio?.sounds.find((s) => s.name === a.sound || s.id === a.sound);
        if (!sound) throw new Error(`Sound "${a.sound}" not found`);
        const asset = doc.audio?.assets.find((x) => x.id === sound.asset);
        if (!asset) throw new Error("The sound has no audio file");
        const slot = doc.skeleton.slots.find((s) => s.name === a.slot || s.id === a.slot);
        if (!slot) throw new Error(`Slot "${a.slot}" not found`);
        const names = slotAttachments(doc, slot.id).map((x) => x.name);
        if (names.length < 2) throw new Error("The mouth slot needs two or more attachments (one per mouth shape)");
        const map = { ...guessMouthMapping(names), ...(a.mapping ?? {}) } as Record<MouthShape, string>;
        const { samples, rate } = decodeWav(await assetBytes(session, asset.src));
        const keys = lipSync(samples, rate, { fps: doc.fps });
        const speed = sound.rate ?? 1;
        const fps = doc.fps;
        const snap = (t: number) => Math.round(t * fps) / fps;
        const end = a.start + samples.length / rate / speed;
        let animName = a.animation ?? `lipsync ${sound.name}`;
        session.store.transaction("lip sync", (s) => {
          let anim = s.doc.animations.find((x) => x.name === animName || x.id === animName);
          if (!anim) {
            s.apply("createAnimation", { name: animName });
            anim = s.doc.animations.find((x) => x.name === animName)!;
          }
          animName = anim.name;
          const tl = anim.timelines.find((t) => t.target === "slot" && t.id === slot.id && t.property === "attachment");
          for (const k of [...((tl?.keys as { time: number }[]) ?? [])])
            if (k.time >= a.start - 1e-6 && k.time <= end + 1e-6) s.apply("deleteKey", { animation: anim.id, target: "slot", id: slot.id, property: "attachment", time: k.time });
          s.apply("setKeys", { animation: anim.id, target: "slot", id: slot.id, property: "attachment", keys: keys.map((k) => ({ time: snap(a.start + k.time / speed), value: map[k.shape], curve: "stepped" })) });
          s.apply("addAudioKey", { animation: anim.id, sound: sound.id, time: a.start });
          if (anim.duration > 0 && end > anim.duration) s.apply("updateAnimation", { animation: anim.id, duration: snap(end) });
        });
        await commit();
        const used = [...new Set(keys.map((k) => k.shape))].map((sh) => `${sh}→${map[sh]}`).join(", ");
        return text({ ok: true, animation: animName, keys: keys.length, seconds: Math.round((end - a.start) * 100) / 100, shapes: used });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- pose tool ----------------
  server.registerTool(
    "pose_bones",
    {
      description:
        "Pose tool (inverse kinematics without a constraint): bend `bone` and up to `chain`-1 of its parents so the bone's tip reaches a target point, given in ARTBOARD pixels (y-down, top-left origin; the same space as render_frame). Without `animation` it changes the setup pose; with `animation` (+ `time`) it sets rotation keys there. The root bone never moves.",
      inputSchema: {
        bone: z.string(),
        x: z.number(),
        y: z.number(),
        chain: z.number().int().min(1).max(32).default(3),
        animation: z.string().optional(),
        time: z.number().min(0).default(0),
      },
    },
    async (a) => {
      try {
        const doc = session.doc;
        const sk = new Skeleton(doc);
        const anim = a.animation ? doc.animations.find((x) => x.name === a.animation || x.id === a.animation) : undefined;
        if (a.animation && !anim) throw new Error(`Animation "${a.animation}" not found`);
        sk.setToSetupPose();
        if (anim) applyAnimation(sk, anim, a.time);
        sk.updateWorldTransform();
        const bone = sk.findBone(a.bone) ?? sk.bones.find((b) => b.data.id === a.bone);
        if (!bone) throw new Error(`Bone "${a.bone}" not found`);
        const [tx, ty] = new OpenBoneInstance(doc).artboardToSkeleton(a.x, a.y);
        const chain = poseChainFrom(bone, a.chain);
        const before = new Map(chain.map((b) => [b, b.rotation]));
        const miss = solvePose({ bones: chain, local: [Math.max(bone.data.length, 0), 0] }, tx, ty);
        const changed = chain.filter((b) => Math.abs(b.rotation - before.get(b)!) > 1e-4);
        session.store.transaction("pose bones", (s) => {
          for (const b of changed) {
            const rotation = Math.round(b.rotation * 100) / 100;
            if (anim) s.apply("setKeys", { animation: anim.id, target: "bone", id: b.data.id, property: "rotation", keys: [{ time: a.time, value: rotation }] });
            else s.apply("updateBone", { bone: b.data.id, rotation });
          }
        });
        await commit();
        return text({ ok: true, bones: changed.map((b) => `${b.data.name} ${Math.round(b.rotation * 10) / 10}°`), reached: miss < 0.5, distanceLeft: Math.round(miss * 10) / 10 });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- stats ----------------
  server.registerTool(
    "get_stats",
    {
      description: "Skeleton statistics like the editor's Stats panel: bones, slots, constraints, visible/total attachments, vertices, weighted vertex transforms, triangles, clipping masks, estimated draw calls, images and image area.",
      inputSchema: { skin: z.string().optional() },
    },
    async (a) => {
      try {
        const d = session.doc;
        const sk = d.skeleton;
        const s = new Skeleton(d);
        if (a.skin) s.setSkin(a.skin);
        s.updateWorldTransform();
        let totalAtt = 0;
        for (const skin of sk.skins) for (const atts of Object.values(skin.attachments)) totalAtt += Object.keys(atts).length;
        let vertices = 0;
        let transforms = 0;
        let triangles = 0;
        let clipping = 0;
        let visible = 0;
        for (const slot of s.slots) {
          const att = s.getAttachment(slot);
          if (!att) continue;
          visible++;
          if (att.type === "clipping") clipping++;
          if (att.type === "mesh") {
            const n = att.vertices.length / 2;
            vertices += n;
            transforms += att.weights ? att.weights.reduce((t, w) => t + w.length, 0) : n;
            triangles += att.triangles.length / 3;
          } else if (att.type === "region" || att.type === "sequence") {
            vertices += 4;
            transforms += 4;
            triangles += 2;
          }
        }
        let calls = 0;
        let last = "";
        for (const it of s.drawList()) {
          const key = `${it.texture?.id ?? it.image?.id ?? "solid"}|${it.blend}|${it.clip ? "clip" : ""}`;
          if (key !== last) calls++;
          last = key;
        }
        return text({
          bones: sk.bones.length,
          slots: sk.slots.length,
          constraints: { ik: sk.ik.length, transform: sk.transform.length, path: sk.path.length, physics: sk.physics.length, sliders: sk.sliders?.length ?? 0 },
          attachments: { visible, total: totalAtt },
          vertices,
          vertexTransforms: transforms,
          triangles,
          clippingMasks: clipping,
          drawCallsEstimate: calls,
          images: d.images.length,
          atlasPages: d.atlas?.pages.length ?? 0,
          imageMegapixels: Math.round((d.images.reduce((t, i) => t + i.width * i.height, 0) / 1e6) * 100) / 100,
          animations: d.animations.length,
          stateMachines: d.stateMachines.length,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
