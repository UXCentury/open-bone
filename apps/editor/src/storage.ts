import { type OpenBoneDocument, parseDocument, serialize, textureAssets } from "@openbone/core";
import { confirmDiscard } from "./destructive.ts";
import { audioAsDataUrl, registerAudioOverride, resolveAudioUrl } from "./audio.ts";
import { fontAsDataUrl, registerFontOverride, resolveFontUrl } from "./fonts.ts";
import { imageAsDataUrl, registerImageOverride, resolveImageUrl } from "./images.ts";
import { fileName, loadDocument, setFileName, store, toast } from "./state.ts";
import { addRecent, recentLabel, removeRecent } from "./recent.ts";

const isRelative = (src: string) => !!src && !/^(data:|https?:|blob:)/.test(src);

/**
 * A copy of the document with every image, atlas page and sound stored inside it (data: URLs), so a file saved from
 * the browser opens anywhere with its art and audio. Assets that can't be read are left as they are.
 */
export async function bundledDocument(doc: OpenBoneDocument): Promise<{ doc: OpenBoneDocument; missing: string[] }> {
  const out = structuredClone(doc);
  const missing: string[] = [];
  for (const t of textureAssets(out)) {
    if (!isRelative(t.src)) continue;
    try {
      t.src = await imageAsDataUrl(t as never);
    } catch {
      missing.push(t.src);
    }
  }
  for (const a of out.audio?.assets ?? []) {
    if (!isRelative(a.src)) continue;
    try {
      a.src = await audioAsDataUrl(a);
    } catch {
      missing.push(a.src);
    }
  }
  for (const f of out.fonts ?? []) {
    if (!isRelative(f.src)) continue;
    try {
      f.src = await fontAsDataUrl(f);
    } catch {
      missing.push(f.src);
    }
  }
  return { doc: out, missing };
}

/**
 * Desktop: copy every relative image and sound next to the saved file (same relative path), so the project folder is
 * complete wherever it is saved. Reads each asset from wherever the editor loads it now.
 */
async function copyAssetsTo(dir: string, doc: OpenBoneDocument): Promise<string[]> {
  const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
  const missing: string[] = [];
  const jobs: { src: string; url: string }[] = [
    ...textureAssets(doc).filter((t) => isRelative(t.src)).map((t) => ({ src: t.src, url: resolveImageUrl(t as never) })),
    ...(doc.audio?.assets ?? []).filter((a) => isRelative(a.src)).map((a) => ({ src: a.src, url: resolveAudioUrl(a) })),
    ...(doc.fonts ?? []).filter((f) => isRelative(f.src)).map((f) => ({ src: f.src, url: resolveFontUrl(f) })),
  ];
  for (const j of jobs) {
    try {
      const res = await fetch(j.url);
      if (!res.ok) throw new Error(String(res.status));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const target = `${dir}/${j.src}`;
      const parent = target.replace(/[\\/][^\\/]*$/, "");
      await mkdir(parent, { recursive: true }).catch(() => {});
      await writeFile(target, bytes);
    } catch {
      missing.push(j.src);
    }
  }
  return missing;
}

const warnMissing = (missing: string[]) => {
  if (missing.length) toast(`Saved, but ${missing.length} asset${missing.length > 1 ? "s" : ""} could not be read: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`, "error");
};

/** Show a saved file selected in its folder (Finder, Explorer, the Linux file manager). Desktop only. */
export async function revealInFolder(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (e) {
    toast(`Could not open the folder: ${(e as Error).message ?? e}`, "error");
  }
}

/**
 * "Saved …" toast with an Open folder button when `path` is a real file path (desktop). Browsers only give pages
 * the file name, never its folder, so on the web the toast says where downloads usually go instead.
 */
export function savedToast(text: string, path: string | null) {
  if (isDesktop() && path && /[\\/]/.test(path)) toast(text, "info", { label: "Open folder", run: () => revealInFolder(path) });
  else toast(text);
}

/** True inside the Tauri desktop shell. */
export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let desktopPath: string | null = null;
/** Desktop: the project file being edited (null for unsaved projects, on the web, or a binary file opened read-only). */
export const projectFilePath = () => desktopPath;

/**
 * Desktop: the folder the open project's relative asset paths ("assets/arm.png") are read from — the folder of the
 * project file, or of the MCP server's project file. Kept in the autosave, so the art comes back after a restart.
 * Any other load (an example, a new project, a dropped file) clears it.
 */
let assetDir: string | null = null;
export const projectAssetDir = () => assetDir;
export const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
/** After the load that brought this project in (loads clear it): where its relative assets live. */
export function setProjectAssetDir(dir: string | null) {
  assetDir = dir;
}
store.subscribe((_d, e) => {
  if (e.kind === "load") assetDir = null;
});

