# Engine and platform exports

The Export dialog's **Engines** group packages animations for engines and apps that have no OpenBone runtime yet.
Every export is a ZIP with a README.

| Entry | Kind | What you get |
| --- | --- | --- |
| Unity | sprite sheet | PNG sheet(s), TexturePacker JSON (hash, with pivots), `<name>.unity.json` and `Editor/OpenBoneSpriteSheetImporter.cs`, which slices the sheet (custom pivots at the skeleton origin) and creates one `.anim` clip per animation |
| Godot 4 | sprite sheet | PNG sheet(s), a `SpriteFrames` `.tres` (one `AtlasTexture` per unique frame, `margin` restores trimmed borders; fps and loop per animation), an `AnimatedSprite2D` `.tscn` whose position is the skeleton origin |
| Flutter | sprite sheet **or** WebView | Sheet + JSON + a dependency-free Dart widget (`CustomPainter`) and a Flame component; or the interactive WebView package below with a `webview_flutter` controller |
| Android | WebView | Kotlin `OpenBoneView` (wraps `WebView`, loads from `assets/`) |
| iOS | WebView | Swift `OpenBoneView` (`WKWebView`) + SwiftUI `OpenBoneAnimation` wrapper |
| Sprite sheet | sprite sheet | PNG sheet(s), TexturePacker JSON hash + array, Phaser 3 multi-atlas (PixiJS, Phaser, Cocos, ...) |

## Sprite sheets

`apps/editor/src/export-engines.ts` renders each chosen animation with `renderFrames` (all clips share one frame
size: the artboard, or the union of the content bounds over every frame) and hands the frames to
`buildSpriteSheets` (`packages/export/src/spritesheet.ts`): transparent borders are trimmed (offsets kept in
`spriteSourceSize`), pixel-identical frames are stored once (`aliasOf`), and the MaxRects packer from
`packages/core/src/atlas.ts` places them on as many sheets as needed. The metadata writers in
`packages/export/src/engines.ts` are pure string/object builders, tested in `packages/export/test/engines.test.ts`.

Frame names are `<animation>_0001`, ... Fps, loop and the origin are in `meta.openbone` of the JSON files.

## WebView packages

These keep state machines, inputs, listeners, scripts and touch, by embedding the web player:

- `packages/player/src/bundle/webview.ts` is the entry of a single classic script (`openbone-player.js`): player,
  renderers, runtime and the QuickJS sandbox with its `.wasm` inlined. `@openbone/core` is aliased to
  `bundle/core-lite.ts` so the op registry (and zod) stay out: about 0.8 MB, 0.33 MB gzipped.
- `pnpm build:player-bundle` writes `packages/player/dist/openbone-player.js`. The editor does not need it: a Vite
  plugin (`apps/editor/vite.config.ts`) builds the same bundle with esbuild into the virtual module
  `virtual:openbone-player-bundle`, loaded lazily by the dialog, so exports work offline with no prebuilt file.
- `index.html` (from `webViewHtml` in `packages/export/src/webview.ts`) embeds the `.obone`/`.obonb` as base64, so
  it works from `file://` (no `fetch`). `preview.html` drives it through the bridge from a desktop browser.

### Bridge (`packages/player/src/bridge.ts`)

Host → page: `OpenBone.receive(command)` with `{type: "setInput", name, value}`, `{type: "fire", name}`,
`{type: "play", animation?, loop?}`, `{type: "pause"}`, `{type: "setSkin", name}`, `{type: "useStateMachine", name?}`,
`{type: "getInputs"}`. iframes can send `postMessage({openbone: command})`.

Page → host: JSON strings `{"source": "openbone", "v": 1, "type": ...}` with `ready`, `event`, `stateChange`,
`inputs` and `error`, posted to `window.OpenBoneHost.postMessage` (Flutter channel / Android interface),
`webkit.messageHandlers.openbone` (iOS), `parent.postMessage` (iframes) and an `openbone-message` DOM event.

The native templates were written without Flutter, Gradle or Xcode toolchains and are not compiled in CI; the
page, bundle and bridge are tested in the browser and in `packages/player/test/`.
