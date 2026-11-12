import type { FontAsset, OpenBoneDocument } from "@openbone/core";
import { fontsChanged } from "./text.ts";

/** FontFaces already added, by family|weight|style|url, so loading the same document twice adds nothing. */
const added = new Map<string, Promise<boolean>>();

/**
 * Make the document's fonts available to canvas text in a browser (FontFace API): each font is loaded, added to
 * `document.fonts` under its family, and texts naming that family draw with it. Resolves once every font has loaded or
 * failed (a failed font logs a warning and leaves the family to installed fonts). A no-op without the FontFace API
 * (Node, workers without fonts). `resolveUrl` maps a font's src (relative path, data: URI or URL) to a loadable URL.
 */
export async function loadDocumentFonts(doc: Pick<OpenBoneDocument, "fonts">, resolveUrl: (font: FontAsset) => string = (f) => f.src): Promise<void> {
  const fonts = doc.fonts ?? [];
  const g = globalThis as { FontFace?: typeof FontFace; document?: Document };
  if (!fonts.length || typeof g.FontFace !== "function" || !g.document?.fonts) return;
  const results = await Promise.all(fonts.map((f) => addFont(f, resolveUrl(f))));
  if (results.some((r) => r)) fontsChanged();
}

function addFont(f: FontAsset, url: string): Promise<boolean> {
  const weight = String(f.weight ?? 400);
  const style = f.style ?? "normal";
  const key = `${f.family}|${weight}|${style}|${url}`;
  let p = added.get(key);
  if (!p) {
    p = (async () => {
      try {
        const face = new FontFace(f.family, `url(${JSON.stringify(url)})`, { weight, style });
        await face.load();
        document.fonts.add(face);
        return true;
      } catch (e) {
        console.warn(`OpenBone: font "${f.name}" (${f.family}) could not be loaded: ${(e as Error).message ?? e}`);
        added.delete(key);
        return false;
      }
    })();
    added.set(key, p);
  }
  return p;
}
