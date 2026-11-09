# Changelog

OpenBone uses one version for the whole repo (packages, editor, desktop app). Set it with `pnpm version:set <major|minor|patch|x.y.z>` and check it with `pnpm version:check`. Versions follow [Semantic Versioning](https://semver.org): while it's 0.x, minor versions may change the `.obone` format or APIs.

## Unreleased

- About dialog (☰ Menu → About OpenBone): version, build, credits for the open-source tools OpenBone is built with.
- `pnpm version:set` / `pnpm version:check` keep every package, the Tauri app and the desktop crate on one version.

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
