/**
 * `openbone-scripts.js`: the QuickJS script sandbox as an add-on for the web player. The player loads it (and
 * `quickjs.wasm`) only when an animation has scripts; see sandbox-lazy.ts. Registers `globalThis.OpenBoneScripts`.
 */
import { createQuickJsHost } from "@openbone/scripting";
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten";

async function createHost(wasmUrl: string) {
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`${wasmUrl}: HTTP ${res.status}`);
  const wasmBinary = await res.arrayBuffer();
  const module = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmBinary }));
  return createQuickJsHost({ module });
}

(globalThis as { OpenBoneScripts?: unknown }).OpenBoneScripts = { createHost };
