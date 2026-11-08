import { type OpenBoneDocument, animationDuration, textureAssets } from "@openbone/core";
import { type Frame, createZip, encodeApng, encodeAviMjpeg, encodeGif, encodeMovMjpeg, encodePng, encodePsd } from "@openbone/export";
import { CanvasRenderer } from "@openbone/render-canvas";
import { Skeleton, seekAnimation } from "@openbone/runtime";
import { mixAnimationAudio } from "./export-audio.ts";
import { encodeMp4 } from "./export-mp4.ts";
import { resolveImageUrl } from "./images.ts";

/** Image and video exports: render an animation offscreen, then encode the frames. */

export type MediaFormat = "png" | "jpeg" | "gif" | "apng" | "psd" | "avi" | "mov" | "mp4";

export interface MediaOptions {
  /** Animation id, or null for the setup pose (one frame). */
  animation: string | null;
  skin: string | null;
  fps: number;
  /** Output pixels per artboard pixel. */
  scale: number;
  /** "artboard": the artboard rectangle; "content": tight bounds of everything drawn over the animation. */
  area: "artboard" | "content";
  padding: number;
  /** Background colour, or null for transparent (PNG, GIF, APNG, PSD only). */
  background: string | null;
  /** PNG/JPEG/PSD: false = one frame at `time`; true = every frame. */
  sequence: boolean;
  time: number;
  /** JPEG, AVI and MOV quality 0..1. */
  quality: number;
  /** GIF/APNG: 0 = loop forever, 1 = play once. */
  loops: number;
  /** Video: include the animation's sound (audio keys and event sounds). Default true. */
  audio?: boolean;
}

export const MEDIA: Record<MediaFormat, { label: string; ext: string; mime: string; animated: boolean; alpha: boolean; video?: boolean }> = {
  png: { label: "PNG", ext: "png", mime: "image/png", animated: false, alpha: true },
  jpeg: { label: "JPEG", ext: "jpg", mime: "image/jpeg", animated: false, alpha: false },
  gif: { label: "GIF", ext: "gif", mime: "image/gif", animated: true, alpha: true },
  apng: { label: "APNG", ext: "png", mime: "image/apng", animated: true, alpha: true },
  psd: { label: "PSD", ext: "psd", mime: "image/vnd.adobe.photoshop", animated: false, alpha: true },
  avi: { label: "AVI", ext: "avi", mime: "video/x-msvideo", animated: true, alpha: false, video: true },
  mov: { label: "MOV", ext: "mov", mime: "video/quicktime", animated: true, alpha: false, video: true },
  mp4: { label: "MP4", ext: "mp4", mime: "video/mp4", animated: true, alpha: false, video: true },
};

/** Frame times for an export: every 1/fps over the animation (a loop's end frame equals its first, so it is skipped). */
export function frameTimes(doc: OpenBoneDocument, o: Pick<MediaOptions, "animation" | "fps" | "sequence" | "time">, format: MediaFormat): number[] {
  const anim = o.animation ? doc.animations.find((a) => a.id === o.animation) : null;
  const all = MEDIA[format].animated || o.sequence;
  if (!anim || !all) return [anim ? Math.max(0, o.time) : 0];
  const n = Math.max(1, Math.round(animationDuration(anim) * o.fps));
  return Array.from({ length: n }, (_, i) => i / o.fps);
}

async function loadTextures(doc: OpenBoneDocument): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  await Promise.all(
    textureAssets(doc).map(
      (t) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => (map.set(t.id, img), resolve());
          img.onerror = () => resolve();
          img.src = resolveImageUrl(t);
        }),
    ),
  );
  return map;
}

export interface RenderedFrames {
  frames: Frame[];
  width: number;
  height: number;
  /** The canvas the frames were drawn on (re-used to make JPEGs). */
  canvas: HTMLCanvasElement;
}

