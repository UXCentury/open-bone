import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Plugin, defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { collectCredits } from "../../scripts/credits.ts";
import { currentVersion } from "../../scripts/version.ts";
import { type WebBundleFormat, buildPlayerBundle, buildScriptsAddon, buildWebBundle, quickJsWasmBytes } from "../../packages/player/src/bundle/build.ts";

const EXAMPLES = path.resolve(__dirname, "../../examples");
const MIME: Record<string, string> = { ".obone": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg" };

/** Every file under a folder, as paths relative to it (examples/assets has subfolders per art source). */
function walk(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, p) : [p];
  });
}

/** Serve (dev) and copy (build) the repo's example projects at /examples/. */
function examples(): Plugin {
  const files = () => [...fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".obone")), ...walk(EXAMPLES, "assets")];
  return {
    name: "openbone-examples",
    configureServer(server) {
      server.middlewares.use("/examples", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const file = path.join(EXAMPLES, rel);
        if (!file.startsWith(EXAMPLES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
        res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      // Examples hosted elsewhere (VITE_OPENBONE_EXAMPLES_URL): the build doesn't carry them.
      if (process.env.VITE_OPENBONE_EXAMPLES_URL) return;
      for (const f of files()) this.emitFile({ type: "asset", fileName: `examples/${f}`, source: fs.readFileSync(path.join(EXAMPLES, f)) });
    },
  };
}

/**
 * `virtual:openbone-player-bundle`: the self-contained WebView player script (packages/player/src/bundle), built
 * with esbuild on first import and rebuilt when package sources change. Export dialogs load it lazily, so it costs
 * nothing until someone exports a WebView package, and it needs no prebuilt file or network.
 */
function playerBundle(): Plugin {
  const id = "virtual:openbone-player-bundle";
  const resolved = `\0${id}`;
  let cache: Promise<string> | null = null;
  return {
    name: "openbone-player-bundle",
    resolveId: (s) => (s === id ? resolved : undefined),
    async load(i) {
      if (i !== resolved) return;
      cache ??= buildPlayerBundle();
      return `export default ${JSON.stringify(await cache)};`;
    },
    configureServer(server) {
      const packages = path.resolve(__dirname, "../../packages");
      server.watcher.on("change", (file) => {
        if (!file.startsWith(packages) || !cache) return;
        cache = null;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) server.moduleGraph.invalidateModule(mod);
      });
    },
  };
}

/**
 * `virtual:openbone-web-player/<iife|esm>/<min|full>/<qjs|noqjs|lazy>`: the web player library for the Web export, one
 * module per variant, each built with esbuild only when an export first asks for it (dev) or at build time.
 * `virtual:openbone-web-player/scripts/<min|full>`: the lazy-loaded sandbox add-on (openbone-scripts.js);
 * `virtual:openbone-web-player/quickjs-wasm`: its quickjs.wasm, as base64.
 */
function webPlayerBundle(): Plugin {
  const prefix = "virtual:openbone-web-player/";
  const cache = new Map<string, Promise<string>>();
  return {
    name: "openbone-web-player",
    resolveId: (s) => (s.startsWith(prefix) ? `\0${s}` : undefined),
    async load(id) {
      if (!id.startsWith(`\0${prefix}`)) return;
      const [format, min, qjs] = id.slice(prefix.length + 1).split("/");
      let code = cache.get(id);
      if (!code) {
        code =
          format === "quickjs-wasm"
            ? Promise.resolve(Buffer.from(quickJsWasmBytes()).toString("base64"))
            : format === "scripts"
              ? buildScriptsAddon({ minify: min === "min" })
              : buildWebBundle({ format: format as WebBundleFormat, minify: min === "min", scripts: qjs === "lazy" ? "lazy" : qjs === "qjs" });
        cache.set(id, code);
      }
      return `export default ${JSON.stringify(await code)};`;
    },
    configureServer(server) {
      const packages = path.resolve(__dirname, "../../packages");
      server.watcher.on("change", (file) => {
        if (!file.startsWith(packages) || !cache.size) return;
        for (const id of cache.keys()) {
          const mod = server.moduleGraph.getModuleById(id);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
        cache.clear();
      });
    },
  };
}

/** `virtual:openbone-about`: version, git commit, build date and the credits list, for the About dialog. */
function about(): Plugin {
  const id = "virtual:openbone-about";
  const resolved = `\0${id}`;
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  return {
    name: "openbone-about",
    resolveId: (s) => (s === id ? resolved : undefined),
    load(i) {
      if (i !== resolved) return;
      const info = {
        version: currentVersion(),
        commit: process.env.OPENBONE_COMMIT ?? git("rev-parse", "--short", "HEAD"),
        dirty: !process.env.OPENBONE_COMMIT && git("status", "--porcelain", "--untracked-files=no") !== "",
        buildDate: new Date().toISOString().slice(0, 10),
        credits: collectCredits(),
      };
      return `export default ${JSON.stringify(info)};`;
    },
  };
}

export default defineConfig({
  plugins: [solid(), examples(), playerBundle(), webPlayerBundle(), about()],
  server: { port: Number(process.env.PORT) || 5180, strictPort: false },
  optimizeDeps: { exclude: ["quickjs-emscripten"] },
  build: { target: "es2022", rollupOptions: { input: { editor: path.resolve(__dirname, "index.html"), player: path.resolve(__dirname, "player.html") } } },
});
