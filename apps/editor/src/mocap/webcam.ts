/** Webcam recording for "Animate from video": a short clip recorded in the browser, then tracked like a file. */

export interface Recorder {
  stream: MediaStream;
  /** Start recording; resolves with the clip when `stop()` is called or `maxSeconds` pass. */
  record(maxSeconds: number): Promise<Blob>;
  stop(): void;
  /** Turn the camera off. */
  close(): void;
}

function pickType(): string {
  for (const t of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return "";
}

/** Ask for the camera (the browser shows its own permission prompt). */
export async function openWebcam(): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser or app can't use a camera here: record a clip with another app and choose it as a video file");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
  } catch (e) {
    const name = (e as DOMException).name;
    throw new Error(
      name === "NotAllowedError"
        ? "Camera access was refused: allow it in the browser's site settings, then try again"
        : name === "NotFoundError"
          ? "No camera was found"
          : `The camera couldn't start (${(e as Error).message})`,
    );
  }
  let rec: MediaRecorder | null = null;
  const stop = () => {
    if (rec?.state === "recording") rec.stop();
  };
  return {
    stream,
    record(maxSeconds) {
      const type = pickType();
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<Blob>((resolve) => (rec!.onstop = () => resolve(new Blob(chunks, { type: rec!.mimeType || type || "video/webm" }))));
      rec.start(250);
      const timer = setTimeout(() => rec?.state === "recording" && rec.stop(), maxSeconds * 1000);
      return done.finally(() => clearTimeout(timer));
    },
    stop,
    close() {
      stop();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}
