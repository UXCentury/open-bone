/**
 * Script sandbox for web bundles that ship QuickJS as separate files: `openbone-scripts.js` (the sandbox glue) and
 * `quickjs.wasm`, next to the player. They are loaded only when an animation actually has scripts, so pages
 * without scripts never download them. Set `window.OPENBONE_SCRIPTS_BASE` to load them from another folder.
 */
import type { ScriptHost } from "@openbone/runtime";

interface ScriptsAddon {
  createHost(wasmUrl: string): Promise<ScriptHost>;
}

// Where the player was loaded from: classic scripts know their own <script> element; modules know import.meta.url.
const playerUrl: string = (() => {
  try {
    const s = typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement | null) : null;
    if (s?.src) return s.src;
  } catch {
    /* ignore */
  }
  try {
    const u = (import.meta as { url?: string }).url;
    if (u && !u.startsWith("file:///openbone-player")) return u;
  } catch {
    /* ignore */
  }
  return typeof location !== "undefined" ? location.href : "";
})();

/** Folder holding openbone-scripts.js and quickjs.wasm (default: the player's folder). */
function folder(): string {
  const g = globalThis as { OPENBONE_SCRIPTS_BASE?: string };
  const b = g.OPENBONE_SCRIPTS_BASE ?? new URL(".", playerUrl).href;
  return b.endsWith("/") ? b : `${b}/`;
}

let loading: Promise<ScriptsAddon> | null = null;
function loadAddon(): Promise<ScriptsAddon> {
  const g = globalThis as { OpenBoneScripts?: ScriptsAddon };
  if (g.OpenBoneScripts) return Promise.resolve(g.OpenBoneScripts);
  loading ??= new Promise<ScriptsAddon>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${folder()}openbone-scripts.js`;
    s.async = true;
    s.onload = () => (g.OpenBoneScripts ? resolve(g.OpenBoneScripts) : reject(new Error("openbone-scripts.js did not register")));
    s.onerror = () => reject(new Error(`could not load ${s.src}`));
    document.head.append(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

export async function sandboxFactory(): Promise<ScriptHost | null> {
  try {
    const addon = await loadAddon();
    return await addon.createHost(`${folder()}quickjs.wasm`);
  } catch (e) {
    console.warn("OpenBone: could not load the script sandbox (openbone-scripts.js + quickjs.wasm next to the player); scripts will not run.", e);
    return null;
  }
}
