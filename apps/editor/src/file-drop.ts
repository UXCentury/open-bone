/**
 * Files dropped anywhere on the editor window are imported by type: images, numbered sequences, sprite sheets,
 * PSDs and ZIPs (sequence-import.ts), sounds (audio.ts), fonts (fonts.ts) and other projects (.obone / .obonb open
 * the Import from project dialog).
 *
 * Every drag over the window is claimed, so a drop the editor doesn't use never makes the page navigate to the file
 * (the browser's and WebKit's default, which replaces the editor with a media player or image view). Panels with
 * their own drop targets (Folders) call preventDefault first, and their drops are left to them.
 *
 * Desktop app: on Linux and macOS the window handles file drops natively (Tauri's default) and the webview never
 * sees them as HTML drops (WebKitGTK delivers no files to the page), so the native drop event's paths are read
 * through the fs plugin. On Windows the native handler would break HTML drag and drop inside the page (Folders), so
 * tauri.windows.conf.json turns it off and WebView2 delivers ordinary HTML drops with File objects. A drop that
 * carries only file:// URLs (text/uri-list) is read from disk too.
 */
import { parseDocument } from "@openbone/core";
import { importAudio, isAudioFile } from "./audio.ts";
import { importFonts, isFontFile } from "./fonts.ts";
import { importImages } from "./panels/Toolbar.tsx";
import { openImportDialogWith } from "./panels/ImportDialog.tsx";
import { playActive } from "./play.ts";
import { importFiles } from "./sequence-import.ts";
import { toast } from "./state.ts";
import { isDesktop } from "./storage.ts";

/** MIME types by extension, for files read from a path (they arrive without one). */
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  psd: "image/vnd.adobe.photoshop", zip: "application/zip", json: "application/json",
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", ttc: "font/collection",
  obone: "application/json", obonb: "application/octet-stream",
};
const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";
export const mimeFromName = (name: string) => MIME[extOf(name)] ?? "";

const isProject = (f: File) => /\.(obone|obonb)$/i.test(f.name);
const isSceneFile = (f: File) => /\.(png|jpe?g|webp|gif|psd|zip|json)$/i.test(f.name) || f.type.startsWith("image/");

/** file:// URLs of a drop (text/uri-list), as local paths. */
export function droppedPaths(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.startsWith("file://"))
    .map((l) => {
      const u = new URL(l);
      const p = decodeURIComponent(u.pathname);
      // Windows: file:///C:/x → C:/x
      return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
    });
}

async function filesFromPaths(paths: string[]): Promise<File[]> {
  if (!paths.length || !isDesktop()) return [];
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const out: File[] = [];
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() ?? p;
    try {
      const bytes = await readFile(p);
      out.push(new File([bytes], name, { type: mimeFromName(name) }));
    } catch (err) {
      toast(`Couldn't read ${name}: ${(err as Error)?.message ?? err}`, "error");
    }
  }
  return out;
}

/** Files read from the browser often lack a MIME type (fonts, PSDs); name it from the extension. */
const typed = (f: File) => (f.type || !mimeFromName(f.name) ? f : new File([f], f.name, { type: mimeFromName(f.name), lastModified: f.lastModified }));

/** Import files by type. Returns how many were recognised. */
export async function importDroppedFiles(input: File[]): Promise<number> {
  const files = input.map(typed);
  const scene = files.filter(isSceneFile);
  const audio = files.filter(isAudioFile);
  const fonts = files.filter(isFontFile);
  const projects = files.filter(isProject);
  const known = new Set([...scene, ...audio, ...fonts, ...projects]);
  const unknown = files.filter((f) => !known.has(f));
  if (unknown.length) toast(`Can't import ${unknown.map((f) => f.name).join(", ")}: use images, PSD, ZIP, sounds, fonts or .obone files`, "error");
  if (scene.length) await importFiles(scene, importImages);
  if (audio.length) await importAudio(audio);
  if (fonts.length) await importFonts(fonts);
  for (const p of projects) {
    try {
      openImportDialogWith(parseDocument(new Uint8Array(await p.arrayBuffer())), p.name);
    } catch (err) {
      toast(`Couldn't open ${p.name}: ${(err as Error)?.message ?? err}`, "error");
    }
  }
  return known.size;
}

/** Native drops (desktop, Linux and macOS): when one arrives, an HTML drop of the same files is ignored. */
let nativeDropAt = 0;

async function listenNativeDrops(): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type !== "drop" || playActive()) return;
    nativeDropAt = Date.now();
    void filesFromPaths(e.payload.paths)
      .then((files) => (files.length ? importDroppedFiles(files) : 0))
      .catch((err) => toast(`Import failed: ${(err as Error)?.message ?? err}`, "error"));
  });
}

export function setupFileDrop(): () => void {
  let unlistenNative: (() => void) | undefined;
  let disposed = false;
  void listenNativeDrops()
    .then((u) => (disposed ? u() : (unlistenNative = u)))
    .catch((err) => console.warn("native file drop unavailable", err));
  const over = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = playActive() ? "none" : "copy";
  };
  const drop = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt || playActive() || Date.now() - nativeDropAt < 1000) return;
    const files = Array.from(dt.files);
    const uris = files.length ? "" : dt.getData("text/uri-list") || dt.getData("text/plain");
    void (async () => {
      const all = files.length ? files : await filesFromPaths(droppedPaths(uris));
      if (all.length) await importDroppedFiles(all);
    })().catch((err) => toast(`Import failed: ${(err as Error)?.message ?? err}`, "error"));
  };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
  return () => {
    disposed = true;
    unlistenNative?.();
    window.removeEventListener("dragover", over);
    window.removeEventListener("drop", drop);
  };
}
