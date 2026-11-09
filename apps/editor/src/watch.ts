import type { AudioAsset, ImageAsset } from "@openbone/core";
import { createSignal } from "solid-js";
import { registerAudioOverride } from "./audio.ts";
import { readFileAsDataUrl, registerImageOverride } from "./images.ts";
import { store, toast } from "./state.ts";
import { isDesktop, projectFilePath } from "./storage.ts";
import { AUDIO_EXT, IMAGE_EXT, assetFolders, assetsForFile, isFileSrc } from "./watch-match.ts";

/**
 * Live art reloading. Desktop: the folders the project's images and sounds come from (plus any folder picked with
 * "Watch folder…") are watched through tauri-plugin-fs. Web: a folder picked with the File System Access API is
 * polled while the tab is focused. Changed files replace the art in place (new size included) without undo steps.
 */

/** Watching on or off (☰ Menu toggle). */
export const [watching, setWatchingSignal] = createSignal(false);
/** What is being watched, for the menu label / tooltip. */
export const [watchedFolders, setWatchedFolders] = createSignal<string[]>([]);

type Stop = () => void;
let stops: Stop[] = [];
/** Folders picked by hand: desktop paths or web directory handles. */
const extraDesktop: string[] = [];
let webRoot: FileSystemDirectoryHandle | null = null;

const mimeOf = (file: string) => {
  const ext = file.split(".").pop()!.toLowerCase();
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm" }[ext] ??
    "application/octet-stream"
  );
};

// Reloads arriving close together are reported in one toast.
let pending: string[] = [];
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function report(name: string) {
  pending.push(name);
  toastTimer ??= setTimeout(() => {
    const names = [...new Set(pending)];
    toast(`Art updated: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` +${names.length - 4}` : ""}`);
    pending = [];
    toastTimer = null;
  }, 250);
}

async function imageSizeOf(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function reloadImage(img: ImageAsset, blob: Blob) {
  const { width, height } = await imageSizeOf(blob);
  if (isFileSrc(img.src)) {
    // The file is the truth: show the new pixels from memory, the document keeps its path.
    registerImageOverride(img.src, URL.createObjectURL(blob));
    if (width !== img.width || height !== img.height) store.applyQuiet("updateImage", { image: img.id, width, height }, "watch");
    else store.applyQuiet("updateImage", { image: img.id }, "watch"); // nudge views to redraw
  } else {
    // Embedded art: store the new pixels in the document so saving keeps them.
    const src = await readFileAsDataUrl(new File([blob], img.name, { type: blob.type }));
    store.applyQuiet("updateImage", { image: img.id, src, width, height }, "watch");
  }
}

async function reloadAudio(a: AudioAsset, blob: Blob) {
  if (isFileSrc(a.src)) registerAudioOverride(a.src, URL.createObjectURL(blob));
  else store.applyQuiet("updateAudio", { asset: a.id, src: await readFileAsDataUrl(new File([blob], a.name, { type: blob.type })) }, "watch");
}

/** A file changed: reload every asset it stands for. Returns how many assets were reloaded. */
export async function fileChanged(path: string, read: () => Promise<Blob>): Promise<number> {
  const { images, audio } = assetsForFile(store.doc, path);
  if (!images.length && !audio.length) return 0;
  let blob: Blob;
  try {
    blob = await read();
  } catch {
    return 0; // removed or mid-write; the next change event brings it back
  }
  if (!blob.size) return 0;
  for (const img of images) await reloadImage(img, blob).catch((e) => toast(`Could not reload ${img.name}: ${(e as Error).message}`, "error"));
  for (const a of audio) await reloadAudio(a, blob).catch((e) => toast(`Could not reload ${a.name}: ${(e as Error).message}`, "error"));
  report(path.split(/[\\/]/).pop()!);
  return images.length + audio.length;
}

// ---------------- desktop ----------------

async function startDesktop() {
  const { watch, readFile } = await import("@tauri-apps/plugin-fs");
  const file = projectFilePath();
  const folders = [...new Set([...(file ? assetFolders(store.doc, file.replace(/[\\/][^\\/]*$/, "")) : []), ...extraDesktop])];
  if (!folders.length) {
    toast("Nothing to watch yet: save the project next to its art, or use Watch folder…", "error");
    return false;
  }
  const watched: string[] = [];
  for (const dir of folders) {
    try {
      const stop = await watch(
        dir,
        (e) => {
          for (const p of e.paths) if (IMAGE_EXT.test(p) || AUDIO_EXT.test(p)) void fileChanged(p, async () => new Blob([await readFile(p)], { type: mimeOf(p) }));
        },
        { recursive: extraDesktop.includes(dir), delayMs: 300 },
      );
      stops.push(stop);
      watched.push(dir);
    } catch {
      /* folder gone or outside the allowed scope */
    }
  }
  setWatchedFolders(watched);
  return watched.length > 0;
}

// ---------------- web ----------------

const POLL_MS = 1000;

async function scan(dir: FileSystemDirectoryHandle, prefix = "", out = new Map<string, FileSystemFileHandle>(), depth = 0) {
  if (depth > 4 || out.size > 4000) return out;
  for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === "directory") await scan(h as FileSystemDirectoryHandle, p, out, depth + 1);
    else if (IMAGE_EXT.test(name) || AUDIO_EXT.test(name)) out.set(p, h as FileSystemFileHandle);
  }
  return out;
}

