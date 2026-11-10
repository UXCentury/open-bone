# @openbone/export

Image, video, archive and sprite-sheet encoders for OpenBone exports, in plain TypeScript.

[![npm](https://img.shields.io/npm/v/@openbone/export)](https://www.npmjs.com/package/@openbone/export)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package turns rendered frames into files: PNG, APNG,
GIF, layered PSD, AVI and MOV (Motion-JPEG, optional PCM sound), ZIP, sprite sheets and ready-to-import engine packs
for Unity, Godot, Flutter and generic engines. It does not render. Pose frames with
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime) and draw them with a renderer such as
[`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas), then pass the pixels here. The
editor's Export dialog, the [MCP server](https://www.npmjs.com/package/@openbone/mcp) and `openbone export` in the
[CLI](https://www.npmjs.com/package/@openbone/cli) all use these encoders. If you only need files, the CLI does the
rendering and encoding in one command.

The encoders have no native dependencies (GIF uses [gifenc](https://www.npmjs.com/package/gifenc), MIT). They run in
browsers and in Node 20 or later. PNG and ZIP reading use the standard `CompressionStream` / `DecompressionStream`.

## Install

```bash
npm install @openbone/export
```

```bash
pnpm add @openbone/export
```

```bash
yarn add @openbone/export
```

To render frames in Node as in the quick start, also install `@openbone/core`, `@openbone/runtime`,
`@openbone/render-canvas` and a canvas implementation such as [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas).

## Quick start

Render one second of the Knight's walk in Node and save it as a GIF, an APNG and a Godot sprite-sheet pack:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { parseDocument, textureAssets } from "@openbone/core";
import { type Frame, buildSpriteSheets, encodeApng, encodeGif, encodePng, enginePackZip } from "@openbone/export";
import { CanvasRenderer } from "@openbone/render-canvas";
import { OpenBoneInstance } from "@openbone/runtime";

const doc = parseDocument(readFileSync("knight.obone"));
const images = new Map();
for (const img of textureAssets(doc)) images.set(img.id, await loadImage(readFileSync(img.src)));

const scale = 0.5;
const width = Math.round(doc.width * scale);
const height = Math.round(doc.height * scale);
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
const renderer = new CanvasRenderer(ctx, (id) => images.get(id));

const knight = new OpenBoneInstance(doc);
knight.animationState.setAnimation(0, "walk", true, 0);
const fps = 30;
const frames: Frame[] = [];
for (let i = 0; i < fps; i++) {
  knight.advance(i === 0 ? 0 : 1 / fps);
  renderer.render(knight.skeleton, { view: { x: 0, y: 0, zoom: scale }, background: null });
  frames.push(ctx.getImageData(0, 0, width, height)); // RGBA pixels: a Frame
}

writeFileSync("walk.png", await encodePng(frames[0]));
writeFileSync("walk.apng", await encodeApng(frames, { delayMs: 1000 / fps }));
writeFileSync("walk.gif", encodeGif(frames, { delayMs: 1000 / fps, transparent: true }));

const sheets = buildSpriteSheets([{ name: "walk", fps, loop: true, frames }], {
  origin: { x: doc.originX * scale, y: doc.originY * scale }, // the pivot of every frame
});
writeFileSync("knight-godot.zip", await enginePackZip("godot", sheets, { name: "knight" }));
```

Image `src` paths in the example files are relative to the `.obone` file; run this next to it, or resolve them
yourself.

## Frames

Every image encoder takes `Frame` objects:

```ts
interface Frame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray; // RGBA, 8 bits per channel, not premultiplied, rows top to bottom
}
```

All frames passed to one call must have the same size. A 2D canvas `ImageData` has this layout, so
`ctx.getImageData(...)` can be passed as a frame directly.

## API

| Export | Output |
|---|---|
| `encodePng(frame)` | `Promise<Uint8Array>`: a PNG file (8-bit RGBA) |
| `encodeApng(frames, { delayMs, loops? })` | `Promise<Uint8Array>`: an animated PNG. `loops` 0 (default) repeats forever |
| `encodeGif(frames, { delayMs, loops?, transparent? })` | An animated GIF, 256 colours per frame. With `transparent`, pixels under 50% alpha become transparent; otherwise frames should be opaque |
| `encodePsd(layers)` | A layered Photoshop file from `{ name, frame }[]`: the first layer is visible, the rest hidden |
| `encodeAviMjpeg(jpegs, { width, height, fps, audio? })` | An AVI with a Motion-JPEG video stream and optional 16-bit PCM sound |
| `encodeMovMjpeg(jpegs, { width, height, fps, audio? })` | The same as a QuickTime MOV |
| `floatToPcm(channels, sampleRate)` | `PcmAudio` for the video encoders, from planar float channels (-1..1) |
| `createZip(entries, date?)` | A ZIP of `{ name, data }[]` with stored (uncompressed) entries, e.g. a PNG sequence |
| `readZip(bytes)` | `Promise<ZipEntry[]>`: the files of a ZIP (stored or deflated entries) |
| `buildSpriteSheets(clips, options?)` | Packs frames into sheets (below) |
| `enginePackFiles(engine, set, options)` / `enginePackZip(...)` | Sprite-sheet packs for `"unity"`, `"godot"`, `"flutter"` or `"generic"` (below) |
| `webPackFiles(o)` / `webPackZip(o)` / `webIndexHtml(o)` | A website export around `<openbone-player>` (below) |
| `webViewPackFiles(platform, o)` / `webViewPackZip(...)` / `webViewHtml(page)` | WebView packages for `"flutter"`, `"android"` and `"ios"` (below) |
| `texturePackerHash`, `texturePackerArray`, `phaserMultiAtlas`, `unitySheetJson`, `godotSpriteFrames`, `godotScene` | The individual metadata writers used by the engine packs |
| `trimBounds`, `cropFrame`, `frameName`, `safeName`, `crc32`, `zlibDeflate`, `toBase64` | Small helpers |

### Video

The video encoders take finished JPEG files, one per frame, so you choose the JPEG encoder: `canvas.toBlob(...,
"image/jpeg")` in a browser, or `canvas.toBuffer("image/jpeg")` with `@napi-rs/canvas`. Sound is interleaved with
the video, one chunk per frame.

```ts
import { writeFileSync } from "node:fs";
import { encodeAviMjpeg, encodeMovMjpeg, floatToPcm } from "@openbone/export";

// jpegs: Uint8Array[], one JPEG file per frame; left, right: Float32Array samples at 44.1 kHz
const audio = floatToPcm([left, right], 44100);
writeFileSync("clip.avi", encodeAviMjpeg(jpegs, { width: 450, height: 300, fps: 30, audio }));
writeFileSync("clip.mov", encodeMovMjpeg(jpegs, { width: 450, height: 300, fps: 30 }));
```

To get the sounds an animation plays with their times, use `animationAudioSchedule()` from `@openbone/runtime`.

### Sprite sheets

```ts
buildSpriteSheets(clips: SheetClipInput[], options?: SheetOptions): SpriteSheetSet
```

Each clip is `{ name, fps, loop, frames }`. Frames are named `<clip>_0001`, `<clip>_0002`, and so on.

| Option | Default | What it does |
|---|---|---|
| `trim` | `true` | Trim transparent borders (the offset is kept in `spriteSourceSize`) |
| `padding` | `2` | Pixels between frames and around the sheet edge |
| `maxSize` | `2048` | Largest sheet size; more frames go on more sheets |
| `powerOfTwo` | `false` | Round sheet sizes up to powers of two |
| `dedupe` | `true` | Store pixel-identical frames once |
| `origin` | frame centre | Skeleton origin in frame pixels, used as every frame's pivot |
| `alphaThreshold` | `0` | Alpha at or below this counts as transparent when trimming |

The result has `pages` (each with an RGBA `image`), `frames` (rect, trim and pivot per frame, in the TexturePacker
convention) and `clips` (frame names in play order).

### Engine packs

```ts
enginePackFiles(engine: "unity" | "godot" | "flutter" | "generic", set: SpriteSheetSet, options: EnginePackOptions): Promise<PackFile[]>
enginePackZip(engine, set, options): Promise<Uint8Array> // everything inside a <name>/ folder
```

Options: `name` (file base name), `scale` (recorded in metadata, default 1), `godotRoot` (default
`res://openbone/<name>/`) and `pixelsPerUnit` (Unity, default 100).

| Engine | What the pack contains |
|---|---|
| `unity` | Sheet PNGs, TexturePacker JSON, a `.unity.json` description, an editor importer script (`OpenBoneSpriteSheetImporter.cs`) and a README |
| `godot` | Sheet PNGs, a `SpriteFrames` resource (`.tres`), a scene with an `AnimatedSprite2D` (`.tscn`), TexturePacker JSON and a README |
| `flutter` | Sheet PNGs, TexturePacker JSON, a Dart sprite-sheet loader and a Flame component, and a README |
| `generic` | Sheet PNGs, TexturePacker JSON (hash and array), a Phaser multi-atlas and a README |

### Web and WebView packs

`webPackZip` and `webViewPackZip` wrap an exported document with the `<openbone-player>` script: a website (a ZIP
with a demo page and embed snippets, or one self-contained HTML file), or a WebView package for Flutter, Android or
iOS. You provide the document bytes and the player bundle source (`playerCode` or `bundle`); the editor and the MCP
server build that bundle with `@openbone/player/bundle`. See
[engine exports](https://github.com/UXCentury/open-bone/blob/main/docs/engine-exports.md) for what each package
contains and how to use it.

## Documentation

- [Engine exports](https://github.com/UXCentury/open-bone/blob/main/docs/engine-exports.md): sprite-sheet and WebView packs, engine by engine
- [Architecture, exports](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md#exports-and-live-art): how the editor, CLI and MCP server share one export path
- [MCP server](https://github.com/UXCentury/open-bone/blob/main/docs/mcp.md): the `export_file` tool
- The editor: [desktop app](https://github.com/UXCentury/open-bone/releases) or run it from the [repository](https://github.com/UXCentury/open-bone#quick-start)
- Related packages: [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas),
  [`@openbone/player`](https://www.npmjs.com/package/@openbone/player),
  [`@openbone/cli`](https://www.npmjs.com/package/@openbone/cli),
  [`@openbone/core`](https://www.npmjs.com/package/@openbone/core)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
