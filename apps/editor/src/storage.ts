import { type OpenBoneDocument, parseDocument, textureAssets } from "@openbone/core";
import { registerImageOverride } from "./images.ts";
import { exportJson, fileName, loadDocument, setFileName, toast } from "./state.ts";

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
    // Save writes JSON, so a binary file opened here is saved as a new .obone next to it.
    const binary = /\.obonb$/i.test(path);
    desktopPath = binary ? null : path;
    loadDocument(doc, path.split(/[\\/]/).pop()!.replace(/\.obonb$/i, ".obone"), "");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function saveProject(saveAs = false) {
  const json = exportJson();
  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    let path = desktopPath;
    if (!path || saveAs) {
      path = await save({ defaultPath: fileName(), filters: [{ name: "OpenBone", extensions: ["obone"] }] });
      if (!path) return;
    }
    await writeTextFile(path, json);
    desktopPath = path;
    setFileName(path.split(/[\\/]/).pop()!);
    toast(`Saved ${path}`);
    return;
  }
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
