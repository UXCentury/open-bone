/**
 * Build the self-contained WebView player bundle: one classic (non-module) script with the player, renderers,
 * runtime and the QuickJS script sandbox (its .wasm inlined), so it runs from file:// in any WebView.
 *
 *   pnpm build:player-bundle            -> packages/player/dist/openbone-player.js
 *
 * The editor builds the same bundle through a Vite plugin (apps/editor/vite.config.ts), so exports never need
 * a prebuilt file and work offline.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLE_ENTRY = path.join(here, "webview.ts");
/** Folder whose changes invalidate the bundle (player, runtime, renderers, core, scripting sources). */
export const BUNDLE_SOURCES = path.resolve(here, "../../..");

function quickJsWasmPath(): string {
  const req = createRequire(import.meta.url);
  const qjs = req.resolve("quickjs-emscripten");
  const variant = createRequire(qjs).resolve("@jitl/quickjs-wasmfile-release-sync");
  return path.join(path.dirname(variant), "emscripten-module.wasm");
}

/** Build the bundle and return its source. */
export async function buildPlayerBundle(opts: { minify?: boolean } = {}): Promise<string> {
  const wasm = quickJsWasmPath();
  const result = await build({
    entryPoints: [BUNDLE_ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: opts.minify ?? true,
    legalComments: "none",
    // Emscripten builds a .wasm URL from import.meta.url even when given the bytes. Classic scripts have no
    // import.meta, and the page URL can be blob:/about: (not a valid base), so use a fixed, never-fetched URL.
    define: { "import.meta.url": JSON.stringify("file:///openbone-player.js") },
    logLevel: "silent",
    banner: { js: "/*! OpenBone player bundle (MIT). Includes quickjs-emscripten (MIT). https://github.com/UXCentury/open-bone */" },
    plugins: [
      {
        name: "openbone-quickjs-wasm",
        setup(b) {
          b.onResolve({ filter: /^@openbone\/core$/ }, () => ({ path: path.join(here, "core-lite.ts") }));
          b.onResolve({ filter: /^openbone:quickjs-wasm$/ }, () => ({ path: wasm, namespace: "openbone-wasm" }));
          b.onLoad({ filter: /.*/, namespace: "openbone-wasm" }, () => ({ contents: fs.readFileSync(wasm), loader: "binary" }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

export type WebBundleFormat = "iife" | "esm";

export interface WebBundleOptions {
  /** "iife": classic `<script src>` exposing `window.OpenBone`; "esm": an ES module with named exports. */
  format?: WebBundleFormat;
  minify?: boolean;
  /** Inline the QuickJS sandbox so document scripts run (adds ~0.5 MB). */
  scripts?: boolean;
}

function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(here, "../../package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Build the web player library (`<openbone-player>` + `OpenBone.Player`) for websites: classic script or ES module,
 * minified or readable, with or without the script sandbox. Returns the source.
 */
export async function buildWebBundle(opts: WebBundleOptions = {}): Promise<string> {
  const format = opts.format ?? "iife";
  const scripts = opts.scripts ?? true;
  const minify = opts.minify ?? true;
  const result = await build({
    entryPoints: [path.join(here, "web.ts")],
    bundle: true,
    write: false,
    format,
    ...(format === "iife" ? { globalName: "OpenBone" } : {}),
    platform: "browser",
    target: "es2020",
    minify,
    legalComments: "none",
    define: {
      "import.meta.url": JSON.stringify("file:///openbone-player.js"),
      __OPENBONE_VERSION__: JSON.stringify(packageVersion()),
    },
    logLevel: "silent",
    banner: {
      js: `/*! OpenBone web player ${packageVersion()} (MIT)${scripts ? ". Includes quickjs-emscripten (MIT)" : ""}. https://github.com/UXCentury/open-bone */`,
    },
    plugins: [
      {
        name: "openbone-web",
        setup(b) {
          b.onResolve({ filter: /^@openbone\/core$/ }, () => ({ path: path.join(here, "core-lite.ts") }));
          b.onResolve({ filter: /^openbone:script-sandbox$/ }, () => ({ path: path.join(here, scripts ? "sandbox-quickjs.ts" : "sandbox-none.ts") }));
          if (!scripts) b.onResolve({ filter: /^@openbone\/scripting$/ }, () => ({ path: path.join(here, "scripting-stub.ts") }));
          b.onResolve({ filter: /^openbone:quickjs-wasm$/ }, () => ({ path: quickJsWasmPath(), namespace: "openbone-wasm" }));
          b.onLoad({ filter: /.*/, namespace: "openbone-wasm" }, () => ({ contents: fs.readFileSync(quickJsWasmPath()), loader: "binary" }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = path.resolve(here, "../../dist/openbone-player.js");
  const code = await buildPlayerBundle();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, code);
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${(code.length / 1024).toFixed(0)} KB)`);
}
