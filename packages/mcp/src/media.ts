import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DecodedAudio, decodeWav, encodeWav } from "@openbone/export";

/**
 * Sound decoding and MP4 / WebM encoding for exports in Node. WAV is decoded here; other audio (MP3, OGG, FLAC…) and
 * the MP4 (H.264 + AAC) and WebM (VP9 + Opus) encoders come from an `ffmpeg` found on the PATH (or OPENBONE_FFMPEG).
 * ffmpeg is used as an external program, not bundled, so this package keeps its permissive licence; without it, WAV
 * sound still works and MP4 / WebM say how to get them (the editor makes them with the browser's encoders).
 */

let ffmpegPath: string | null | undefined;

/** The ffmpeg executable, or null when there is none. */
export function findFfmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidate = process.env.OPENBONE_FFMPEG || "ffmpeg";
  try {
    const r = spawnSync(candidate, ["-hide_banner", "-version"], { encoding: "utf8" });
    ffmpegPath = r.status === 0 ? candidate : null;
  } catch {
    ffmpegPath = null;
  }
  return ffmpegPath;
}

/** Run ffmpeg with `input` on stdin; resolves with stdout. */
function ffmpeg(args: string[], input?: Uint8Array | ((write: (b: Uint8Array) => Promise<void>) => Promise<void>)): Promise<Buffer> {
  const bin = findFfmpeg();
  if (!bin) return Promise.reject(new Error("ffmpeg not found"));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(0, 500)}`))));
    p.stdin.on("error", () => {
      /* ffmpeg closed its input early: the exit code says why */
    });
    const write = (b: Uint8Array) =>
      new Promise<void>((res) => {
        if (p.stdin.write(b)) res();
        else p.stdin.once("drain", () => res());
      });
    if (typeof input === "function")
      void input(write)
        .then(() => p.stdin.end())
        .catch(reject);
    else if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

/**
 * Decode an audio file: WAV in-process, anything else through ffmpeg (stereo float at `sampleRate`). Null when it
 * can't be decoded (no ffmpeg, or a broken file).
 */
export async function decodeAudio(bytes: Uint8Array, sampleRate = 48000): Promise<DecodedAudio | null> {
  const wav = decodeWav(bytes);
  if (wav) return wav;
  if (!findFfmpeg()) return null;
  try {
    const raw = await ffmpeg(["-i", "pipe:0", "-f", "f32le", "-ac", "2", "-ar", String(sampleRate), "pipe:1"], bytes);
    const f = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    const n = f.length >> 1;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = f[i * 2];
      r[i] = f[i * 2 + 1];
    }
    return { sampleRate, channels: [l, r] };
  } catch {
    return null;
  }
}

export interface VideoFrame {
  width: number;
  height: number;
  /** RGBA, opaque (already flattened onto the background). */
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * Encode frames (and an optional sound track) as MP4 (H.264 + AAC, yuv420p, plays everywhere) or WebM (VP9 + Opus)
 * with ffmpeg. `quality` 0..1 maps to the encoder's constant-quality setting.
 */
export async function encodeVideoFfmpeg(
  frames: VideoFrame[],
  o: { format: "mp4" | "webm"; fps: number; quality?: number; audio?: { sampleRate: number; channels: Float32Array[] } | null },
): Promise<Uint8Array> {
  if (!findFfmpeg())
    throw new Error(
      `${o.format.toUpperCase()} export needs ffmpeg on the PATH (or OPENBONE_FFMPEG set to it). Install ffmpeg, or export ${o.format.toUpperCase()} from the editor (it uses the browser's encoders), or use AVI / MOV.`,
    );
  const { width, height } = frames[0];
  // H.264 / yuv420p need even sizes.
  const w = width + (width % 2);
  const h = height + (height % 2);
  const dir = mkdtempSync(path.join(tmpdir(), "openbone-video-"));
  try {
    const out = path.join(dir, `out.${o.format}`);
    const args = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(o.fps), "-i", "pipe:0"];
    if (o.audio) {
      const wav = path.join(dir, "sound.wav");
      writeFileSync(wav, encodeWav(o.audio));
      args.push("-i", wav);
    }
    const q = Math.max(0, Math.min(1, o.quality ?? 0.85));
    if (w !== width || h !== height) args.push("-vf", `pad=${w}:${h}:0:0`);
    if (o.format === "mp4") args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(Math.round(35 - q * 20)), "-preset", "medium", "-movflags", "+faststart");
    else args.push("-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "0", "-crf", String(Math.round(45 - q * 20)), "-row-mt", "1");
    if (o.audio) args.push(...(o.format === "mp4" ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "libopus", "-b:a", "160k"]), "-shortest");
    args.push(out);
    await ffmpeg(args, async (write) => {
      for (const f of frames) await write(f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
    });
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
