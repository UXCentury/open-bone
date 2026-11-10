# OpenBone for Godot

Plays [OpenBone](https://github.com/UXCentury/open-bone) skeletal animations and interactive state machines in Godot
4.4 and later. It adds one node, **OpenBoneSprite** (a `Node2D`), as a GDExtension: no editor plugin to enable.

Prebuilt for Windows (x86_64), macOS (universal: Apple Silicon + Intel), Linux (x86_64, arm64) and Android (arm64).
Web and iOS exports aren't supported yet.

## Install

- **Asset Library:** in the Godot editor, open the AssetLib tab, search for *OpenBone* and install it.
- **By hand:** download `openbone-godot-<version>.zip` from the
  [releases](https://github.com/UXCentury/open-bone/releases) and unzip it into your project, so that you get
  `res://addons/openbone/openbone.gdextension`.

Restart the editor once after installing so that it loads the extension.

## Use

Export a `.obone` (or binary `.obonb`) file from the OpenBone editor and put it in your project together with its images
(the paths in the file are relative to it).

```gdscript
extends Node2D

func _ready() -> void:
    var sprite := OpenBoneSprite.new()
    sprite.position = Vector2(576, 520)
    add_child(sprite)
    sprite.load("res://characters/knight.obone")
    sprite.play("idle")                       # or: sprite.use_state_machine("knight")
    sprite.animation_event.connect(func(name, time, i, f, s): print("event ", name))
    sprite.state_changed.connect(func(layer, from, to): print(layer, ": ", from, " -> ", to))
```

You can also add an **OpenBoneSprite** node in the scene tree and set *Document*, *Animation* or *State Machine* in the
Inspector.

Main API: `load(path)`, `play(name, loop, track)`, `queue(...)`, `use_state_machine(name)`, `set_input(name, value)`,
`fire(name)`, `get_active_state(layer)`, `get_bone_transform(bone)`, `set_text(slot, text)`, `advance(delta)`; properties
`document`, `animation`, `state_machine`, `skin`, `looping`, `playing`, `speed`, `scripts_enabled`, `handle_input`,
`audio_enabled`, `audio_bus`; signals `animation_event`, `audio_command`, `state_changed`.

## Exporting your game

`.obone` / `.obonb` files aren't Godot resources, so add them to the export: **Project → Export → Resources → Filters to
export non-resource files/folders**: `*.obone, *.obonb`. Images and sounds referenced by the document are imported
normally and need nothing extra.

On macOS the libraries aren't notarized. If you unzipped the release by hand and macOS refuses to load them, run
`xattr -dr com.apple.quarantine addons/openbone` in your project folder.

## Licence

MIT. See [LICENSE](LICENSE), which also lists the bundled third-party code (QuickJS, nlohmann/json, godot-cpp; all MIT).
