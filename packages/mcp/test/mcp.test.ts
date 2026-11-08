import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deserialize, validate } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.ts";

async function connect() {
  const { server } = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
    if (r.isError) throw new Error(r.content[0].text);
    return r;
  };
  return { client, call };
}

describe("MCP server", () => {
  it("lists generated + custom tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["add_bone", "set_keys", "add_transition", "add_listener", "render_frame", "simulate_state_machine", "new_project", "add_path", "add_path_constraint", "update_path_constraint", "add_physics_constraint", "update_physics_constraint", "update_transform_constraint"])
      expect(names).toContain(n);
  });

  it("builds an interactive button purely through tools", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ob-"));
    const file = path.join(dir, "button.obone");
    const { call } = await connect();
    await call("new_project", { name: "Button", path: file, width: 400, height: 200, originX: 200, originY: 100 });
    await call("add_bone", { name: "btn", length: 0 });
    await call("add_slot", { bone: "btn", name: "bg" });
    await call("add_shape", { slot: "bg", shape: "rect", width: 200, height: 70, radius: 20, fill: "#3b82f6" });
    await call("add_slot", { bone: "btn", name: "hit" });
    await call("add_bounding_box", { slot: "hit", width: 200, height: 70 });
    await call("create_animation", { name: "idle" });
    await call("set_keys", { animation: "idle", target: "bone", id: "btn", property: "scaleX", keys: [{ time: 0, value: 1 }] });
    await call("create_animation", { name: "hover" });
    await call("set_keys", { animation: "hover", target: "bone", id: "btn", property: "scaleX", keys: [{ time: 0, value: 1 }, { time: 0.2, value: 1.1, curve: "backOut" }] });
    await call("set_keys", { animation: "hover", target: "slot", id: "bg", property: "color", keys: [{ time: 0, value: "#ffffff" }, { time: 0.2, value: "#ddeeff" }] });
    await call("create_state_machine", { name: "ui" });
    await call("add_input", { stateMachine: "ui", name: "hover", type: "bool" });
    await call("add_state", { stateMachine: "ui", animation: "idle" });
    await call("add_state", { stateMachine: "ui", animation: "hover", loop: false });
    await call("add_transition", { stateMachine: "ui", from: "idle", to: "hover", conditions: [{ input: "hover", value: true }] });
    await call("add_transition", { stateMachine: "ui", from: "hover", to: "idle", conditions: [{ input: "hover", value: false }] });
    await call("add_listener", { stateMachine: "ui", slot: "hit", event: "enter", actions: [{ type: "setInput", input: "hover", value: true }] });
    await call("add_listener", { stateMachine: "ui", slot: "hit", event: "exit", actions: [{ type: "setInput", input: "hover", value: false }] });
    await call("add_listener", { stateMachine: "ui", slot: "hit", event: "click", actions: [{ type: "reportEvent", event: "clicked" }] });

    const sim = await call("simulate_state_machine", {
      stateMachine: "ui",
      steps: [
        { advance: 0.1 },
        { pointer: { type: "move", x: 200, y: 100 }, advance: 0.3 },
        { pointer: { type: "down", x: 200, y: 100 }, advance: 0.05 },
        { pointer: { type: "up", x: 200, y: 100 }, advance: 0.05 },
        { pointer: { type: "move", x: 5, y: 5 }, advance: 0.3 },
      ],
    });
    const log = sim.content[0].text!;
    expect(log).toMatch(/idle → hover/);
    expect(log).toMatch(/event clicked/);
    expect(log).toMatch(/hover → idle/);

    const img = await call("render_frame", { stateMachine: "ui", steps: [{ pointer: { type: "move", x: 200, y: 100 }, advance: 0.3 }] });
    const png = Buffer.from(img.content[0].data!, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    // Autosaved file round-trips and validates.
    const saved = deserialize(readFileSync(file, "utf8"));
    expect(validate(saved).filter((i) => i.level === "error")).toEqual([]);
    expect(saved.stateMachines[0].listeners.length).toBe(3);
  });

  it("returns helpful errors", async () => {
    const { call } = await connect();
    await expect(call("add_slot", { bone: "ghost" })).rejects.toThrow(/Bone "ghost" not found. Available: root/);
  });
});

describe("skins in previews", () => {
  it("pose() shows the requested skin and rejects unknown ones", async () => {
    const { DocumentStore, createDocument } = await import("@openbone/core");
    const { pose } = await import("../src/index.ts");
    const s = new DocumentStore(createDocument());
    s.apply("addSlot", { bone: "root", name: "body" });
    s.apply("addShape", { slot: "body", name: "shirt", shape: "rect", fill: "#0000ff" });
    s.apply("addSkin", { name: "red" });
    s.apply("copyAttachment", { slot: "body", attachment: "shirt", toSkin: "red" });
    s.apply("updateAttachment", { slot: "body", attachment: "shirt", skin: "red", props: { fill: "#ff0000" } });
    const { inst } = pose(s.doc, { skin: "red" });
    const att = inst.skeleton.getAttachment(inst.skeleton.findSlot("body")!);
    expect(att).toMatchObject({ fill: "#ff0000" });
    expect(() => pose(s.doc, { skin: "nope" })).toThrow(/not found/);
  });
});
