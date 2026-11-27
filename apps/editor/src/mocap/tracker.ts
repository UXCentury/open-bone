/**
 * Body tracking for "Animate from video": MediaPipe's Pose Landmarker, run in the browser on a video file or a webcam
 * recording. The WASM runtime and the model are bundled with the editor (served at /mediapipe/), so nothing is sent
 * anywhere. The library is imported only when someone tracks a clip.
 */
import type { PoseFrame, PoseTrack } from "@openbone/core";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";

const BASE = `${import.meta.env.BASE_URL}mediapipe/`;

let landmarker: Promise<PoseLandmarker> | null = null;

/** Load the tracker once (GPU where the browser allows it, CPU otherwise). */
function load(): Promise<PoseLandmarker> {
  landmarker ??= (async () => {
    // MediaPipe hands every frame to the model through WebGL, also on the CPU.
    if (!document.createElement("canvas").getContext("webgl2") && !document.createElement("canvas").getContext("webgl"))
      throw new Error("Body tracking needs WebGL, which is turned off in this browser: turn on hardware acceleration (or use another browser) and try again");
    const { PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = { wasmLoaderPath: `${BASE}vision_wasm_internal.js`, wasmBinaryPath: `${BASE}vision_wasm_internal.wasm` };
    const model = new Uint8Array(await (await fetch(`${BASE}pose_landmarker_full.task`)).arrayBuffer());
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: "VIDEO" as const,
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      return await PoseLandmarker.createFromOptions(fileset, options("GPU"));
    } catch {
      return await PoseLandmarker.createFromOptions(fileset, options("CPU"));
    }
  })();
  landmarker.catch(() => (landmarker = null));
  return landmarker;
}

export interface TrackOptions {
  /** Frames per second to sample. Default 30. */
  fps?: number;
  /** Seconds of the video to track. Default: all of it. */
  start?: number;
  end?: number;
  onProgress?: (stage: string, p: number) => void;
  signal?: AbortSignal;
}

/** A video element for `src`, with its metadata loaded. */
export async function openVideo(src: Blob | string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = typeof src === "string" ? src : URL.createObjectURL(src);
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("This video can't be read here: try an MP4 (H.264) or WebM file"));
  });
  // Recordings from MediaRecorder report an infinite duration until the end has been seen once.
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e9;
    await new Promise<void>((r) => (video.ondurationchange = () => Number.isFinite(video.duration) && r()));
    video.currentTime = 0;
  }
  return video;
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      // Wait for the frame to be ready to draw where the browser tells us; some don't for a paused seek, so don't wait long.
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => resolve());
      setTimeout(resolve, 40);
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

/** Track the body through a video, one frame every 1/fps seconds. */
export async function trackVideo(src: Blob | string | HTMLVideoElement, o: TrackOptions = {}): Promise<PoseTrack> {
  const progress = o.onProgress ?? (() => {});
  progress("Loading the body tracker", 0);
  const pose = await load();
  const video = src instanceof HTMLVideoElement ? src : await openVideo(src);
  const fps = o.fps ?? 30;
  const start = Math.max(0, o.start ?? 0);
  const end = Math.min(video.duration, o.end ?? video.duration);
  if (!(end > start)) throw new Error("The video is empty, or the start is after the end");
  const frames: PoseFrame[] = [];
  const count = Math.floor((end - start) * fps + 1e-6) + 1;
  // Timestamps must only go up, also across clips: continue from the last one this tracker saw.
  for (let i = 0; i < count; i++) {
    if (o.signal?.aborted) throw new DOMException("Tracking cancelled", "AbortError");
    const t = Math.min(end, start + i / fps);
    await seek(video, t);
    const result = pose.detectForVideo(video, nextTimestamp());
    const lm = result.landmarks[0];
    frames.push({ time: Math.round((t - start) * 1e4) / 1e4, points: lm ? lm.map((p) => [round(p.x), round(p.y), round(p.visibility ?? 1)]) : [] });
    if (i % 3 === 0) progress("Tracking the body", (i + 1) / count);
    // Let the page breathe (progress, Cancel) between frames.
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  progress("Tracking the body", 1);
  const found = frames.filter((f) => f.points.length).length;
  if (!found) throw new Error("No body was found in the video: the whole body, or at least the upper body, should be in view");
  return { format: "openbone-pose-track", version: 1, width: video.videoWidth, height: video.videoHeight, fps, frames };
}

let lastTimestamp = 0;
const nextTimestamp = () => (lastTimestamp = Math.max(lastTimestamp + 1, Math.round(performance.now())));
const round = (v: number) => Math.round(v * 1e5) / 1e5;
