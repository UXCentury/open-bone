import type { OpenBoneDocument } from "@openbone/core";

/**
 * Re-encode a document's embedded images (and atlas pages) as WebP, keeping each one only when it gets smaller.
 * Painted art typically drops to a quarter of its PNG size at quality 0.85, with alpha kept.
 * Works on data URLs (what exports embed); other sources are left alone.
 */
export async function compressImages(doc: OpenBoneDocument, quality: number): Promise<{ before: number; after: number }> {
  let before = 0;
  let after = 0;
  const one = async (src: string | undefined): Promise<string | undefined> => {
    if (!src?.startsWith("data:image/")) return src;
    before += src.length;
    const out = await toWebp(src, quality);
    const best = out && out.length < src.length ? out : src;
    after += best.length;
    return best;
  };
  for (const img of doc.images) img.src = (await one(img.src)) ?? img.src;
  for (const page of doc.atlas?.pages ?? []) page.src = (await one(page.src)) ?? page.src;
  return { before, after };
}

let webpOk: boolean | undefined;
function canEncodeWebp(): boolean {
  if (webpOk === undefined) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    webpOk = c.toDataURL("image/webp").startsWith("data:image/webp");
  }
  return webpOk;
}

async function toWebp(src: string, quality: number): Promise<string | null> {
  if (src.startsWith("data:image/webp") || !canEncodeWebp()) return null;
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  if (!img.naturalWidth || !img.naturalHeight) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const url = c.toDataURL("image/webp", quality);
  return url.startsWith("data:image/webp") ? url : null;
}
