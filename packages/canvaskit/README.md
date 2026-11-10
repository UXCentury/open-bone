# @openbone/canvaskit

[OpenBone](https://github.com/UXCentury/open-bone#readme) runtime for **CanvasKit** (Skia compiled to WebAssembly): a renderer for any CanvasKit canvas (browser WebGL or software surfaces, or headless in Node) and a small player with state machines, pointer listeners, events, skins and sound.

## Install

```bash
npm install @openbone/canvaskit canvaskit-wasm
```

`canvaskit-wasm` (BSD-3-Clause) is a peer dependency.

## Use

In a page:

```ts
import CanvasKitInit from "canvaskit-wasm";
import { CanvasKitPlayer } from "@openbone/canvaskit";

const ck = await CanvasKitInit({ locateFile: (f) => `/canvaskit/${f}` });
const player = await CanvasKitPlayer.create(ck, document.querySelector("canvas")!, "hero.obone", { stateMachine: "character" });
player.setInput("speed", 1);
player.on("event", (e) => console.log(e.name));
```

On your own surface (or in Node, e.g. to render frames on a server):

```ts
import { CanvasKitRenderer, loadOpenBone } from "@openbone/canvaskit";
import { OpenBoneInstance } from "@openbone/runtime";

const asset = await loadOpenBone(ck, "https://cdn.example.com/hero.obone"); // images decoded by Skia
const hero = new OpenBoneInstance(asset.doc);
hero.useStateMachine();
const renderer = new CanvasKitRenderer(ck, (id) => asset.images.get(id));

hero.advance(1 / 60);
const canvas = surface.getCanvas();
canvas.clear(ck.TRANSPARENT);
renderer.render(canvas, hero, { x: 0, y: 0, zoom: 1 }); // artboard pan/zoom; the canvas's matrix applies on top
surface.flush();
```

`CanvasKitPlayer` options: `stateMachine`, `animation`, `skin`, `scripts`, `audio`, `fit` (`contain`/`cover`/`none`), `background` (default the document's, `null` for transparent), `surface` (`"webgl"` or `"software"`), `autoplay`, `fonts`. Call `player.resize()` after the canvas changes size.

## How it draws

One `drawVertices` per `@openbone/render-webgl` batch: positions, texture coordinates (scaled to the image), per-vertex colours modulating the image shader, so meshes, weights, tints, sequences and particles match the reference renderer. Slots with a two-colour tint (`dark`) draw through a colour-matrix filter (`rgb = dark + (light − dark) × rgb`), one `drawVertices` per run of items with the same light and dark colour; batches without one are untouched. Blend modes map to Skia's `SrcOver`, `Plus`, `Multiply` and `Screen`; clipping masks are clip paths (anti-aliased). Text attachments are drawn by Skia when you pass `fonts: (family, weight) => typeface`, otherwise rasterised with a 2D canvas where one exists.

## Demo

`pnpm --filter @openbone/examples engines`, then open http://localhost:5190/canvaskit/ (`?example=campfire`, `rocket`, `crash`…).

MIT. CanvasKit is © Google, BSD-3-Clause.
