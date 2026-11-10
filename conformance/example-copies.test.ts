import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sample apps that ship their own copy of an example (the Flutter example bundles them as assets) must stay identical
 * to examples/, or they show an old rig. Fix: copy the file from examples/ again.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = ["runtimes/flutter/openbone/example/assets/openbone"];

describe("example copies in sample apps", () => {
  for (const dir of COPIES)
    for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith(".obone")))
      it(`${dir}/${f} matches examples/${f}`, () => {
        expect(fs.readFileSync(path.join(root, dir, f), "utf8") === fs.readFileSync(path.join(root, "examples", f), "utf8"), `copy examples/${f} to ${dir}/`).toBe(true);
      });
});
