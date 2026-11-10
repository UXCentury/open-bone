# @openbone/canvaskit

OpenBone runtime for CanvasKit (Skia compiled to WebAssembly): a renderer and a player.

[![npm](https://img.shields.io/npm/v/@openbone/canvaskit)](https://www.npmjs.com/package/@openbone/canvaskit)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package draws OpenBone skeletons on any CanvasKit
canvas: a browser WebGL or software surface, or a headless surface in Node. `CanvasKitPlayer` adds a render loop,
fit, pointer input, state machines, events, skins, scripts and sound for an HTML canvas. Playback comes from
[`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit); drawing follows the batches of the
reference renderer, [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl).

## Install

```bash
npm install @openbone/canvaskit canvaskit-wasm
```

`canvaskit-wasm` (BSD-3-Clause) is a peer dependency (`>=0.39.0`). Its `canvaskit.wasm` file must be reachable by
`CanvasKitInit`'s `locateFile`. For the Node example, also install `@openbone/runtime`.

## Quick start: in a page

```ts
import CanvasKitInit from "canvaskit-wasm";
import { CanvasKitPlayer } from "@openbone/canvaskit";

const ck = await CanvasKitInit({ locateFile: (file) => `/canvaskit/${file}` }); // where you serve canvaskit.wasm
const canvas = document.querySelector<HTMLCanvasElement>("#stage")!; // give it a CSS size

const player = await CanvasKitPlayer.create(ck, canvas, "/knight.obone", { stateMachine: "knight", fit: "contain" });
player.setInput("walk", true);
player.on("stateChange", (e) => console.log(e.layer, e.from, "->", e.to));
new ResizeObserver(() => player.resize()).observe(canvas);
```

`knight.obone` is in the repository's `examples/` folder. The player draws at the device pixel ratio, fits the
artboard into the canvas and sends pointer events over it to the state machine.

## Quick start: a PNG in Node

```ts
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import CanvasKitInit from "canvaskit-wasm";
import { CanvasKitRenderer, loadOpenBone } from "@openbone/canvaskit";
import { OpenBoneInstance } from "@openbone/runtime";

const ck = await CanvasKitInit();

// Node's fetch has no file: URLs, so hand loadOpenBone a fetch that reads files.
const readFetch = (async (url: string | URL | Request) => new Response(await readFile(new URL(String(url))))) as typeof fetch;
const file = pathToFileURL(process.argv[2] ?? "knight.obone");
const asset = await loadOpenBone(ck, file, { fetch: readFetch }); // images resolve next to the file

const knight = new OpenBoneInstance(asset.doc);
knight.play("idle");
knight.advance(0.5);

const scale = 0.5;
const surface = ck.MakeSurface(asset.doc.width * scale, asset.doc.height * scale)!;
const renderer = new CanvasKitRenderer(ck, (id) => asset.images.get(id));
const canvas = surface.getCanvas();
canvas.clear(ck.TRANSPARENT);
renderer.render(canvas, knight, { x: 0, y: 0, zoom: scale });
surface.flush();
await writeFile("knight-ck.png", surface.makeImageSnapshot().encodeToBytes()!);
```

Over HTTP(S) no custom `fetch` is needed: `loadOpenBone(ck, "https://cdn.example.com/knight.obone")`.

## API

| Export | |
|---|---|
| `CanvasKitPlayer` | `await CanvasKitPlayer.create(ck, canvas, src, options)` plays a document on an HTML canvas. |
| `CanvasKitRenderer` | `new CanvasKitRenderer(ck, images, { fonts? })`; `render(canvas, skeletonOrInstance, view?)` draws one frame on any CanvasKit `Canvas`. |
| `loadOpenBone(ck, src, options)` | Loads a document and decodes its images (atlas pages when packed) with Skia. Works in browsers and Node. |
| `OpenBoneAsset` | `{ doc, baseUrl, images }` (CanvasKit images by image or atlas page id). Shareable by many players. |
| `PlayerOptions`, `CanvasKitRendererOptions`, `LoadOptions`, `View`, `DriverOptions`, `InputValue`, `OpenBoneSource` | Option and value types. |

`src` is a URL, bytes (`ArrayBuffer` or `Uint8Array` of a `.obone` or `.obonb` file), a parsed document or, for
`CanvasKitPlayer.create`, an `OpenBoneAsset`.

### `CanvasKitRenderer`

- `render(canvas, target, view)`: `view` is `{ x, y, zoom }` in canvas pixels (the artboard's top-left lands at
  `x, y`). The canvas's current matrix applies on top, so you can also position the skeleton with `canvas.concat`.
  It does not clear the canvas.
- `CanvasKitRenderer.matrix(doc, view)`: the skeleton-to-canvas matrix for a view.
- `drawCalls`: `drawVertices` calls in the last render. `dispose()` frees shaders, paints and cached images.
- `fonts(family, weight)`: return a `Typeface` to draw text attachments natively with Skia. Without it, text is
  rasterised with a 2D canvas where one exists (so in Node, text is skipped unless you pass `fonts`).

### `CanvasKitPlayer` options

| Option | Default | |
|---|---|---|
| `stateMachine` / `animation` / `loop` | first state machine, else first animation | What to run. |
| `skin` | default skin | Skin (outfit) by name or id. |
| `scripts` | `"quickjs"` when the document has scripts | `"none"` or your own `ScriptHost`. |
| `audio` | `true` | `false` or `"muted"`. Sound unlocks on the first click or key press. |
| `fit` | `contain` | `contain`, `cover` or `none`. |
| `background` | the document's | A CSS colour; `null` for transparent. |
| `surface` | `webgl` | `webgl` (falls back to software when WebGL is unavailable) or `software`. |
| `autoplay` | `true` | Start the render loop right away. |
| `fonts` | | As for the renderer. |
| `baseUrl`, `fetch`, `resolveImageUrl` | | Loading, as in `loadOpenBone`. |
| `audioContext`, `audioBaseUrl`, `resolveAudioUrl`, `unlockTarget`, `onEvent`, `onStateChange` | | As in engine-kit. |

### `CanvasKitPlayer` methods

| Member | |
|---|---|
| `setInput(name, value)`, `getInput(name)`, `fire(name)` | State machine inputs and triggers. |
| `playAnimation(name, loop?)` | Play an animation instead of the state machine. |
| `setSkin(name)`, `setText(slot, text)` | Outfit, and text for a slot's text attachment (`null` restores it). |
| `play()`, `pause()`, `playing` | The render loop; pausing also pauses sounds. |
| `resize()` | Call after the canvas changed size (the player does not observe it). |
| `draw()` | Draw the current pose once. |
| `on(name, fn)` | Listen to `"event"`, `"stateChange"` or `"audio"`. Returns an unsubscribe function. |
| `driver`, `instance`, `stateMachine`, `renderer`, `asset`, `ck`, `canvas` | Lower-level access (playback speed is `driver.speed`). |
| `dispose()` | Stops the loop and sounds, removes pointer listeners and frees the surface and renderer. |

## How it draws

One `drawVertices` per render-webgl batch: positions, texture coordinates (scaled to the image) and per-vertex
colours modulating the image shader, so meshes, weights, tints, sequences and particles match the reference renderer.

- **Two-colour tint**: slots with a `dark` colour draw through a colour-matrix filter
  (`rgb = dark + (light − dark) × rgb`), one `drawVertices` per run of items with the same light and dark colour.
  Batches without one are untouched.
- **Blend modes** map to Skia's `SrcOver`, `Plus`, `Multiply` and `Screen`.
- **Clipping** masks are anti-aliased clip paths.
- **Premultiplied alpha**: premultiplied atlas pages are labelled as premultiplied images, Skia's own format, so they
  blend correctly without conversion.
- **Particles** use the built-in soft sprite.

## Demo

From a checkout: `pnpm --filter @openbone/examples engines`, then open http://localhost:5190/canvaskit/
(`?example=campfire`, `rocket`, `crash`…).

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model and rendering
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Demo source](https://github.com/UXCentury/open-bone/blob/main/examples/engines/canvaskit/main.ts)
- Related packages: [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit),
  [`@openbone/pixi`](https://www.npmjs.com/package/@openbone/pixi),
  [`@openbone/phaser`](https://www.npmjs.com/package/@openbone/phaser),
  [`@openbone/three`](https://www.npmjs.com/package/@openbone/three),
  [`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas)

## License

MIT, © UX Century and OpenBone contributors. CanvasKit is © Google, BSD-3-Clause. See
[LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
