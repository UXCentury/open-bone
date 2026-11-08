import { cpSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deserialize, deserializeBinary } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.ts";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples");

/** A temp copy of the examples (projects autosave after every edit). */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "ob-extra-"));
  for (const f of ["knight.obone", "robot.obone", "walker.obone"]) cpSync(path.join(examples, f), path.join(dir, f));
  cpSync(path.join(examples, "assets"), path.join(dir, "assets"), { recursive: true });
  return dir;
}

async function connect() {
  const { server } = createServer({ bridge: false } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    if (r.isError) throw new Error(r.content[0].text);
    return r.content[0].text ?? "";
  };
  return { client, call };
}

describe("extra MCP tools", () => {
  it("lists the new tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["export_file", "trace_mesh", "lip_sync", "pose_bones", "get_stats", "smooth_weights", "prune_weights", "add_slider"]) expect(names).toContain(n);
  });

  it("exports every format", async () => {
    const dir = sandbox();
    const { call } = await connect();
    await call("open_project", { path: path.join(dir, "robot.obone") });
    const magic = (file: string, n = 4) => readFileSync(file).subarray(0, n);
    const out = (name: string) => path.join(dir, name);
    const cases: [string, Record<string, unknown>, (f: string) => void][] = [
      ["obone", {}, (f) => expect(deserialize(readFileSync(f, "utf8")).name).toBe("Robot")],
      ["json", { animations: ["talk"] }, (f) => expect(JSON.parse(readFileSync(f, "utf8")).animations.map((a: { name: string }) => a.name)).toEqual(["talk"])],
      ["obonb", {}, (f) => expect(deserializeBinary(new Uint8Array(readFileSync(f))).animations.map((a) => a.name)).toEqual(["idle", "talk"])],
      ["png", { animation: "talk", time: 0.5 }, (f) => expect([...magic(f)]).toEqual([0x89, 0x50, 0x4e, 0x47])],
      ["png", { animation: "idle", sequence: true, fps: 10, scale: 0.25 }, (f) => expect(magic(f, 2).toString()).toBe("PK")],
      ["jpeg", { animation: "talk", time: 0.4, scale: 0.5 }, (f) => expect([...magic(f, 3)]).toEqual([0xff, 0xd8, 0xff])],
      ["apng", { animation: "idle", fps: 8, scale: 0.25 }, (f) => expect(readFileSync(f).includes(Buffer.from("acTL"))).toBe(true)],
      ["gif", { animation: "idle", fps: 8, scale: 0.25, transparent: true }, (f) => expect(magic(f, 3).toString()).toBe("GIF")],
      ["psd", { animation: "idle", fps: 4, scale: 0.25 }, (f) => expect(magic(f).toString()).toBe("8BPS")],
      ["avi", { animation: "talk", fps: 10, scale: 0.25 }, (f) => expect(magic(f).toString()).toBe("RIFF")],
      ["mov", { animation: "talk", fps: 10, scale: 0.25 }, (f) => expect(readFileSync(f).includes(Buffer.from("moov"))).toBe(true)],
      ["spritesheet", { engine: "godot", fps: 6, scale: 0.25 }, (f) => expect(magic(f, 2).toString()).toBe("PK")],
      ["web", { singleFile: true }, (f) => {
        const html = readFileSync(f, "utf8");
        expect(html).toContain("<openbone-player");
        expect(html.length).toBeGreaterThan(60000); // player + embedded animation and voice
      }],
      ["web", {}, (f) => expect(magic(f, 2).toString()).toBe("PK")],
    ];
    for (const [format, args, check] of cases) {
      const file = out(`out-${format}-${Object.keys(args).join("-") || "default"}.${format}`);
      const msg = await call("export_file", { format, out: file, ...args });
      expect(msg, format).toContain("Saved");
      expect(statSync(file).size, format).toBeGreaterThan(20);
      check(file);
    }
  }, 120000);

  it("traces a mesh from a painted region", async () => {
    const dir = sandbox();
    const { call } = await connect();
    await call("open_project", { path: path.join(dir, "knight.obone") });
    const r = JSON.parse(await call("trace_mesh", { slot: "torso", interior: 3 }));
    expect(r.outline).toBeGreaterThan(8);
    expect(r.triangles).toBeGreaterThan(r.outline - 2);
    const doc = deserialize(readFileSync(path.join(dir, "knight.obone"), "utf8"));
    const slot = doc.skeleton.slots.find((s) => s.name === "torso")!;
    expect(doc.skeleton.skins[0].attachments[slot.id]["knight-torso"].type).toBe("mesh");
  });

  it("lip-syncs a WAV voice onto a mouth slot", async () => {
    const dir = sandbox();
    const { call } = await connect();
    await call("open_project", { path: path.join(dir, "robot.obone") });
    const r = JSON.parse(await call("lip_sync", { sound: "robot-voice", slot: "mouth", animation: "idle", start: 0.5 }));
    expect(r.keys).toBeGreaterThan(8);
    expect(r.shapes).toContain("round→mouth-round");
    const doc = deserialize(readFileSync(path.join(dir, "robot.obone"), "utf8"));
    const idle = doc.animations.find((a) => a.name === "idle")!;
    expect(idle.audio?.[0].time).toBe(0.5);
    expect(idle.duration).toBeGreaterThan(4);
  });

  it("poses a chain toward a point, in setup or as keys", async () => {
    const dir = sandbox();
    const { call } = await connect();
    await call("open_project", { path: path.join(dir, "knight.obone") });
    const setup = JSON.parse(await call("pose_bones", { bone: "front-hand", x: 150, y: 200, chain: 3 }));
    expect(setup.bones.length).toBeGreaterThan(1);
    const keyed = JSON.parse(await call("pose_bones", { bone: "back-hand", x: 450, y: 200, chain: 3, animation: "idle", time: 1.2 }));
    expect(keyed.bones.length).toBeGreaterThan(1);
    const doc = deserialize(readFileSync(path.join(dir, "knight.obone"), "utf8"));
    const lf = doc.skeleton.bones.find((b) => b.name === "back-forearm")!;
    const tl = doc.animations.find((a) => a.name === "idle")!.timelines.find((t) => t.target === "bone" && t.id === lf.id && t.property === "rotation");
    expect((tl?.keys as { time: number }[]).some((k) => Math.abs(k.time - 1.2) < 1e-6)).toBe(true);
  });

  it("smooths and prunes weights, and reports stats", async () => {
    const dir = sandbox();
    const { call } = await connect();
    await call("open_project", { path: path.join(dir, "knight.obone") });
    expect(await call("smooth_weights", { slot: "drape", attachment: "drape", strength: 0.6 })).toBeTruthy();
    expect(await call("prune_weights", { slot: "drape", attachment: "drape", threshold: 0.2, maxInfluences: 1 })).toBeTruthy();
    const doc = deserialize(readFileSync(path.join(dir, "knight.obone"), "utf8"));
    const cape = doc.skeleton.slots.find((s) => s.name === "drape")!;
    const mesh = doc.skeleton.skins[0].attachments[cape.id].drape as { weights: { weight: number }[][] };
    expect(mesh.weights.every((w) => w.length === 1 && Math.abs(w[0].weight - 1) < 1e-6)).toBe(true);
    const stats = JSON.parse(await call("get_stats"));
    expect(stats.bones).toBe(doc.skeleton.bones.length);
    expect(stats.vertices).toBeGreaterThan(40);
    expect(stats.drawCallsEstimate).toBeGreaterThanOrEqual(1);
  });
});