/**
 * Desktop: read a project's relative images, sounds and fonts from `dir` and show them from memory (the document
 * keeps its paths). Returns the files that could not be read.
 */
export async function loadAssetsFromDisk(doc: OpenBoneDocument, dir: string): Promise<string[]> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const missing: string[] = [];
  const load = async (src: string, register: (src: string, url: string) => void) => {
    if (!isRelative(src)) return;
    const file = `${dir}/${src}`;
    try {
      register(src, URL.createObjectURL(new Blob([await readFile(file)])));
    } catch {
      missing.push(file);
    }
  };
  for (const img of textureAssets(doc)) await load(img.src, registerImageOverride);
  for (const a of doc.audio?.assets ?? []) await load(a.src, registerAudioOverride);
  for (const f of doc.fonts ?? []) await load(f.src, registerFontOverride);
  return missing;
}

/**
 * Web: a page can't read the files next to a project it opened, so its relative images, sounds and fonts come from a
 * folder the user picks (a folder input, which every browser has). A file matches an asset when its path inside the
 * picked folder is the asset's path, or ends with it (a parent folder was picked). Returns the paths still missing.
 */
export function pickAssetFolder(doc: OpenBoneDocument = store.doc): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => resolve(registerPickedAssets(doc, [...(input.files ?? [])]));
    input.click();
  });
}

