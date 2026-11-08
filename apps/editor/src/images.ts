import type { ImageAsset } from "@openbone/core";
import { baseUrl } from "./state.ts";

const overrides = new Map<string, string>();
/** Map a document image src to a different URL for display (e.g. desktop files read from disk). */
export const registerImageOverride = (src: string, url: string) => overrides.set(src, url);

const cache = new Map<string, { src: string; img: HTMLImageElement; ready: boolean }>();
let onReady: () => void = () => {};
export const setImageReadyCallback = (fn: () => void) => (onReady = fn);

/** URL the editor loads an image asset from (desktop overrides, absolute URLs, or relative to the project). */
export const resolveImageUrl = (asset: ImageAsset) =>
  overrides.get(asset.src) ?? (/^(data:|https?:|blob:|\/)/.test(asset.src) ? asset.src : `${baseUrl()}${asset.src}`);

/** Image asset as a data: URL (for embedding in an exported file). */
export async function imageAsDataUrl(asset: ImageAsset): Promise<string> {
  if (asset.src.startsWith("data:")) return asset.src;
  const res = await fetch(resolveImageUrl(asset));
  if (!res.ok) throw new Error(`Could not read image "${asset.name}" (${res.status})`);
  const blob = await res.blob();
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(`Could not read image "${asset.name}"`));
    r.readAsDataURL(blob);
  });
}

/** Resolve an image asset to a loaded HTMLImageElement (null while loading/missing). */
export function imageFor(asset: ImageAsset): HTMLImageElement | null {
  const src = resolveImageUrl(asset);
  let e = cache.get(asset.id);
  if (!e || e.src !== src) {
    const img = new Image();
    e = { src, img, ready: false };
    const entry = e;
    img.onload = () => {
      entry.ready = true;
      onReady();
    };
    img.src = src;
    cache.set(asset.id, e);
  }
  return e.ready ? e.img : null;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = rej;
    img.src = src;
  });
}
