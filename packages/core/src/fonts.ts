import type { FontAsset, OpenBoneDocument } from "./types.ts";

/** A CSS font-family list ("Noto Serif JP, 'Georgia', serif") as names, without quotes. */
export function splitFontFamilies(list: string | undefined | null): string[] {
  return (list ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter((p) => p.length > 0);
}

/** The document's fonts of one family (case-insensitive). */
export function documentFontsOf(doc: OpenBoneDocument, family: string): FontAsset[] {
  const f = family.toLowerCase();
  return (doc.fonts ?? []).filter((x) => x.family.toLowerCase() === f);
}

/**
 * The document font a text uses: the first family in its `font` list that the document has fonts for, and of those
 * the one whose weight is closest to `weight` (italic only when asked). Null when the text names no document font, so
 * installed fonts apply. Every runtime follows this rule.
 */
export function pickDocumentFont(doc: OpenBoneDocument, families: string, weight = 400, italic = false): FontAsset | null {
  for (const fam of splitFontFamilies(families)) {
    const list = documentFontsOf(doc, fam);
    if (!list.length) continue;
    let best: FontAsset | null = null;
    let score = Infinity;
    for (const f of list) {
      const s = Math.abs((f.weight ?? 400) - weight) + ((f.style === "italic") !== italic ? 1000 : 0);
      if (s < score) (best = f), (score = s);
    }
    return best;
  }
  return null;
}

/** Fonts used by at least one text attachment (by family), for pruning exports. */
export function usedFonts(doc: OpenBoneDocument): Set<FontAsset> {
  const used = new Set<FontAsset>();
  const families = new Set<string>();
  for (const skin of doc.skeleton.skins)
    for (const atts of Object.values(skin.attachments))
      for (const a of Object.values(atts)) if (a.type === "text") for (const f of splitFontFamilies(a.font)) families.add(f.toLowerCase());
  for (const f of doc.fonts ?? []) if (families.has(f.family.toLowerCase())) used.add(f);
  return used;
}

/** File extension → MIME type for font files. */
export const FONT_MIME: Record<string, string> = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", ttc: "font/collection" };
export const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i;
