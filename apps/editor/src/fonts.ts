import { FONT_EXT, FONT_MIME, type FontAsset, fontNameFromFile, readFontMeta } from "@openbone/core";
import { loadDocumentFonts } from "@openbone/runtime";
import { readFileAsDataUrl } from "./images.ts";
import { apply, baseUrl, setSelection, store, toast } from "./state.ts";

const overrides = new Map<string, string>();
/** Map a document font src to a different URL (desktop files read from disk, MCP bridge files). */
export const registerFontOverride = (src: string, url: string) => {
  overrides.set(src, url);
  void syncFonts();
};

/** URL the editor loads a font from (overrides, absolute URLs, or relative to the project). */
export const resolveFontUrl = (font: Pick<FontAsset, "src">) =>
  overrides.get(font.src) ?? (/^(data:|https?:|blob:|\/)/.test(font.src) ? font.src : `${baseUrl()}${font.src}`);

/** Load the document's fonts into the page (FontFace), so the viewport, Play mode and previews draw text with them. */
function syncFonts() {
  return loadDocumentFonts(store.doc, resolveFontUrl);
}
let lastFonts: FontAsset[] | undefined;
store.subscribe((d) => {
  if (d.fonts === lastFonts) return;
  lastFonts = d.fonts;
  void syncFonts();
});

export const isFontFile = (f: File) => FONT_EXT.test(f.name) || f.type.startsWith("font/");

/** Import TTF/OTF/WOFF2 files as embedded fonts; the family, weight and style come from the file. */
export async function importFonts(files: FileList | File[]) {
  let last: string | undefined;
  let family = "";
  for (const file of Array.from(files)) {
    if (!isFontFile(file)) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = readFontMeta(bytes);
    let src = await readFileAsDataUrl(file);
    // Browsers label font files inconsistently (or not at all): name the type from the extension.
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (FONT_MIME[ext]) src = src.replace(/^data:[^;,]*/, `data:${FONT_MIME[ext]}`);
    const base = fontNameFromFile(file.name) || "font";
    const taken = new Set((store.doc.fonts ?? []).map((x) => x.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    family = meta?.family ?? base;
    const r = apply("addFont", { name, family, src, weight: meta?.weight ?? 400, style: meta?.style ?? "normal" }) as { id: string } | undefined;
    if (r) last = r.id;
    if (ext === "woff" || ext === "woff2") toast(`${file.name}: WOFF fonts work on the web only; game engines need TTF or OTF.`, "error");
  }
  if (last) {
    setSelection({ kind: "font", id: last });
    toast(`Font "${family}" added. Texts that list it in Font draw with it, in the editor and every runtime.`);
  }
  return last;
}

/** Font asset as a data: URL (for embedding in an exported file). */
export async function fontAsDataUrl(font: FontAsset): Promise<string> {
  if (font.src.startsWith("data:")) return font.src;
  const res = await fetch(resolveFontUrl(font));
  if (!res.ok) throw new Error(`Could not read font "${font.name}" (${res.status})`);
  const ext = font.src.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  let blob = await res.blob();
  if (!blob.type.startsWith("font/") && FONT_MIME[ext]) blob = new Blob([blob], { type: FONT_MIME[ext] });
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(`Could not read font "${font.name}"`));
    r.readAsDataURL(blob);
  });
}
