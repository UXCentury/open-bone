import { type OpenBoneDocument, deserialize, textureAssets } from "@openbone/core";

/**
 * Where example projects come from: the editor's own /examples/ by default, or any URL set at build time with
 * VITE_OPENBONE_EXAMPLES_URL (e.g. a GitHub Release or a CDN), so deployments don't have to carry the art.
 */
const configured = (import.meta.env.VITE_OPENBONE_EXAMPLES_URL as string | undefined)?.trim();
export const EXAMPLES_BASE = configured ? configured.replace(/\/?$/, "/") : "/examples/";

/** URL of a file inside the examples (relative paths only; absolute and data: URLs pass through). */
export const exampleUrl = (src: string) => (/^(data:|https?:|blob:|\/)/.test(src) ? src : `${EXAMPLES_BASE}${src}`);

export async function fetchExample(name: string): Promise<OpenBoneDocument> {
  const res = await fetch(exampleUrl(`${name}.obone`));
  if (!res.ok) throw new Error(`Example “${name}” could not be downloaded (${res.status})`);
  return deserialize(await res.text());
}

const EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
};
async function asDataUrl(url: string, src: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${src} (${res.status})`);
  let blob = await res.blob();
  const want = EXT[src.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? ""];
  if (want && blob.type !== want) blob = new Blob([blob], { type: want });
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(src));
    r.readAsDataURL(blob);
  });
}

/**
 * Download an example as one self-contained document: every image, atlas page and sound is fetched and stored inside
 * it. `onProgress(done, total)` reports each finished asset.
 */
export async function bundleExample(name: string, onProgress?: (done: number, total: number) => void): Promise<OpenBoneDocument> {
  const doc = await fetchExample(name);
  const items: { src: string; set: (v: string) => void }[] = [];
  for (const t of textureAssets(doc)) if (t.src && !t.src.startsWith("data:")) items.push({ src: t.src, set: (v) => (t.src = v) });
  for (const a of doc.audio?.assets ?? []) if (!a.src.startsWith("data:")) items.push({ src: a.src, set: (v) => (a.src = v) });
  let done = 0;
  onProgress?.(0, items.length);
  // A few at a time: fast on a good connection without flooding a slow one.
  const queue = [...items];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        it.set(await asDataUrl(exampleUrl(it.src), it.src));
        onProgress?.(++done, items.length);
      }
    }),
  );
  return doc;
}
