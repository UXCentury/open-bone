import { type OpenBoneDocument, parseDocument, serialize, textureAssets } from "@openbone/core";
import { audioAsDataUrl, registerAudioOverride, resolveAudioUrl } from "./audio.ts";
import { imageAsDataUrl, registerImageOverride, resolveImageUrl } from "./images.ts";
import { fileName, loadDocument, setFileName, store, toast } from "./state.ts";

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

/** True inside the Tauri desktop shell. */
export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let desktopPath: string | null = null;

/** ProjectStorage: native dialogs + filesystem on desktop, File System Access API or download on the web. */
export async function openProject(webFallback: () => void) {
  if (!isDesktop()) return webFallback();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { readTextFile, readFile } = await import("@tauri-apps/plugin-fs");
  const path = await open({ multiple: false, filters: [{ name: "OpenBone", extensions: ["obone", "obonb", "json"] }] });
  if (typeof path !== "string") return;
  try {
    const doc: OpenBoneDocument = parseDocument(await readFile(path));
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    // Relative image paths are read from disk and shown via in-memory data URLs (the file keeps its paths).
    for (const img of textureAssets(doc)) {
      if (/^(data:|https?:)/.test(img.src)) continue;
      const bytes = await readFile(`${dir}/${img.src}`).catch(() => null);
      if (bytes) registerImageOverride(img.src, URL.createObjectURL(new Blob([bytes])));
    }
    for (const a of doc.audio?.assets ?? []) {
      if (/^(data:|https?:)/.test(a.src)) continue;
      const bytes = await readFile(`${dir}/${a.src}`).catch(() => null);
      if (bytes) registerAudioOverride(a.src, URL.createObjectURL(new Blob([bytes])));
    }
    // Save writes JSON, so a binary file opened here is saved as a new .obone next to it.
    const binary = /\.obonb$/i.test(path);
    desktopPath = binary ? null : path;
    loadDocument(doc, path.split(/[\\/]/).pop()!.replace(/\.obonb$/i, ".obone"), "");
  } catch (e) {
    toast((e as Error).message, "error");
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
    setFileName(path.split(/[\\/]/).pop()!);
    toast(`Saved ${path}`);
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
