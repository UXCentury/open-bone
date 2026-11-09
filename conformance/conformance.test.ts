import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "@openbone/core";
import { createQuickJsHost } from "@openbone/scripting";
import { describe, expect, it } from "vitest";
import { type Expected, FORMAT, expectedFor, stringify } from "./generate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const files = fs.readdirSync(path.join(here, "expected")).filter((f) => f.endsWith(".json")).sort();

describe("conformance suite (the TypeScript runtime is the reference)", () => {
  it("has a reference file for every fixture and example", () => {
    const examples = fs.readdirSync(path.join(root, "examples")).filter((f) => f.endsWith(".obone")).map((f) => `example-${f.replace(/\.obone$/, "")}.json`);
    expect(files).toEqual(expect.arrayContaining(examples));
    expect(files.length).toBeGreaterThanOrEqual(examples.length + 5);
  });

  for (const file of files)
    it(`${file} still matches the runtime (else run: pnpm conformance)`, async () => {
      const stored = JSON.parse(fs.readFileSync(path.join(here, "expected", file), "utf8")) as Expected;
      expect(stored.format).toBe(FORMAT);
      const doc = deserialize(fs.readFileSync(path.join(root, stored.document), "utf8"));
      const fresh = await expectedFor(stored.fixture, doc, stored.document, await createQuickJsHost());
      // Compare case by case so a failure names the case instead of dumping megabytes.
      expect(fresh.cases.map((c) => c.name)).toEqual(stored.cases.map((c) => c.name));
      for (let i = 0; i < fresh.cases.length; i++) expect(stringify({ ...fresh, cases: [fresh.cases[i]] }), fresh.cases[i].name).toBe(stringify({ ...stored, cases: [stored.cases[i]] }));
    });
});
