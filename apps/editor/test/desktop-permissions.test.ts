import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "../src");
const capabilities = path.join(here, "../../desktop/src-tauri/capabilities/default.json");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

/** writeFile → fs:allow-write-file, readTextFile → fs:allow-read-text-file */
const permissionFor = (fn: string) => `fs:allow-${fn.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The desktop app may only call the fs functions its capability file allows; a missing one fails at run time, after
 * the user picked where to save (sprite sheet ZIPs were refused because only text writes were allowed). Every fs
 * function the editor imports must have its permission in the desktop capabilities.
 */
describe("desktop permissions", () => {
  it("allow every @tauri-apps/plugin-fs function the editor uses", () => {
    const used = new Set<string>();
    for (const file of sources(src)) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*await import\("@tauri-apps\/plugin-fs"\)|import\s*\{([^{}]*)\}\s*from\s*"@tauri-apps\/plugin-fs"/g))
        for (const name of (m[1] ?? m[2]).split(",")) {
          const fn = name.trim().split(/\s+as\s+|:/)[0].trim();
          if (fn && !fn.startsWith("type ")) used.add(fn);
        }
    }
    expect(used.size).toBeGreaterThan(0);
    const caps = JSON.parse(readFileSync(capabilities, "utf8")) as { permissions: (string | { identifier: string })[] };
    const granted = new Set(caps.permissions.map((p) => (typeof p === "string" ? p : p.identifier)));
    const missing = [...used].map(permissionFor).filter((p) => !granted.has(p));
    expect(missing).toEqual([]);
  });
});
