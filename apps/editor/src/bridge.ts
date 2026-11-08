import type { OpCall } from "@openbone/core";
import { createSignal } from "solid-js";
import { loadDocument, setFileName, store, toast } from "./state.ts";

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
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as { type: string; doc?: never; ops?: OpCall[]; message?: string; path?: string };
    if (msg.type === "load" && msg.doc) {
      const first = !store.doc || store.doc !== msg.doc;
      store.load(msg.doc, "bridge");
      if (first && msg.path) setFileName(msg.path.split(/[\\/]/).pop() ?? "project.obone");
    } else if (msg.type === "ops" && msg.ops) {
      for (const o of msg.ops) {
        try {
          store.apply(o.op, o.args, "bridge");
        } catch (e) {
          toast(`Sync error: ${(e as Error).message}`, "error");
          ws?.send(JSON.stringify({ type: "hello" }));
        }
      }
    } else if (msg.type === "error") toast(msg.message ?? "MCP error", "error");
  };
  ws.onclose = () => {
    if (bridgeStatus() === "connecting") toast("Could not reach the MCP server. Start it with: pnpm mcp", "error");
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
