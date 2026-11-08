# OpenBone

**Open-source 2D skeletal animation (Spine-style rigging) + Rive-style interactivity + an MCP server so AI agents can build animations for you.**

![The OpenBone editor: the painted Knight example mid-wave in Animate mode, with the skeleton tree, the grouped dopesheet and the Inspector](docs/editor.webp)

## Features

### Rigging
- **Bones** with parent/child hierarchy, length, rotation, translation, scale and shear, and inherit modes (normal, only translation, no rotation, no scale).
- **Slots** with draw order, colour/alpha tint and blend modes (normal, additive, multiply, screen).
- **Skins**: create, duplicate, rename and delete outfits, switch them live in the viewport, player and previews; attachments can override the default skin per outfit.
- **Constraints**
  - **IK**: 1- and 2-bone, mix, bend direction, softness, stretch, compress and uniform scaling; mix and softness blend between keys, bend/stretch/compress key in steps (like Spine's IK timeline).
  - **Transform**: rotate/translate/scale/shear mixes, world or local space, absolute or relative.
  - **Path**: place and rotate a bone chain along a bezier path, with position, spacing and rotate modes.
  - **Physics**: secondary motion (hair, cloth, tails) with inertia, strength, damping, gravity and wind; deterministic fixed timestep.
  - **Sliders**: a bone's property (e.g. shoulder rotation) or a number input scrubs an animation: corrective shapes, shadows, dials. Range-to-time mapping, mix, loop and additive; applied before the other constraints.

### Attachments
- **Regions** (images), **vector shapes** (rect, rounded rect, ellipse, polygon with fill and stroke), **points** and **bounding boxes** (hit areas).
- **Meshes**: deformable, weighted to bones, with free-form deform keys. **Trace mesh** builds one automatically from an image's visible pixels (outline detail, padding and inner vertices to choose; honours the region's rotation and scale), so less transparent area is drawn and the mesh bends with the art.
- **Clipping masks**: slots after the mask, up to an end slot, are drawn only inside its outline (Canvas2D clip, WebGL2 stencil).
- **Bezier paths** for path constraints, optionally weighted to bones.
- **Sprite sequences**: frame-by-frame animation from numbered image files (After Effects / render output, sorted naturally), sprite sheets cut by a grid or read from TexturePacker / Aseprite JSON (hash or array, trimmed frames), or a ZIP of frames. Own fps, loop / once / ping-pong / hold-last, start offset; driven by animation or state time, by frame keys, or by a number input. Works with skins, clipping, draw order and the atlas.
- **Particle emitters** on any slot: rate and bursts, point/circle/box/cone shapes, world or local space, lifetime, speed, gravity, drag, size, rotation and colour-over-life ranges, soft circle / square / spark streak / image looks, blend modes, and presets (fire, smoke, sparks, confetti, exhaust, coins). Seeded and deterministic, so the editor preview and image/video exports show the same particles; emitting and rate are keyable, and state machines can start, stop or burst them.
- **Text attachments** (font, size, weight, colour, alignment, outline) whose content can be a live template bound to inputs.
- **Texture atlas packing** (MaxRects): fewer GPU draw calls and single-file exports; optional **rotation** (images turn 90° when that packs tighter) and **scaling** (store images at 75/50/25%, or *Auto* to shrink just enough to fit one page).

