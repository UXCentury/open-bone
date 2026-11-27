/**
 * Animate from video: pick a video (or record one with the webcam), track the body in it, check which bone follows
 * which body part, and key an animation. Tracking runs in the browser with the bundled model; one undo step.
 */
import {
  POSE_LANDMARKS,
  POSE_SEGMENTS,
  POSE_SOURCES,
  type PoseSource,
  type PoseTrack,
  guessPoseMapping,
  poseToKeys,
} from "@openbone/core";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { saveTextFile } from "../storage.ts";
import { animationId, setAnimationId, setMode, store, toast, transaction } from "../state.ts";
import { openVideo, trackVideo } from "./tracker.ts";
import { type Recorder, openWebcam } from "./webcam.ts";

export const [videoAnimOpen, setVideoAnimOpen] = createSignal(false);

const LABELS: Record<PoseSource, string> = {
  leftUpperArm: "Left upper arm",
  leftForearm: "Left forearm",
  leftHand: "Left hand",
  rightUpperArm: "Right upper arm",
  rightForearm: "Right forearm",
  rightHand: "Right hand",
  leftThigh: "Left thigh",
  leftShin: "Left shin",
  leftFoot: "Left foot",
  rightThigh: "Right thigh",
  rightShin: "Right shin",
  rightFoot: "Right foot",
  spine: "Spine (hips → shoulders)",
  neck: "Neck",
  head: "Head",
  hips: "Hips (position)",
  leftWrist: "Left wrist (position, IK target)",
  rightWrist: "Right wrist (position, IK target)",
  leftAnkle: "Left ankle (position, IK target)",
  rightAnkle: "Right ankle (position, IK target)",
};

const MAX_RECORD = 30;

/** Lines of the stick figure drawn over the video. */
const LINES: [number, number][] = [
  ...Object.values(POSE_SEGMENTS)
    .filter(([a, b]) => a in POSE_LANDMARKS && b in POSE_LANDMARKS)
    .map(([a, b]) => [POSE_LANDMARKS[a as keyof typeof POSE_LANDMARKS], POSE_LANDMARKS[b as keyof typeof POSE_LANDMARKS]] as [number, number]),
  [11, 12],
  [23, 24],
  [11, 23],
  [12, 24],
];

