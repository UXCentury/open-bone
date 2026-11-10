# @openbone/pixi

OpenBone runtime for PixiJS v8: an OpenBone document as a Pixi `Container`.

[![npm](https://img.shields.io/npm/v/@openbone/pixi)](https://www.npmjs.com/package/@openbone/pixi)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package plays OpenBone documents inside a PixiJS v8
scene, with state machines, pointer listeners, events, skins, scripts and sound. Playback comes from
[`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit) and
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime); drawing uses Pixi meshes built from the same
batches as the reference renderer, [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl).
For a page without Pixi, use [`@openbone/player`](https://www.npmjs.com/package/@openbone/player).

## Install

```bash
npm install @openbone/pixi pixi.js
```

`pixi.js` v8 is a peer dependency (`^8.0.0`).

## Quick start

```ts
import { Application } from "pixi.js";
import { OpenBone, loadOpenBone } from "@openbone/pixi";

const app = new Application();
await app.init({ preference: "webgl", width: 900, height: 600, background: "#1b1e24" });
document.body.appendChild(app.canvas);

// Loads the document, its images (atlas pages when packed) and, when it has scripts, the script sandbox.
const knight = await OpenBone.from("/knight.obone", { stateMachine: "knight" });
knight.position.set(knight.asset.doc.originX, knight.asset.doc.originY); // skeleton origin, in stage pixels
app.stage.addChild(knight);

knight.setInput("walk", true);
knight.onOpenBone("stateChange", (e) => console.log(e.layer, e.from, "->", e.to));
knight.onOpenBone("event", (e) => console.log("event", e.name));
setTimeout(() => knight.fire("attack"), 500);

// Load once, then make several copies that share the textures.
const asset = await loadOpenBone("/button.obone");
for (let i = 0; i < 2; i++) {
  const button = await OpenBone.from(asset);
  button.scale.set(0.5);
  button.position.set(100 + i * 250 + asset.doc.originX * 0.5, 20 + asset.doc.originY * 0.5);
  app.stage.addChild(button);
}
```

`knight.obone` and `button.obone` are in the repository's `examples/` folder. The container's position is the
skeleton origin; at scale 1, one skeleton unit is one pixel, with y down like the rest of Pixi.

## API

| Export | |
|---|---|
| `OpenBone` | The display object (a `Container`). `await OpenBone.from(src, options)` loads and creates it. |
| `loadOpenBone(src, options)` | Loads a document and its textures into an `OpenBoneAsset` that many objects can share. |
| `OpenBoneAsset` | `{ doc, baseUrl, textures }` (Pixi textures by image or atlas page id). |
| `OpenBoneOptions`, `LoadOptions`, `DriverOptions`, `InputValue`, `OpenBoneSource` | Option and value types. |
| `BatchMesh`, `PIXI_BLEND` | The mesh class used per batch, and the blend mode mapping. |

`src` is a URL, bytes (`ArrayBuffer` or `Uint8Array` of a `.obone` or `.obonb` file), a parsed document or, for
`OpenBone.from`, an `OpenBoneAsset`.

### Options

| Option | Default | |
|---|---|---|
| `stateMachine` / `animation` / `loop` | first state machine, else first animation | What to run. |
| `skin` | default skin | Skin (outfit) by name or id. |
| `scripts` | `"quickjs"` when the document has scripts | `"none"` or your own `ScriptHost`. |
| `audio` | `true` | `false` or `"muted"`. |
| `audioContext`, `audioBaseUrl`, `resolveAudioUrl`, `unlockTarget` | | Sound setup (see engine-kit). |
| `onEvent`, `onStateChange` | | Callbacks. |
| `autoUpdate` | `true` | Advance on a Pixi ticker. Set `false` and call `update(dt)` (seconds) yourself. |
| `ticker` | `Ticker.shared` | The ticker used when `autoUpdate` is on. |
| `interactive` | `true` | Route Pixi pointer events to the state machine. |
| `resolution` | `devicePixelRatio` | Pixel ratio that text is rasterised at. |
| `baseUrl`, `fetch` (loading) | the document's folder | Where relative image and audio paths load from, and the fetch to use. |
| `resolveImageUrl(src)` (loading) | | Map an image path to the URL to load. |

### Methods and properties

| Member | |
|---|---|
| `setInput(name, value)`, `getInput(name)`, `fire(name)` | State machine inputs and triggers. |
| `play(animation, loop?)`, `useStateMachine(name?)` | Switch to an animation or a state machine. |
| `setSkin(name)`, `setText(slot, text)` | Outfit, and text for a slot's text attachment (`null` restores it). |
| `pause()`, `resume()`, `paused`, `speed` | Playback. Pausing also pauses sounds; `speed` changes their rate too. |
| `update(dt)`, `redraw()` | Advance and rebuild the meshes; rebuild only (after changing the pose by hand). |
| `onOpenBone(name, fn)` | Listen to `"event"`, `"stateChange"` or `"audio"`. Returns an unsubscribe function. |
| `artboard` | The artboard rectangle in the container's space (y down). |
| `drawCalls` | Batches drawn in the last update. |
| `driver`, `instance`, `skeleton`, `stateMachine`, `asset` | Lower-level access. |
| `destroy()` | Stops ticking, stops sounds and frees text and particle textures. Shared asset textures are kept. |

### Pointer input

With a state machine and `interactive` on, the object listens to `pointerdown`, `pointerup`, `pointerupoutside` and
`globalpointermove`, with the artboard as hit area. Points are converted to skeleton space for the state machine's
listeners. Moving off the artboard ends hovers.

### Sound and scripts

Sounds play with Web Audio and unlock on the first click or key press. Documents with scripts load the QuickJS
sandbox in `OpenBone.from`. If you use Vite, exclude `quickjs-emscripten` from dependency pre-bundling
(`optimizeDeps: { exclude: ["quickjs-emscripten"] }`) so it finds its `.wasm` file, as the repository's demo does.

## How it draws

Each frame the pose is grouped into render-webgl's batches (one per texture or atlas page and blend mode). Each batch
is one `Mesh` with a small vertex-coloured shader, so meshes, weights, tints, per-vertex particle colours and sprite
sequences look as in the editor. Batches with a two-colour tint (a slot `dark` colour) switch to a second shader with
a per-vertex dark colour; other batches never upload it. Premultiplied atlas pages are uploaded as they are; other
images are premultiplied on upload.

- **Clipping** masks become stencil masks (`Graphics`).
- **Blend modes** map to Pixi's `normal`, `add`, `multiply` and `screen`, which use the same GL blend functions.
- **Text** attachments are rasterised to canvas textures. **Particles** use the built-in soft sprite.
- Pack an atlas when exporting for the fewest draw calls (`drawCalls`).

The shader is GLSL, so use Pixi's WebGL renderer (`preference: "webgl"`, Pixi's default).

## Demo

From a checkout: `pnpm --filter @openbone/examples engines`, then open http://localhost:5190/pixi/ (add
`?example=campfire`, `rocket`, `crash`… for other examples).

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model and rendering
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Demo source](https://github.com/UXCentury/open-bone/blob/main/examples/engines/pixi/main.ts)
- Related packages: [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit),
  [`@openbone/phaser`](https://www.npmjs.com/package/@openbone/phaser),
  [`@openbone/three`](https://www.npmjs.com/package/@openbone/three),
  [`@openbone/canvaskit`](https://www.npmjs.com/package/@openbone/canvaskit),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
