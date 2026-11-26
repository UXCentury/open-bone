import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.ts";

/** Paths of every schema node that uses the draft-07 tuple form `items: [...]`. */
function tupleItems(schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const out: string[] = [];
  if (Array.isArray((schema as { items?: unknown }).items)) out.push(path || "/");
  for (const [k, v] of Object.entries(schema)) out.push(...tupleItems(v, `${path}/${k}`));
  return out;
}

describe("tool input schemas", () => {
  it("never use the draft-07 tuple form `items: [...]` (strict JSON Schema 2020-12 clients drop such tools)", async () => {
    const { server } = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const bad = tools.flatMap((t) => tupleItems(t.inputSchema).map((p) => `${t.name}:${p}`));
    expect(bad).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["set_keys", "paste_keys", "move_key", "add_particles"]));
  });
});