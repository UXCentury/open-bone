import type { ImageAsset } from "@openbone/core";
import { baseUrl } from "./state.ts";

const overrides = new Map<string, string>();
/** Map a document image src to a different URL for display (e.g. desktop files read from disk). */
export const registerImageOverride = (src: string, url: string) => overrides.set(src, url);

const cache = new Map<string, { src: string; img: HTMLImageElement; ready: boolean }>();
let onReady: () => void = () => {};
export const setImageReadyCallback = (fn: () => void) => (onReady = fn);

/** Resolve an image asset to a loaded HTMLImageElement (null while loading/missing). */
export function imageFor(asset: ImageAsset): HTMLImageElement | null {
  const src = overrides.get(asset.src) ?? (/^(data:|https?:|blob:|\/)/.test(asset.src) ? asset.src : `${baseUrl()}${asset.src}`);
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