### Animation
- Per-property timelines: bone rotate/translate/scale/shear, slot colour and attachment, IK/transform/path/physics constraint values, mesh and path deform, sequence frame, particle emitting and rate, draw order.
- Linear, stepped and bezier curves. The Timeline's **Graph view** shows every numeric timeline as value curves over time: drag keys in time and value, shape bezier handles on the curve, pan, zoom, fit, and normalize curves of different units; a per-key ease editor sits beside the dopesheet.
- **Full-width dopesheet timeline** with a **● Rec** button (keys past the end extend the animation), grouped by bone, slot and constraint (collapsible, with summary keys that move a group's keys together), keys coloured per property and shaped by curve type, hold bars where a value stays the same, auto-key, key dragging, events (with int/float/string payloads and audio references).
- Per-animation **Export** switch (helper animations stay out of exports) and **colour**.
- Track mixing and cross-fades at runtime.
- **Onion skin**: ghost poses before (red) and after (green) the current frame.

### Interactivity (Rive-style)
- **State machines** with layers, bool/number/string/trigger inputs, animation and 1D blend states, any-state transitions, conditions, exit times, cross-fades, **"on complete" hand-offs** for staged flows (play once, then continue) and **inputs set on enter** (reset a round when going back to idle). The graph pans, zooms and fits to view.
- **Live data**: **text attachments** whose content is a template bound to inputs (`{multiplier:0.00}x`, thousands separators, signs, percent), and **input bindings** that drive bone, slot (colour, alpha) and constraint properties from a number input with a clamped linear mapping. See the crash-game example.
- **Pointer listeners** on hit boxes (down, up, enter, exit, move, click) that set inputs, fire triggers, report events, play or stop sounds, start or stop particles, or run scripts.
- **Sandboxed scripts** (QuickJS-WASM, memory cap and per-call deadline) with an `ob` API: `onStart`, `onUpdate`, `onEvent`, `onPointer`.

### Audio
- **Sounds** from WAV, MP3 or OGG files (embedded or by path), each with a bus, volume, rate (pitch), loop and fade in/out.
- The timeline's audio lane shows each sound's **waveform**, so keys can be timed by eye. **Lip sync** analyses a voice recording and keys a mouth slot's images to it (rest, closed M/B/P, small, open, wide, round), from the current time, in one undo step; see the Robot example.
- Played by **audio keys** on an animation's timeline, by **events** (every time the event fires), by **state hooks** (play/stop on enter or exit) and by **listener actions**. Looping sounds fade out when their state or animation ends.
- **Mixer**: named buses (sfx, music, ui, or your own) with volume and mute, and a master volume. The runtime only emits play/stop/fade commands; the player and editor play them with Web Audio, unlocking on the first click or key press.

### Editor
- **Selection**: drag a box on empty space to select many bones (Shift adds, Ctrl/⌘ removes, Shift-click toggles); drag, rotate, scale or key (`K`) them together.
- **Tools**: select/rotate, translate, scale, **Pose** (`I`: drag any bone and it plus its parents bend to follow, inverse kinematics without setting up a constraint; chain length 1–5 or to the root, Shift for just the grabbed bone; keys in Animate mode), create bone, **mesh vertex editing** (select, drag, add, delete, nudge; re-triangulates) with **soft selection** (nearby vertices follow with a falloff), and **weights** (brush with add/remove, radius and strength, heat-map; **Direct** mode sets selected vertices' weights per bone; **Smooth**, **Auto** and **Prune**).
- **Setup and Animate modes**, undo/redo for every change.
- **Skeleton tree** with parent/child guide lines, collapsible bones and slots (Alt-click: a whole branch), **search** (matches shown with their parents; Enter selects the first) and auto-scroll to whatever you select in the viewport.
- **Viewport aids**: checkerboard (transparent backgrounds supported), origin lines, red/green **move arrows** on the selected bone (axis-locked dragging), grid, rulers, draggable guides (saved per project) and **smart snapping** to the artboard centre/edges/origin, guides, grid, other bone joints and mesh vertices (hold Ctrl/⌘ to bypass).
- **Dockable workspace**: resize panels, drag panel tabs to any side or group them, collapse sections; the layout is remembered and can be reset.
- **Play mode** (▶ Play, `P`): run the result in the editor exactly as shipped, with a floating panel to toggle inputs, fire triggers and watch events, state changes and script logs; pick the state machine or animation, skin and speed, fit or 1:1, full window. Stop returns to the exact editing state.
- **Keyboard shortcuts** that use ⌘ on macOS and Ctrl on Windows/Linux, with a searchable reference (`?`) where every key can be rebound (conflict-checked, saved per browser).
- **Preview** panel (plays an animation or runs a state machine live, clickable, while you edit), **Outline** minimap (click to move the view) and **Stats** (bones, vertices, vertex transforms, triangles, clipping, estimated draw calls).
- In-app dialogs and a live MCP connection that shows an agent's edits as they happen.

### Export
- **OpenBone project** (`.obone`): the whole project, to open and keep editing later.
- **Data**: JSON (`.json`) or compact **binary** (`.obonb`, about 40% of JSON), with a choice of animations, state machines, scripts and skins, plus nonessential-data stripping, animation clean-up, embedded images and atlas packing.
- **Images**: PNG and JPEG (one frame or a ZIP of every frame), animated **GIF** and **APNG**, layered **PSD** (one layer per frame).
- **Video**: **AVI** and **MOV** (Motion-JPEG).
- **Web**: the `<openbone-player>` web component as a classic script (`window.OpenBone`) or an ES module, **minified (≈ 90 KB, 32 KB gzipped) or readable**, plus your animation, a demo page with controls for the inputs and a README with embed snippets (ZIP), or **one self-contained HTML file** that works without a server. In ZIPs the script sandbox ships as separate files (`openbone-scripts.js` + `quickjs.wasm`) that are downloaded only when an animation has scripts. Embedded images are re-encoded as **WebP** when smaller (the knight example: 470 KB → 71 KB), or kept lossless.
- **Engines**: sprite-sheet packs (trimmed, packed sheets with frame metadata) for **Unity** (TexturePacker/Unity JSON + import guide), **Godot 4** (ready `SpriteFrames` `.tres` and an `AnimatedSprite2D` scene), **Flutter** (sheet + JSON + Flame snippet) and generic engines (TexturePacker hash/array JSON for Phaser, PixiJS, Cocos); plus **interactive WebView packages** for **Flutter**, **Android** (Kotlin `OpenBoneView`) and **iOS** (Swift, UIKit and SwiftUI) that run the full file (state machines, inputs, scripts) through a small JS bridge (`setInput`, `fire`, `play`, events back to the app). The native templates are not compiled in CI; see their READMEs.
- Animation, skin, frame rate, scale, artboard or fit-to-content area, transparent or coloured background, quality and looping options; a live preview; export settings can be saved to a file and loaded again.

### Runtime and tools
- Renderer-agnostic TypeScript runtime with **WebGL2** (batched) and **Canvas2D** renderers.
- **`<openbone-player>`** web component and a `Player` class (loads `.obone`, `.json` and `.obonb`).
- **MCP server** (116 tools; every editing op becomes a tool automatically) covering everything the editor does: render/simulate, every export format, trace mesh, lip sync, the Pose tool, weight clean-up and stats, plus a live WebSocket bridge to the editor.
- **CLI**: validate, summarize, render PNG/GIF, simulate state machines, apply any op.
- **Desktop app** (Tauri 2) with native file dialogs.

Everything in this repository is **MIT** and built only on permissively licensed open-source dependencies.

## Quick start

```bash
pnpm install
```

```bash
pnpm dev
```

The editor opens at http://localhost:5180 with the *Walker* example (IK legs, weighted cape mesh, idle/walk blend, jump trigger, eye-follow script). The *Examples* menu also has a **robot** (lip sync: its mouth is keyed from its voice; click it to talk), a **knight** (painted parts, weighted cape mesh, idle/march/wave, click to wave), an interactive button (state machine, clipping mask, click sound), a tail (path and physics constraints), a campfire (sprite sequences), a rocket (particles, click to toggle the engine) and a **crash game** (staged flow idle → fly-out → flying → crash or cash-out, a live multiplier text, input bindings and a sprite-sequence explosion). The knight, button, rocket and crash-game art is painted (see [examples/assets/canva/LICENSE.md](examples/assets/canva/LICENSE.md); MIT like the rest of the repo). Press **▶ Play** to try any of them. The player demo is at http://localhost:5180/player.html.

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
| `packages/core` | Document model (`.obone` JSON and `.obonb` binary), the **op registry** (every edit: validated with zod, undoable, replayable), store with undo/redo, validation, export selection, atlas packing, snapping, summaries |
| `packages/runtime` | Pose solver, IK/transform/path/physics constraints, animation sampling and mixing, state machine, listeners, events, input bindings, text templates, sprite sequences, particles, audio commands, script host interface |
| `packages/scripting` | QuickJS-WASM sandbox (memory cap and CPU deadline per call) |
| `packages/render-webgl` | Batched WebGL2 renderer |
| `packages/render-canvas` | Canvas2D renderer (fallback, editor viewport, headless PNG/GIF in Node) |
| `packages/player` | `<openbone-player>`, the `Player` class, Web Audio playback, and the self-contained WebView bundle + JS bridge used by the mobile packages |
| `packages/export` | Export encoders and packagers: PNG, APNG, GIF, PSD, AVI and MOV (Motion-JPEG), ZIP, sprite sheets, Unity/Godot/Flutter packs and the Flutter/Android/iOS WebView templates |
| `packages/mcp` | MCP server (stdio + streamable HTTP), render/simulate tools, live WebSocket bridge |
| `packages/cli` | `openbone` command line |
| `apps/editor` | SolidJS editor |
| `apps/desktop` | Tauri 2 shell around the editor, with native file dialogs |
| `examples` | Walker, robot, knight, button, tail, campfire, rocket and crash-game projects, their art, and the script that builds them |

Read [docs/architecture.md](docs/architecture.md) for the design and [docs/format.md](docs/format.md) for the file format.

## Open core

OpenBone (editor, runtime, player, MCP, CLI) is and stays MIT. A hosted **OpenBone Cloud** (accounts, cloud projects, real-time collaboration, hosted MCP, asset CDN) is planned as a separate service that builds on these packages. The editor already talks to storage through one place (`apps/editor/src/storage.ts`) so a cloud backend can slot in without forking.

## Clean-room note

OpenBone is an independent implementation. It does not use or derive from Esoteric Software's Spine runtimes or editor (whose licence requires a paid Spine licence), or from Rive's editor. Formats, solvers and APIs are our own, built from public math (affine transforms, analytic IK, cubic bézier easing).
