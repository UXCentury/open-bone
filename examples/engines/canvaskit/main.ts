import { CanvasKitPlayer } from "@openbone/canvaskit";
import CanvasKitInit from "canvaskit-wasm/bin/canvaskit.js";
import wasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import { SRC, STATE_MACHINE, bindControls, stage } from "../shared.ts";

const ck = await CanvasKitInit({ locateFile: () => wasmUrl });
const canvas = document.createElement("canvas");
stage().appendChild(canvas);

const player = await CanvasKitPlayer.create(ck, canvas, SRC, { stateMachine: STATE_MACHINE });
new ResizeObserver(() => player.resize()).observe(canvas);

bindControls(player, (log) => player.on("event", (e) => log(e.name)));
Object.assign(window, { ck, player });
