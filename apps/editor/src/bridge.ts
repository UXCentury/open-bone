import type { OpCall, OpenBoneDocument } from "@openbone/core";
import { createSignal } from "solid-js";
import { logActivity } from "./activity.ts";
import { clearAgentFx } from "./agent-fx.ts";
import { registerAudioOverride } from "./audio.ts";
import { askConfirm } from "./dialogs.tsx";
import { addRecent } from "./recent.ts";
import { registerFontOverride } from "./fonts.ts";
import { registerImageOverride } from "./images.ts";
import { loadDocument, setFileName, store, toast } from "./state.ts";
import { dirOf, isDesktop, projectAssetDir, setProjectAssetDir, sharesRelativeAssets } from "./storage.ts";

interface BridgeFile {
  src: string;
  kind: "image" | "audio" | "font";
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
    else if (f.kind === "font") registerFontOverride(f.src, url);
    else registerAudioOverride(f.src, url);
  }
  // Already-loaded documents: nudge the views to pick up the new pixels (not sent back to the server).
  for (const img of store.doc.images) if (files.some((f) => f.src === img.src)) store.applyQuiet("updateImage", { image: img.id }, "bridge");
  logActivity("mcp", `Received ${files.length === 1 ? `“${files[0].src}”` : `${files.length} files`} from the MCP project folder`);
}

export const [bridgeStatus, setBridgeStatus] = createSignal<"off" | "connecting" | "connected">("off");
let ws: WebSocket | null = null;
let unsub: (() => void) | null = null;

/** Nothing drawn yet: no images, no slots, no bones besides the root. */
const isEmptyScene = (d: OpenBoneDocument) => d.images.length === 0 && d.skeleton.slots.length === 0 && d.skeleton.bones.length <= 1;

/**
 * Live link to `openbone-mcp` (ws://127.0.0.1:7717). Local edits are applied optimistically and sent as ops, remote ops
 * are replayed here.
 *
 * Connecting never swaps the open scene without asking. The editor's hello carries its scene, and a server with no
 * project yet takes it over and sends nothing back. A server that has a project open sends it ("load"): an empty one
 * (or an empty editor) just resolves itself, otherwise the editor asks whether to open the agent's project or send its
 * own scene to the agent. Servers before 0.4.5 ignore the hello's scene and send their project twice; both copies
 * are covered by the one answer.
 */
