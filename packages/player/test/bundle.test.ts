import { describe, expect, it } from "vitest";
import { buildPlayerBundle } from "../src/bundle/build.ts";

describe("WebView player bundle", () => {
  it("builds one classic script with the bridge and QuickJS inlined, without the op registry", async () => {
    const code = await buildPlayerBundle();
    expect(code.startsWith("/*! OpenBone player bundle")).toBe(true);
    expect(code).not.toMatch(/^\s*(import|export)\s/m); // no ES module syntax: loads from file:// in WebViews
    expect(code).toContain("OpenBoneHost");
    expect(code).toContain("openbone-data");
    expect(code).not.toContain("ZodError"); // core-lite alias keeps zod out
    expect(code.length).toBeGreaterThan(600_000); // includes the ~500 KB wasm as base64
    expect(code.length).toBeLessThan(1_200_000);
  }, 30_000);
});
