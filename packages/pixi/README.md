# @openbone/pixi

[OpenBone](../../README.md) runtime for **PixiJS v8**: an OpenBone document as a Pixi `Container`, with state machines, pointer listeners, events, skins and sound.

## Install

```bash
npm install @openbone/pixi pixi.js
```

`pixi.js` (v8, MIT) is a peer dependency.

## Use

```ts
import { Application } from "pixi.js";
import { OpenBone } from "@openbone/pixi";

const app = new Application();
await app.init({ preference: "webgl", resizeTo: window });
document.body.appendChild(app.canvas);

// Loads the document, its images (relative to the file, or atlas pages when packed) and, if needed, the script sandbox.
const hero = await OpenBone.from("hero.obone", { stateMachine: "character" });
hero.position.set(400, 500); // the skeleton origin
app.stage.addChild(hero);

hero.setInput("speed", 1);
hero.fire("jump");
hero.onOpenBone("event", (e) => console.log(e.name));
```

The object advances itself on `Ticker.shared` (pass `autoUpdate: false` and call `hero.update(dt)` to drive it yourself). Pointer events over the artboard (`hero.artboard`) go to the state machine's listeners (`interactive: false` turns that off). Load once and share: `const asset = await loadOpenBone(url)` then `OpenBone.from(asset)` for each copy.

| Option | |
|---|---|
| `stateMachine` / `animation` / `loop` | What to run (default: the first state machine, else the first animation). |
| `skin` | Outfit by name or id; `setSkin()` switches later. |
| `scripts` | `"quickjs"` (default when the document has scripts), `"none"` or your own `ScriptHost`. |
| `audio` | `true` (default), `false` or `"muted"`. Sounds play with Web Audio after the first click or key press. |
| `baseUrl`, `resolveImageUrl` | Where relative image and audio paths load from. |
| `resolution` | Pixel ratio text is rasterised at (default `devicePixelRatio`). |

## How it draws

Each frame the pose is grouped into the same batches as `@openbone/render-webgl` (one per texture or atlas page and blend mode), and each batch is one `Mesh` with a small vertex-coloured shader, so meshes, weights, tints, per-vertex particle colours and sprite sequences look exactly as in the editor. Batches with a two-colour tint (a slot `dark` colour) switch to a second shader with a per-vertex dark colour; the others never upload it. Clipping masks become stencil masks (`Graphics`), blend modes map to Pixi's `normal`/`add`/`multiply`/`screen`, text attachments are rasterised to canvas textures, and particles use the built-in soft sprite. Pack an atlas when exporting for the fewest draw calls (`hero.drawCalls`).

The shader is GLSL, so use the WebGL renderer (`preference: "webgl"`, Pixi's default).

## Demo

`pnpm --filter @openbone/examples engines`, then open http://localhost:5190/pixi/ (add `?example=campfire`, `rocket`, `crash`… for other examples).

MIT.
