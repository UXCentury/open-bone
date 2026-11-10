# @openbone/render-webgl

Batched WebGL2 renderer for OpenBone skeletons, with stencil clipping, blend modes and two-colour tint.

[![npm](https://img.shields.io/npm/v/@openbone/render-webgl)](https://www.npmjs.com/package/@openbone/render-webgl)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package draws a skeleton posed by
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime) on a WebGL2 canvas. It is the reference
renderer: the editor viewport and [`@openbone/player`](https://www.npmjs.com/package/@openbone/player) use it, and the
engine packages ([`@openbone/pixi`](https://www.npmjs.com/package/@openbone/pixi),
[`phaser`](https://www.npmjs.com/package/@openbone/phaser), [`three`](https://www.npmjs.com/package/@openbone/three),
[`canvaskit`](https://www.npmjs.com/package/@openbone/canvaskit)) reproduce its batches and blending. Use it directly
when you own the canvas and the render loop; otherwise the player is simpler.

## Install

```bash
npm install @openbone/render-webgl @openbone/runtime @openbone/core
```

Needs a browser (or any environment) with WebGL2. There are no peer dependencies.

## Quick start

```ts
import { parseDocument, textureAssets } from "@openbone/core";
import { WebGLRenderer } from "@openbone/render-webgl";
import { OpenBoneInstance } from "@openbone/runtime";

const url = "/knight.obone";
const doc = parseDocument(new Uint8Array(await (await fetch(url)).arrayBuffer()));

// Load every texture (atlas pages when packed, otherwise loose images), keyed by id.
const images = new Map<string, HTMLImageElement>();
await Promise.all(
  textureAssets(doc).map(async (t) => {
    const img = new Image();
    img.src = new URL(t.src, new URL(url, location.href)).href;
    await img.decode();
    images.set(t.id, img);
  }),
);

const knight = new OpenBoneInstance(doc);
knight.useStateMachine("knight");
knight.stateMachine!.setInput("walk", true);

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!; // e.g. width="900" height="600"
const renderer = new WebGLRenderer(canvas, (id) => images.get(id));
const zoom = canvas.width / doc.width; // fit the artboard to the drawing buffer

let last = performance.now();
requestAnimationFrame(function frame(now) {
  knight.advance(Math.min(0.1, (now - last) / 1000));
  last = now;
  renderer.render(knight.skeleton, { x: 0, y: 0, zoom }, [0, 0, 0, 0]);
  requestAnimationFrame(frame);
});
```

`examples/knight.obone` in the repository has a `knight` state machine with a `walk` input. This code does not route
pointer events or play sounds; see [`@openbone/player`](https://www.npmjs.com/package/@openbone/player) for code that
does.

## API

The package exports one class, `WebGLRenderer`.

| Member | |
|---|---|
| `new WebGLRenderer(canvas, images)` | `canvas`: an `HTMLCanvasElement` or `OffscreenCanvas`. `images(id)` returns an image, canvas, bitmap or other `TexImageSource` for an image id or atlas page id. Throws `"WebGL2 not available"` when no context can be created. |
| `render(skeleton, view?, clearColor?)` | Draws one frame. `view` is `{ x, y, zoom }` in drawing-buffer pixels: the artboard's top-left lands at (`x`, `y`), scaled by `zoom`. `clearColor` is premultiplied RGBA in 0..1 (default transparent); `null` draws without clearing. |
| `drawCalls` | Draw calls issued by the last `render()`, clip-mask stencil writes included. |
| `invalidate(id?)` | Forget one cached texture (after an image changed), or all of them. |
| `dispose()` | Delete textures, buffers and the shader program. |
| `gl`, `canvas`, `images` | The WebGL2 context and the constructor arguments. |

Textures upload on first use and are cached by id. A missing texture draws in solid white. The view is in
drawing-buffer pixels, so multiply by `devicePixelRatio` yourself when the canvas is sized for a high-DPI screen.

## How it draws

- **Batching**: consecutive draw items share one draw call while their texture and blend mode stay the same. Packed
  images and shapes live on the same atlas page (shapes use its white block), so a packed rig usually draws in a few
  calls. A batch also ends at a clipping mask change, around each text item, and at 16,384 vertices (16-bit indices).
- **Premultiplied alpha**: the context is created with `premultipliedAlpha: true` and output is premultiplied.
  Straight-alpha images are premultiplied on upload; atlas pages exported as premultiplied are uploaded as they are.
- **Blend modes** (premultiplied): `normal` is `ONE, ONE_MINUS_SRC_ALPHA`, `additive` is `ONE, ONE`, `multiply` is
  `DST_COLOR, ONE_MINUS_SRC_ALPHA`, `screen` is `ONE, ONE_MINUS_SRC_COLOR`.
- **Clipping**: each clipping mask's polygon is written into the stencil buffer (the context asks for one), and the
  slots it covers draw only where it is set.
- **Two-colour tint**: every vertex carries a light colour and a dark rgb. The fragment shader computes
  `rgb = dark + (light - dark) × texture rgb`; with a black dark colour this is the usual multiply tint.
- **Vertex colours**: particles and meshes with per-vertex colours keep them.
- **Text** attachments are rasterised into textures with a 2D canvas, redrawn only when the content or pixel scale
  changes, and dropped about 60 frames after they stop showing. **Particles** use a built-in soft round sprite.

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model and rendering
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md): documents, images and atlases
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md): the draw list a renderer consumes
- Related packages: [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player),
  [`@openbone/engine-kit`](https://www.npmjs.com/package/@openbone/engine-kit)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
