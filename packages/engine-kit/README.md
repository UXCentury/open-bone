# @openbone/engine-kit

Shared loading, playback and draw batching for the OpenBone game-engine runtimes.

[![npm](https://img.shields.io/npm/v/@openbone/engine-kit)](https://www.npmjs.com/package/@openbone/engine-kit)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package holds the engine-independent half of
[`@openbone/pixi`](https://www.npmjs.com/package/@openbone/pixi),
[`@openbone/phaser`](https://www.npmjs.com/package/@openbone/phaser),
[`@openbone/three`](https://www.npmjs.com/package/@openbone/three) and
[`@openbone/canvaskit`](https://www.npmjs.com/package/@openbone/canvaskit): loading a document, finding its textures,
driving playback (animations, state machines, pointer listeners, events, scripts, sound) and grouping each frame's
draw list into the same draw calls as the reference renderer,
[`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl).

**You only need it to integrate OpenBone with an engine that has no package yet.** To play animations in one of the
engines above, install that engine's package instead.

## Install

```bash
npm install @openbone/engine-kit
```

It depends on `@openbone/core`, `@openbone/runtime`, `@openbone/scripting` (the QuickJS sandbox, loaded only for
documents with scripts) and `@openbone/player` (for its Web Audio backend). There are no peer dependencies.

## Quick start

The steps every integration follows. This runs as is in Node; in an engine, step 4 runs every frame and each batch
becomes one engine draw call.

```ts
import { readFile } from "node:fs/promises";
import { OpenBoneDriver, buildBatches, loadDocument, textureRequests, tintRuns } from "@openbone/engine-kit";

// 1. Load: a URL (fetched), bytes (.obone or .obonb) or a parsed document.
const { doc, baseUrl } = await loadDocument(await readFile("knight.obone"), { baseUrl: "https://cdn.example.com/knight/" });

// 2. The textures your engine must load, keyed by id (atlas pages when packed, otherwise loose images).
const textures = textureRequests(doc, baseUrl);
console.log(textures.slice(0, 2)); // [{ id, url, width, height }, ...]

// 3. Playback: one driver per object. It owns the OpenBoneInstance, the state machine and Web Audio.
const driver = await OpenBoneDriver.create(doc, baseUrl, { stateMachine: "knight", audio: false });
driver.on("stateChange", (e) => console.log(e.layer, e.from, "->", e.to));
driver.setInput("walk", true);

// 4. Every frame: advance, then turn the draw list into draw calls.
driver.advance(1 / 60);
const loaded = new Set(textures.map((t) => t.id)); // ids your engine actually has
const batches = buildBatches(driver.instance.drawList(), { hasTexture: (id) => loaded.has(id) });
for (const b of batches) {
  // b.texture (id or null = white), b.blend, b.clip, b.vertices, b.uvs, b.colors, b.indices, b.dark?
  if (b.dark) for (const run of tintRuns(b)) void run; // engines without a second vertex colour
}
console.log(`${batches.length} batches, first: ${batches[0].texture} ${batches[0].blend} ${batches[0].indices.length / 3} triangles`);
driver.dispose();
```

With `examples/knight.obone` from the repository this prints the first two texture URLs, the state change to `walk`
and the batch count.

## API

### Loading

| Export | |
|---|---|
| `loadDocument(src, { baseUrl?, fetch? })` | `src` is a URL, `URL`, `ArrayBuffer`, `Uint8Array` or parsed document. Detects JSON or binary from the bytes. Returns `{ doc, baseUrl }`: the folder relative image and audio paths resolve against (the document URL's folder by default, `""` for bytes). |
| `textureRequests(doc, baseUrl, resolve?)` | Every texture to load as `{ id, url, width, height }`: atlas pages when packed, otherwise images with a source. |
| `loadTextures(doc, baseUrl, { load?, resolveImageUrl? })` | Loads them all into a `Map` by id with `load(url, request)` (default: `<img>` elements). Failed loads are left out. |
| `loadImageElement(url, crossOrigin?)` | One `<img>`, resolving to `null` on error. |
| `resolveAssetUrl(src, baseUrl)`, `folderOf(url)` | URL helpers. |

### Playback: `OpenBoneDriver`

`await OpenBoneDriver.create(doc, baseUrl, options)` loads the script sandbox when the document has scripts.
`OpenBoneDriver.createSync(doc, baseUrl, options)` skips it; pass your own host in `scripts` or scripts do not run.

| Option | |
|---|---|
| `stateMachine`, `animation`, `loop`, `skin` | What to run (default: the first state machine, else the first animation) and wear. |
| `scripts` | `"quickjs"` (default when the document has scripts), `"none"` or a `ScriptHost`. |
| `audio` | `true` (default), `false` or `"muted"`. |
| `audioContext` | Share the engine's `AudioContext`. |
| `audioBaseUrl`, `resolveAudioUrl` | Where sounds load from (default: the document's base URL). |
| `unlockTarget` | Where the first click or key press unlocks audio (default `window`). |
| `onEvent`, `onStateChange` | Callbacks. |

Members: `advance(dt)` (scaled by `speed`), `refresh()` (re-pose without advancing), `setInput`, `getInput`, `fire`,
`setText`, `setSkin`, `skins`, `animations`, `play(animation, loop?, track?)`, `useStateMachine(name?)`,
`pointer(type, x, y)` in skeleton space (y up), `pointerLeave()` (ends hovers), `on("event" | "stateChange" |
"audio", fn)` (returns an unsubscribe function), `pause()` / `resume()` / `setMuted()` (sound only: stop calling
`advance` to freeze time), `instance`, `skeleton`, `stateMachine`, `audio` and `dispose()`.

`setEngineScriptHostFactory(factory)` replaces how `create` makes the sandbox, for example to supply a bundled
QuickJS build.

### Drawing

| Export | |
|---|---|
| `buildBatches(drawList, { hasTexture?, maxVertices?, maxIndices? })` | Groups `instance.drawList()` into `Batch`es exactly where render-webgl flushes: on a texture or blend change, a clipping mask change, around every text item, and at 16,384 vertices. Textures for which `hasTexture` returns false batch as solid white, as in render-webgl. |
| `Batch` | `texture` (id, atlas page id, `PARTICLE_DOT_TEXTURE` or `null` for white), `blend`, `clip` (the same object for consecutive batches under one mask), `vertices` (skeleton space, y up), `uvs` (0..1, v down), `colors` (straight RGBA per vertex), `indices`, `items`, `dark` (rgb per vertex, only when a slot in the batch has a dark colour) and, for text items, `text`. |
| `tintRuns(batch)`, `tintMatrix(light, dark)` | For engines without a second vertex colour: split a two-colour batch into runs with one flat tint, and the tint as a 4 × 5 colour matrix. |
| `forEachTriangleVertex(batch, fn)` | Expands indexed triangles for engines that batch unindexed ones. |
| `premultiply(r, g, b, a)`, `darkOf(item)` | Colour helpers. |
| `TextRasterizer` | Draws text attachments into canvases, cached per slot, redrawn only when content or pixel scale changes. Call `nextFrame()` once per frame; it returns ids to free. |
| `textQuad`, `textPad`, `textId`, `MAX_TEXT_TEXTURE` | Text geometry helpers, as render-webgl uses them. |
| `particleDotPixels(premultiplied?)`, `particleDotCanvas()` | The built-in soft particle sprite. |

## Writing an engine integration

1. Load the document and its textures. Upload straight-alpha images premultiplied; atlas pages listed by
   `premultipliedTextures(doc)` from `@openbone/core` are already premultiplied.
2. Create one `OpenBoneDriver` per object and call `advance(dt)` from the engine's update.
3. Each frame, draw every batch as one indexed triangle list with `texture × vec4(rgb · a, a)` in premultiplied
   alpha, using render-webgl's blend functions (`normal`: `ONE, ONE_MINUS_SRC_ALPHA`; `additive`: `ONE, ONE`;
   `multiply`: `DST_COLOR, ONE_MINUS_SRC_ALPHA`; `screen`: `ONE, ONE_MINUS_SRC_COLOR`). With a `dark` attribute, use
   `rgb = dark + (light − dark) × texture rgb`.
4. Write each clipping mask polygon into a stencil (or clip path) and draw the batches that share that `clip` inside it.
5. Convert engine pointer events to skeleton space and call `pointer()`; call `pointerLeave()` when the pointer leaves
   the artboard.

Done this way, the engine shows the same picture as the reference renderer. The repository's `packages/engine-kit/test/reference.ts`
runs render-webgl against a recording WebGL stand-in, so an integration's tests can compare their geometry with the
reference renderer for the same frame. The four existing engine packages are working examples.

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model, rendering, audio and scripts
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md): the draw list
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Engine sources](https://github.com/UXCentury/open-bone/tree/main/packages): `pixi`, `phaser`, `three`, `canvaskit`, `engine-kit/test/reference.ts`
- Related packages: [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl),
  [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
