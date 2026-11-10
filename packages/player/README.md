# @openbone/player

A drop-in `<openbone-player>` web component and a `Player` class for OpenBone animations in the browser.

[![npm](https://img.shields.io/npm/v/@openbone/player)](https://www.npmjs.com/package/@openbone/player)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](https://github.com/UXCentury/open-bone/blob/main/LICENSE)

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging,
Rive-style state machines and an MCP server for AI agents. This package is the quickest way to put an OpenBone file on
a web page. It loads a `.obone` or `.obonb` document and its images, runs the animation or state machine with
[`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime), draws with
[`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl) (falling back to
[`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas) when WebGL2 is missing), routes
pointer events to state machine listeners, plays sounds with Web Audio and runs document scripts in the QuickJS sandbox
from [`@openbone/scripting`](https://www.npmjs.com/package/@openbone/scripting). For PixiJS, Phaser, Three.js or
CanvasKit, use the engine packages instead (see [Documentation](#documentation)).

## Install

```bash
npm install @openbone/player
```

`esbuild` is an optional peer dependency. You only need it for `@openbone/player/bundle` (see
[Script-tag player](#script-tag-player-no-bundler)).

## Quick start

With a bundler (Vite, webpack, esbuild…). The knight below is `examples/knight.obone` from the repository; its state
machine is called `knight`, with a `walk` boolean and `attack` and `salute` triggers.

```html
<openbone-player src="/knight.obone" state-machine="knight" style="width: 600px; height: 400px"></openbone-player>
<button id="attack">Attack</button>

<script type="module">
  import { definePlayerElement } from "@openbone/player";

  definePlayerElement(); // registers <openbone-player>

  const knight = document.querySelector("openbone-player");
  knight.addEventListener("openbone-load", () => knight.setInput("walk", true));
  knight.addEventListener("openbone-event", (e) => console.log("event", e.detail.name));
  knight.addEventListener("openbone-state", (e) => console.log(e.detail.layer, e.detail.from, "->", e.detail.to));
  document.querySelector("#attack").addEventListener("click", () => knight.fire("attack"));
</script>
```

Images and sounds load relative to the document's URL. The element is 400 × 300 px unless you size it with CSS.

## API

### Exports

| Export | |
|---|---|
| `definePlayerElement(tag?)` | Registers the element (default tag `openbone-player`). Safe to call more than once. |
| `OpenBonePlayerElement` | The element class. |
| `Player` | Plays a document on a canvas you own. The element wraps one. |
| `PlayerOptions` | Options type for `Player`. |
| `setScriptHostFactory(factory)` | Replaces how players create the script sandbox (for example `() => Promise.resolve(null)` to never load QuickJS). |
| `WebAudioBackend`, `WebAudioOptions` | The Web Audio playback used by the player. Also at `@openbone/player/audio`. |

### `<openbone-player>` attributes

| Attribute | Default | |
|---|---|---|
| `src` | | URL of a `.obone` (JSON) or `.obonb` (binary) file. Changing it reloads. |
| `state-machine` | first | State machine to run, by name or id. |
| `animation` | | Play this animation instead of a state machine. |
| `skin` | default skin | Skin (outfit) by name or id. Changing it switches the outfit without reloading. |
| `fit` | `contain` | `contain`, `cover` or `none` (actual size, centred). |
| `renderer` | `webgl` | `webgl` or `canvas`. WebGL falls back to Canvas 2D when WebGL2 is not available. |
| `background` | the file's | Any CSS colour (`#fff`, `rebeccapurple`, `rgb(0 0 0 / 50%)`, …), or `transparent` / `none`. |
| `autoplay` | on | `autoplay="false"` loads and draws the first frame, then waits for `play()`. |
| `scripts` | on | `scripts="none"` never runs the document's scripts. |
| `audio` / `muted` | on | `audio="off"` disables sound; `muted` loads sounds but starts muted. |

Changing `skin` switches the skin in place. Changing any other attribute, including setting `src` after the element is
on the page, reloads the player with the new settings.

### Element methods and events

| Method | |
|---|---|
| `setInput(name, value)` | Set a state machine input (boolean, number or string). |
| `fire(name)` | Fire a trigger input. |
| `setText(slot, text)` | Show fixed text (or an `{input}` template) in a slot's text attachment; `null` restores it. |
| `setSkin(name)` | Switch skin (updates the `skin` attribute); `null` shows the default skin. |
| `play()` / `pause()` | Start or stop playback and sound. |
| `player` | The underlying `Player`, or `null` before the element is connected. |

| Event | `detail` |
|---|---|
| `openbone-load` | none: the document, images and script sandbox are ready. |
| `openbone-event` | The fired event: `name`, `id`, `time`, `int`, `float`, `string`, `animation`. |
| `openbone-state` | A state change: `layer`, `from` (or `null`), `to`. |

Events bubble and cross the shadow root.

### `Player`

```ts
import { Player } from "@openbone/player";

const canvas = document.querySelector<HTMLCanvasElement>("#c")!; // give it a CSS size
const player = new Player({
  canvas,
  src: "/knight.obone",
  stateMachine: "knight",
  fit: "contain",
  onEvent: (e) => console.log("event", e.name, e.int, e.float, e.string),
  onStateChange: (e) => console.log(e.layer, e.from, "->", e.to),
});
await player.ready; // the document, its images and (if needed) the script sandbox are loaded

player.setInput("walk", true);
player.fire("salute");
player.speed = 0.5;
```

`PlayerOptions`:

| Option | |
|---|---|
| `canvas` | The canvas to draw on. It follows its CSS size (a `ResizeObserver`) at the device pixel ratio. |
| `src` | A URL, or an already parsed `OpenBoneDocument`. |
| `baseUrl` | Folder for relative image and audio paths (default: the folder of `src`). |
| `resolveImageUrl(src)`, `resolveAudioUrl(asset)` | Map asset paths to URLs yourself (overrides `baseUrl`). |
| `stateMachine`, `animation`, `skin`, `autoplay`, `fit`, `renderer`, `background` | As the attributes above. `background: null` is transparent. |
| `scripts` | `"quickjs"` (default when the document has scripts), `"none"`, or your own `ScriptHost`. |
| `audio` | `true` (default), `false` or `"muted"`. |
| `audioContext` | Share an existing `AudioContext` instead of creating one. |
| `onEvent`, `onStateChange`, `onLoad` | Callbacks. |

Members: `ready` (promise), `play()`, `pause()`, `playing`, `speed` (sounds follow it), `setInput`, `getInput`,
`fire`, `setText`, `setSkin`, `skins`, `playAnimation(name, loop?)`, `setFit(fit)`, `setMuted(muted)`, `muted`,
`audio`, `instance` (the runtime `OpenBoneInstance`), `stateMachine`, `doc`, `clientToSkeleton(clientX, clientY)`,
`boundingBoxes()` and `dispose()`.

`boundingBoxes()` returns the active bounding boxes in skeleton space with point, segment, AABB and overlap queries
(see `@openbone/runtime`); `clientToSkeleton` converts page coordinates through the current fit:

```ts
canvas.addEventListener("click", (e) => {
  const hit = player.boundingBoxes().containsPoint(...player.clientToSkeleton(e.clientX, e.clientY));
  if (hit) console.log("clicked", hit.slot.data.name);
});
```

### Pointer input

Pointer down, up and move over the canvas are converted to skeleton space and sent to the state machine, so listeners
on bounding boxes (hover, click) work without extra code. Leaving the canvas ends hovers.

### Audio

Sounds load with the document and play through Web Audio. Browsers only allow sound after a user gesture, so audio
unlocks on the first click or key press; one-shot sounds requested before that are dropped. `pause()` pauses sounds
where they are and `play()` resumes them.

### Scripts

Documents with scripts load the QuickJS sandbox on demand (a dynamic import of `@openbone/scripting`). Pass
`scripts: "none"` (or the `scripts="none"` attribute) to skip it. If your bundler pre-bundles dependencies, exclude
`quickjs-emscripten` so it can find its `.wasm` file; the repository's Vite configs use
`optimizeDeps: { exclude: ["quickjs-emscripten"] }`.

### Disposal

Removing the element from the page disposes its player. With a `Player` of your own, call `dispose()`: it stops the
render loop and the sounds and frees the WebGL resources.

## Script-tag player (no bundler)

The npm package ships ES modules, not a prebuilt script. `@openbone/player/bundle` (Node only, needs `esbuild`)
builds a self-contained player for plain `<script src>` use:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { buildScriptsAddon, buildWebBundle, quickJsWasmBytes } from "@openbone/player/bundle";

await mkdir("public", { recursive: true });
// Classic script that defines <openbone-player> and window.OpenBone. "lazy": the script sandbox is fetched
// from next to the player, only for animations that have scripts.
await writeFile("public/openbone-player.js", await buildWebBundle({ format: "iife", scripts: "lazy" }));
await writeFile("public/openbone-scripts.js", await buildScriptsAddon());
await writeFile("public/quickjs.wasm", quickJsWasmBytes());
```

```html
<script src="openbone-player.js"></script>
<openbone-player src="walker.obone" state-machine="character" style="width: 600px; height: 380px"></openbone-player>
```

Including the script registers `<openbone-player>` and sets `window.OpenBone` to `{ Player, OpenBonePlayerElement,
definePlayerElement, parseDocument, version }`.

`buildWebBundle` options: `format` (`"iife"` or `"esm"`), `minify` (default true) and `scripts` (`true` inlines
QuickJS in one file, `"lazy"` loads `openbone-scripts.js` and `quickjs.wasm` from the player's folder only when
needed, `false` leaves the sandbox out and skips scripts with a warning). Set `window.OPENBONE_SCRIPTS_BASE` to load
the lazy files from another folder. `buildPlayerBundle()` builds the variant used by the WebView packages.

You can also skip the build: the OpenBone editor's **Web** export (and the MCP server's `export_file` with format
`web`) writes the player, your animation and a demo page as a ZIP, or as one self-contained HTML file.

## Documentation

- [Architecture](https://github.com/UXCentury/open-bone/blob/main/docs/architecture.md): runtime model, rendering, audio and scripts
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md): `.obone` and `.obonb`
- [Engine exports](https://github.com/UXCentury/open-bone/blob/main/docs/engine-exports.md): WebView packages and the host bridge
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md)
- Related packages: [`@openbone/runtime`](https://www.npmjs.com/package/@openbone/runtime),
  [`@openbone/render-webgl`](https://www.npmjs.com/package/@openbone/render-webgl),
  [`@openbone/render-canvas`](https://www.npmjs.com/package/@openbone/render-canvas),
  [`@openbone/pixi`](https://www.npmjs.com/package/@openbone/pixi),
  [`@openbone/phaser`](https://www.npmjs.com/package/@openbone/phaser),
  [`@openbone/three`](https://www.npmjs.com/package/@openbone/three),
  [`@openbone/canvaskit`](https://www.npmjs.com/package/@openbone/canvaskit)

## License

MIT, © UX Century and OpenBone contributors. See [LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
