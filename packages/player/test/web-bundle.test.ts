import { describe, expect, it } from "vitest";
import { buildWebBundle } from "../src/bundle/build.ts";

describe("web player bundle", () => {
  it("classic script: global OpenBone, defines <openbone-player>, no module syntax", async () => {
    const code = await buildWebBundle({ format: "iife", minify: true, scripts: false });
    expect(code.startsWith("/*! OpenBone web player")).toBe(true);
    expect(code).toMatch(/var OpenBone\s*=/);
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).toContain("openbone-player");
    expect(code).not.toContain("ZodError");
    // Without the sandbox, QuickJS is not bundled.
    expect(code).not.toContain("emscripten");
    expect(code.length).toBeLessThan(250_000);
  }, 30_000);

  it("ES module exports the API", async () => {
    const code = await buildWebBundle({ format: "esm", minify: false, scripts: false });
    expect(code).toMatch(/export\s*\{/);
    for (const n of ["Player", "definePlayerElement", "parseDocument", "version"]) expect(code).toContain(n);
  }, 30_000);

  it("minified is smaller than readable, and the sandbox adds QuickJS", async () => {
    const [min, readable, withScripts] = await Promise.all([
      buildWebBundle({ format: "iife", minify: true, scripts: false }),
      buildWebBundle({ format: "iife", minify: false, scripts: false }),
      buildWebBundle({ format: "iife", minify: true, scripts: true }),
    ]);
    expect(min.length).toBeLessThan(readable.length * 0.7);
    expect(readable).toContain("\n  "); // indented, human-readable
    expect(withScripts.length).toBeGreaterThan(min.length + 400_000); // ~0.5 MB wasm as base64
    expect(withScripts).toContain("quickjs-emscripten (MIT)");
  }, 60_000);
});
