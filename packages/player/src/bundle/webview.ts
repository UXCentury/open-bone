/**
 * Entry of the self-contained player bundle (`openbone-player.js`) used by the WebView packages.
 *
 * The page provides the document in one of these ways (first found wins):
 *   - `<script type="application/octet-stream" id="openbone-data">BASE64</script>` (.obone or .obonb bytes)
 *   - `?src=url` in the page URL (fetched; needs http(s), not file://)
 *   - `window.OPENBONE_SRC` (a URL or a parsed document)
 * Options come from `data-*` attributes on `<body>`: data-state-machine, data-animation, data-skin, data-fit,
 * data-background ("none" = transparent), data-renderer.
 *
 * It exposes `window.OpenBone` (see bridge.ts for the message format).
 */
import { type OpenBoneDocument, parseDocument } from "@openbone/core";
import type { ScriptHost } from "@openbone/runtime";
import { createQuickJsHost } from "@openbone/scripting";
import { RELEASE_SYNC, newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten";
// Resolved by the bundle build to the QuickJS .wasm bytes (esbuild `binary` loader).
import wasmBinary from "openbone:quickjs-wasm";
import { Player } from "../player.ts";
import { type BridgeCommand, type BridgeInputInfo, type BridgePlayer, applyCommand, parseCommand, postToHost } from "../bridge.ts";

declare global {
  interface Window {
    OPENBONE_SRC?: string | OpenBoneDocument;
    OpenBone?: unknown;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function findSource(): string | OpenBoneDocument | null {
  const el = document.getElementById("openbone-data");
  if (el?.textContent?.trim()) return parseDocument(base64ToBytes(el.textContent));
  const q = new URLSearchParams(location.search).get("src");
  if (q) return q;
  return window.OPENBONE_SRC ?? null;
}

async function scriptHostFor(): Promise<ScriptHost> {
  const module = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmBinary: wasmBinary.slice().buffer }));
  return createQuickJsHost({ module });
}

function start() {
  const body = document.body;
  const opt = (k: string) => body.dataset[k] || undefined;
  let canvas = document.querySelector<HTMLCanvasElement>("canvas#openbone");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "openbone";
    body.append(canvas);
  }
  let player: Player | null = null;
  const queue: BridgeCommand[] = [];

  const inputs = (): BridgeInputInfo[] => {
    const sm = player?.stateMachine;
    if (!sm) return [];
    return sm.data.inputs.map((i) => ({ name: i.name, type: i.type, value: i.type === "trigger" ? null : (sm.getInput(i.name) ?? null) }));
  };
  const adapter: BridgePlayer = {
    setInput: (n, v) => player?.setInput(n, v),
    fire: (n) => player?.fire(n),
    play: () => player?.play(),
    pause: () => player?.pause(),
    playAnimation: (n, loop) => player?.playAnimation(n, loop),
    setSkin: (n) => player?.setSkin(n),
    useStateMachine: (n) => {
      if (!player) return;
      player.instance.useStateMachine(n);
      watchInputs();
    },
    inputs,
  };
  const watchInputs = () => player?.stateMachine?.on("inputChange", () => postToHost({ type: "inputs", inputs: inputs() }));

  /** Run a command now, or once the document has loaded. Errors go to the host as `error` messages. */
  const run = (cmd: unknown) => {
    try {
      const c = parseCommand(cmd);
      if (!player?.instance) {
        queue.push(c);
        return;
      }
      const reply = applyCommand(adapter, c);
      if (reply) postToHost(reply);
    } catch (e) {
      postToHost({ type: "error", message: (e as Error).message });
    }
  };

  window.OpenBone = {
    /** Host entry point: a JSON string or object command. */
    receive: run,
    setInput: (name: string, value: boolean | number) => run({ type: "setInput", name, value }),
    fire: (name: string) => run({ type: "fire", name }),
    play: (animation?: string, loop?: boolean) => run({ type: "play", animation, loop }),
    pause: () => run({ type: "pause" }),
    setSkin: (name: string | null) => run({ type: "setSkin", name }),
    useStateMachine: (name?: string) => run({ type: "useStateMachine", name }),
    getInputs: () => inputs(),
    get player() {
      return player;
    },
  };
  // iframe hosts can send commands with postMessage({ openbone: command }).
  window.addEventListener("message", (e) => {
    const d = e.data as { openbone?: unknown } | null;
    if (d && typeof d === "object" && "openbone" in d) run(d.openbone);
  });

  let src: string | OpenBoneDocument | null;
  try {
    src = findSource();
  } catch (e) {
    postToHost({ type: "error", message: `Could not read the embedded document: ${(e as Error).message}` });
    return;
  }
  if (!src) {
    postToHost({ type: "error", message: "No document: embed one in #openbone-data, or pass ?src=" });
    return;
  }
  const bg = opt("background");
  const hasScripts = typeof src === "object" ? src.scripts.length > 0 : true;
  (hasScripts ? scriptHostFor() : Promise.resolve(undefined)).then(
    (host) => {
      player = new Player({
        canvas: canvas!,
        src: src!,
        stateMachine: opt("stateMachine"),
        animation: opt("animation"),
        skin: opt("skin"),
        fit: (opt("fit") as "contain") ?? "contain",
        renderer: (opt("renderer") as "webgl") ?? "webgl",
        ...(bg !== undefined ? { background: bg === "none" ? null : bg } : {}),
        scripts: host ?? "none",
        onEvent: (e) => postToHost({ type: "event", name: e.name, int: e.int, float: e.float, string: e.string, time: e.time }),
        onStateChange: (e) => postToHost({ type: "stateChange", layer: e.layer, from: e.from, to: e.to }),
      });
      player.ready.then(
        () => {
          const p = player!;
          watchInputs();
          postToHost({
            type: "ready",
            animations: p.doc.animations.map((a) => a.name),
            stateMachines: p.doc.stateMachines.map((s) => s.name),
            inputs: inputs(),
            skins: p.skins,
            width: p.doc.width,
            height: p.doc.height,
          });
          for (const c of queue.splice(0)) run(c);
        },
        (e) => postToHost({ type: "error", message: (e as Error).message }),
      );
    },
    (e) => postToHost({ type: "error", message: `Script engine failed to start: ${(e as Error).message}` }),
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
