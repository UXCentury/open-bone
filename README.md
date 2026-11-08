# OpenBone

**Open-source 2D skeletal animation (Spine-style rigging) + Rive-style interactivity + an MCP server so AI agents can build animations for you.**

- **Rig**: bones, slots, draw order, skins, region/image attachments, vector shapes, weighted meshes, bounding boxes, points, 1- and 2-bone IK, transform constraints.
- **Animate**: per-property timelines (bone rotate/translate/scale/shear, slot colour/attachment, IK mix, mesh deform, draw order), bezier/stepped curves, events, track mixing.
- **Make it interactive**: state machines with layers, bool/number/trigger inputs, 1D blend states, any-state transitions, exit times, cross-fades, pointer listeners on hit boxes, reported events, and **sandboxed scripts** (QuickJS) with an `ob` API.
- **Edit anywhere**: SolidJS web editor, Tauri desktop app, CLI, and a **Model Context Protocol server** (68 tools) with a live bridge: watch an agent rig and animate in the editor in real time.
- **Ship it**: renderer-agnostic TypeScript runtime, WebGL2 + Canvas2D renderers, and an `<openbone-player>` web component.

Everything in this repository is **MIT** and built only on permissively licensed open-source dependencies.

## Quick start

```bash
pnpm install
```

```bash
pnpm dev
```

The editor opens at http://localhost:5180 with the *Walker* example (IK legs, weighted cape mesh, idle/walk blend, jump trigger, eye-follow script). The player demo is at http://localhost:5180/player.html.

```bash
pnpm test
```

### Let an agent animate (MCP)

This repo ships `.mcp.json`, so Claude Code picks up the `openbone` server automatically. For other clients:

```json
{ "mcpServers": { "openbone": { "command": "pnpm", "args": ["exec", "tsx", "/path/to/OpenBone/packages/mcp/src/bin.ts"] } } }
```

Then ask: *"Create a project at ~/anim/robot.obone: a robot with IK arms, an idle and a wave animation, and a state machine that waves when clicked."* Click **⚡ Connect MCP** in the editor to watch it happen live (the bridge listens on `ws://127.0.0.1:7717`). See [docs/mcp.md](docs/mcp.md).

### CLI

```bash
pnpm cli render examples/walker.obone --animation walk --time 0.25 --out walk.png
```

```bash
pnpm cli simulate examples/walker.obone --steps '[{"setInputs":{"speed":1},"advance":1},{"fire":["jump"],"advance":1}]'
```

`pnpm cli` with no arguments lists every command (validate, summary, render, gif, simulate, apply, ops, mcp).

### Desktop

```bash
pnpm desktop
```

Requires Rust and the Tauri system dependencies (on Linux: webkit2gtk-4.1, GTK 3).

### Embed in a website

```html
<script type="module">
  import { definePlayerElement } from "@openbone/player";
  definePlayerElement();
</script>
<openbone-player src="walker.obone" state-machine="character"></openbone-player>
<script>
  const p = document.querySelector("openbone-player");
  p.setInput("speed", 1);
  p.addEventListener("openbone-event", (e) => console.log(e.detail.name));
</script>
```

## Repository layout

| Package | What it is |
|---|---|
| `packages/core` | Document model (`.obone` JSON), the **op registry** (every edit: validated with zod, undoable, replayable), store with undo/redo, validation, summaries |
| `packages/runtime` | Pose solver, IK/transform constraints, animation sampling and mixing, state machine, listeners, events, script host interface |
| `packages/scripting` | QuickJS-WASM sandbox (memory cap and CPU deadline per call) |
| `packages/render-webgl` | Batched WebGL2 renderer |
| `packages/render-canvas` | Canvas2D renderer (fallback, editor viewport, headless PNG/GIF in Node) |
| `packages/player` | `<openbone-player>` and the `Player` class |
| `packages/mcp` | MCP server (stdio + streamable HTTP), render/simulate tools, live WebSocket bridge |
| `packages/cli` | `openbone` command line |
| `apps/editor` | SolidJS editor |
| `apps/desktop` | Tauri 2 shell around the editor, with native file dialogs |
| `examples` | Walker and button projects, plus the script that builds them |

Read [docs/architecture.md](docs/architecture.md) for the design and [docs/format.md](docs/format.md) for the file format.

## Open core

OpenBone (editor, runtime, player, MCP, CLI) is and stays MIT. A hosted **OpenBone Cloud** (accounts, cloud projects, real-time collaboration, hosted MCP, asset CDN) is planned as a separate service that builds on these packages. The editor already talks to storage through one place (`apps/editor/src/storage.ts`) so a cloud backend can slot in without forking.

## Clean-room note

OpenBone is an independent implementation. It does not use or derive from Esoteric Software's Spine runtimes or editor (whose licence requires a paid Spine licence), or from Rive's editor. Formats, solvers and APIs are our own, built from public math (affine transforms, analytic IK, cubic bézier easing).
