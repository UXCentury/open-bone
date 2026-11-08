/** Script sandbox for web bundles that include QuickJS: the .wasm is inlined, so nothing is fetched. */
import type { ScriptHost } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten";
import wasmBinary from "openbone:quickjs-wasm";

export async function sandboxFactory(): Promise<ScriptHost | null> {
  const module = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmBinary: wasmBinary.slice().buffer }));
  return createQuickJsHost({ module });
}