function startWeb(root: FileSystemDirectoryHandle) {
  let files = new Map<string, FileSystemFileHandle>();
  const seen = new Map<string, string>();
  let busy = false;
  let ticks = 0;
  const stamp = (f: File) => `${f.lastModified}:${f.size}`;
  const tick = async (baseline = false) => {
    // Poll only while the editor tab is in front: switching to the paint app and back picks up the changes.
    if (busy || (!baseline && (document.visibilityState !== "visible" || !document.hasFocus()))) return;
    busy = true;
    try {
      if (baseline || ticks++ % 5 === 0) files = await scan(root);
      for (const [p, h] of files) {
        if (!assetsForFile(store.doc, p).images.length && !assetsForFile(store.doc, p).audio.length) continue;
        let f: File;
        try {
          f = await h.getFile();
        } catch {
          continue;
        }
        const was = seen.get(p);
        seen.set(p, stamp(f));
        if (!baseline && was !== undefined && was !== stamp(f)) await fileChanged(p, async () => f);
      }
    } finally {
      busy = false;
    }
  };
  void tick(true);
  const timer = setInterval(() => void tick(), POLL_MS);
  const onFocus = () => void tick();
  window.addEventListener("focus", onFocus);
  stops.push(() => {
    clearInterval(timer);
    window.removeEventListener("focus", onFocus);
  });
  setWatchedFolders([root.name]);
}

// ---------------- controls ----------------

export function stopWatching() {
  for (const s of stops) s();
  stops = [];
  setWatchingSignal(false);
  setWatchedFolders([]);
}

/** Pick a folder of art to watch (native dialog on desktop, folder picker on the web). */
export async function watchFolder() {
  if (isDesktop()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "Watch folder for art changes" });
    if (typeof dir !== "string") return;
    if (!extraDesktop.includes(dir)) extraDesktop.push(dir);
    stopWatching();
    if (await startDesktop()) {
      setWatchingSignal(true);
      toast(`Watching ${watchedFolders().length} folder${watchedFolders().length > 1 ? "s" : ""} for art changes`);
    }
    return;
  }
  const w = window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) return toast("This browser can't watch folders (needs the File System Access API: Chrome or Edge)", "error");
  let root: FileSystemDirectoryHandle;
  try {
    root = await w.showDirectoryPicker({ mode: "read", id: "openbone-watch" });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw e;
  }
  watchDirectoryHandle(root);
  toast(`Watching “${root.name}” for art changes (checked while the editor is in front)`);
}

/** Web: watch a directory handle (from the folder picker, or any FileSystemDirectoryHandle). */
export function watchDirectoryHandle(root: FileSystemDirectoryHandle) {
  stopWatching();
  webRoot = root;
  startWeb(root);
  setWatchingSignal(true);
}

/** ☰ Menu toggle: desktop watches the project's art folders; the web re-uses the last picked folder or asks for one. */
export async function toggleWatching() {
  if (watching()) {
    stopWatching();
    toast("Stopped watching art folders");
    return;
  }
  if (isDesktop()) {
    if (await startDesktop()) {
      setWatchingSignal(true);
      toast(`Watching ${watchedFolders().length} folder${watchedFolders().length > 1 ? "s" : ""} for art changes`);
    }
    return;
  }
  if (!webRoot) return watchFolder();
  startWeb(webRoot);
  setWatchingSignal(true);
  toast(`Watching “${webRoot.name}” for art changes`);
}

/** Desktop: after opening or saving elsewhere, watch the new project's folders. */
export async function rewatch() {
  if (!watching() || !isDesktop()) return;
  for (const s of stops) s();
  stops = [];
  if (!(await startDesktop())) setWatchingSignal(false);
}

// A newly opened project has other art folders.
store.subscribe((_d, e) => {
  if (e.kind === "load") void rewatch();
});
