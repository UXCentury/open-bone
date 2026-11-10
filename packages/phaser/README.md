# @openbone/phaser

OpenBone runtime for Phaser 3: a scene plugin, a loader file type and a GameObject.

[![npm](https://img.shields.io/npm/v/@openbone/phaser)](https://www.npmjs.com/package/@openbone/phaser)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package plays OpenBone documents in Phaser 3 games,
with state machines, pointer listeners, events, skins, scripts and sound, on both the WebGL and the Canvas renderer.
Playback comes from [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit); WebGL drawing
streams the same batches as [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl) into
Phaser's pipeline, and Canvas drawing uses [`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas).

## Install

```bash
npm install @openbone/phaser phaser@3
```

`phaser` is a peer dependency (`>=3.60.0 <4`).

## Quick start

```ts
import * as Phaser from "phaser";
import { type OpenBoneGameObject, OpenBonePlugin } from "@openbone/phaser";

class Level extends Phaser.Scene {
  declare openbone: OpenBonePlugin; // the scene plugin, under its mapping
  knight!: OpenBoneGameObject;

  preload() {
    // .obone or .obonb; images load relative to the file (atlas pages when packed).
    this.load.openbone("knight", "/knight.obone");
  }

  create() {
    const doc = this.openbone.get("knight")!.doc;
    // x, y is the skeleton origin: here the artboard fills the 900 × 600 game.
    this.knight = this.add.openbone(doc.originX, doc.originY, "knight", { stateMachine: "knight" });
    this.knight.setInput("walk", true).fire("attack");
    this.knight.onOpenBone("stateChange", (e) => console.log(e.layer, e.from, "->", e.to));
    this.knight.onOpenBone("event", (e) => console.log("event", e.name));
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: 900,
  height: 600,
  plugins: { scene: [{ key: "OpenBonePlugin", plugin: OpenBonePlugin, mapping: "openbone" }] },
  scene: Level,
});
```

`knight.obone` is in the repository's `examples/` folder; its `knight` state machine has a `walk` input and `attack`
and `salute` triggers. Registering the plugin adds `this.load.openbone` and `this.add.openbone` (typed through global
declarations when you import the package).

## API

| Export | |
|---|---|
| `OpenBonePlugin` | Scene plugin. Registers the `openbone` loader file type and game object factory. `get(key)` returns the loaded `OpenBoneCacheEntry`. |
| `OpenBoneGameObject` | The game object created by `this.add.openbone`. |
| `OpenBoneFile`, `OpenBoneFileConfig` | The loader file type and its options. |
| `OpenBoneCacheEntry` | `{ doc, baseUrl, textureKeys, scriptHost? }`, stored in `this.cache.custom.openbone`. |
| `OpenBoneObjectOptions`, `DriverOptions`, `InputValue` | Option and value types. |
| `CACHE_KEY`, `textureKey(fileKey, id)` | The cache name and the Phaser texture key used for each image or atlas page. |
| `DARK_PIPELINE`, `twoColorPipeline(renderer)`, `TwoColorPipeline` | The two-colour tint pipeline (registered automatically when needed). |

### Loading: `this.load.openbone(key, url, config?)`

| Config | Default | |
|---|---|---|
| `baseUrl` | the document's folder | Base for relative image and audio paths. |
| `resolveImageUrl(src)` | | Map an image path to the URL to load. |
| `scripts` | `true` | Load the QuickJS sandbox while preloading when the document has scripts. `false` skips it. |
| `xhrSettings` | | Phaser XHR settings for the document request. |

The document's images (or atlas pages) are queued on the same loader, so `create()` runs after they have loaded.

### Adding: `this.add.openbone(x, y, key, options?)`

| Option | Default | |
|---|---|---|
| `stateMachine` / `animation` / `loop` | first state machine, else first animation | What to run. |
| `skin` | default skin | Skin (outfit) by name or id. |
| `audio` | `true` | `false` or `"muted"`. |
| `scripts` | the sandbox loaded with the file | `"none"` or your own `ScriptHost`. |
| `interactive` | `true` | Route the scene's pointer events to the state machine. |
| `audioContext`, `audioBaseUrl`, `resolveAudioUrl`, `unlockTarget`, `onEvent`, `onStateChange` | | As in engine-kit. Sounds use Phaser's own `AudioContext` by default. |

### Methods and properties

| Member | |
|---|---|
| `setInput(name, value)`, `getInput(name)`, `fire(name)` | State machine inputs and triggers. |
| `play(animation, loop?)`, `useStateMachine(name?)` | Switch to an animation or a state machine. |
| `setSkin(name)`, `setText(slot, text)` | Outfit, and text for a slot's text attachment (`null` restores it). |
| `pause()`, `resume()`, `paused`, `speed` | Playback; pausing also pauses sounds. |
| `onOpenBone(name, fn)` | Listen to `"event"`, `"stateChange"` or `"audio"`. Returns an unsubscribe function. |
| `artboard` | The artboard rectangle in local space (y down). |
| `boundingBoxes()`, `worldToSkeleton(x, y)`, `skeletonToWorld(x, y)` | Bounding-box queries in skeleton space (y up), and conversion from / to Phaser world coordinates: `const w = cam.getWorldPoint(p.x, p.y); obj.boundingBoxes().containsPoint(...obj.worldToSkeleton(w.x, w.y))`. |
| `batches` | Batches drawn in the last WebGL frame. |
| `driver`, `instance`, `skeleton`, `stateMachine` | Lower-level access. |
| `destroy()` | Unbinds pointer handlers, stops sounds and removes its text textures. |

`setInput`, `fire`, `setText`, `setSkin`, `play`, `pause` and `resume` return the object, so calls chain. The object
also has Phaser's Alpha, BlendMode, ComputedSize, Depth, Pipeline, ScrollFactor, Transform and Visible components: its
x/y is the skeleton origin, and position, rotation, scale, depth, alpha, visibility and scroll factor work as on any
GameObject. It advances in the scene's update.

### Pointer input

With a state machine and `interactive` on, the object listens to the scene's `pointerdown`, `pointerup` and
`pointermove`. Pointers over its artboard (through the camera and the object's transform) reach the state machine's
listeners; moving off the artboard ends hovers. Hidden or inactive objects ignore pointers.

## How it draws

- **WebGL**: the pose is grouped into render-webgl's batches and streamed into Phaser's MultiPipeline, which can merge
  several textures into one draw call. Vertex colours use Phaser's tint (8 bits per channel). Batches with a
  two-colour tint (a slot `dark` colour) go through `OpenBoneTwoColorPipeline`, a MultiPipeline with a second packed
  colour per vertex, registered on the renderer the first time it is needed. Blend modes map to Phaser's (additive is
  registered as `ONE, ONE` like the reference renderer). Clipping masks write the stencil buffer, so an OpenBone
  object with clipping should not itself be inside a Phaser geometry mask. Text is rasterised to canvas textures;
  particles use the built-in soft sprite.
- **Canvas** (`type: Phaser.CANVAS`): drawn by `@openbone/render-canvas` in the object's transform.
- **Premultiplied atlas pages** are replaced once by straight-alpha copies in Phaser's texture manager, because Phaser
  premultiplies on upload and its Canvas renderer expects straight alpha.

## Demo

From a checkout: `pnpm --filter @openbone/examples engines`, then open http://localhost:5190/phaser/ (`?canvas` for
the Canvas renderer, `?example=campfire` for other examples).

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model and rendering
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Demo source](https://github.com/UXCentury/open-bone/blob/main/examples/engines/phaser/main.ts)
- Related packages: [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit),
  [`@openbone/pixi`](https://www.npmjs.com/package/@openbone/pixi),
  [`@openbone/three`](https://www.npmjs.com/package/@openbone/three),
  [`@openbone/canvaskit`](https://www.npmjs.com/package/@openbone/canvaskit),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
