import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, "..");

const TYPES: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".obone": "application/json", ".obonb": "application/octet-stream", ".wasm": "application/wasm" };

/** Serve the example projects (`/examples/knight.obone`) and their art (`/examples/assets/...`) from the repo. */
function exampleFiles() {
  return {
    name: "openbone-example-files",
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: import("node:http").ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        if (!url.startsWith("/examples/")) return next();
        const file = path.resolve(examples, url.slice("/examples/".length));
        if (!file.startsWith(examples) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [exampleFiles()],
  server: { port: 5190 },
  // QuickJS (the script sandbox) finds its .wasm next to its own module; pre-bundling would move it.
  optimizeDeps: { exclude: ["quickjs-emscripten"] },
  build: {
    outDir: path.resolve(here, "dist"),
    rollupOptions: {
      input: {
        index: path.resolve(here, "index.html"),
        pixi: path.resolve(here, "pixi/index.html"),
        phaser: path.resolve(here, "phaser/index.html"),
        three: path.resolve(here, "three/index.html"),
        canvaskit: path.resolve(here, "canvaskit/index.html"),
      },
    },
  },
});
