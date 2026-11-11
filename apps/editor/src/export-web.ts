import type { OpenBoneDocument } from "@openbone/core";
import { type WebPackOptions, type WebPlayerFormat, webIndexHtml, webPackZip } from "@openbone/export";
import { webViewDocument } from "./export-engines.ts";

/** Web export: `<openbone-player>` library + animation + demo page (ZIP), or one self-contained HTML file. */

export interface WebExportOptions {
  format: WebPlayerFormat;
  minify: boolean;
  /** Include the QuickJS script sandbox (needed only when the document has scripts). */
  scripts: boolean;
  singleFile: boolean;
  demoControls: boolean;
  /** State machine to start (name), or null for the first one / first animation. */
  stateMachine: string | null;
  pack: boolean;
  binary: boolean;
  /** Re-encode images as WebP at this quality (0..1) when smaller; null keeps them as they are. */
  webpQuality: number | null;
  /** Player background, or null for transparent; undefined keeps the document's. */
  background: string | null | undefined;
}

// One lazily built bundle per variant (see the webPlayerBundle plugin in vite.config.ts).
const BUNDLES: Record<string, () => Promise<{ default: string }>> = {
  "iife/min/qjs": () => import("virtual:openbone-web-player/iife/min/qjs"),
  "iife/min/noqjs": () => import("virtual:openbone-web-player/iife/min/noqjs"),
  "iife/full/qjs": () => import("virtual:openbone-web-player/iife/full/qjs"),
  "iife/full/noqjs": () => import("virtual:openbone-web-player/iife/full/noqjs"),
  "esm/min/qjs": () => import("virtual:openbone-web-player/esm/min/qjs"),
  "esm/min/noqjs": () => import("virtual:openbone-web-player/esm/min/noqjs"),
  "esm/full/qjs": () => import("virtual:openbone-web-player/esm/full/qjs"),
  "esm/full/noqjs": () => import("virtual:openbone-web-player/esm/full/noqjs"),
  "iife/min/lazy": () => import("virtual:openbone-web-player/iife/min/lazy"),
  "iife/full/lazy": () => import("virtual:openbone-web-player/iife/full/lazy"),
  "esm/min/lazy": () => import("virtual:openbone-web-player/esm/min/lazy"),
  "esm/full/lazy": () => import("virtual:openbone-web-player/esm/full/lazy"),
};

/** The sandbox add-on (openbone-scripts.js) and quickjs.wasm that "lazy" players load when an animation has scripts. */
async function scriptsAddon(minify: boolean): Promise<{ code: string; wasm: Uint8Array }> {
  const code = (await (minify ? import("virtual:openbone-web-player/scripts/min") : import("virtual:openbone-web-player/scripts/full"))).default;
  const b64 = (await import("virtual:openbone-web-player/quickjs-wasm")).default;
  const bin = atob(b64);
  const wasm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) wasm[i] = bin.charCodeAt(i);
  return { code, wasm };
}

/** Player library source for a variant ("lazy": the sandbox ships as separate files, loaded only when needed). */
export async function webPlayerCode(format: WebPlayerFormat, minify: boolean, scripts: boolean | "lazy"): Promise<string> {
  return (await BUNDLES[`${format}/${minify ? "min" : "full"}/${scripts === "lazy" ? "lazy" : scripts ? "qjs" : "noqjs"}`]()).default;
}

/**
 * Approximate player size in KB, for the dialog (measured builds). ZIP exports keep the sandbox in separate files
 * (≈ 55 KB + 491 KB .wasm) that are downloaded only for animations with scripts; single files inline it (+710 KB).
 */
export const playerSizeKb = (minify: boolean, scripts: boolean, singleFile: boolean) => (minify ? 90 : 175) + (scripts && singleFile ? 710 : 0);

export async function exportWebPack(
  source: OpenBoneDocument,
  o: WebExportOptions,
  baseName: string,
  title: string,
  onProgress?: (stage: string, p: number) => void,
): Promise<{ data: Uint8Array; name: string; ext: string; mime: string; description: string }> {
  onProgress?.("Preparing animation", 0);
  const { bytes, doc } = await webViewDocument(source, { pack: o.pack, binary: o.binary, webpQuality: o.webpQuality });
  onProgress?.("Building player", 0.4);
  // ZIP: keep the sandbox out of the player and ship it as files loaded on demand. Single file: inline it.
  const lazy = o.scripts && !o.singleFile;
  const playerCode = await webPlayerCode(o.format, o.minify, lazy ? "lazy" : o.scripts);
  const addon = lazy ? await scriptsAddon(o.minify) : undefined;
  const sm = (o.stateMachine ? doc.stateMachines.find((s) => s.name === o.stateMachine) : null) ?? doc.stateMachines[0];
  const pack: WebPackOptions = {
    title,
    baseName,
    playerCode,
    format: o.format,
    minified: o.minify,
    scripts: o.scripts,
    scriptsAddon: addon,
    doc: bytes,
    docExt: o.binary ? "obonb" : "obone",
    singleFile: o.singleFile,
    demoControls: o.demoControls,
    stateMachine: sm?.name,
    animation: sm ? undefined : doc.animations[0]?.name,
    width: doc.width,
    height: doc.height,
    background: o.background === null ? "transparent" : (o.background ?? undefined),
    inputs: sm?.inputs.map((i) => ({ name: i.name, type: i.type })) ?? [],
    hasScripts: doc.scripts.length > 0,
    hasAudio: !!doc.audio?.assets.length,
    buses: doc.audio?.buses.map((b) => b.name) ?? [],
  };
  onProgress?.("Writing files", 0.9);
  if (o.singleFile)
    return { data: new TextEncoder().encode(webIndexHtml(pack)), name: `${baseName}.html`, ext: "html", mime: "text/html", description: "Web page" };
  return { data: webPackZip(pack), name: `${baseName}-web.zip`, ext: "zip", mime: "application/zip", description: "Web export (ZIP)" };
}
