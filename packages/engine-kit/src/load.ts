import { type OpenBoneDocument, parseDocument, textureAssets } from "@openbone/core";
import { loadDocumentFonts } from "@openbone/runtime";

/** Where a document comes from: a URL, its bytes (.obone JSON or .obonb binary), or an already parsed document. */
export type OpenBoneSource = string | URL | ArrayBuffer | Uint8Array | OpenBoneDocument;

export interface LoadedDocument {
  doc: OpenBoneDocument;
  /** Folder relative image and audio paths resolve against ("" when unknown). */
  baseUrl: string;
}

export interface FetchOptions {
  /** Base URL for relative image/audio paths (default: the document URL's folder). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const isAbsolute = (src: string) => /^(data:|https?:|blob:|file:|\/)/.test(src);

/** Resolve an asset path from a document against a base URL (absolute, data: and blob: URLs pass through). */
export function resolveAssetUrl(src: string, baseUrl: string): string {
  if (isAbsolute(src) || !baseUrl) return src;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return baseUrl + src;
  }
}

/** The folder of a URL (with trailing slash), resolved against the page when relative. */
export function folderOf(url: string): string {
  try {
    const here = typeof location !== "undefined" ? location.href : undefined;
    return new URL(".", new URL(url, here)).href;
  } catch {
    const i = url.lastIndexOf("/");
    return i >= 0 ? url.slice(0, i + 1) : "";
  }
}

/** Fetch (when given a URL) and parse a document; detects .obone JSON vs .obonb binary from the bytes. */
export async function loadDocument(src: OpenBoneSource, opts: FetchOptions = {}): Promise<LoadedDocument> {
  if (typeof src === "string" || src instanceof URL) {
    const url = String(src);
    const res = await (opts.fetch ?? fetch)(url);
    if (!res.ok) throw new Error(`OpenBone: failed to load ${url} (${res.status})`);
    const doc = parseDocument(new Uint8Array(await res.arrayBuffer()));
    // blob:/data: URLs have no folder to resolve relative image paths against.
    const base = opts.baseUrl ?? (/^(blob:|data:)/.test(url) ? "" : folderOf(url));
    return { doc, baseUrl: base };
  }
  if (src instanceof ArrayBuffer || src instanceof Uint8Array) {
    return { doc: parseDocument(src instanceof Uint8Array ? src : new Uint8Array(src)), baseUrl: opts.baseUrl ?? "" };
  }
  return { doc: src, baseUrl: opts.baseUrl ?? "" };
}

/** A texture the document needs: an atlas page, or a loose image when not packed. */
export interface TextureRequest {
  id: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Every texture to load for a document, with URLs resolved: atlas pages (when packed) and images with a source.
 * Images that live only in the atlas (src "") are skipped, their pixels come from the page.
 */
export function textureRequests(doc: OpenBoneDocument, baseUrl: string, resolve?: (src: string) => string): TextureRequest[] {
  return textureAssets(doc).map((t) => ({
    id: t.id,
    url: resolve ? resolve(t.src) : resolveAssetUrl(t.src, baseUrl),
    width: t.width,
    height: t.height,
  }));
}

/** Load an image element (browser), resolving with null when it fails, so one missing file does not stop playback. */
export function loadImageElement(url: string, crossOrigin: string | null = "anonymous"): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const el = new Image();
    if (crossOrigin !== null) el.crossOrigin = crossOrigin;
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = url;
  });
}

/** Load every texture of a document with `load` (default: image elements); failed ones are left out. */
export async function loadTextures<T = HTMLImageElement>(
  doc: OpenBoneDocument,
  baseUrl: string,
  opts: { resolveImageUrl?: (src: string) => string; load?: (url: string, req: TextureRequest) => Promise<T | null> } = {},
): Promise<Map<string, T>> {
  const load = opts.load ?? ((url: string) => loadImageElement(url) as Promise<T | null>);
  const out = new Map<string, T>();
  // The document's own fonts load with its textures (text is rasterised with canvas fonts).
  const fonts = loadDocumentFonts(doc, (f) => resolveAssetUrl(f.src, baseUrl));
  await Promise.all(
    textureRequests(doc, baseUrl, opts.resolveImageUrl).map(async (r) => {
      const t = await load(r.url, r);
      if (t) out.set(r.id, t);
    }),
  );
  await fonts;
  return out;
}
