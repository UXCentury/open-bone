declare module "openbone:quickjs-wasm" {
  const bytes: Uint8Array;
  export default bytes;
}

declare module "openbone:script-sandbox" {
  import type { ScriptHost } from "@openbone/runtime";
  export function sandboxFactory(): Promise<ScriptHost | null>;
}
