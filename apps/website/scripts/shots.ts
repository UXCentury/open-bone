/**
 * The documentation screenshots: one entry per image in src/assets/screenshots/. Each opens an example in the
 * editor (fresh browser profile, 1440 × 900 at 2×), runs its steps and captures the window or one element.
 * Helpers are in screenshots.ts; `ed.state()` runs code against the editor's own modules.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ed } from "./screenshots.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface Shot {
  name: string;
  /** One line: what the picture shows (also the alt text's starting point). */
  about: string;
  example?: string;
  /** Open this page instead of the editor (the web-engine demos). */
  url?: string;
  /** Runs in Node before the page opens; returns a clean-up function (used to start an MCP server). */
  before?: () => Promise<() => void>;
  steps?: (ed: Ed) => Promise<void>;
  viewport?: { width: number; height: number };
  /** Capture only this element (CSS selector), with optional padding. */
  clipTo?: string;
  clipPad?: number;
  clip?: { x: number; y: number; width: number; height: number };
  settle?: number;
}

/** Make the bottom dock (timeline, state machine, scripts) taller and re-fit the artboard. */
async function tallBottom(ed: Ed, size = 430) {
  await ed.state(`(await m("layout")).setDockSize("bottom", ${size}, false)`);
  await ed.wait(200);
  await ed.click("Fit artboard");
}

/** Zoom the viewport in around a point (CSS px) with the mouse wheel. */
async function zoomAt(ed: Ed, x: number, y: number, ticks = 3) {
  await ed.page.mouse.move(x, y);
  for (let i = 0; i < ticks; i++) {
    await ed.page.mouse.wheel(0, -120);
    await ed.wait(60);
  }
  await ed.page.mouse.move(5, 450);
}

/** Play the current animation for a while and pause (particles and physics only move while playing). */
async function playFor(ed: Ed, ms: number) {
  await ed.click("Play/pause (Space)");
  await ed.wait(ms);
  await ed.click("Play/pause (Space)");
}

async function animate(ed: Ed, anim: string, t = 0) {
  await ed.click("Animate mode");
  await ed.animation(anim, t);
}

const MCP_HTTP = 7729;
const MCP_BRIDGE = 7728;

