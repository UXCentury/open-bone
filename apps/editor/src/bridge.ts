import type { OpCall } from "@openbone/core";
import { createSignal } from "solid-js";
import { logActivity } from "./activity.ts";
import { registerAudioOverride } from "./audio.ts";
import { registerImageOverride } from "./images.ts";
import { loadDocument, setFileName, store, toast } from "./state.ts";

interface BridgeFile {
  src: string;
  kind: "image" | "audio";
  mime: string;
  base64: string;
}

/** Files the MCP server sent for its relative paths: show and play them from memory (the document keeps the paths). */
function receiveFiles(files: BridgeFile[]) {
  for (const f of files) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
    if (f.kind === "image") registerImageOverride(f.src, url);
    else registerAudioOverride(f.src, url);
  }
  // Already-loaded documents: nudge the views to pick up the new pixels (not sent back to the server).
  for (const img of store.doc.images) if (files.some((f) => f.src === img.src)) store.applyQuiet("updateImage", { image: img.id }, "bridge");
  logActivity("mcp", `Received ${files.length === 1 ? `“${files[0].src}”` : `${files.length} files`} from the MCP project folder`);
}

export const [bridgeStatus, setBridgeStatus] = createSignal<"off" | "connecting" | "connected">("off");
let ws: WebSocket | null = null;
let unsub: (() => void) | null = null;

/**
 * Live link to `openbone-mcp` (ws://127.0.0.1:7717). The server owns the document; local edits are
 * applied optimistically and sent as ops, remote ops are replayed here.
 */
export function connectBridge(url = localStorageGet("openbone.bridge") ?? "ws://127.0.0.1:7717") {
  disconnectBridge();
  setBridgeStatus("connecting");
  logActivity("system", `Connecting to the MCP server at ${url}…`);
  ws = new WebSocket(url);
  ws.onopen = () => {
    setBridgeStatus("connected");
    ws!.send(JSON.stringify({ type: "hello" }));
    unsub = store.subscribe((_d, e) => {
      if (e.origin === "bridge" || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (e.kind === "op" || e.kind === "transaction") for (const o of e.ops) ws.send(JSON.stringify({ type: "op", op: o.op, args: o.args }));
      else if (e.kind === "load") ws.send(JSON.stringify({ type: "load", doc: store.doc }));
    });
    toast("Connected to MCP server — agent edits appear live");
    logActivity("mcp", `Connected to the MCP server (${url}): agent edits appear here as they happen`);
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as { type: string; doc?: never; ops?: OpCall[]; message?: string; path?: string; files?: BridgeFile[] };
    if (msg.type === "files" && msg.files) receiveFiles(msg.files);
    else if (msg.type === "load" && msg.doc) {
      const first = !store.doc || store.doc !== msg.doc;
      store.load(msg.doc, "bridge");
      if (first && msg.path) setFileName(msg.path.split(/[\\/]/).pop() ?? "project.obone");
    } else if (msg.type === "ops" && msg.ops) {
      for (const o of msg.ops) {
        try {
          store.apply(o.op, o.args, "bridge");
        } catch (e) {
          toast(`Sync error in ${o.op}: ${(e as Error).message}`, "error");
          ws?.send(JSON.stringify({ type: "hello" }));
        }
      }
    } else if (msg.type === "error") toast(msg.message ?? "MCP error", "error");
  };
  ws.onclose = () => {
    if (bridgeStatus() === "connecting") toast("Could not reach the MCP server. Start it with: npx @openbone/mcp", "error");
    else if (bridgeStatus() === "connected") logActivity("mcp", "Disconnected from the MCP server");
    setBridgeStatus("off");
    unsub?.();
    unsub = null;
  };
}

export function disconnectBridge() {
  unsub?.();
  unsub = null;
  ws?.close();
  ws = null;
  setBridgeStatus("off");
}

export const bridgeUndo = () => ws?.send(JSON.stringify({ type: "undo" }));
export const bridgeRedo = () => ws?.send(JSON.stringify({ type: "redo" }));

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
void loadDocument;
