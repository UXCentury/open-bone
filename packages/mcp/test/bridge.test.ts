import { createDocument } from "@openbone/core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startBridge } from "../src/bridge.ts";
import { ProjectSession } from "../src/session.ts";

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Start a bridge on a free port; connect an "editor" that says hello with `doc` and collect what it receives. */
async function connect(session: ProjectSession, doc: unknown, then?: (ws: WebSocket) => void) {
  const wss = startBridge(session, 0, () => {});
  servers.push(wss);
  await new Promise<void>((ok) => wss.on("listening", () => ok()));
  const port = (wss.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got: { type: string; doc?: { name: string }; message?: string }[] = [];
  ws.on("message", (m) => got.push(JSON.parse(String(m))));
  await new Promise<void>((ok) => ws.on("open", () => ok()));
  ws.send(JSON.stringify({ type: "hello", doc }));
  await new Promise((ok) => setTimeout(ok, 100));
  if (then) {
    then(ws);
    await new Promise((ok) => setTimeout(ok, 100));
  }
  ws.close();
  return got;
}

describe("live bridge connect", () => {
  it("a server with no project takes over the editor's scene instead of replacing it", async () => {
    const session = new ProjectSession();
    const got = await connect(session, createDocument("Hero"));
    expect(session.doc.name).toBe("Hero");
    expect(got.filter((m) => m.type === "load").map((m) => m.doc?.name)).toEqual([]);
    expect(got.some((m) => m.type === "synced")).toBe(true);
  });

  it("a server already working on a project sends it to the editor", async () => {
    const session = new ProjectSession();
    session.newProject("Agent scene", null);
    const got = await connect(session, createDocument("Hero"));
    expect(session.doc.name).toBe("Agent scene");
    expect(got.find((m) => m.type === "load")?.doc?.name).toBe("Agent scene");
  });

  it("an editor sending its own scene detaches the server from its project file, so autosave never overwrites it", async () => {
    const session = new ProjectSession();
    session.newProject("Agent scene", "/tmp/agent-scene.obone");
    const saved: string[] = [];
    session.save = async () => {
      saved.push(session.doc.name);
      return "";
    };
    await connect(session, createDocument("Hero"), (ws) => ws.send(JSON.stringify({ type: "load", doc: createDocument("Hero") })));
    expect(session.doc.name).toBe("Hero");
    expect(session.filePath).toBeNull();
    expect(saved).not.toContain("Hero");
  });
});