/** Show a project's relative assets from picked files (see `pickAssetFolder`). Exported for tests. */
export function registerPickedAssets(doc: OpenBoneDocument, files: File[]): string[] {
  // The first part of webkitRelativePath is the picked folder itself.
  const byPath = files.map((f) => ({ f, rel: (f.webkitRelativePath || f.name).replace(/^[^/]*\//, "") }));
  const find = (src: string) => {
    const want = src.replace(/^\.\//, "");
    return byPath.find((x) => x.rel === want)?.f ?? byPath.find((x) => x.rel.endsWith(`/${want}`))?.f;
  };
  const missing: string[] = [];
  let found = 0;
  const load = (src: string, register: (src: string, url: string) => void) => {
    if (!isRelative(src)) return;
    const f = find(src);
    if (!f) return missing.push(src);
    register(src, URL.createObjectURL(f));
    found++;
  };
  for (const img of textureAssets(doc)) load(img.src, registerImageOverride);
  for (const a of doc.audio?.assets ?? []) load(a.src, registerAudioOverride);
  for (const f of doc.fonts ?? []) load(f.src, registerFontOverride);
  // Redraw with the new pixels (no undo step, nothing changes in the document).
  for (const img of doc.images) if (isRelative(img.src) && find(img.src)) store.applyQuiet("updateImage", { image: img.id }, "assets");
  if (found) toast(`Loaded ${found} file${found === 1 ? "" : "s"} from the project folder`);
  reportUnreadable(missing);
  return missing;
}

/** Web: after opening a project whose art is stored next to its file, offer to read it from the project folder. */
export function offerAssetFolder(doc: OpenBoneDocument) {
  if (isDesktop() || !hasRelativeAssets(doc)) return;
  toast("This project's images and sounds are files next to it, which a web page can't read on its own. Choose the project's folder to show them.", "info", {
    label: "Choose folder",
    run: () => void pickAssetFolder(doc),
  });
}

/**
 * Web: offer the folder only when the art really can't be fetched (the examples' relative paths load from the site).
 * Dev servers answer unknown paths with the app page, so only an image response counts.
 */
export async function offerAssetFolderIfMissing(doc: OpenBoneDocument, base = "") {
  if (isDesktop()) return;
  const src = textureAssets(doc).map((t) => t.src).find(isRelative);
  if (!src) return;
  try {
    const r = await fetch(`${base}${src}`, { method: "HEAD" });
    if (r.ok && (r.headers.get("content-type") ?? "").startsWith("image/")) return;
  } catch {
    /* unreachable: offer the folder */
  }
  offerAssetFolder(doc);
}

/** True when a document has images, sounds or fonts stored as paths next to its file. */
export const hasRelativeAssets = (doc: OpenBoneDocument) =>
  textureAssets(doc).some((i) => isRelative(i.src)) || (doc.audio?.assets ?? []).some((a) => isRelative(a.src)) || (doc.fonts ?? []).some((f) => isRelative(f.src));

const relativeSrcs = (doc: OpenBoneDocument) =>
  new Set([...textureAssets(doc), ...(doc.audio?.assets ?? []), ...(doc.fonts ?? [])].map((a) => a.src).filter(isRelative));

/** The two documents load some of the same files by relative path: the same project, so its folder still applies. */
export function sharesRelativeAssets(a: OpenBoneDocument, b: OpenBoneDocument) {
  const mine = relativeSrcs(a);
  return [...relativeSrcs(b)].some((s) => mine.has(s));
}

/**
 * Desktop, at startup: the autosaved project's art comes back from the folder it was in. Call before loading the
 * document; then `afterRestore` marks the folder (and file) again. Without a folder (autosaves from before 0.4.7),
 * say how to get the art back instead of showing empty parts silently.
 */
export async function restoreDesktopAssets(doc: OpenBoneDocument, saved: { dir?: string | null; path?: string | null }) {
  if (!isDesktop() || !hasRelativeAssets(doc)) return () => {};
  if (!saved.dir) {
    return () => toast("This project's images are next to its file, which the editor doesn't know yet: open it again with ☰ Menu → Open to show them.", "error");
  }
  const missing = await loadAssetsFromDisk(doc, saved.dir);
  return () => {
    assetDir = saved.dir!;
    if (saved.path) desktopPath = saved.path;
    reportUnreadable(missing);
  };
}

/** One toast for files that could not be read, so missing art never goes unnoticed. */
export function reportUnreadable(paths: string[], what = "asset") {
  if (!paths.length) return;
  const n = paths.length;
  toast(`${n} ${what}${n === 1 ? "" : "s"} could not be read${n === 1 ? "" : `, first`}: ${paths[0]}`, "error");
}

/** ProjectStorage: native dialogs + filesystem on desktop, File System Access API or download on the web. */
export async function openProject(webFallback: () => void) {
  if (!isDesktop()) return webFallback();
  if (!(await confirmDiscard("Opening another project"))) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, filters: [{ name: "OpenBone", extensions: ["obone", "obonb", "json"] }] });
  if (typeof path !== "string") return;
  await openProjectFile(path);
}

/** Desktop: ☰ Menu → Open recent. A project that is gone is taken off the list. */
export async function openRecentProject(path: string) {
  if (!isDesktop()) return;
  if (!(await confirmDiscard("Opening another project"))) return;
  if (!(await openProjectFile(path))) {
    removeRecent(path);
    toast(`${recentLabel(path)} could not be opened, so it was removed from Open recent.`, "error");
  }
}

/** Desktop: open the project file at `path` with its art. Returns whether it opened. */
async function openProjectFile(path: string): Promise<boolean> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  try {
    const doc: OpenBoneDocument = parseDocument(await readFile(path));
    const dir = dirOf(path);
    // Relative image paths are read from disk and shown via in-memory data URLs (the file keeps its paths).
    const missing = await loadAssetsFromDisk(doc, dir);
    // Save writes JSON, so a binary file opened here is saved as a new .obone next to it.
    const binary = /\.obonb$/i.test(path);
    desktopPath = binary ? null : path;
    loadDocument(doc, path.split(/[\\/]/).pop()!.replace(/\.obonb$/i, ".obone"), "");
    assetDir = dir;
    addRecent(path);
    reportUnreadable(missing);
    return true;
  } catch (e) {
    toast((e as Error).message, "error");
    return false;
  }
}

export async function saveProject(saveAs = false) {
  const doc = store.doc;
  if (isDesktop()) {
    const json = serialize(doc);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    let path = desktopPath;
    if (!path || saveAs) {
      path = await save({ defaultPath: fileName(), filters: [{ name: "OpenBone", extensions: ["obone"] }] });
      if (!path) return;
    }
    await writeTextFile(path, json);
    // The images and sounds go into the same folder, so the project opens complete from there.
    warnMissing(await copyAssetsTo(path.replace(/[\\/][^\\/]*$/, ""), doc));
    desktopPath = path;
    assetDir = dirOf(path);
    addRecent(path);
    setFileName(path.split(/[\\/]/).pop()!);
    savedToast(`Saved ${path}`, path);
    return;
  }
  // In the browser the file is all we can write: it carries its images and sounds inside.
  const bundled = await bundledDocument(doc);
  warnMissing(bundled.missing);
  const json = serialize(bundled.doc);
  const w = window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: fileName(), types: [{ description: "OpenBone", accept: { "application/json": [".obone"] } }] });
      const s = await h.createWritable();
      await s.write(json);
      await s.close();
      setFileName(h.name);
      toast(`Saved ${h.name}`);
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = fileName();
  a.click();
  URL.revokeObjectURL(a.href);
  setFileName(fileName());
}

/**
 * Save a file somewhere the user picks (native dialog on desktop, file picker or download on the web)
 * without changing the open project's file. Returns the saved name, or null if cancelled.
 */
export async function saveFile(suggestedName: string, data: string | Uint8Array, opts: { ext: string; description: string; mime: string }): Promise<string | null> {
  const { ext, description, mime } = opts;
  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile, writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: suggestedName, filters: [{ name: description, extensions: [ext] }] });
    if (!path) return null;
    if (typeof data === "string") await writeTextFile(path, data);
    else await writeFile(path, data);
    return path;
  }
  const w = window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [`.${ext}`] } }] });
      const s = await h.createWritable();
      await s.write(data as FileSystemWriteChunkType);
      await s.close();
      return h.name;
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return suggestedName;
}

