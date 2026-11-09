import type { AudioAsset, ImageAsset, OpenBoneDocument } from "@openbone/core";

/** Pure helpers for live art reloading (watch.ts): which assets a changed file belongs to. */

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
export const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
/** A file path in the document (relative to the project), not embedded data or a URL. */
export const isFileSrc = (src: string) => !!src && !/^(data:|https?:|blob:)/.test(src);
const stem = (p: string) => norm(p).split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
/** `a` ends with path `b` on a folder boundary (or they are equal). */
const endsWithPath = (a: string, b: string) => a === b || a.endsWith(`/${b}`);

/**
 * Assets a changed file stands for. `file` is the changed path relative to the watched folder (or absolute); an
 * asset matches when its src path and the file path end the same way (assets/arm.png ↔ /art/assets/arm.png), or,
 * for embedded art, when the file name (without extension) is the asset's name.
 */
export function assetsForFile(doc: Pick<OpenBoneDocument, "images" | "audio">, file: string): { images: ImageAsset[]; audio: AudioAsset[] } {
  const f = norm(file).toLowerCase();
  const name = stem(f);
  const matches = (src: string, assetName: string) => {
    if (isFileSrc(src)) {
      const s = norm(src).toLowerCase();
      return endsWithPath(f, s) || endsWithPath(s, f);
    }
    return assetName.toLowerCase() === name || (!!src && stem(assetName) === name);
  };
  return {
    images: IMAGE_EXT.test(f) ? doc.images.filter((i) => i.src && matches(i.src, i.name)) : [],
    audio: AUDIO_EXT.test(f) ? (doc.audio?.assets ?? []).filter((a) => matches(a.src, a.name)) : [],
  };
}

/** Folders (absolute) holding the project's file-based images and sounds, given the project file's folder. */
export function assetFolders(doc: Pick<OpenBoneDocument, "images" | "audio" | "atlas">, projectDir: string): string[] {
  const dirs = new Set<string>();
  const base = norm(projectDir).replace(/\/$/, "");
  for (const src of [...doc.images.map((i) => i.src), ...(doc.atlas?.pages ?? []).map((p) => p.src), ...(doc.audio?.assets ?? []).map((a) => a.src)]) {
    if (!isFileSrc(src)) continue;
    const s = norm(src);
    const abs = /^([a-z]:)?\//i.test(s) ? s : `${base}/${s}`;
    dirs.add(abs.replace(/\/[^/]*$/, "") || "/");
  }
  return [...dirs].sort();
}