/** An MCP server of our own (not the one a coding agent may be running), on a scratch copy of the robot. */
async function startMcp(): Promise<() => void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbone-shot-"));
  fs.copyFileSync(path.join(repo, "examples/robot.obone"), path.join(dir, "robot.obone"));
  fs.cpSync(path.join(repo, "examples/assets"), path.join(dir, "assets"), { recursive: true });
  // One process (node + the tsx loader), so killing it really stops the server.
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "packages/mcp/src/bin.ts", "--project", path.join(dir, "robot.obone"), "--http", String(MCP_HTTP), "--bridge-port", String(MCP_BRIDGE)],
    { cwd: repo, stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${MCP_HTTP}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return () => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

const ENGINES_PORT = 5191;

/** The repository's web-engine demos (examples/engines: PixiJS, Phaser, Three.js, CanvasKit), served by Vite. */
async function startEngines(): Promise<() => void> {
  const dir = path.join(repo, "examples");
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(dir, "node_modules/vite/bin/vite.js"), "--config", "engines/vite.config.ts", "--host", "127.0.0.1", "--port", String(ENGINES_PORT), "--strictPort"],
    { cwd: dir, stdio: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${ENGINES_PORT}/`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return () => child.kill();
}

/** One MCP tool call over streamable HTTP, the way an agent's client makes it. */
export async function mcpCall(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${MCP_HTTP}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  return res.text();
}

export const SHOTS: Shot[] = [
  // ── Getting started ───────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "editor-overview",
    about: "Windswept in Animate mode: skeleton tree, viewport, Inspector and the dopesheet with the voice line",
    example: "windswept",
    steps: async (ed) => {
      await animate(ed, "talk1", 1.2);
      await ed.select("bone", "head");
    },
  },
  {
    name: "editor-examples",
    about: "The Examples dialog",
    example: "walker",
    steps: async (ed) => {
      await ed.state('(await m("editor-menus")).setExamplesOpen(true)');
    },
    clipTo: ".modal",
    clipPad: 16,
  },
  {
    name: "editor-menu",
    about: "The main menu",
    example: "walker",
    steps: async (ed) => {
      await ed.click("Menu: new, open");
    },
  },
  {
    name: "editor-3d",
    about: "The 3D view: every part on its own plane in depth",
    example: "knight",
    steps: async (ed) => {
      await ed.state('(await m("zview")).setView3d_(true)');
      await ed.wait(800);
    },
  },
  {
    name: "editor-order",
    about: "The Order view: the draw order side by side",
    example: "tail",
    steps: async (ed) => {
      await ed.state('(await m("zview")).setZView_(true)');
      await ed.wait(800);
    },
  },
  {
    name: "editor-palette",
    about: "The command palette (Ctrl/⌘+K)",
    example: "knight",
    steps: async (ed) => {
      await ed.state('(await m("panels/CommandPalette")).setPaletteOpen(true)');
      await ed.page.keyboard.type("onion");
    },
  },

  // ── First rig ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "rig-add-menu",
    about: "The + Add menu: images and PSDs, frame sequences, shapes and sounds",
    example: "walker",
    steps: async (ed) => {
      await ed.select("bone", "torso");
      await ed.click("Add an image, a frame sequence");
    },
  },
  {
    name: "rig-bones",
    about: "Walker's bones up close, a bone selected and the Create bone tool",
    example: "walker",
    steps: async (ed) => {
      await ed.click("Create bone: drag from parent");
      await ed.select("bone", "front-forearm");
      await zoomAt(ed, 650, 330, 4);
    },
  },
  {
    name: "rig-slots",
    about: "A slot selected: its image, colour, blend mode, draw order and the attachment buttons",
    example: "walker",
    steps: async (ed) => {
      await ed.select("slot", "head");
    },
  },
  {
    name: "rig-mesh",
    about: "Editing the tail mesh's vertices with the Mesh tool",
    example: "tail",
    steps: async (ed) => {
      await ed.select("slot", "tail");
      await ed.click("Edit mesh vertices");
    },
  },
  {
    name: "rig-weights",
    about: "Painting weights on Walker's scarf: bone colours, overlay and vertex pies",
    example: "walker",
    steps: async (ed) => {
      await ed.select("slot", "drape");
      await ed.click("Paint mesh weights");
      await zoomAt(ed, 630, 300, 4);
    },
  },
  {
    name: "rig-ik",
    about: "An IK constraint on Walker's front leg",
    example: "walker",
    steps: async (ed) => {
      await ed.select("ik", "front-leg");
    },
  },

  // ── Animating ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "anim-dopesheet",
    about: "The walk cycle in the dopesheet",
    example: "walker",
    steps: async (ed) => {
      await animate(ed, "walk", 0.3);
      await tallBottom(ed);
      await ed.select("bone", "hip");
    },
  },
  {
    name: "anim-graph",
    about: "The Graph view: value curves and bezier handles",
    example: "walker",
    steps: async (ed) => {
      await animate(ed, "walk", 0.3);
      await tallBottom(ed);
      await ed.select("bone", "torso");
      await ed.click("Graph", { exact: true });
    },
  },
  {
    name: "anim-ffd",
    about: "Free-form deformation: the Mesh tool in Animate mode on the tail",
    example: "tail",
    steps: async (ed) => {
      await animate(ed, "curl", 0.6);
      await ed.select("slot", "tail");
      await ed.click("Edit mesh vertices");
    },
  },
  {
    name: "anim-onion",
    about: "Onion skin on the walk cycle",
    example: "walker",
    steps: async (ed) => {
      await animate(ed, "walk", 0.4);
      await ed.click("Onion skin");
    },
  },

  // ── State machines ────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "sm-graph",
    about: "Walker's state machine: inputs, bindings, listeners and the state graph",
    example: "walker",
    steps: async (ed) => {
      await ed.tab("State Machine");
      await tallBottom(ed, 470);
      await ed.click("Fit to view (F, or double-click");
      await ed.wait(300);
    },
  },
  {
    name: "sm-button",
    about: "The Button example's state machine with hover and press",
    example: "button",
    steps: async (ed) => {
      await ed.tab("State Machine");
      await tallBottom(ed, 470);
      await ed.click("Fit to view (F, or double-click");
      await ed.wait(300);
    },
  },
  {
    name: "sm-play",
    about: "Play mode on the Crash game: inputs, live text and the log",
    example: "crash",
    steps: async (ed) => {
      await ed.click("Play: try");
      await ed.wait(800);
      await ed.page.getByRole("button", { name: "Fire" }).first().click();
      await ed.wait(2200);
      // The game sets the multiplier; here we type it like a host app would.
      await ed.page.locator("input.num[type=number]").first().fill("2.37");
      await ed.wait(1200);
    },
    settle: 0,
  },
  {
    name: "sm-scripts",
    about: "A sandboxed script in the Scripts panel",
    example: "walker",
    steps: async (ed) => {
      await ed.tab("Scripts");
      await tallBottom(ed, 400);
    },
  },

  // ── Audio and lip sync ────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "audio-timeline",
    about: "Windswept's voice line on the audio lane with the lip-sync mouth keys",
    example: "windswept",
    steps: async (ed) => {
      await animate(ed, "talk1", 2.2);
      await tallBottom(ed);
      await ed.select("slot", "mouth");
    },
  },
  {
    name: "audio-lipsync",
    about: "The Lip sync dialog on Pip the fox",
    example: "fox",
    steps: async (ed) => {
      await animate(ed, "talk", 0);
      await ed.click("Lip sync: key");
      await ed.page.getByRole("button", { name: "Next" }).click();
      await ed.wait(2500);
    },
    clipTo: ".modal",
    clipPad: 16,
  },
  {
    name: "audio-mixer",
    about: "The mixer: the music bus selected in the Inspector",
    example: "windswept",
    steps: async (ed) => {
      await ed.select("bus", "music");
    },
  },
  {
    name: "audio-sound",
    about: "A sound selected: bus, volume, rate, loop and fades",
    example: "rocket",
    steps: async (ed) => {
      await ed.state('const snd = (d.audio?.sounds ?? [])[0]; s.setSelection({ kind: "sound", id: snd.id });');
    },
  },

  // ── Particles ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "particles-rocket",
    about: "The rocket's exhaust emitter mid-launch, with its settings in the Inspector",
    example: "rocket",
    steps: async (ed) => {
      await animate(ed, "launch", 0);
      await ed.select("slot", "exhaust");
      await playFor(ed, 1250);
    },
  },
  {
    name: "particles-play",
    about: "Play mode: the rocket launched with its smoke, exhaust and sparks running",
    example: "rocket",
    steps: async (ed) => {
      await ed.click("Play: try");
      await ed.wait(800);
      await ed.page.getByRole("button", { name: "Fire" }).first().click();
      await ed.wait(1400);
    },
    settle: 0,
  },
  {
    name: "particles-campfire",
    about: "Campfire: sprite-sequence flames, a flame mesh and a clipping mask",
    example: "campfire",
    steps: async (ed) => {
      await ed.select("slot", "flame");
    },
  },

  // ── Physics ───────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "physics-hair",
    about: "A physics constraint on Windswept's hair: inertia, strength, damping, gravity and wind",
    example: "windswept",
    steps: async (ed) => {
      await ed.select("physics", "hair-A1-physics");
    },
  },
  {
    name: "physics-tail",
    about: "Spring antennae and a path-driven tail on the Tail example",
    example: "tail",
    steps: async (ed) => {
      await ed.select("physics", "antenna-l1");
    },
  },

  // ── Exporting ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "export-dialog",
    about: "The Export dialog: project, data, image, video, web and engine formats",
    example: "walker",
    steps: async (ed) => {
      await ed.state("s.setExportOpen(true)");
    },
    clipTo: ".modal",
    clipPad: 16,
  },
  ...(["JSON", "Binary", "MP4", "WebM", "GIF", "Website", "Unity"] as const).map(
    (fmt): Shot => ({
      name: `export-${fmt.toLowerCase()}`,
      about: `The Export dialog with ${fmt} selected`,
      example: fmt === "MP4" || fmt === "WebM" ? "windswept" : "knight",
      steps: async (ed) => {
        await ed.state("s.setExportOpen(true)");
        await ed.wait(400);
        await ed.page.locator(".modal").getByText(fmt, { exact: true }).first().click();
        await ed.wait(600);
        if (fmt === "MP4" || fmt === "WebM") {
          await ed.page.locator(".modal select").first().selectOption({ label: "talk1" });
          await ed.wait(900);
        }
        await ed.wait(600);
      },
      clipTo: ".modal",
      clipPad: 16,
    }),
  ),

  // ── Web engines ───────────────────────────────────────────────────────────────────────────────────────────────
  ...(["pixi", "phaser", "three", "canvaskit"] as const).map(
    (engine): Shot => ({
      name: `engine-${engine}`,
      about: `The knight in the ${engine} demo (examples/engines/${engine})`,
      url: `http://127.0.0.1:${ENGINES_PORT}/${engine}/`,
      before: startEngines,
      viewport: { width: 1280, height: 800 },
      clip: { x: 0, y: 0, width: 750, height: 590 },
      settle: 2500,
    }),
  ),

  // ── MCP ───────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "mcp-live",
    about: "The editor live-connected to an MCP server while an agent adds a wave animation to the robot",
    example: "walker",
    before: startMcp,
    steps: async (ed) => {
      await ed.state(`localStorage.setItem("openbone.bridge", "ws://127.0.0.1:${MCP_BRIDGE}"); (await m("bridge")).connectBridge("ws://127.0.0.1:${MCP_BRIDGE}");`);
      await ed.wait(1500);
      // What an agent would do next: a new animation with keys, and a state machine trigger.
      await mcpCall("create_animation", { name: "wave", duration: 1 });
      // Keys are absolute: the robot's head rests at -90° and its antenna at 90°.
      const around = (base: number, offsets: [number, number][]) => offsets.map(([time, v]) => ({ time, value: base + v, curve: "easeInOut" }));
      await mcpCall("set_keys", { animation: "wave", target: "bone", id: "head", property: "rotation", keys: around(-90, [[0, 0], [0.25, 10], [0.5, -8], [0.75, 6], [1, 0]]) });
      await mcpCall("set_keys", { animation: "wave", target: "bone", id: "antenna", property: "rotation", keys: around(90, [[0, 0], [0.3, -22], [0.6, 18], [1, 0]]) });
      await ed.wait(600);
      await ed.click("Animate mode");
      await ed.animation("wave", 0.25);
      await ed.select("bone", "head");
      await ed.wait(400);
    },
  },
];

/** Images made by the `openbone` CLI itself (packages/cli), for the CLI guide. `{out}` is the output file. */
export interface CliShot {
  name: string;
  about: string;
  /** Arguments after `openbone`. */
  args: string[];
  /** What the CLI writes. */
  ext: "png" | "gif";
}

export const CLI_SHOTS: CliShot[] = [
  { name: "cli-render-walk", about: "openbone render: one frame of Walker's walk", args: ["render", "examples/walker.obone", "--animation", "walk", "--time", "0.25", "--out", "{out}"], ext: "png" },
  {
    name: "cli-render-bones",
    about: "openbone render --bones --bounding-boxes: the Knight's rig and hit areas drawn on top",
    args: ["render", "examples/knight.obone", "--animation", "attack", "--time", "0.3", "--bones", "--bounding-boxes", "--out", "{out}"],
    ext: "png",
  },
  {
    name: "cli-gif-button",
    about: "openbone gif: a state machine run of the Button (hover, then press)",
    args: ["gif", "examples/button.obone", "--state-machine", "ui", "--steps", '[{"setInputs":{"hover":true},"advance":0.8},{"fire":["press"],"advance":0.8}]', "--fps", "20", "--scale", "1", "--out", "{out}"],
    ext: "gif",
  },
];
