# Changelog

OpenBone uses one version for the whole repo (packages, editor, desktop app). Set it with `pnpm version:set <major|minor|patch|x.y.z>` and check it with `pnpm version:check`. Versions follow [Semantic Versioning](https://semver.org): while it's 0.x, minor versions may change the `.obone` format or APIs.

## Unreleased

- About dialog (☰ Menu → About OpenBone): version, build, credits for the open-source tools OpenBone is built with.
- `pnpm version:set` / `pnpm version:check` keep every package, the Tauri app and the desktop crate on one version.
- Dopesheet: multi-key selection (Shift/Ctrl-click, Shift-drag box, Ctrl/⌘+A), drag and arrow-key nudge of the selection, copy / cut / paste at the playhead (across animations), scale in time, curve and delete for all selected keys. New ops `transformKeys`, `pasteKeys`, `deleteKeys` (also MCP tools).
- Compensate (`J`, toolbar ⇲ Comp): transform a bone while its child bones keep their place.
- Linked meshes (`addLinkedMesh`): share another mesh's geometry and weights with a different image, optionally following its deform keys.
- Photoshop (`.psd`) import: layers become slots and regions in place; groups can become bones.
- Runtime fixes ahead of the native ports: full-weight rotation keys set the keyed value; draw-order keys keep unlisted slots in place (like Spine); blend states report their stronger animation's progress (exit times, on complete); transitions to deleted states are skipped; constraint results written to world transforms survive later constraints (`syncApplied`); physics stretch uses the world rest length; additive sliders mix their colour and constraint keys; fully transparent shapes aren't drawn; no NaN from text-driven bindings or short deform keys.
- Conformance suite (`conformance/`, `pnpm conformance`): reference poses, draw lists, events, audio and state-machine traces from the TypeScript runtime for every example plus focused rigs and packed atlases, checked by a drift test; `docs/runtime-spec.md` specifies the evaluation rules for ports to other languages.
- Skin bones and skin constraints: `SkinData.bones` / `constraints`; anything a skin lists is active only while a skin listing it is set (inactive bones and their children are not posed or drawn, inactive constraints are skipped). Ops `addToSkin`, `removeFromSkin`; Inspector "Only in skins" on bones and constraints.
- Inherit timeline: `{target: "bone", property: "inherit"}` with stepped `normal | onlyTranslation | noRotation | noScale` keys; keyable from the Inspector's Inherit field in Animate mode.
- Constraint order: optional `order` on every constraint, applied as one sorted list (default unchanged: IK, transform, path, physics). Op `setConstraintOrder`; Inspector "Constraint order" list with ↑↓.
- Reference scale: `skeleton.referenceScale` (default 100). Physics gravity and wind and IK softness scale with the skeleton's size relative to it, so a rescaled rig behaves the same. Document inspector "Ref. scale".
- Two-colour tint: a keyable `dark` slot colour (Canvas2D and WebGL2 renderers; the PixiJS, Phaser, Three.js and CanvasKit runtimes draw the normal tint for now).

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
