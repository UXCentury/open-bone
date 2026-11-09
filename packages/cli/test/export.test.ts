import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { deserialize } from "@openbone/core";
import { ProjectSession, exportFile } from "@openbone/mcp";
import { describe, expect, it } from "vitest";
import { expandGlob, globToRegExp } from "../src/glob.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const run = promisify(execFile);

/** Entries of a ZIP (stored or deflated) by name. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 30, p + 30 + nameLen);
    const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 30 + nameLen + extra + size;
  }
  return out;
}

describe("globs", () => {
  it("matches *, **, ?, sets and braces", () => {
    expect(globToRegExp("*.obone").test("a.obone")).toBe(true);
    expect(globToRegExp("*.obone").test("x/a.obone")).toBe(false);
    expect(globToRegExp("**/*.obone").test("a.obone")).toBe(true);
    expect(globToRegExp("**/*.obone").test("x/y/a.obone")).toBe(true);
    expect(globToRegExp("{fox,knight}.obone").test("knight.obone")).toBe(true);
    expect(globToRegExp("[fk]*.obone").test("walker.obone")).toBe(false);
    expect(globToRegExp("w?lker.obone").test("walker.obone")).toBe(true);
  });

  it("expands against the file system", async () => {
    const all = await expandGlob("examples/*.obone", root);
    expect(all.map((f) => path.basename(f))).toContain("walker.obone");
    expect(await expandGlob("examples/{fox,knight}.obone", root)).toHaveLength(2);
    expect(await expandGlob("examples/walker.obone", root)).toEqual([path.join(root, "examples/walker.obone")]);
    expect(await expandGlob("examples/nope.obone", root)).toEqual([]);
  });
});

describe("openbone export", () => {
  it("exports several files through the shared export code", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "ob-cli-"));
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", path.join(root, "packages/cli/src/bin.ts"), "export", "examples/{button,robot}.obone", "--format", "atlas", "--out", out, "--strip-whitespace", "--polygons", "--premultiplied"],
      { cwd: root },
    );
    expect(stdout).toMatch(/button\.zip/);
    expect(readdirSync(out).sort()).toEqual(["button.zip", "robot.zip"]);
    const files = unzip(readFileSync(path.join(out, "robot.zip")));
    const doc = deserialize(files.get("robot.json")!.toString("utf8"));
    expect(doc.atlas).toMatchObject({ premultipliedAlpha: true, stripWhitespace: true, polygons: true });
    for (const p of doc.atlas!.pages) expect(files.get(p.src)!.subarray(1, 4).toString()).toBe("PNG");
    expect(doc.images.every((i) => i.src === "")).toBe(true);
  }, 60_000);

  it("writes the same bytes as the MCP export_file path", async () => {
    const s = new ProjectSession();
    s.autosave = false;
    await s.open(path.join(root, "examples/button.obone"));
    const r = await exportFile(s, { format: "json" }, async () => {
      throw new Error("no scripts needed");
    });
    const out = mkdtempSync(path.join(tmpdir(), "ob-cli-"));
    await run(process.execPath, ["--import", "tsx", path.join(root, "packages/cli/src/bin.ts"), "export", "examples/button.obone", "--format", "json", "--out", out], { cwd: root });
    expect(Buffer.compare(readFileSync(path.join(out, "button.json")), Buffer.from(r.bytes))).toBe(0);
  }, 60_000);
});