export function connectBridge(url = localStorageGet("openbone.bridge") ?? "ws://127.0.0.1:7717") {
  disconnectBridge();
  setBridgeStatus("connecting");
  logActivity("system", `Connecting to the MCP server at ${url}…`);
  const socket = (ws = new WebSocket(url));
  /** "waiting": no project from the server yet; "asking": the dialog is open; "synced": following the server. */
  let phase: "waiting" | "asking" | "synced" = "waiting";
  /** The server's project the user chose not to open (JSON), so a repeat of it doesn't replace the scene. */
  let declined: string | null = null;
  const sendMine = () => {
    socket.send(JSON.stringify({ type: "load", doc: store.doc }));
    logActivity("mcp", "Sent this scene to the MCP server: the agent now works on it");
  };
  const openTheirs = (doc: OpenBoneDocument, path?: string) => {
    if (!path && JSON.stringify(doc) === JSON.stringify(store.doc)) return; // our own scene back (a reconnect): nothing changes
    // A server without a file (it took this editor's scene) sends the same project back: keep the folder its art is in,
    // or the autosave forgets it and the art is gone after a restart.
    const keepDir = !path && sharesRelativeAssets(store.doc, doc) ? projectAssetDir() : null;
    store.load(doc, "bridge");
    if (path) {
      setFileName(path.split(/[\\/]/).pop() ?? "project.obone");
      // The server sends the art over the link; remembering its folder brings it back after a restart too. The file is
      // on this machine, so ☰ Menu → Open recent lists it like a project opened here.
      if (isDesktop()) {
        setProjectAssetDir(dirOf(path));
        addRecent(path);
      }
    } else if (keepDir) setProjectAssetDir(keepDir);
  };
  const firstLoad = async (doc: OpenBoneDocument, path?: string) => {
    const json = JSON.stringify(doc);
    if (json === declined) return;
    if (isEmptyScene(doc) && !isEmptyScene(store.doc)) {
      declined = json;
      phase = "synced";
      return sendMine();
    }
    if (isEmptyScene(store.doc) || json === JSON.stringify(store.doc)) {
      phase = "synced";
      return openTheirs(doc, path);
    }
    phase = "asking";
    const open = await askConfirm({
      title: "The MCP server has another project open",
      message: `The agent is working on “${doc.name}”${path ? ` (${path})` : ""}. Open it here, or send your scene “${store.doc.name}” to the agent instead? Sending yours replaces the agent's copy in memory; its saved file is not changed.`,
      confirmLabel: `Open “${doc.name}”`,
      cancelLabel: "Send my scene",
    });
    if (ws !== socket) return; // disconnected meanwhile
    phase = "synced";
    if (open) socket.send(JSON.stringify({ type: "hello" })); // the latest copy, with any edits made meanwhile
    else {
      declined = json;
      sendMine();
    }
  };
  socket.onopen = () => {
    setBridgeStatus("connected");
    // The editor's scene goes along: a server with no project yet keeps it instead of sending one.
    socket.send(JSON.stringify({ type: "hello", doc: store.doc }));
    // A server with no project yet takes the scene and answers "synced"; one with a project sends "load" (below).
    unsub = store.subscribe((_d, e) => {
      if (e.origin === "bridge" || socket.readyState !== WebSocket.OPEN || phase === "asking") return;
      if (e.kind === "op" || e.kind === "transaction") for (const o of e.ops) socket.send(JSON.stringify({ type: "op", op: o.op, args: o.args }));
      else if (e.kind === "load") socket.send(JSON.stringify({ type: "load", doc: store.doc }));
    });
    toast("Connected to MCP server — agent edits appear live");
    logActivity("mcp", `Connected to the MCP server (${url}): agent edits appear here as they happen`);
  };
  socket.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as {
      type: string;
      doc?: OpenBoneDocument;
      ops?: OpCall[];
      message?: string;
      path?: string;
      files?: BridgeFile[];
      id?: number;
      task?: string;
      args?: Record<string, unknown>;
    };
    if (msg.type === "request" && msg.id !== undefined) void answerRequest(socket, msg.id, msg.task ?? "", msg.args ?? {});
    else if (msg.type === "files" && msg.files) receiveFiles(msg.files);
    else if (msg.type === "synced") {
      phase = "synced";
      logActivity("mcp", "The MCP server took over this scene: the agent works on it");
    } else if (msg.type === "load" && msg.doc) {
      if (phase === "asking") return;
      if (phase === "waiting") void firstLoad(msg.doc, msg.path);
      else if (declined === null || JSON.stringify(msg.doc) !== declined) {
        declined = null;
        openTheirs(msg.doc, msg.path);
      }
    } else if (msg.type === "ops" && msg.ops) {
      if (phase === "asking") return; // edits to the project not (yet) shown here; opening it fetches the latest copy
      for (const o of msg.ops) {
        try {
          store.apply(o.op, o.args, "bridge");
        } catch (e) {
          toast(`Sync error in ${o.op}: ${(e as Error).message}`, "error");
          socket.send(JSON.stringify({ type: "hello" }));
        }
      }
    } else if (msg.type === "error") toast(msg.message ?? "MCP error", "error");
  };
  socket.onclose = () => {
    if (bridgeStatus() === "connecting") toast("Could not reach the MCP server. Start it with: npx @openbone/mcp", "error");
    else if (bridgeStatus() === "connected") logActivity("mcp", "Disconnected from the MCP server");
    setBridgeStatus("off");
    unsub?.();
    unsub = null;
  };
}

/** Work the MCP server asks of the editor because it needs a browser (see packages/mcp/src/bridge.ts). */
async function answerRequest(socket: WebSocket, id: number, task: string, args: Record<string, unknown>) {
  const reply = (msg: Record<string, unknown>) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ id, ...msg }));
  try {
    if (task !== "trackVideo") throw new Error(`This editor can't do "${task}": update it`);
    const { trackVideo } = await import("./mocap/tracker.ts");
    const name = String(args.name ?? "video");
    logActivity("mcp", `The agent asked to track the body in ${name}`);
    const bytes = Uint8Array.from(atob(String(args.base64 ?? "")), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: String(args.mime ?? "video/mp4") });
    let last = 0;
    const track = await trackVideo(blob, {
      fps: Number(args.fps) || store.doc.fps || 30,
      start: typeof args.start === "number" ? args.start : undefined,
      end: typeof args.end === "number" ? args.end : undefined,
      onProgress: (stage, p) => {
        const now = performance.now();
        if (now - last < 250 && p < 1) return;
        last = now;
        reply({ type: "progress", stage, p });
      },
    });
    reply({ type: "result", ok: true, data: track });
    logActivity("mcp", `Tracked ${track.frames.length} frames of ${name} for the agent`);
  } catch (e) {
    reply({ type: "result", ok: false, error: (e as Error).message });
  }
}

export function disconnectBridge() {
  clearAgentFx();
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
