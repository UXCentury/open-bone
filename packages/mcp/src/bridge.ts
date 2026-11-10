import type { OpCall } from "@openbone/core";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { isLocalRequest } from "./local-only.ts";
import type { ProjectSession } from "./session.ts";

/**
 * Live bridge: the OpenBone editor connects here (ws://localhost:PORT) so changes made by the
 * agent appear instantly in the editor, and edits made in the editor are visible to the agent.
 *
 * Messages (JSON):
 *   editor → server: {type:"hello"} | {type:"op", op, args} | {type:"undo"} | {type:"redo"} | {type:"load", doc}
 *   server → editor: {type:"load", doc, path} | {type:"ops", ops} | {type:"error", message}
 */
export function startBridge(session: ProjectSession, port: number, log: (m: string) => void) {
  const wss = new WebSocketServer({
    port,
    host: "127.0.0.1",
    // Only the editor (local page or desktop app) and non-browser clients: web pages on other sites are refused.
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const ok = isLocalRequest({ origin: req.headers.origin, host: req.headers.host });
      if (!ok) log(`bridge: refused a connection from ${req.headers.origin ?? "?"} (not the OpenBone editor)`);
      return ok;
    },
  });
  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const broadcast = (msg: unknown, except?: WebSocket) => {
    for (const c of clients) if (c !== except) send(c, msg);
  };

  let current: WebSocket | undefined;
  session.store.subscribe((doc, e) => {
    const origin = e.origin;
    const except = origin === "bridge" ? current : undefined;
    if (e.kind === "op" || e.kind === "transaction") broadcast({ type: "ops", ops: e.ops as OpCall[] }, except);
    else broadcast({ type: "load", doc, path: session.filePath });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    log(`editor connected (${clients.size})`);
    send(ws, { type: "load", doc: session.doc, path: session.filePath });
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (raw) => {
      let msg: { type: string; op?: string; args?: Record<string, unknown>; doc?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      current = ws;
      try {
        if (msg.type === "hello") send(ws, { type: "load", doc: session.doc, path: session.filePath });
        else if (msg.type === "op" && msg.op) session.store.apply(msg.op, msg.args ?? {}, "bridge");
        else if (msg.type === "undo") session.store.undo();
        else if (msg.type === "redo") session.store.redo();
        else if (msg.type === "load" && msg.doc) session.store.load(msg.doc as never);
        await session.maybeAutosave();
      } catch (e) {
        send(ws, { type: "error", message: (e as Error).message });
        // Resync the editor so it does not drift from the server copy.
        send(ws, { type: "load", doc: session.doc, path: session.filePath });
      } finally {
        current = undefined;
      }
    });
  });
  wss.on("listening", () => log(`live bridge on ws://127.0.0.1:${port}`));
  wss.on("error", (e) => log(`bridge error: ${e.message}`));
  return wss;
}
