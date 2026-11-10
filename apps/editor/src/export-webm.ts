import type { Frame } from "@openbone/export";
import { ArrayBufferTarget, Muxer } from "webm-muxer";
import type { AudioMix } from "./export-audio.ts";

/**
 * WebM (VP9 or VP8 video, Opus sound) with the browser's WebCodecs encoders. With a transparent background the video
 * keeps its alpha channel where the encoder supports it (Chrome and Edge do for VP9/VP8), so it can be layered over a
 * web page with a plain <video> element.
 */

export const webmSupported = () => typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

/** Video codecs to try, best first: VP9 profile 0 (8-bit), then VP8. */
const CODECS = [
  { webcodecs: "vp09.00.10.08", muxer: "V_VP9", label: "VP9" },
  { webcodecs: "vp8", muxer: "V_VP8", label: "VP8" },
] as const;

type Pick = { config: VideoEncoderConfig; muxer: string; label: string; alpha: boolean };

async function pickVideo(width: number, height: number, fps: number, bitrate: number, wantAlpha: boolean): Promise<Pick> {
  // With alpha wanted, first look for a codec that keeps it; otherwise (or if none does) take the first that encodes.
  for (const alpha of wantAlpha ? [true, false] : [false]) {
    for (const c of CODECS) {
      const config: VideoEncoderConfig = { codec: c.webcodecs, width, height, framerate: fps, bitrate, ...(alpha ? { alpha: "keep" as const } : {}) };
      const r = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (r?.supported) return { config, muxer: c.muxer, label: c.label, alpha };
    }
  }
  throw new Error(`This browser cannot encode VP9 or VP8 at ${width}×${height}. Lower the scale, or export MP4 or MOV instead.`);
}

async function pickAudio(sampleRate: number, numberOfChannels: number): Promise<AudioEncoderConfig | null> {
  if (typeof AudioEncoder === "undefined") return null;
  // Opus only runs at 48 kHz in WebM players; the encoder resamples when given another rate it supports.
  const config: AudioEncoderConfig = { codec: "opus", sampleRate, numberOfChannels, bitrate: 160_000 };
  const r = await AudioEncoder.isConfigSupported(config).catch(() => null);
  return r?.supported ? config : null;
}

export interface WebmResult {
  data: Uint8Array;
  /** "VP9" or "VP8". */
  videoCodec: string;
  /** Whether the file keeps transparency. */
  alpha: boolean;
  /** Whether the file has Opus sound. */
  sound: boolean;
  warnings: string[];
}

export async function encodeWebm(
  frames: Frame[],
  o: {
    width: number;
    height: number;
    fps: number;
    quality: number;
    audio: AudioMix | null;
    /** Keep transparency (frames were rendered on a transparent background). */
    transparent: boolean;
    /** Filled behind the frames when transparency was asked for but the encoder cannot keep it. */
    fallbackBackground: string;
  },
  onProgress?: (p: number) => void,
): Promise<WebmResult> {
  if (!webmSupported()) throw new Error("WebM export needs a browser with WebCodecs (Chrome, Edge, Safari 17+ or Firefox 130+). Export MOV or AVI instead.");
  const { width, height, fps } = o;
  const warnings: string[] = [];
  const bitrate = Math.round(Math.min(40e6, Math.max(1e6, width * height * fps * (0.05 + o.quality * 0.25))));
  const video = await pickVideo(width, height, fps, bitrate, o.transparent);
  if (o.transparent && !video.alpha) {
    warnings.push(`This browser's ${video.label} encoder cannot keep transparency, so the background is filled with ${o.fallbackBackground}.`);
  }
  const audioConfig = o.audio ? await pickAudio(o.audio.sampleRate, o.audio.channels.length) : null;
  if (o.audio && !audioConfig) warnings.push("This browser cannot encode Opus sound, so the WebM is silent. MOV and AVI keep the sound.");

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: video.muxer, width, height, frameRate: fps, alpha: video.alpha },
    audio: audioConfig && o.audio ? { codec: "A_OPUS", sampleRate: o.audio.sampleRate, numberOfChannels: o.audio.channels.length } : undefined,
    firstTimestampBehavior: "offset",
  });
  let failure: Error | null = null;
  const fail = (e: DOMException) => (failure ??= new Error(`WebM encoding failed: ${e.message}`));

  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  venc.configure(video.config);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  // Frames are drawn onto the canvas; without alpha support, transparent frames go over the fallback background.
  const scratch = o.transparent && !video.alpha ? document.createElement("canvas") : null;
  if (scratch) {
    scratch.width = width;
    scratch.height = height;
  }
  const step = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  for (let i = 0; i < frames.length; i++) {
    if (failure) throw failure;
    img.data.set(frames[i].data);
    if (scratch) {
      scratch.getContext("2d")!.putImageData(img, 0, 0);
      ctx.fillStyle = o.fallbackBackground;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(scratch, 0, 0);
    } else {
      ctx.putImageData(img, 0, 0);
    }
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step), ...(video.alpha ? { alpha: "keep" as const } : {}) });
    venc.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
    while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 1));
    onProgress?.(((i + 1) / frames.length) * 0.9);
  }
  await venc.flush();
  venc.close();

  if (audioConfig && o.audio) {
    const { channels, sampleRate } = o.audio;
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
    aenc.configure(audioConfig);
    const total = channels[0].length;
    const block = 4096;
    for (let start = 0; start < total; start += block) {
      const n = Math.min(block, total - start);
      const planar = new Float32Array(n * channels.length);
      channels.forEach((ch, c) => planar.set(ch.subarray(start, start + n), c * n));
      const data = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: channels.length, timestamp: Math.round((start * 1e6) / sampleRate), data: planar });
      aenc.encode(data);
      data.close();
    }
    await aenc.flush();
    aenc.close();
  }
  if (failure) throw failure;
  muxer.finalize();
  onProgress?.(1);
  return { data: new Uint8Array(target.buffer), videoCodec: video.label, alpha: video.alpha, sound: !!audioConfig, warnings };
}
