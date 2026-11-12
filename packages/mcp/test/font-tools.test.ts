import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { parseDocument } from "@openbone/core";
import { readFileSync } from "node:fs";
import { pendingFiles } from "../src/bridge.ts";
import { createServer } from "../src/index.ts";

const FONT = path.resolve(__dirname, "../../../examples/assets/fonts/NotoSerifJP-Regular-subset.otf");

async function connect() {
  const { server } = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const errors: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
    if (r.isError) errors.push(`${name}: ${r.content[0].text}`);
    return r.content[0];
  };
  return { call, errors };
}

describe("font tools", () => {
  it("import_font reads the family from the file, renders with it and sends it over the bridge", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ob-font-"));
    copyFileSync(FONT, path.join(dir, "serif.otf"));
    const { call, errors } = await connect();
    await call("new_project", { name: "F", path: path.join(dir, "f.obone") });
    const r = JSON.parse((await call("import_font", { path: path.join(dir, "serif.otf") })).text!);
    expect(r).toMatchObject({ ok: true, family: "Noto Serif CJK JP" });
    await call("import_font", { path: FONT, family: "Body", weight: 700, embed: true });
    await call("add_slot", { name: "label", bone: "root" });
    await call("add_text", { slot: "label", name: "t", text: "風の丘", font: "Noto Serif CJK JP, serif", size: 40 });
    const summary = (await call("get_summary")).text!;
    expect(summary).toContain("## Fonts: Noto Serif CJK JP 400");
    expect(summary).toContain("Body 700");
    const png = await call("render_frame", {});
    expect(png.type).toBe("image");
    // Both fonts (one from a file, one embedded as a data: URI) were registered for drawing, each as its own face.
    expect(GlobalFonts.families.filter((f) => f.family.startsWith("OpenBone face ")).length).toBeGreaterThanOrEqual(2);
    expect((await call("validate")).text).toMatch(/no text uses family .*Body/);
    expect(errors).toEqual([]);

    await call("save_project", {});
    const doc = parseDocument(readFileSync(path.join(dir, "f.obone")));
    expect(doc.fonts?.map((f) => [f.family, f.src.startsWith("data:") ? "data" : f.src])).toEqual([
      ["Noto Serif CJK JP", "serif.otf"],
      ["Body", "data"],
    ]);
    expect(pendingFiles(doc, dir, new Map()).map((f) => [f.src, f.kind, f.mime])).toEqual([["serif.otf", "font", "font/otf"]]);
  });
});
