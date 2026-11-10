# @openbone/render-canvas

Canvas 2D renderer for OpenBone skeletons, in the browser or headless in Node.

[![npm](https://img.shields.io/npm/v/@openbone/render-canvas)](https://www.npmjs.com/package/@openbone/render-canvas)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package draws a skeleton posed by
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime) to any `CanvasRenderingContext2D`: a browser
canvas, an `OffscreenCanvas`, or a headless canvas such as [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas)
in Node. The OpenBone editor, MCP server and CLI use it for previews and PNG/GIF exports, and
[`@openbone/player`](https://www.npmjs.com/package/@openbone/player) falls back to it without WebGL2. It also packs
atlases. For the fastest browser drawing, use [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl).

## Install

```bash
npm install @openbone/render-canvas @openbone/runtime @openbone/core
```

`@openbone/core` loads documents and `@openbone/runtime` poses them. For Node, add a canvas implementation:

```bash
npm install @napi-rs/canvas
```

## Quick start: a PNG in Node

```ts
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Image, createCanvas, loadImage } from "@napi-rs/canvas";
import { parseDocument, textureAssets } from "@openbone/core";
import { CanvasRenderer, type Ctx2D } from "@openbone/render-canvas";
import { OpenBoneInstance } from "@openbone/runtime";

const file = process.argv[2] ?? "knight.obone";
const doc = parseDocument(new Uint8Array(await readFile(file))); // .obone (JSON) or .obonb (binary)

// Images (or atlas pages when the document is packed), keyed by id. Relative paths are relative to the file.
const images = new Map<string, Image>();
for (const t of textureAssets(doc)) {
  const src = /^(data:|https?:)/.test(t.src) ? t.src : path.resolve(path.dirname(file), t.src);
  images.set(t.id, await loadImage(src));
}

// Pose the skeleton: one second into the "walk" animation.
const knight = new OpenBoneInstance(doc);
knight.play("walk");
knight.advance(0);
for (let i = 0; i < 60; i++) knight.advance(1 / 60);

const scale = 0.5;
const canvas = createCanvas(Math.round(doc.width * scale), Math.round(doc.height * scale));
const renderer = new CanvasRenderer(canvas.getContext("2d") as unknown as Ctx2D, (id) => images.get(id) as unknown as CanvasImageSource);
renderer.render(knight.skeleton, { view: { x: 0, y: 0, zoom: scale } });
await writeFile("knight.png", canvas.toBuffer("image/png"));
```

Run it on `examples/knight.obone` from the repository to get a 450 × 300 PNG of the knight mid-stride. Advance in
small steps, as here, so physics constraints settle the way they do in real playback.

## In the browser

```ts
import { parseDocument, textureAssets } from "@openbone/core";
import { CanvasRenderer } from "@openbone/render-canvas";
import { OpenBoneInstance } from "@openbone/runtime";

const doc = parseDocument(new Uint8Array(await (await fetch("/knight.obone")).arrayBuffer()));
const images = new Map<string, HTMLImageElement>();
await Promise.all(
  textureAssets(doc).map(async (t) => {
    const img = new Image();
    img.src = `/${t.src}`; // paths in the file are relative to it
    await img.decode();
    images.set(t.id, img);
  }),
);

const knight = new OpenBoneInstance(doc);
knight.play("idle");

const canvas = document.querySelector<HTMLCanvasElement>("#c2d")!;
const renderer = new CanvasRenderer(canvas.getContext("2d")!, (id) => images.get(id));
const zoom = canvas.width / doc.width;

let last = performance.now();
requestAnimationFrame(function frame(now) {
  knight.advance(Math.min(0.1, (now - last) / 1000));
  last = now;
  renderer.render(knight.skeleton, { view: { x: 0, y: 0, zoom } }); // clears, fills the background, draws
  requestAnimationFrame(frame);
});
```

If you only need playback on a page, [`@openbone/player`](https://www.npmjs.com/package/@openbone/player) does all
of this (plus input, sound and scripts) for you.

## API

| Export | |
|---|---|
| `CanvasRenderer` | `new CanvasRenderer(ctx, images)`; `render(skeleton, options?)`. |
| `CanvasRenderOptions` | Options for `render`, below. |
| `ImageResolver` | `(id) => image`: returns the image or atlas page for a texture id. Missing ones draw as a translucent purple placeholder. |
| `Ctx2D`, `ImageSource` | Types of the context and image sources it accepts. |
| `buildAtlas(doc, options, env)` | Packs every image of a document into atlas pages (PNG `data:` URIs), as the editor, MCP server and CLI do. `env` supplies `createCanvas`, `load` and `encodePng`. |
| `drawAtlasPage`, `drawRegionFromPage`, `particleImages` | Lower-level atlas helpers used by `buildAtlas`. |
| `straightAlphaCopy(img, makeCanvas)` | A straight-alpha copy of a premultiplied image. |

`images` is called with image ids for loose images and with atlas page ids for packed documents.
`textureAssets(doc)` from `@openbone/core` lists exactly the ids and paths to load.

### Render options

| Option | Default | |
|---|---|---|
| `view` | `{ x: 0, y: 0, zoom: 1 }` | Artboard to canvas transform: the artboard's top-left lands at (`x`, `y`) in canvas pixels, scaled by `zoom`. |
| `clear` | `true` | Clear the canvas and fill the background first. Pass `false` to draw over what is there. |
| `background` | the document's | A CSS colour for the artboard rectangle; `null` for none. |
| `bones`, `paths`, `boundingBoxes`, `wireframe`, `selectedBone` | off | Editor overlays. `paths` defaults to `bones`. |
| `slotAlpha(slotId)` | | Per-slot opacity multiplier; `0` skips the slot. |

`renderer.convertPremultiplied` (default `true`) controls the premultiplied-atlas conversion described below.

### Animated GIFs

There is no GIF encoder in this package. Render frames in a loop (advance by `1 / fps`, call `render`, read
`ctx.getImageData`) and pass the pixels to an encoder of your choice. The OpenBone MCP server does this with
[`gifenc`](https://www.npmjs.com/package/gifenc).

## How it draws

- **Meshes and regions** are drawn as textured triangles, one affine image transform per triangle. Shapes are paths.
- **Blend modes**: `normal`, `additive`, `multiply` and `screen` map to `source-over`, `lighter`, `multiply` and
  `screen`.
- **Clipping**: a clipping mask becomes a clip path for the slots it covers.
- **Tint**: slot colours are applied with cached tinted copies of each image (colours are quantised to 1/64, so an
  animated tint reuses a few copies). Two-colour tint (a slot `dark` colour) maps each channel from the dark colour
  to the light one per pixel. It needs readable pixels: a cross-origin image without CORS falls back to the plain tint.
- **Premultiplied alpha**: a 2D canvas composites straight alpha only, so premultiplied atlas pages are converted to
  straight-alpha copies once, before drawing.
- **Text and particles**: text attachments are drawn with the canvas text API; particles use a soft radial sprite.

Canvas 2D is slower than WebGL for large rigs. Each triangle's clip is grown slightly to hide seams, but faint lines
can still show at some scales.

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model and rendering
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md): documents, images and atlases
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md): the draw list
- Related packages: [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/core`](https://www.npmjs.com/package/@openbone/core),
  [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
