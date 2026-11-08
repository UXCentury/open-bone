import { type AnimationData, type AudioAsset, findSound } from "@openbone/core";
import { WebAudioBackend } from "@openbone/player";
import { AudioDirector, type AudioCommand, eventsBetween, playAudioKeys } from "@openbone/runtime";
import { createSignal } from "solid-js";
import { readFileAsDataUrl } from "./images.ts";
import { apply, baseUrl, setSelection, store, toast } from "./state.ts";

const overrides = new Map<string, string>();
/** Map a document audio src to a different URL (desktop files read from disk). */
export const registerAudioOverride = (src: string, url: string) => overrides.set(src, url);

export const resolveAudioUrl = (asset: AudioAsset) =>
  overrides.get(asset.src) ?? (/^(data:|https?:|blob:|\/)/.test(asset.src) ? asset.src : `${baseUrl()}${asset.src}`);

const [muted, setMutedSignal] = createSignal(false);
export { muted as audioMuted };

/** Last audio commands, newest first (shown in the State Machine event log and the console). */
const [audioLog, setAudioLog] = createSignal<string[]>([]);
export { audioLog };

/** Web Audio playback for the whole editor (preview, state machine Run, Inspector auditions). */
export const audio = new WebAudioBackend(store.doc, {
  resolveUrl: resolveAudioUrl,
  onLog: (msg) => {
    console.info(`[openbone audio] ${msg}`);
    setAudioLog((l) => [msg, ...l].slice(0, 40));
  },
});
audio.unlock(window);
store.subscribe((d) => audio.setDocument(d));

export function setAudioMuted(m: boolean) {
  setMutedSignal(m);
  audio.setMuted(m);
  if (m) audio.stopAll(0.05);
}

/** Feed runtime commands to the backend. */
export const playCommand = (c: AudioCommand) => audio.handle(c);

// ---------- Timeline preview ----------

/** Plays audio keys and event sounds while the timeline preview runs (it poses by time, not with an AnimationState). */
const preview = new AudioDirector(store.doc, playCommand);
store.subscribe((d) => (preview.doc = d));
let previewAnim: string | null = null;

/** Call each preview frame with the time before and after the step (unwrapped: `next` may pass the duration). */
export function previewAudioStep(anim: AnimationData, prev: number, next: number, dt: number) {
  if (previewAnim !== anim.id) {
    preview.stopAll();
    previewAnim = anim.id;
  }
  preview.update(dt);
  playAudioKeys(preview, anim, prev, next, true, "preview");
  for (const ev of eventsBetween(store.doc, anim, prev, next, true))
    if (ev.audio) preview.play(ev.audio, { volume: ev.volume, owner: "preview", source: `event:${ev.name}` });
}

// ---------- Scrubbing ----------

const SCRUB_KEY = "openbone.scrubSound";
const readScrub = () => {
  try {
    return localStorage.getItem(SCRUB_KEY) !== "0";
  } catch {
    return true;
  }
};
const [scrubSound, setScrubSignal] = createSignal(readScrub());
/** Whether dragging the timeline's playhead plays the audio under it (remembered per browser). */
export { scrubSound };
export function setScrubSound(on: boolean) {
  setScrubSignal(on);
  try {
    localStorage.setItem(SCRUB_KEY, on ? "1" : "0");
  } catch {
    /* private mode: just this session */
  }
}

let lastScrub = 0;
/**
 * Scrub feedback: a short grain of every audio key sounding at time `t` (from the right point in its file), and the
 * sounds of events the playhead just crossed. Called while the playhead is dragged; throttled.
 */
export function scrubAudio(anim: AnimationData, prev: number, t: number) {
  if (!scrubSound() || muted()) return;
  const now = performance.now();
  if (now - lastScrub < 40) return;
  lastScrub = now;
  const ctx = audio.activate();
  if (!ctx) return;
  const doc = store.doc;
  for (const k of anim.audio ?? []) {
    const snd = findSound(doc, k.sound);
    const asset = snd && doc.audio?.assets.find((a) => a.id === snd.asset);
    if (!snd || !asset) continue;
    const off = (t - k.time) * (snd.rate || 1);
    const dur = asset.duration || Infinity;
    if (off < 0 || (!snd.loop && off >= dur)) continue;
    audio.scrub(asset.id, snd.loop && Number.isFinite(dur) ? off % dur : off, { volume: (snd.volume ?? 1) * (k.volume ?? 1), rate: snd.rate || 1, bus: snd.bus });
  }
  // Event sounds (footsteps…) play once when the playhead passes their key, in either direction.
  const [a, b] = prev <= t ? [prev, t] : [t, prev];
  if (b - a < 0.5)
    for (const ev of eventsBetween(doc, anim, a, b, false))
      if (ev.audio) preview.play(ev.audio, { volume: ev.volume, owner: "scrub", source: `event:${ev.name}` });
}

/** Stop the preview's sounds (playback paused, animation or mode changed). */
export function stopPreviewAudio() {
  if (preview.playing.size) preview.stopAll();
  previewAnim = null;
}

/** Play a sound once from the Inspector. */
export function audition(sound: string) {
  const s = findSound(store.doc, sound);
  if (!s) return;
  if (!audio.unlocked) void audio.ctx?.resume();
  preview.stopOwner("audition", 0, true);
  preview.play(s.id, { owner: "audition", source: "audition", loop: false });
}

// ---------- Import ----------

const AUDIO_EXT = /\.(wav|mp3|ogg|oga|opus|m4a|aac|flac|webm)$/i;
export const isAudioFile = (f: File) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name);

/** Duration in seconds via an <audio> element (no user gesture needed). 0 when unknown. */
export function audioDuration(src: string): Promise<number> {
  return new Promise((ok) => {
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => ok(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) / 1000 : 0);
    el.onerror = () => ok(0);
    el.src = src;
  });
}

/** Import WAV/MP3/OGG files as embedded audio assets (each with a sound of the same name). */
export async function importAudio(files: FileList | File[]) {
  let last: string | undefined;
  for (const file of Array.from(files)) {
    if (!isAudioFile(file)) continue;
    const src = await readFileAsDataUrl(file);
    const duration = await audioDuration(src);
    const base = file.name.replace(/\.[^.]+$/, "") || "sound";
    const taken = new Set([...(store.doc.audio?.assets ?? []), ...(store.doc.audio?.sounds ?? [])].map((x) => x.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    const r = apply("addAudio", { name, src, duration }) as { id: string; sound?: string } | undefined;
    if (r) last = r.sound;
  }
  if (last) {
    setSelection({ kind: "sound", id: last });
    toast("Audio imported. Add it to an animation (Timeline ♪) or a state (State Machine panel).");
  }
}

/** Audio asset as a data: URL (for embedding in an exported file). */
export async function audioAsDataUrl(asset: AudioAsset): Promise<string> {
  if (asset.src.startsWith("data:")) return asset.src;
  const res = await fetch(resolveAudioUrl(asset));
  if (!res.ok) throw new Error(`Could not read audio "${asset.name}" (${res.status})`);
  let blob = await res.blob();
  // Servers often label audio files generically: name the type from the extension so the data URL says what it is.
  const ext = asset.src.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm" };
  if (!blob.type.startsWith("audio/") && byExt[ext]) blob = new Blob([blob], { type: byExt[ext] });
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(`Could not read audio "${asset.name}"`));
    r.readAsDataURL(blob);
  });
}
