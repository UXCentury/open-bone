import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { poseTrack } from "../../runtime/test/pose-figure.ts";
import { startBridge } from "../src/bridge.ts";
import { createServer } from "../src/index.ts";
import { ProjectSession } from "../src/session.ts";

const KNIGHT = path.resolve(__dirname, "../../../examples/knight.obone");
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function connect(session = new ProjectSession()) {
  const { server } = createServer({ session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    return { error: !!r.isError, text: r.content[0].text ?? "" };
  };
  return { call, session };
}

/** A fake editor on the live bridge that answers "trackVideo" with a synthetic track. */
async function fakeEditor(session: ProjectSession, seconds: number) {
  const wss = startBridge(session, 0, () => {});
  closers.push(() => wss.close());
  await new Promise<void>((ok) => wss.on("listening", () => ok()));
  const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
  closers.push(() => ws.close());
  const requests: { task: string; args: Record<string, unknown> }[] = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(String(m));
    if (msg.type !== "request") return;
    requests.push({ task: msg.task, args: msg.args });
    ws.send(JSON.stringify({ type: "progress", id: msg.id, stage: "Tracking the body", p: 0.5 }));
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: poseTrack(seconds) }));
  });
  await new Promise<void>((ok) => ws.on("open", () => ok()));
  ws.send(JSON.stringify({ type: "hello" }));
  await new Promise((ok) => setTimeout(ok, 50));
  return requests;
}

const boneKeys = (session: ProjectSession, anim: string) =>
  session.doc.animations
    .find((a) => a.name === anim)!
    .timelines.map((t) => ({ id: t.id, property: t.property, keys: t.keys.length }))
    .sort((a, b) => `${a.id}${a.property}`.localeCompare(`${b.id}${b.property}`));

describe("video to animation tools", () => {
  it("animate_from_video says the editor is needed when none is connected", async () => {
    const { call } = await connect();
    await call("open_project", { path: KNIGHT });
    const r = await call("animate_from_video", { path: "clip.mp4" });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/needs the OpenBone editor/);
  });

  it("asks the connected editor to track the video, keys the rig, and saves a track that maps to the same keys", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ob-video-"));
    writeFileSync(path.join(dir, "knight.obone"), readFileSync(KNIGHT));
    writeFileSync(path.join(dir, "clip.mp4"), Buffer.from("not really a video"));
    const session = new ProjectSession();
    const requests = await fakeEditor(session, 2);
    const { call } = await connect(session);
    await call("open_project", { path: path.join(dir, "knight.obone") });
    const r = await call("animate_from_video", { path: "clip.mp4", saveTrack: "clip.pose.json", end: 2 });
    expect(r.error, r.text).toBe(false);
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ ok: true, animation: "clip", seconds: 2, trackedFrames: 61, savedTrack: "clip.pose.json" });
    expect(out.mapping).toMatchObject({ "front-arm": "leftUpperArm", "front-foot": "leftAnkle", hip: "hips" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ task: "trackVideo", args: { name: "clip.mp4", mime: "video/mp4", end: 2 } });
    expect(Buffer.from(String(requests[0].args.base64), "base64").toString()).toBe("not really a video");

    const again = JSON.parse((await call("animate_from_pose_track", { path: "clip.pose.json", animation: "again" })).text);
    expect(again).toMatchObject({ ok: true, animation: "again", keys: out.keys });
    expect(boneKeys(session, "again")).toEqual(boneKeys(session, "clip"));
    // One undo step each.
    await call("undo");
    expect(session.doc.animations.some((a) => a.name === "again")).toBe(false);
    expect(session.doc.animations.some((a) => a.name === "clip")).toBe(true);
  });

  it("reports an editor error", async () => {
    const session = new ProjectSession();
    const wss = startBridge(session, 0, () => {});
    closers.push(() => wss.close());
    await new Promise<void>((ok) => wss.on("listening", () => ok()));
    const ws = new WebSocket(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
    closers.push(() => ws.close());
    ws.on("message", (m) => {
      const msg = JSON.parse(String(m));
      if (msg.type === "request") ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "No body was found in the video" }));
    });
    await new Promise<void>((ok) => ws.on("open", () => ok()));
    const dir = mkdtempSync(path.join(tmpdir(), "ob-video-"));
    writeFileSync(path.join(dir, "clip.webm"), "x");
    const { call } = await connect(session);
    await call("open_project", { path: KNIGHT });
    const r = await call("animate_from_video", { path: path.join(dir, "clip.webm") });
    expect(r).toMatchObject({ error: true });
    expect(r.text).toMatch(/No body was found/);
  });
});
