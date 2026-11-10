# Changelog

OpenBone uses one version for the whole repo (packages, editor, desktop app, native runtimes). Set it with `pnpm version:set <major|minor|patch|x.y.z>` and check it with `pnpm version:check`. Versions follow [Semantic Versioning](https://semver.org): while it's 0.x, minor versions may change the `.obone` format or APIs.

## Unreleased

### Packages
- npm: every `@openbone/*` package builds to JavaScript with type definitions, plus the `openbone` CLI (`npx openbone`) and `npx -y @openbone/mcp`.
- NuGet: `OpenBone.Runtime`, `OpenBone.Scripting.Jint` and `OpenBone.MonoGame`, with symbols and SourceLink.
- Unity: the package installs from git (`https://github.com/UXCentury/open-bone.git#upm`) and OpenUPM, with the DLLs built in.
- Maven Central: `io.openbone:openbone-runtime`, `openbone-scripting`, `openbone-gdx` and `openbone-android`.
- Swift: `Package.swift` moved to the repository root, so SwiftPM installs the package from the repository URL.
- Flutter: the plugin can be published to pub.dev with the C++ sources bundled.
- Godot: a ready-to-install `addons/openbone` with Windows, macOS, Linux (x86_64, arm64) and Android libraries.
- Publish workflows for each registry, run by the GitHub release (pub.dev and Swift: by the tag).

### Added
- Bounding-box queries, in the TypeScript runtime and every native runtime (C++ and its C API, C#, Java, Haxe, Swift, Dart): `skeleton.boundingBoxes()` (`instance.boundingBoxes()`) gives the world polygons of the active bounding boxes and their AABB, with `containsPoint` / `containsPointAll`, `intersectsSegment` / `intersectsSegmentAll`, `aabbIntersects` and `intersectsBounds(other)` for overlap between two skeletons, in skeleton space. The player and the engine adapters expose it with coordinate helpers (`Player.clientToSkeleton`, pixi `toSkeleton`, phaser `worldToSkeleton`, three `rayToSkeleton`, canvaskit `clientToSkeleton`).
- Bounding boxes can be weighted to bones (`autoWeights`, `setWeights`) and take deform keys, like paths.
- Path constraints: `constantSpeed` (default on, the existing arc-length placement). Off places bones at the raw bezier parameter inside each curve segment, as Spine does; a "Constant speed" checkbox in the path-constraint Inspector. Existing files pose exactly as before.
- Conformance: `bounds` (recorded point, segment, AABB and skeleton-overlap queries) and `paths` (constant speed on and off on uneven curves) fixtures.

### Security
- MCP server: the editor bridge and the HTTP transport refuse browser requests from pages other than the OpenBone editor, including DNS rebinding. Before, any web page open on the same machine could connect to the bridge and read or change the open project.

### Fixed
- MCP: `--project` with a file that can't be read stops with the reason instead of replacing it with an empty project, and `new_project` refuses to replace an existing file unless called with `overwrite: true`.
- CLI and MCP exports: ZIPs carry the format in their name (`hero-atlas.zip`, `hero-web.zip`, `hero-spritesheet-godot.zip`, …), so exporting several formats into one folder no longer overwrites files.
- CLI: `openbone <command> --help` prints that command's usage (it was read as a file name); the help lists `--animations` and `--steps`.
- `<openbone-player>`: setting `src` after the element is on the page loads it, and changing any attribute reloads the player; `background` accepts any CSS colour under WebGL too (short hex such as `#fff` was drawn wrong).
- Runtime: a document whose scripts would be skipped because no `scriptHost` was given prints a warning once; pass `scriptHost: null` to opt out on purpose. `scriptTimeoutMs`, which nothing read, is deprecated.
- Editor: the Preview panel runs document scripts, like the viewport.

### Changed
- QuickJS (quickjs-ng 0.10.1) is vendored in `runtimes/cpp/third_party`, so no build downloads it.
- No fused multiply-add: a source pragma (`exact_math.h`) replaces the compiler flag where clang builds the runtime.
- The MCP server reports the real version.

## 0.2.0 (2026-11-10)

Native runtimes for C++ (Godot, Cocos2d-x, SDL2, SFML, OpenGL, Unreal), C# (Unity, MonoGame), Java (libGDX, Android), Swift, Flutter and Haxe, all checked against a shared conformance suite; sound in the engine integrations; desktop installers for Windows, macOS and Linux; WebM video export; and the rest of the Spine-style rigging tools.

### Native runtimes

- **GLFW / OpenGL 3.3 sample** (`runtimes/cpp/engines/glfw`): the WebGL2 renderer's shader and blending in plain OpenGL (two-colour tint, premultiplied pages, all blend modes, stencil clipping), mouse input, and a hidden-window `--out frame.png` mode.
- **Sound in more runtimes**: the Swift `OpenBoneView` / `OpenBonePlayer` (new `OpenBoneAudio`, AVFoundation; `OpenBoneDocument` gains `audioAssets`, `audioBuses`, `audioMaster`), the libGDX module (`OpenBoneAudio`), the Android `OpenBoneView` (SoundPool / MediaPlayer, `SoundSource`) and the SDL2 and SFML samples play the document's sounds (on by default, `isAudioEnabled` / `--mute` to opt out; audio callbacks still get every command), on shared, unit-tested gain / voice / fade logic (`OpenBoneAudioMixer`, Java `AudioMixer`, `engines/common/openbone_audio.hpp`). Unreal still only emits audio commands.
- **MonoGame integration** (`runtimes/csharp/monogame`): `OpenBone.MonoGame` for MonoGame 3.8 DesktopGL — `OpenBoneRenderer` (`DrawUserIndexedPrimitives`, premultiplied blend modes, stencil clipping, two-colour tint through a GLSL effect built in code with a `BasicEffect` fallback, optional SpriteFont text), `OpenBoneMonoGame` (load, animations or state machine, mouse / touch → listeners, events) and `OpenBoneSoundPlayer` (`SoundEffectInstance` with bus × master volume, log2 pitch, loops and fades), a DesktopGL knight sample and window-less tests (also in CI).
- **Haxe runtime** (`runtimes/haxe`): a pure Haxe 4.3 port of the runtime with no dependencies (`.obone`/`.obonb` loading, skins and skin bones, every constraint in custom order, sliders, physics, particles, sequences, packed/trimmed/polygon atlases, text templates, the draw list, state machines with listeners and bindings, events, audio commands) and JS number semantics on every target. All 82 conformance cases pass on the JS target (scripts run on its JavaScript engine through `JsScriptHost`); on eval and Python the 6 scripted state-machine cases are skipped and the other 76 pass.
- The Flutter plugin moved from `runtimes/dart` to `runtimes/flutter/openbone`: Flutter 3.47's Swift Package Manager support fails when a plugin's folder name differs from its package name ([flutter#186881](https://github.com/flutter/flutter/issues/186881)).
- Java runtime on **Gradle 9.9** and Android Gradle Plugin 9.5 (Kotlin 2.4 through the Kotlin Android plugin), without Gradle 10 deprecations.
- **Swift Package Manager** for the Flutter plugin on iOS and macOS (`runtimes/flutter/openbone/darwin/openbone/Package.swift`, with iOS and macOS sharing one `darwin/` folder and podspec), so Flutter no longer warns that `openbone` lacks SPM support; the podspecs stay for CocoaPods.
- **Sound in the native engine integrations**: the Flutter `OpenBoneWidget` (new `OpenBoneAudio`, flutter_soloud; the plugin now needs Flutter 3.41+) and the Cocos2d-x `OpenBoneNode` (`cocos2d::AudioEngine`) play the document's sounds, like the Godot `OpenBoneSprite`. The C API gains `ob_document_audio_asset`, `ob_document_audio_bus` and `ob_document_audio_master`, and the Dart `OpenBoneDocument` exposes `audioAssets`, `audioBuses` and `audioMaster`. The Flutter example bundles its sounds.
- **C++ runtime** (`runtimes/cpp`): a native C++17 port of the runtime with no engine dependencies — `.obone`/`.obonb` loading, skins and skin bones, every attachment, animation mixing, IK/transform/path/physics in constraint order, sliders, particles, text templates, the draw list (clipping, sequences, packed/trimmed/polygon atlases, two-colour tint), state machines with listeners and bindings, events, audio commands, and scripts in embedded QuickJS. Passes all conformance cases (CTest). A stable C API (`openbone.h`, `libopenbone`) for FFI, a Godot 4 GDExtension (`OpenBoneSprite`, checked in headless Godot), SDL2 and SFML sample renderers, an Unreal Engine 5 plugin (as source) and a Cocos2d-x 4.0 node (built and run on Linux; it now binds its textures through the program state).
- **C# runtime** (`runtimes/csharp`): `OpenBone.Runtime` for .NET Standard 2.1 / .NET 8, a native port of the runtime (`.obone` and `.obonb` loading, skins and skin bones, every attachment, mixing, constraints in custom order, sliders, physics, particles, text templates, the draw list, state machines with listeners and bindings, events and audio commands) that passes every case of the conformance suite (`dotnet test`). Scripts run in Jint (`OpenBone.Scripting.Jint`) with the same `ob` API and limits as the QuickJS host.
- **Unity package** (`runtimes/csharp/unity/com.openbone.runtime`): ScriptedImporter for `.obone` / `.obonb`, OpenBone Animation and OpenBone State Machine components (UnityEvents, EventSystem or mouse pointer input), a mesh generator with blend modes, stencil clipping, two-colour tint and premultiplied pages (`OpenBone/Skeleton` shader), and an AudioSource bridge. Built with `runtimes/csharp/unity/build-package.py`; tested in Unity 6 (6000.6.8f1) with every example; it now declares its `com.unity.ugui` dependency, imports art and sounds in any import order, clamps texture edges, and has `StageBounds` for framing a camera on the document's stage.
- **Java runtime** (`runtimes/java`): a Java 11 port of the runtime with no dependencies (`.obone`/`.obonb` loading, skins and skin bones, every constraint in custom order, sliders, physics, particles, sequences, packed atlases, text templates, draw list, state machines, bindings, events, audio commands), state machine scripts in QuickJS (`openbone-scripting`), a libGDX renderer with an LWJGL3 sample (`openbone-gdx`), and a Kotlin Android library with `OpenBoneView` (`openbone-android`). JUnit runs all 82 conformance cases on the JVM; an instrumented test runs them on Android.
- **Swift runtime** (`runtimes/swift`): a SwiftPM package that compiles the C++ runtime from source and wraps its C API — `OpenBoneDocument` / `OpenBoneInstance` (`.obone`/`.obonb`, skins, animation tracks, state-machine inputs, triggers and pointer, event / audio / state / log callbacks, bones, slots, zero-copy or copied draw list), ARC-owned handles. `OpenBoneView` (Metal, UIKit and AppKit) and SwiftUI `OpenBonePlayer` draw it with blend modes, stencil clipping, two-colour tint, premultiplied pages, particles and CoreText text, and send touches / the mouse to listeners; plus a SwiftUI sample. `swift test` runs all 82 conformance cases (checked on Linux; the views have not yet been run on Apple hardware). The C API gains `ob_instance_slot_count` / `ob_instance_slot` / `ob_instance_find_slot`.
- **Flutter / Dart runtime** (`runtimes/flutter/openbone`): the `openbone` Flutter FFI plugin wraps the C++ runtime's C API with `dart:ffi` (ffigen bindings) and builds `libopenbone` for Android, Linux and Windows (CMake) and iOS/macOS (CocoaPods). Pure-Dart `OpenBoneDocument` / `OpenBoneInstance` (skins, tracks, state machine inputs, triggers and pointer, event / audio-command / state streams, draw list; native memory freed by `dispose` or finalizers) and `OpenBoneWidget` + `OpenBoneController` (Ticker-driven, `Canvas.drawVertices` with blend modes, clipping, two-colour tint and premultiplied pages, gestures → listeners). `flutter test` runs all 82 conformance cases; the example runs on Linux desktop and an Android emulator (iOS, macOS and Windows not built yet). C API additions: slot accessors (`ob_instance_slot_count` / `ob_instance_slot` / `ob_instance_find_slot`, shared with the Swift package) and `ob_particle_dot_alpha`; CMake options `OPENBONE_BUILD_STATIC`, `OPENBONE_INSTALL`.

### Editor and rigging

- Dopesheet: multi-key selection (Shift/Ctrl-click, Shift-drag box, Ctrl/⌘+A), drag and arrow-key nudge of the selection, copy / cut / paste at the playhead (across animations), scale in time, curve and delete for all selected keys. New ops `transformKeys`, `pasteKeys`, `deleteKeys` (also MCP tools).
- Compensate (`J`, toolbar ⇲ Comp): transform a bone while its child bones keep their place.
- Linked meshes (`addLinkedMesh`): share another mesh's geometry and weights with a different image, optionally following its deform keys.
- Runtime fixes ahead of the native ports: full-weight rotation keys set the keyed value; draw-order keys keep unlisted slots in place (like Spine); blend states report their stronger animation's progress (exit times, on complete); transitions to deleted states are skipped; constraint results written to world transforms survive later constraints (`syncApplied`); physics stretch uses the world rest length; additive sliders mix their colour and constraint keys; fully transparent shapes aren't drawn; no NaN from text-driven bindings or short deform keys.
- Skin bones and skin constraints: `SkinData.bones` / `constraints`; anything a skin lists is active only while a skin listing it is set (inactive bones and their children are not posed or drawn, inactive constraints are skipped). Ops `addToSkin`, `removeFromSkin`; Inspector "Only in skins" on bones and constraints.
- Inherit timeline: `{target: "bone", property: "inherit"}` with stepped `normal | onlyTranslation | noRotation | noScale` keys; keyable from the Inspector's Inherit field in Animate mode.
- Constraint order: optional `order` on every constraint, applied as one sorted list (default unchanged: IK, transform, path, physics). Op `setConstraintOrder`; Inspector "Constraint order" list with ↑↓.
- Reference scale: `skeleton.referenceScale` (default 100). Physics gravity and wind and IK softness scale with the skeleton's size relative to it, so a rescaled rig behaves the same. Document inspector "Ref. scale".
- Two-colour tint: a keyable `dark` slot colour, drawn by every renderer and runtime: Canvas2D, WebGL2, PixiJS (two-colour mesh shader), Phaser (a two-colour pipeline), Three.js (a `DARK` material variant) and CanvasKit (a colour-matrix filter per run of equally tinted items). Engine-kit batches carry a per-vertex `dark` channel only when a slot in them uses one, so documents without it draw exactly as before.
- Folders for slots, skins, animations, events, constraints and state machines (optional `folder` path; ops `setFolder`, `renameFolder`): grouped, collapsible lists with drag into folders, new / rename / delete folder. New Events list in the left panel.
- Import data (☰ Menu → Import from project…, op `importData`): copy animations and skins from another project by bone/slot name, with the images, sounds and events they use, or bring in its whole skeleton under a new root bone; conflicts rename, replace or skip.
- Weight tools: lock bones while painting (locked weights stay, the others renormalise; also Smooth / Auto / Prune / Direct), and `swapWeights` (Weights panel → Swap…) to trade two bones' weights on a mesh or its selected vertices.

### Export and art pipeline

- **Desktop installers**: the Desktop installers workflow builds the Tauri app for Windows (`.msi`, NSIS `.exe`), macOS (universal `.dmg`) and Linux (`.deb`, `.rpm`, `.AppImage`) and attaches them to a draft GitHub Release for each `v*` tag (or keeps them as artifacts on a manual run). Optional macOS signing and notarization through repository secrets; installer metadata (publisher, category, descriptions, licence) in the Tauri config. See `docs/releasing.md`.
- **WebM video export**: VP9 (VP8 as fallback) with Opus sound through WebCodecs and `webm-muxer` (MIT); with a transparent background the video keeps its alpha channel where the browser's encoder supports it (Chrome, Edge), otherwise the background is filled with the document's colour and the dialog says so.
- Texture atlas: **premultiplied alpha** (pages stored as rgb × a, recorded as `atlas.premultipliedAlpha`; render-webgl, Pixi, Three.js, CanvasKit and Phaser upload them as they are with the matching blend, Canvas2D converts them back), **whitespace stripping** (each image packed by its visible bounds; meshes keep what their uvs cover, particle images stay whole) and **polygon packing** (region attachments draw a tight convex outline, `region.polygon`, instead of the full quad). In the Export dialog's Texture atlas settings, `pack_atlas` / `export_file` and the `setAtlas` op. One packing path (`buildAtlas` in render-canvas) for the editor, MCP server and CLI.
- **Live art reloading**: ☰ Menu → *Watch art for changes* watches the folders the project's images and sounds come from (desktop, via tauri-plugin-fs), or a folder picked with *Watch folder…* (web: File System Access API, checked while the editor tab is in front). Changed files replace the art in place, sizes included (region attachments scale with their image), with a toast and no undo steps. New op `updateImage`; `DocumentStore.applyQuiet` applies an op without an undo step.
- **CLI batch export**: `openbone export <files or globs> --format json|obonb|atlas|png|jpeg|gif|apng|psd|avi|mov|spritesheet|web --out <dir>` with `--animation`, `--skin`, `--scale`, `--fps` and the atlas options. It runs the same `exportFile` code as the MCP `export_file` tool. New `atlas` format: runtime JSON plus its atlas pages as PNG files in a ZIP.
- Photoshop (`.psd`) import: layers become slots and regions in place; groups can become bones.

### Tooling, CI and docs

- **CI** (`.github/workflows`): GitHub Actions run the web tests and build, and every native runtime against the conformance suite when its files change — C++ on Linux, macOS and Windows plus Godot (headless), SDL2 and SFML; C# and the Unity compile check; Java, libGDX and the Android library; Swift on Linux and macOS plus an iOS build; Flutter tests on Linux and macOS and the example built for Linux, Android, macOS, iOS and Windows.
- About dialog (☰ Menu → About OpenBone): version, build, credits for the open-source tools OpenBone is built with.
- `pnpm version:set` / `pnpm version:check` keep every package, the Tauri app and the desktop crate on one version.
- Conformance suite (`conformance/`, `pnpm conformance`): reference poses, draw lists, events, audio and state-machine traces from the TypeScript runtime for every example plus focused rigs and packed atlases, checked by a drift test; `docs/runtime-spec.md` specifies the evaluation rules for ports to other languages.

## 0.1.0

First public version.

- **Rigging:** bones with inherit modes, slots, skins, region / mesh / weighted mesh / shape / text / sequence / particle / clipping / path / bounding box / point attachments, IK (1- and 2-bone, softness, stretch, compress), transform, path and physics constraints, sliders, texture atlas packing.
- **Animation:** dopesheet and curve graph, auto-key, onion skin, events, audio keys, lip sync, deform keys.
- **Interactivity:** Rive-style state machines (inputs, blend states, transitions, pointer listeners), data bindings, staged flows, QuickJS-sandboxed scripts.
- **Audio:** sounds, buses and mixing, played by animations, events, states and listeners.
- **Editor:** web and desktop (Tauri 2), docking panels, Play mode, rebindable shortcuts (Windows / Linux and macOS), undo history that survives a reload, confirmations before destructive actions, examples gallery.
- **Export:** `.obone` / JSON / binary data, PNG, JPEG, GIF, APNG, PSD, AVI / MOV (with sound), MP4, web player, sprite sheets and engine packs (Unity, Godot, Flutter, Android, iOS).
- **Runtimes:** TypeScript runtime with Canvas2D and WebGL2 renderers, `<openbone-player>`, PixiJS, Phaser 3, Three.js and CanvasKit adapters.
- **MCP server** with tools for everything the editor does, a live bridge to the open editor, and a CLI.
