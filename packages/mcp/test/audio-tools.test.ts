import { copyFileSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createDocument } from "@openbone/core";
import { pendingFiles } from "../src/bridge.ts";
import { createServer } from "../src/index.ts";

const WAV = path.resolve(__dirname, "../../../examples/assets/eleven/walker-step.wav");

async function connect() {
  const { server } = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const errors: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string }[] };
    if (r.isError) errors.push(`${name}: ${r.content[0].text}`);
    return r.content[0]?.text ?? "";
  };
  return { client, call, errors };
}

describe("audio tools", () => {
  it("every sound tool works on a saved project", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ob-audio-"));
    copyFileSync(WAV, path.join(dir, "step.wav"));
    const { call, errors } = await connect();
    await call("new_project", { name: "A", path: path.join(dir, "a.obone") });
    await call("import_audio", { path: path.join(dir, "step.wav") });
    await call("import_audio", { path: WAV, name: "music", bus: "music", loop: true });
    await call("add_audio", { name: "ui-click", src: "step.wav", bus: "ui" });
    await call("add_sound", { name: "loud", asset: "step", volume: 2, bus: "sfx" });
    await call("update_sound", { sound: "loud", rate: 1.5, fadeOut: 0.2, bus: null });
    await call("add_bus", { name: "voice" });
    await call("update_bus", { bus: "voice", volume: 0.5, muted: true });
    await call("set_audio_mix", { master: 0.8 });
    await call("create_animation", { name: "idle", duration: 1 });
    await call("add_audio_key", { animation: "idle", sound: "step", time: 0.25 });
    await call("update_audio_key", { animation: "idle", sound: "step", time: 0.25, volume: 0.5 });
    await call("add_event", { name: "hit", audio: "step" });
    await call("set_event_sound", { event: "hit", sound: "loud" });
    await call("add_event_key", { animation: "idle", event: "hit", time: 0.5 });
    await call("create_state_machine", { name: "sm" });
    await call("add_input", { stateMachine: "sm", name: "musicOn", type: "bool", value: true });
    await call("add_state", { stateMachine: "sm", name: "idle", animation: "idle" });
    await call("set_state_sound", { stateMachine: "sm", state: "idle", sound: "music" });
    await call("set_state_sound", { stateMachine: "sm", state: "idle", sound: "step", on: "exit", action: "stop" });
    await call("add_listener", { stateMachine: "sm", event: "click", actions: [{ type: "playSound", sound: "ui-click" }, { type: "setMute", bus: "music", muted: "toggle" }, { type: "toggleInput", input: "musicOn" }] });
    await call("add_listener", { stateMachine: "sm", event: "down", actions: [{ type: "stopSound", sound: "music", fade: 0.5 }, { type: "setMute", bus: null, muted: true }] });
    await call("set_audio_mix", { muted: false });
    const sim = await call("simulate_state_machine", { stateMachine: "sm", steps: [{ advance: 0.6 }, { pointer: { type: "down", x: 400, y: 300 }, advance: 0.05 }, { pointer: { type: "up", x: 400, y: 300 }, advance: 0.05 }] });
    expect(sim).toMatch(/mute music/);
    expect(sim).toMatch(/play ui-click/);
    await call("delete_state_sound", { stateMachine: "sm", state: "idle", sound: "step", on: "exit" });
    await call("delete_audio_key", { animation: "idle", sound: "step", time: 0.25 });
    await call("delete_sound", { sound: "loud" });
    await call("delete_bus", { bus: "voice" });
    expect(await call("validate")).toMatch(/No issues/);
    expect(errors).toEqual([]);
    const saved = JSON.parse(readFileSync(path.join(dir, "a.obone"), "utf8"));
    expect(saved.audio.assets.map((a: { src: string }) => a.src)).toContain("step.wav");
  });

  it("the live bridge sends relative-path sounds and images to the editor once (again when they change)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ob-files-"));
    copyFileSync(WAV, path.join(dir, "step.wav"));
    const doc = createDocument("F");
    doc.audio = { master: 1, muted: false, buses: [], sounds: [], assets: [
      { id: "a1", name: "step", src: "step.wav", duration: 0 },
      { id: "a2", name: "gone", src: "missing.wav", duration: 0 },
      { id: "a3", name: "inline", src: "data:audio/wav;base64,AAAA", duration: 0 },
    ] };
    const sent = new Map<string, number>();
    const first = pendingFiles(doc, dir, sent);
    expect(first.map((f) => [f.src, f.kind, f.mime])).toEqual([["step.wav", "audio", "audio/wav"]]);
    expect(Buffer.from(first[0].base64, "base64").equals(readFileSync(WAV))).toBe(true);
    expect(pendingFiles(doc, dir, sent)).toEqual([]);
    utimesSync(path.join(dir, "step.wav"), new Date(), new Date(Date.now() + 5000));
    expect(pendingFiles(doc, dir, sent).map((f) => f.src)).toEqual(["step.wav"]);
  });
});