/** Render the frames for an export. `onProgress` gets 0..1. */
export async function renderFrames(doc: OpenBoneDocument, o: MediaOptions, format: MediaFormat, onProgress?: (p: number) => void): Promise<RenderedFrames> {
  const textures = await loadTextures(doc);
  const sk = new Skeleton(doc);
  if (o.skin) sk.setSkin(o.skin);
  const anim = o.animation ? doc.animations.find((a) => a.id === o.animation) ?? null : null;
  const times = frameTimes(doc, o, format);
  // Particles are replayed from time 0, so each frame matches what the timeline shows at that time.
  const pose = (t: number) => seekAnimation(sk, anim, t);
  // Area in artboard pixels (y-down).
  let ax = 0;
  let ay = 0;
  let aw = doc.width;
  let ah = doc.height;
  if (o.area === "content") {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const t of times) {
      pose(t);
      const b = sk.bounds();
      if (!Number.isFinite(b.minX)) continue;
      minX = Math.min(minX, b.minX);
      maxX = Math.max(maxX, b.maxX);
      minY = Math.min(minY, b.minY);
      maxY = Math.max(maxY, b.maxY);
    }
    if (Number.isFinite(minX)) {
      ax = minX + doc.originX - o.padding;
      ay = doc.originY - maxY - o.padding;
      aw = maxX - minX + o.padding * 2;
      ah = maxY - minY + o.padding * 2;
    }
  }
  const even = MEDIA[format].video; // video players prefer even dimensions
  let width = Math.max(1, Math.round(aw * o.scale));
  let height = Math.max(1, Math.round(ah * o.scale));
  if (even) {
    width += width % 2;
    height += height % 2;
  }
  if (width * height > 4096 * 4096) throw new Error(`Output is too large (${width}×${height}); lower the scale`);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const r = new CanvasRenderer(ctx, (id) => textures.get(id) ?? null);
  const view = { x: -ax * o.scale, y: -ay * o.scale, zoom: o.scale };
  const bg = MEDIA[format].alpha ? o.background : (o.background ?? doc.background ?? "#ffffff");
  const frames: Frame[] = [];
  for (let i = 0; i < times.length; i++) {
    pose(times[i]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
    }
    r.render(sk, { view, clear: false });
    frames.push({ width, height, data: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer) });
    onProgress?.((i + 1) / times.length);
    if (i % 8 === 7) await new Promise((res) => setTimeout(res)); // keep the UI responsive
  }
  return { frames, width, height, canvas };
}

function jpegOf(f: Frame, canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(f.width, f.height);
  img.data.set(f.data);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error("JPEG encoding failed"))), "image/jpeg", quality),
  );
}

export interface MediaFile {
  name: string;
  data: Uint8Array;
  mime: string;
  ext: string;
  description: string;
  /** Things the user should know about the result (e.g. the sound codec used). */
  warnings?: string[];
}

/** Render and encode. Sequences of PNG/JPEG frames become a ZIP. */
export async function exportMedia(doc: OpenBoneDocument, o: MediaOptions, format: MediaFormat, baseName: string, onProgress?: (stage: string, p: number) => void): Promise<MediaFile> {
  const info = MEDIA[format];
  const { frames, width, height, canvas } = await renderFrames(doc, o, format, (p) => onProgress?.("Rendering", p));
  onProgress?.("Encoding", 0);
  const delayMs = 1000 / o.fps;
  const pad = (i: number) => String(i + 1).padStart(String(frames.length).length < 4 ? 4 : String(frames.length).length, "0");
  const file = (data: Uint8Array, ext = info.ext, mime = info.mime, description = info.label): MediaFile => ({ name: `${baseName}.${ext}`, data, mime, ext, description });
  switch (format) {
    case "png":
    case "jpeg": {
      const encode = (f: Frame) => (format === "png" ? encodePng(f) : jpegOf(f, canvas, o.quality));
      if (frames.length === 1) return file(await encode(frames[0]));
      const entries = [];
      for (let i = 0; i < frames.length; i++) {
        entries.push({ name: `${baseName}_${pad(i)}.${info.ext}`, data: await encode(frames[i]) });
        onProgress?.("Encoding", (i + 1) / frames.length);
      }
      return file(createZip(entries), "zip", "application/zip", `${info.label} sequence (ZIP)`);
    }
    case "gif":
      return file(encodeGif(frames, { delayMs, loops: o.loops, transparent: o.background === null }));
    case "apng":
      return file(await encodeApng(frames, { delayMs, loops: o.loops }), "png", "image/png", "Animated PNG");
    case "psd":
      return file(encodePsd(frames.map((f, i) => ({ name: frames.length > 1 ? `frame ${pad(i)}` : baseName, frame: f }))));
    case "avi":
    case "mov":
    case "mp4": {
      // Sound: what the animation plays over the video's length (frames / fps).
      const anim = o.animation ? doc.animations.find((a) => a.id === o.animation) : null;
      onProgress?.("Mixing sound", 0);
      const mix = anim && o.audio !== false ? await mixAnimationAudio(doc, anim, frames.length / o.fps) : null;
      if (format === "mp4") {
        const r = await encodeMp4(frames, { width, height, fps: o.fps, quality: o.quality, audio: mix }, (p) => onProgress?.("Encoding", p));
        const sound = r.audioCodec ? `, ${r.audioCodec === "aac" ? "AAC" : "Opus"} sound` : "";
        return { ...file(r.data, "mp4", info.mime, `MP4 (H.264${sound})`), warnings: r.warnings };
      }
      const jpegs: Uint8Array[] = [];
      for (let i = 0; i < frames.length; i++) {
        jpegs.push(await jpegOf(frames[i], canvas, o.quality));
        onProgress?.("Encoding", (i + 1) / frames.length);
      }
      const enc = format === "avi" ? encodeAviMjpeg : encodeMovMjpeg;
      return file(enc(jpegs, { width, height, fps: o.fps, audio: mix?.pcm ?? null }), info.ext, info.mime, mix ? `${info.label} with sound` : info.label);
    }
  }
}
