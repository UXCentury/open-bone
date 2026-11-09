import { describe, expect, it } from "vitest";
import { PERMISSIVE, collectCredits } from "./credits.ts";
import { currentVersion, mismatches } from "./version.ts";

describe("repo hygiene", () => {
  it("every package, the Tauri app and the desktop crate share one version", () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(mismatches()).toEqual([]);
  });

  it("every credited dependency has a permissive licence and a link", () => {
    const credits = collectCredits();
    expect(credits.length).toBeGreaterThan(10);
    expect(credits.filter((c) => !PERMISSIVE.test(c.license)).map((c) => `${c.name}: ${c.license}`)).toEqual([]);
    expect(credits.filter((c) => !/^https?:\/\//.test(c.url)).map((c) => c.name)).toEqual([]);
    expect(credits.map((c) => c.name)).toEqual(expect.arrayContaining(["solid-js", "vite", "tauri", "quickjs-emscripten"]));
  });
});