/** Text convenience wrapper for {@link saveFile} (defaults to an .obone document). */
export const saveTextFile = (suggestedName: string, text: string, ext = "obone", description = "OpenBone") =>
  saveFile(suggestedName, text, { ext, description, mime: "application/json" });

// ---------- Save to folder ----------

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac", "audio/webm": "webm",
  "font/ttf": "ttf", "font/otf": "otf", "font/woff": "woff", "font/woff2": "woff2", "font/collection": "ttc", "application/x-font-ttf": "ttf", "application/font-sfnt": "otf",
};
const safeName = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "asset";

/** Bytes and a file name for an asset: data: URLs are decoded, relative and absolute paths are fetched. */
async function assetBytes(src: string, url: string, fallbackName: string, kind: "image" | "audio" | "font"): Promise<{ bytes: Uint8Array; path: string }> {
  if (src.startsWith("data:")) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
    if (!m) throw new Error("bad data URL");
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    const ext = MIME_EXT[m[1] ?? ""] ?? (kind === "image" ? "png" : kind === "font" ? "otf" : "wav");
    return { bytes, path: `assets/${safeName(fallbackName)}.${ext}` };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Relative paths are kept as they are; absolute URLs get a file in assets/ named after them.
  const path = isRelative(src) ? src : `assets/${safeName(src.split(/[?#]/)[0].split("/").pop() || fallbackName)}`;
  return { bytes, path };
}

/**
 * Save the project as a folder: the .obone file plus every image and sound as separate files under assets/
 * (embedded data: assets are written out as files, so the project file stays small and the art can be edited).
 * Browser: pick a folder (Chrome/Edge); desktop: native folder dialog.
 */
export async function saveProjectToFolder() {
  const doc = structuredClone(store.doc);
  const files: { path: string; bytes: Uint8Array }[] = [];
  const used = new Set<string>();
  const unique = (p: string) => {
    let out = p;
    for (let i = 2; used.has(out); i++) out = p.replace(/(\.[^./]+)?$/, `-${i}$1`);
    used.add(out);
    return out;
  };
  const missing: string[] = [];
  for (const t of textureAssets(doc)) {
    if (!t.src) continue;
    try {
      const { bytes, path } = await assetBytes(t.src, resolveImageUrl(t as never), t.name, "image");
      const p = unique(path);
      files.push({ path: p, bytes });
      t.src = p;
    } catch {
      missing.push(t.name);
    }
  }
  for (const a of doc.audio?.assets ?? []) {
    try {
      const { bytes, path } = await assetBytes(a.src, resolveAudioUrl(a), a.name, "audio");
      const p = unique(path);
      files.push({ path: p, bytes });
      a.src = p;
    } catch {
      missing.push(a.name);
    }
  }
  for (const f of doc.fonts ?? []) {
    try {
      const { bytes, path } = await assetBytes(f.src, resolveFontUrl(f), f.name, "font");
      const p = unique(path);
      files.push({ path: p, bytes });
      f.src = p;
    } catch {
      missing.push(f.name);
    }
  }
  const json = serialize(doc);
  const name = fileName().replace(/\.obonb$/i, ".obone") || "project.obone";

  if (isDesktop()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile, writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    const dir = await open({ directory: true, multiple: false, title: "Save project to folder" });
    if (typeof dir !== "string") return;
    for (const f of files) {
      const target = `${dir}/${f.path}`;
      await mkdir(target.replace(/[\\/][^\\/]*$/, ""), { recursive: true }).catch(() => {});
      await writeFile(target, f.bytes);
    }
    await writeTextFile(`${dir}/${name}`, json);
    desktopPath = `${dir}/${name}`;
    assetDir = dir;
    addRecent(desktopPath);
    setFileName(name);
    warnMissing(missing);
    savedToast(`Saved ${name} and ${files.length} asset files to ${dir}`, `${dir}/${name}`);
    return;
  }
  const w = window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> };
  if (!w.showDirectoryPicker) return toast("This browser can't write folders: use Save (one file with everything inside) or Chrome/Edge", "error");
  let root: FileSystemDirectoryHandle;
  try {
    root = await w.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw e;
  }
  const write = async (path: string, data: Uint8Array | string) => {
    const parts = path.split("/");
    let d = root;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const s = await fh.createWritable();
    await s.write(data as FileSystemWriteChunkType);
    await s.close();
  };
  for (const f of files) await write(f.path, f.bytes);
  await write(name, json);
  setFileName(name);
  warnMissing(missing);
  toast(`Saved ${name} and ${files.length} asset files to “${root.name}”`);
}