export function VideoToAnimationDialog() {
  let videoEl!: HTMLVideoElement;
  let overlay!: HTMLCanvasElement;
  let fileInput!: HTMLInputElement;
  let trackInput!: HTMLInputElement;
  const close = () => {
    cancel?.abort();
    recorder()?.close();
    setVideoAnimOpen(false);
  };

  // Source
  const [source, setSource] = createSignal<{ blob: Blob; name: string } | null>(null);
  const [url, setUrl] = createSignal<string | null>(null);
  const [duration, setDuration] = createSignal(0);
  const [start, setStart] = createSignal(0);
  const [end, setEnd] = createSignal(0);
  const [recorder, setRecorder] = createSignal<Recorder | null>(null);
  const [countdown, setCountdown] = createSignal(0);
  const [recording, setRecording] = createSignal(false);

  // Tracking
  const [track, setTrack] = createSignal<PoseTrack | null>(null);
  const [busy, setBusy] = createSignal("");
  let cancel: AbortController | null = null;

  // Mapping and options
  const doc = () => store.doc;
  const [frontSide, setFrontSide] = createSignal<"left" | "right">("left");
  const [mapping, setMapping] = createSignal<Record<string, PoseSource>>(guessPoseMapping(doc(), { frontSide: "left" }));
  const current = doc().animations.find((a) => a.id === animationId());
  const [target, setTarget] = createSignal<string>("new");
  const [animName, setAnimName] = createSignal(uniqueName("from video"));
  const [at, setAt] = createSignal(0);
  const [mirror, setMirror] = createSignal(false);
  const [rootMotion, setRootMotion] = createSignal<"full" | "inPlace" | "off">("full");
  const [mode, setModeOpt] = createSignal<"direction" | "relative">("direction");
  const [smoothing, setSmoothing] = createSignal(0.5);
  const [tolerance, setTolerance] = createSignal(1);

  function uniqueName(base: string) {
    let name = base;
    for (let i = 2; doc().animations.some((a) => a.name === name); i++) name = `${base} ${i}`;
    return name;
  }

  const setVideo = (blob: Blob, name: string) => {
    if (url()) URL.revokeObjectURL(url()!);
    setTrack(null);
    setSource({ blob, name });
    setUrl(URL.createObjectURL(blob));
  };
  const onLoaded = async () => {
    let d = videoEl.duration;
    if (!Number.isFinite(d)) {
      // A fresh recording: find its length.
      const v = await openVideo(url()!);
      d = v.duration;
    }
    setDuration(d);
    setStart(0);
    setEnd(Math.round(d * 100) / 100);
  };

  const startWebcam = async () => {
    try {
      setTrack(null);
      setSource(null);
      setUrl(null);
      const r = await openWebcam();
      setRecorder(r);
      videoEl.srcObject = r.stream;
      await videoEl.play();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const record = async () => {
    const r = recorder();
    if (!r) return;
    for (let i = 3; i > 0; i--) {
      setCountdown(i);
      await new Promise((res) => setTimeout(res, 1000));
      if (recorder() !== r) return setCountdown(0);
    }
    setCountdown(0);
    setRecording(true);
    const blob = await r.record(MAX_RECORD);
    setRecording(false);
    r.close();
    setRecorder(null);
    videoEl.srcObject = null;
    setVideo(blob, "webcam recording");
  };

  const runTracking = async () => {
    const src = source();
    if (!src) return;
    cancel = new AbortController();
    try {
      const t = await trackVideo(src.blob, {
        fps: doc().fps || 30,
        start: start(),
        end: end(),
        signal: cancel.signal,
        onProgress: (stage, p) => setBusy(`${stage}… ${Math.round(p * 100)}%`),
      });
      setTrack(t);
      videoEl.currentTime = start();
      drawOverlay();
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") toast((e as Error).message, "error");
    } finally {
      setBusy("");
      cancel = null;
    }
  };

  const loadTrack = async (file: File) => {
    try {
      const t = JSON.parse(await file.text()) as PoseTrack;
      if (!Array.isArray(t.frames) || !t.width || !t.height) throw new Error("not a pose track");
      setSource(null);
      setUrl(null);
      setTrack(t);
      requestAnimationFrame(drawOverlay);
    } catch (e) {
      toast(`Couldn't read ${file.name}: ${(e as Error).message}`, "error");
    }
  };
  const saveTrack = async () => {
    const t = track();
    if (!t) return;
    const name = (source()?.name ?? "tracking").replace(/\.[^.]+$/, "");
    await saveTextFile(`${name}.pose.json`, JSON.stringify(t), "json", "Pose track");
  };

  // The tracked figure over the video, at the frame being shown.
  function drawOverlay() {
    const t = track();
    const ctx = overlay?.getContext("2d");
    if (!ctx || !videoEl) return;
    const w = (overlay.width = overlay.clientWidth * devicePixelRatio);
    const h = (overlay.height = overlay.clientHeight * devicePixelRatio);
    ctx.clearRect(0, 0, w, h);
    if (!t || !t.frames.length) return;
    // The video is letterboxed inside the element (object-fit: contain).
    const s = Math.min(w / t.width, h / t.height);
    const ox = (w - t.width * s) / 2;
    const oy = (h - t.height * s) / 2;
    const now = source() ? videoEl.currentTime - start() : 0;
    let f = t.frames[0];
    for (const fr of t.frames) if (fr.time <= now + 1e-3) f = fr;
    const p = (i: number) => f.points[i];
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.strokeStyle = "#5b8cffdd";
    for (const [a, b] of LINES) {
      const pa = p(a);
      const pb = p(b);
      if (!pa || !pb || pa[2] < 0.5 || pb[2] < 0.5) continue;
      ctx.beginPath();
      ctx.moveTo(ox + pa[0] * t.width * s, oy + pa[1] * t.height * s);
      ctx.lineTo(ox + pb[0] * t.width * s, oy + pb[1] * t.height * s);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffd25b";
    for (const pt of f.points) if (pt && pt[2] >= 0.5) ctx.fillRect(ox + pt[0] * t.width * s - 3, oy + pt[1] * t.height * s - 3, 6, 6);
  }

  const bones = createMemo(() => doc().skeleton.bones);
  const mapped = createMemo(() => bones().filter((b) => mapping()[b.id]));
  const unmapped = createMemo(() => bones().filter((b) => !mapping()[b.id]));
  const setBone = (id: string, src: PoseSource | "") =>
    setMapping((m) => {
      const n = { ...m };
      if (src) n[id] = src;
      else delete n[id];
      return n;
    });

  const animate = () => {
    const t = track();
    if (!t) return;
    const animation = target() === "new" ? animName().trim() : target();
    if (!animation) return toast("Name the new animation", "error");
    if (target() === "new" && doc().animations.some((a) => a.name === animation)) return toast(`There is already an animation called “${animation}”`, "error");
    let res: ReturnType<typeof poseToKeys>;
    try {
      res = poseToKeys(store.doc, t, {
        animation,
        mapping: mapping(),
        at: target() === "new" ? 0 : at(),
        mirror: mirror(),
        rootMotion: rootMotion(),
        mode: mode(),
        smoothing: smoothing(),
        tolerance: tolerance(),
      });
    } catch (e) {
      return toast((e as Error).message, "error");
    }
    transaction("Animate from video", () => {
      for (const o of res.ops) store.apply(o.op, o.args);
    });
    const anim = store.doc.animations.find((a) => a.id === animation || a.name === animation);
    if (anim) setAnimationId(anim.id);
    setMode("animate");
    close();
    toast(`Animated ${Object.keys(res.mapping).length} bones from the video: ${res.keys} keys over ${res.duration.toFixed(2)} s`);
    for (const w of res.warnings) toast(w, "info");
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy()) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (track() && source() && !videoEl.paused) drawOverlay();
    };
    raf = requestAnimationFrame(loop);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      if (url()) URL.revokeObjectURL(url()!);
    });
  });

  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy() && close()}>
      <div class="modal video-anim-dialog" role="dialog" aria-modal="true" aria-labelledby="video-anim-title">
        <header class="modal-head">
          <h2 id="video-anim-title">Animate from video</h2>
          <span class="muted small">Tracks a body in a video and keys the skeleton to it. Runs on this computer; nothing is uploaded.</span>
          <button class="icon-btn close" title="Close (Esc)" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>
        <div class="video-anim-body">
          <section class="video-anim-source">
            <div class="video-anim-stage">
              <video
                ref={videoEl}
                src={url() ?? undefined}
                muted
                playsinline
                controls={!!url() && !recorder()}
                onLoadedMetadata={onLoaded}
                onSeeked={drawOverlay}
                onTimeUpdate={drawOverlay}
              />
              <canvas ref={overlay} class="video-anim-overlay" />
              <Show when={!url() && !recorder()}>
                <div class="video-anim-empty muted">
                  <Show when={track()} fallback={<>Choose a video of one person, whole body in view, or record one with your webcam.</>}>
                    Tracking loaded from a file ({track()!.frames.length} frames).
                  </Show>
                </div>
              </Show>
              <Show when={countdown()}>
                <div class="video-anim-countdown">{countdown()}</div>
              </Show>
            </div>
            <div class="row gap">
              <button onClick={() => fileInput.click()} disabled={!!busy() || recording()}>
                Choose video…
              </button>
              <Show
                when={recorder()}
                fallback={
                  <button onClick={startWebcam} disabled={!!busy()}>
                    Use webcam
                  </button>
                }
              >
                <Show
                  when={recording()}
                  fallback={
                    <button class="primary" onClick={record} disabled={!!countdown()}>
                      ● Record
                    </button>
                  }
                >
                  <button class="danger" onClick={() => recorder()?.stop()}>
                    ■ Stop
                  </button>
                </Show>
              </Show>
              <button onClick={() => trackInput.click()} disabled={!!busy()} title="Load a pose track saved earlier (.pose.json)">
                Load tracking…
              </button>
              <input ref={fileInput} type="file" accept="video/*,.mp4,.webm,.mov,.mkv" hidden onChange={(e) => e.currentTarget.files?.[0] && setVideo(e.currentTarget.files[0], e.currentTarget.files[0].name)} />
              <input ref={trackInput} type="file" accept=".json,application/json" hidden onChange={(e) => e.currentTarget.files?.[0] && loadTrack(e.currentTarget.files[0])} />
            </div>
            <Show when={source()}>
              <div class="row gap small">
                <label>
                  From <input type="number" min="0" step="0.1" value={start()} onChange={(e) => setStart(Math.max(0, num(e.currentTarget.value, 0)))} /> s
                </label>
                <label>
                  to <input type="number" min="0" step="0.1" value={end()} onChange={(e) => setEnd(Math.min(duration(), num(e.currentTarget.value, duration())))} /> s
                </label>
                <span class="muted">of {duration().toFixed(2)} s</span>
                <span class="grow" />
                <Show
                  when={!busy()}
                  fallback={
                    <>
                      <span class="muted">{busy()}</span>
                      <button onClick={() => cancel?.abort()}>Cancel</button>
                    </>
                  }
                >
                  <button class={track() ? "" : "primary"} onClick={runTracking}>
                    {track() ? "Track again" : "Track body"}
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={recording()}>
              <div class="muted small">Recording… (up to {MAX_RECORD} s)</div>
            </Show>
          </section>

          <section class="video-anim-options">
            <h3>Bones</h3>
            <div class="row gap small">
              <label title="For side-view rigs whose bones are named front-/back- (or near/far)">
                Front side is the body's{" "}
                <select
                  value={frontSide()}
                  onChange={(e) => {
                    const s = e.currentTarget.value as "left" | "right";
                    setFrontSide(s);
                    setMapping(guessPoseMapping(doc(), { frontSide: s }));
                  }}
                >
                  <option value="left">left</option>
                  <option value="right">right</option>
                </select>
              </label>
              <label>
                <input type="checkbox" checked={mirror()} onChange={(e) => setMirror(e.currentTarget.checked)} /> Mirror
              </label>
            </div>
            <div class="video-anim-map">
              <For each={mapped()} fallback={<div class="muted small">No bone names look like body parts: pick them below.</div>}>
                {(b) => (
                  <label class="video-anim-map-row">
                    <span class="ellipsis" title={b.name}>
                      {b.name}
                    </span>
                    <select value={mapping()[b.id]} onChange={(e) => setBone(b.id, e.currentTarget.value as PoseSource | "")}>
                      <option value="">— not animated</option>
                      <For each={POSE_SOURCES}>{(s) => <option value={s}>{LABELS[s]}</option>}</For>
                    </select>
                  </label>
                )}
              </For>
            </div>
            <Show when={unmapped().length}>
              <select
                class="small"
                value=""
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  e.currentTarget.value = "";
                  if (id) setBone(id, "spine");
                }}
              >
                <option value="">+ Animate another bone…</option>
                <For each={unmapped()}>{(b) => <option value={b.id}>{b.name}</option>}</For>
              </select>
            </Show>

            <h3>Animation</h3>
            <div class="video-anim-grid small">
              <span>Into</span>
              <select value={target()} onChange={(e) => setTarget(e.currentTarget.value)}>
                <option value="new">New animation</option>
                <For each={doc().animations}>{(a) => <option value={a.id}>{a.name}</option>}</For>
              </select>
              <Show
                when={target() === "new"}
                fallback={
                  <>
                    <span>Start at</span>
                    <span>
                      <input type="number" min="0" step="0.1" value={at()} onChange={(e) => setAt(Math.max(0, num(e.currentTarget.value, 0)))} /> s{" "}
                      <span class="muted">(keys in the clip's span are replaced)</span>
                    </span>
                  </>
                }
              >
                <span>Name</span>
                <input type="text" value={animName()} onInput={(e) => setAnimName(e.currentTarget.value)} />
              </Show>
              <span>Body movement</span>
              <select value={rootMotion()} onChange={(e) => setRootMotion(e.currentTarget.value as "full" | "inPlace" | "off")}>
                <option value="full">Move with the body</option>
                <option value="inPlace">In place (keep the bounce)</option>
                <option value="off">Hips stay still</option>
              </select>
              <span>Bones point</span>
              <select value={mode()} onChange={(e) => setModeOpt(e.currentTarget.value as "direction" | "relative")}>
                <option value="direction">Along the body (bones follow the limbs)</option>
                <option value="relative">Relative to the first frame</option>
              </select>
              <span>Smoothing</span>
              <input type="range" min="0" max="1" step="0.05" value={smoothing()} onInput={(e) => setSmoothing(Number(e.currentTarget.value))} />
              <span title="How far simplified keys may stray from the tracked motion. 0 keys every frame.">Key tolerance</span>
              <span>
                <input type="number" min="0" step="0.5" value={tolerance()} onChange={(e) => setTolerance(Math.max(0, num(e.currentTarget.value, 1)))} /> ° / px
              </span>
            </div>
            <Show when={current && target() === "new"}>
              <button class="link small" onClick={() => setTarget(current!.id)}>
                Add to “{current!.name}” instead
              </button>
            </Show>
          </section>
        </div>
        <footer class="modal-foot">
          <button onClick={saveTrack} disabled={!track()} title="Save the tracked body as a .pose.json file, to map it again later without tracking (also usable by MCP)">
            Save tracking…
          </button>
          <span class="grow" />
          <button onClick={close} disabled={!!busy()}>
            Cancel
          </button>
          <button class="primary" onClick={animate} disabled={!track() || !mapped().length || !!busy()}>
            Animate
          </button>
        </footer>
      </div>
    </div>
  );
}
