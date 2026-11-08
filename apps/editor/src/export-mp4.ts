import type { Frame } from "@openbone/export";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { AudioMix } from "./export-audio.ts";

/**
 * MP4 (H.264 video, AAC sound) with the browser's WebCodecs encoders. Where the browser has no AAC encoder
 * (e.g. Chromium on Linux) the sound is Opus, which plays in browsers, VLC and most editors but not QuickTime.
 */

export const mp4Supported = () => typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

/** H.264 profiles to try, best first (High, Main, Baseline at a level that fits up to 4K). */
const AVC = ["avc1.640034", "avc1.4d0034", "avc1.420034", "avc1.64002a", "avc1.42002a", "avc1.42001f"];

async function pickVideo(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig> {
  for (const codec of AVC) {
    const config: VideoEncoderConfig = { codec, width, height, framerate: fps, bitrate, avc: { format: "avc" } };
    const r = await VideoEncoder.isConfigSupported(config).catch(() => null);
    if (r?.supported) return config;
  }
  throw new Error(`This browser cannot encode H.264 at ${width}×${height}. Lower the scale, or export MOV instead.`);
}

async function pickAudio(sampleRate: number, numberOfChannels: number): Promise<{ config: AudioEncoderConfig; codec: "aac" | "opus" } | null> {
  if (typeof AudioEncoder === "undefined") return null;
  for (const [codec, name] of [["mp4a.40.2", "aac"], ["opus", "opus"]] as const) {
    const config: AudioEncoderConfig = { codec, sampleRate, numberOfChannels, bitrate: 192_000 };
    const r = await AudioEncoder.isConfigSupported(config).catch(() => null);
    if (r?.supported) return { config, codec: name };
  }
  return null;
}

export interface Mp4Result {
  data: Uint8Array;
  /** Sound codec used, or null when the video has no sound. */
  audioCodec: "aac" | "opus" | null;
  warnings: string[];
}

export async function encodeMp4(
  frames: Frame[],
  o: { width: number; height: number; fps: number; quality: number; audio: AudioMix | null },
  onProgress?: (p: number) => void,
): Promise<Mp4Result> {
  if (!mp4Supported()) throw new Error("MP4 export needs a browser with WebCodecs (Chrome, Edge, Safari 17+ or Firefox 130+). Export MOV or AVI instead.");
  const { width, height, fps } = o;
  const warnings: string[] = [];
  const bitrate = Math.round(Math.min(40e6, Math.max(1e6, width * height * fps * (0.05 + o.quality * 0.25))));
  const video = await pickVideo(width, height, fps, bitrate);
  const audioPick = o.audio ? await pickAudio(o.audio.sampleRate, o.audio.channels.length) : null;
  if (o.audio && !audioPick) warnings.push("This browser cannot encode AAC or Opus sound, so the MP4 is silent. MOV and AVI keep the sound.");
  if (audioPick?.codec === "opus") warnings.push("Sound is Opus (no AAC encoder in this browser): it plays in browsers and VLC but not in QuickTime. MOV keeps uncompressed sound.");

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height, frameRate: fps },
    audio: audioPick && o.audio ? { codec: audioPick.codec, sampleRate: o.audio.sampleRate, numberOfChannels: o.audio.channels.length } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let failure: Error | null = null;
  const fail = (e: DOMException) => (failure ??= new Error(`MP4 encoding failed: ${e.message}`));

  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  venc.configure(video);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  const step = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  for (let i = 0; i < frames.length; i++) {
    if (failure) throw failure;
    img.data.set(frames[i].data);
    ctx.putImageData(img, 0, 0);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
    venc.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
    while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 1));
    onProgress?.(((i + 1) / frames.length) * 0.9);
  }
  await venc.flush();
  venc.close();

  if (audioPick && o.audio) {
    const { channels, sampleRate } = o.audio;
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
    aenc.configure(audioPick.config);
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
  return { data: new Uint8Array(target.buffer), audioCodec: audioPick ? audioPick.codec : null, warnings };
}
