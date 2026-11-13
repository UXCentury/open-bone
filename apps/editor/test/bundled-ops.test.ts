import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, type Rollup } from "vite";
import { registry } from "@openbone/core";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Ops register themselves when their module runs (`import "./ops/audio.ts"` in core's index). A production bundle
 * that tree-shakes those imports away leaves the editor with only some ops ("Unknown op addAudio"), and dev mode never
 * shows it. Bundle core the way the editor's build does and check every op survives.
 */
describe("production bundle", () => {
  it("keeps every op of the registry", async () => {
    const out = (await build({
      configFile: false,
      logLevel: "silent",
      root: here,
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(here, "fixtures/registry-entry.ts"), formats: ["es"], fileName: "entry" },
        rollupOptions: { external: ["zod"] },
      },
    })) as Rollup.RollupOutput[] | Rollup.RollupOutput;
    const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
    const code = chunks.map((c) => (c.type === "chunk" ? c.code : "")).join("\n");
    const missing = [...registry.keys()].filter((name) => !code.includes(`name: "${name}"`));
    expect(missing).toEqual([]);
  }, 60_000);
});
