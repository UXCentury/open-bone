import { type OpCall, type OpenBoneDocument, textureAssets } from "@openbone/core";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
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
 *                    | {type:"files", files:[{src, kind, mime, base64}]}
 *
 * The server stores imported art and sound as paths relative to the project file, which the editor (a web page, or
 * the desktop app without that project open) can't read. So before the document or ops that use such a path, the
 * server sends the file's bytes ("files"), and the editor shows and plays them from memory.
 */

const MEDIA: Record<string, { kind: "image" | "audio"; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  wav: { kind: "audio", mime: "audio/wav" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  flac: { kind: "audio", mime: "audio/flac" },
  m4a: { kind: "audio", mime: "audio/mp4" },
};

export interface BridgeFile {
  src: string;
  kind: "image" | "audio";
  mime: string;
  base64: string;
}

/**
 * Files the document refers to by a relative path that `sent` (src → modification time) hasn't had yet, or that
 * changed on disk since. Only image and audio files, read from `baseDir`. Missing files are skipped.
 */
export function pendingFiles(doc: OpenBoneDocument, baseDir: string, sent: Map<string, number>): BridgeFile[] {
  const srcs = new Set<string>();
  for (const a of textureAssets(doc)) if (a.src) srcs.add(a.src);
  for (const a of doc.audio?.assets ?? []) if (a.src) srcs.add(a.src);
  const out: BridgeFile[] = [];
  for (const src of srcs) {
    if (/^(data:|https?:|blob:)/i.test(src)) continue;
    const media = MEDIA[src.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? ""];
    if (!media) continue;
    const file = path.resolve(baseDir, src);
    try {
      const mtime = statSync(file).mtimeMs;
      if (sent.get(src) === mtime) continue;
      out.push({ src, ...media, base64: readFileSync(file).toString("base64") });
      sent.set(src, mtime);
    } catch {
      /* not there (yet) */
    }
  }
  return out;
}
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
  /** Per editor: files already sent (src → modification time). */
  const sentFiles = new WeakMap<WebSocket, Map<string, number>>();
  const send = (ws: WebSocket, msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const sendFiles = (ws: WebSocket) => {
    let sent = sentFiles.get(ws);
    if (!sent) sentFiles.set(ws, (sent = new Map()));
    const files = pendingFiles(session.doc, session.baseDir, sent);
    if (files.length) send(ws, { type: "files", files });
  };
  const broadcast = (msg: unknown, except?: WebSocket) => {
    for (const c of clients) {
      if (c === except) continue;
      sendFiles(c);
      send(c, msg);
    }
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
    sendFiles(ws);
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
        if (msg.type === "hello") {
          sentFiles.delete(ws); // a fresh editor page: send every file again
          sendFiles(ws);
          send(ws, { type: "load", doc: session.doc, path: session.filePath });
        }
        else if (msg.type === "op" && msg.op) session.store.apply(msg.op, msg.args ?? {}, "bridge");
        else if (msg.type === "undo") session.store.undo();
        else if (msg.type === "redo") session.store.redo();
        else if (msg.type === "load" && msg.doc) session.store.load(msg.doc as never);
        await session.maybeAutosave();
      } catch (e) {
        send(ws, { type: "error", message: (e as Error).message });
        // Resync the editor so it does not drift from the server copy.
        sendFiles(ws);
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
