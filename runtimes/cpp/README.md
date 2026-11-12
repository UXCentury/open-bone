# OpenBone C++ runtime

A native port of the TypeScript runtime (`packages/runtime`) in C++17, with a stable C API for FFI (Swift, Dart, C#,
Python…) and integrations for Godot 4, SDL2, SFML, GLFW (OpenGL), Unreal Engine 5 and Cocos2d-x. It has no engine dependencies:
it loads `.obone` / `.obonb` documents, poses skeletons, runs animations and state machines (with scripts in an
embedded QuickJS sandbox) and hands you a **draw list** — textured triangles in draw order — plus events and audio
commands. Rendering and audio playback are up to the engine (the Godot, Cocos2d-x, SDL2 and SFML integrations play
the sounds; `engines/common/openbone_audio.hpp` is the shared, engine-neutral mixer logic).

It follows [docs/runtime-spec.md](../../docs/runtime-spec.md) and passes the whole [conformance suite](../../conformance)
(21 reference files, 92 cases: setup poses, every animation per skin, scripted state-machine runs), also with
`--strict`, i.e. within the reference's 4-decimal rounding rather than the suite's tolerances.

| | |
| --- | --- |
| Language | C++17 (GCC, Clang, MSVC); the C API is plain C99 |
| Dependencies | [nlohmann/json](https://github.com/nlohmann/json) 3.11.3 (MIT, vendored), [QuickJS-ng](https://github.com/quickjs-ng/quickjs) 0.10.1 (MIT, downloaded by CMake; optional) |
| Ported for exactness | earcut 3.2.4 (ISC; shape and clip triangulation), mulberry32 / FNV-1a (particles), JS number formatting (`String(n)`, `toFixed`, `toPrecision`) |
| Targets | `openbone` (static, C++ and C API), `openbone_shared` → `libopenbone` (C API only), `openbone_conformance`, `openbone_unit`, `openbone_c_example` |
| Licence | MIT |

## Build and test

```bash
cmake -S runtimes/cpp -B runtimes/cpp/build -DCMAKE_BUILD_TYPE=Release
```

```bash
cmake --build runtimes/cpp/build -j
```

```bash
ctest --test-dir runtimes/cpp/build --output-on-failure
```

CTest runs one conformance test per `conformance/expected/*.json`, unit tests for the JS-semantics helpers, a binary
(`.obonb`) decoding check against the TypeScript decoder's output (`tests/data`), the C example, and `c_bounds` (the
bounding-box queries through the C API, against `conformance/expected/bounds.json`). To see the
details of a case, or to compare without the suite's tolerances:

```bash
runtimes/cpp/build/openbone_conformance --root . conformance/expected/interactive.json --case stateMachine:main --strict
```

Options: `OPENBONE_WITH_SCRIPTS` (ON; OFF builds without QuickJS, scripts are then skipped), `OPENBONE_BUILD_SHARED`
(ON), `OPENBONE_BUILD_STATIC` (ON; the tests need it), `OPENBONE_BUILD_TESTS`, `OPENBONE_INSTALL` (ON; install rules),
`OPENBONE_QUICKJS_DIR` (use a local quickjs-ng tree instead of downloading). Embedders such as the Flutter plugin
([`runtimes/flutter/openbone`](../flutter/openbone)) build only `openbone_shared` with static and install off.
The library is compiled with `-ffp-contract=off` (no fused multiply-add) so results match the reference on ARM64 too.

## C++ API

```cpp
#include <openbone/runtime.hpp>

auto doc = openbone::loadFile("knight.obone");          // .obone or .obonb; throws std::runtime_error
openbone::Instance inst(doc, openbone::createQuickJsHost());
inst.onEvent = [](const openbone::FiredEvent& e) { /* footstep, hit… */ };
inst.onAudio = [](const openbone::AudioCommand& c) { /* play / stop / fade → your audio engine */ };

inst.useStateMachine("knight");                          // or inst.play("walk", true);
inst.stateMachine->setInput("speed", openbone::Value::number(0.5));
inst.stateMachine->fire("attack");
inst.pointer(openbone::PointerEvent::Down, x, y);        // skeleton space, y up

inst.advance(dt);
for (const openbone::DrawItem& it : inst.drawList().items) {
  // it.vertices (x,y pairs), it.uvs, it.indices, it.color (or per-vertex it.colors for particles),
  // it.texture (image or atlas page id + src), it.blend, it.dark (two-colour tint), it.clip, it.text
}
```

Main types (`include/openbone/runtime.hpp`): `Document` (immutable, shareable between instances), `Instance`
(skeleton + `AnimationState` or `StateMachineInstance`), `Skeleton` (bones, slots, `setSkin`, `drawList`, `hitTest`,
`setText`, placement `x/y/scaleX/scaleY`), `AnimationState` (tracks, `setAnimation`, `addAnimation`, cross-fades),
`StateMachineInstance` (inputs, triggers, pointer, active states, bindings), `ScriptHost` (plug in your own engine).

## C API (`include/openbone.h`)

Opaque handles, plain structs, 1/0 return codes with `ob_last_error()`; meant for Swift, Dart (`dart:ffi`), C#
(`DllImport`), Python (`ctypes`) and engines that prefer C. Build `libopenbone` (`openbone_shared`) or link the static
`openbone` library with `OPENBONE_STATIC` defined.

```c
ob_document* doc = ob_document_load_file("button.obone");
ob_instance* inst = ob_instance_create(doc, OB_INSTANCE_SCRIPTS);
ob_instance_set_event_callback(inst, on_event, user);
ob_instance_set_audio_callback(inst, on_audio, user);
ob_instance_use_state_machine(inst, NULL);          /* first state machine */
ob_instance_pointer(inst, OB_POINTER_DOWN, x, y);
ob_instance_advance(inst, 1.0 / 60);
int n = ob_instance_update_draw_list(inst);
for (int i = 0; i < n; i++) {
  ob_draw_item it;
  ob_instance_draw_item(inst, i, &it);               /* pointers valid until the instance changes */
}
ob_instance_free(inst);
ob_document_free(doc);
```

Also: animation / skin / state machine / input / texture listings on the document, `ob_instance_play` / `queue`,
`set_bool` / `set_number` / `set_string` / `fire` / `get_input`, `active_state`, `set_text`, `set_transform`, bones, slots,
clipping masks (`ob_instance_clip`), bounds. [`examples/c/play.c`](examples/c/play.c) is a complete program.

## Bounding boxes and path constant speed

`Skeleton::boundingBoxes()` returns a `SkeletonBounds` snapshot of the current pose (like Spine's SkeletonBounds,
docs/runtime-spec.md §8.10): `boxes` (every slot in draw order whose bone is active and whose current attachment is a
bounding box: slot data, attachment, float32 world `vertices`, own min/max) and the overall `minX/minY/maxX/maxY`
(all 0 with no box). Queries, in skeleton space: `aabbContainsPoint`, `aabbIntersects`, `containsPoint` /
`containsPointAll`, `intersectsSegment` / `intersectsSegmentAll` (box indices, -1 / empty for none) and
`intersectsBounds(other)` (first overlapping `{mine, theirs}` pair, e.g. between two characters). Call `update(skeleton)`
or take a new snapshot after the pose changes. Bounding boxes may be weighted and deformed like meshes and paths.

```cpp
openbone::SkeletonBounds hits = inst.skeleton->boundingBoxes();
int i = hits.containsPoint(x, y);
if (i >= 0) std::printf("hit %s\n", hits.boxes[i].attachment->name.c_str());
```

C API: `ob_bounds_create` / `ob_bounds_free`, `ob_bounds_update(bounds, inst)` (returns the box count), `ob_bounds_count`,
`ob_bounds_box` (`ob_bounding_box`: slot, attachment, vertices), `ob_bounds_aabb` (0 when empty),
`ob_bounds_aabb_contains_point`, `ob_bounds_aabb_intersects`, `ob_bounds_contains_point` (index or -1),
`ob_bounds_contains_point_all(b, x, y, out, capacity)` (returns the full count), `ob_bounds_intersects_segment` /
`_all`, `ob_bounds_intersects_bounds(a, b, &mine, &theirs)`. A snapshot keeps the document alive and may outlive its
instance. These are additive, so `OB_API_VERSION` stays 1.

Path constraints read `constantSpeed` (default true: bones are placed by arc length inside each bezier segment). With
`constantSpeed: false` only the segment is found by arc length and the point inside it is at the raw bezier parameter
(Spine with "constant speed" off; spec §7.3). `PathConstraintData::constantSpeed` holds it.

## Drawing the draw list

Each item is an indexed triangle list in skeleton space (y up). Multiply the texture by `color` (straight alpha), or
by the per-vertex `colors` for particles. With `dark` set, use two-colour tint: `rgb = dark + (color.rgb − dark) ×
texture.rgb`, `a = texture.a × color.a`. Items with `clip ≥ 0` are drawn inside clip mask `clips[clip]` (stencil or
the engine's clipping). Textures are images or atlas pages (`src` is a `data:` URL or a path relative to the document;
atlas pages may be premultiplied, `Document::atlas->premultipliedAlpha`), or the built-in soft particle dot
(`@openbone/particle-dot`, `particleDotAlpha`; `ob_particle_dot_alpha` in the C API). Text items carry the resolved string, font, size, alignment, colours
and the box-to-skeleton matrix. `engines/common/openbone_assets.hpp` decodes `data:` URLs and builds the dot sprite.

## Engines

| Engine | Folder | What it is | Status here |
| --- | --- | --- | --- |
| Godot 4.4+ | [`engines/godot`](engines/godot) | GDExtension: `OpenBoneSprite` (Node2D) — loads a document, plays animations / state machines, mouse input, signals `animation_event`, `audio_command`, `state_changed`; draws with RenderingServer canvas items (clip-only canvas groups for masks, a canvas shader for two-colour tint and premultiplied pages, blend modes, text with the theme's fallback font) | Built against godot-cpp 4.4; loaded and run in **headless Godot 4.4.1** on the interactive and dynamics fixtures and the knight, rocket and campfire examples (`demo/test_headless.gd`, CTest with `-DGODOT_EXECUTABLE`) |
| SDL2 | [`engines/sdl2`](engines/sdl2) | `SDL_RenderGeometry` sample with mouse input and sound (WAV, a software mixer in SDL's audio callback); `--frames N --out frame.bmp` renders offscreen with the software renderer | Built (SDL 2.30.9 from source) and run headless; frames checked by eye; sound checked through SDL's `disk` audio driver (the campfire loop with its fade-in) |
| GLFW + OpenGL 3.3 | [`engines/glfw`](engines/glfw) | The WebGL2 renderer's shader and blending in plain OpenGL: two-colour tint, premultiplied pages, all four blend modes, stencil clipping masks; mouse input; `--frames N --out frame.png` renders into a hidden window. No GL loader library (functions come from `glfwGetProcAddress`) | Built (GLFW 3.4 from source) and run on Linux: examples, clipping, additive blending and a premultiplied polygon atlas checked by eye. Text is not rasterised; sound commands are printed |
| SFML 2.6 | [`engines/sfml`](engines/sfml) | `sf::Drawable` with triangle arrays, a GLSL two-colour tint shader, mouse input, `sf::Text` for text with `--font`, sound with `sf::Sound` when sfml-audio is available; `--out frame.png` renders into an `sf::RenderTexture` | Built (SFML 2.6.2 from source, `-DOPENBONE_FETCH_SFML=ON`) and run offscreen, without sfml-audio (no OpenAL / Vorbis / FLAC headers here); the sound code only syntax-checked against SFML's headers |
| Unreal Engine 5 | [`engines/unreal/OpenBone`](engines/unreal/OpenBone) | Plugin: `UOpenBoneComponent` (ProceduralMeshComponent, one section per draw item) over the C API, Blueprint events and calls; emits audio commands (`OnAudio`) but plays no sound | Source and build files only — **not compiled** (no Unreal Engine here) |
| Cocos2d-x 4.0 | [`engines/cocos2dx`](engines/cocos2dx) | `OpenBoneNode` queuing a `TrianglesCommand` per draw item, `Label` text with outlines in the document's fonts, touch and mouse input | Built and run with Cocos2d-x 4.0 on Linux (Ubuntu 22.04, GCC 11): the knight and Windswept with their state machines, textures, meshes, blend modes and text |

### Godot

```bash
cmake -S runtimes/cpp/engines/godot -B build-godot -DCMAKE_BUILD_TYPE=Release   # add -DGODOT_CPP_DIR=… to use a local godot-cpp
```

```bash
cmake --build build-godot -j
```

The library lands in `engines/godot/demo/bin/`; copy `demo/openbone.gdextension` and `demo/bin/` into your project
(or open `demo/`, after copying `examples/knight.obone` into it and linking its art: `ln -s ../../../../../examples/assets demo/assets`). Then:

```gdscript
var knight := OpenBoneSprite.new()
knight.state_machine = "knight"
add_child(knight)
knight.load("res://knight.obone")
knight.set_input("speed", 0.5)
knight.fire("attack")
knight.animation_event.connect(func(name, time, i, f, s): print(name))
knight.audio_command.connect(func(cmd): print(cmd))   # {type, id, sound, asset, bus, volume, rate, loop, …}
```

Headless check: `godot --headless --path runtimes/cpp/engines/godot/demo -s test_headless.gd -- <file.obone>`.
Screen blending falls back to additive (Godot canvas materials have no screen mode).

### GLFW (OpenGL 3.3)

```bash
cmake -S runtimes/cpp/engines/glfw -B build-glfw -DCMAKE_BUILD_TYPE=Release && cmake --build build-glfw -j
```

```bash
build-glfw/openbone_glfw examples/knight.obone                         # a window; click the knight
build-glfw/openbone_glfw examples/button.obone --frames 30 --out button.png   # hidden window → PNG
```

Uses an installed GLFW 3.3+ or builds GLFW 3.4 from source (X11 headers needed on Linux). The sample is one file,
`engines/glfw/main.cpp`: copy its `Renderer` and `Textures` into an OpenGL game to draw OpenBone documents there.

### SDL2, SFML

```bash
cmake -S runtimes/cpp/engines/sdl2 -B build-sdl2 -DCMAKE_BUILD_TYPE=Release && cmake --build build-sdl2 -j
```

```bash
build-sdl2/openbone_sdl2 examples/knight.obone
```

SFML: the same with `engines/sfml` (`-DOPENBONE_FETCH_SFML=ON` builds SFML 2.6.2 if it isn't installed; on Linux
that needs the X11/Xrandr/Xcursor/udev/OpenGL/FreeType development packages). SDL's renderer has no stencil or
shaders, so the SDL2 sample skips clipping masks, two-colour tint and text; SFML 2 skips clipping masks.

Both samples play the document's sounds: gain `volume × bus volume (0 if muted) × master (0 if the document is
muted)`, rate, looping, fade-in, stop fades and `fade` commands (the sound's new volume, keeping the voice's bus and
master gain), stepped every frame by `ob::audio::Mixer` (`engines/common/openbone_audio.hpp`, unit-tested by the
`engine_audio` CTest). `--mute` turns sound off; the commands are printed either way, and offscreen renders are silent.

- **SDL2** uses SDL's own audio, no extra library: WAV files are loaded with `SDL_LoadWAV_RW`, converted to the
  device's float stereo once and mixed in the audio callback (per-voice gain ramped across each buffer, looping, rate
  by linear-interpolation resampling). Other formats are skipped with a message (the examples are all WAV).
- **SFML** uses `sf::SoundBuffer` + `sf::Sound` (WAV, OGG, FLAC, MP3; rate as pitch) when sfml-audio is found or
  can be built (`OPENBONE_SFML_AUDIO`, on by default). SFML 2's audio module links **OpenAL Soft (LGPL-2.1)** as a
  shared library, plus libogg / libvorbis / libFLAC (BSD); building it from source on Linux needs their development
  packages, and without them CMake warns and builds the sample silent. `-DOPENBONE_SFML_AUDIO=OFF` leaves sfml-audio
  out entirely.

### Unreal Engine 5

Build and install the static library into the plugin, per platform:

```bash
cmake -S runtimes/cpp -B build-ue -DCMAKE_BUILD_TYPE=Release -DOPENBONE_BUILD_SHARED=OFF -DOPENBONE_BUILD_TESTS=OFF
```

```bash
cmake --build build-ue --config Release && cmake --install build-ue --prefix runtimes/cpp/engines/unreal/OpenBone/ThirdParty/openbone/Linux
```

(use `Win64` / `Mac` as the last folder on those platforms), copy `engines/unreal/OpenBone` into your project's
`Plugins/`, add an `OpenBone` component to an actor, set `DocumentPath` (relative to `Content/`) and a translucent
unlit two-sided `Material` with a `Texture` parameter (× vertex colour; optional `Dark` vector for two-colour tint).

Sound: the plugin **only emits audio commands** — the `OnAudio` Blueprint event (command, sound, volume); it does not
play them. Play them with your own `USoundBase` / `UAudioComponent` setup.

### Cocos2d-x

Include `engines/cocos2dx/CMakeLists.txt` from your game's CMake (see the file), link `openbone_cocos2dx`, then
`auto* n = OpenBoneNode::create("knight.obone"); n->useStateMachine(); n->enableTouch();`. The node plays the document's
sounds with `cocos2d::AudioEngine` (volume × bus × master, looping, fades; Cocos has no playback rate);
`setAudioEnabled(false)` leaves them to your `onAudio` callback.

Text attachments are `cocos2d::Label` children drawn on top of the skeleton, with their outline. Each text's font list
("Noto Serif JP, Georgia, serif") resolves to the first family that has all its characters: files you map with
`setFontFile("Noto Serif JP", "fonts/NotoSerifJP-Regular.otf")` first, then (Linux) installed fonts through
fontconfig; on other platforms the first family is used as a system font. Ship the fonts your documents name.
`setTextEnabled(false)` turns text off.

Cocos2d-x 4.0 itself needs two fixes to build on current Linux distributions (both in Cocos, not OpenBone):
add `#include <memory>` to `cocos/network/SocketIO.h`, and, because the prebuilt Chipmunk library was linked against
glibc < 2.31, define the two functions it still expects in your game:

```cpp
#include <cmath>
extern "C" float __powf_finite(float x, float y) { return std::pow(x, y); }
extern "C" float __expf_finite(float x) { return std::exp(x); }
```

## Porting notes

Things that mattered for exact parity (see also spec §12):

- **Earcut**: ported line by line from earcut 3.2.4 (the version the TypeScript runtime uses); other triangulators
  (or other earcut versions) can give different indices. Note that earcut's own doc comment shows `[1,0,3, 3,2,1]`
  for its example quad, while 3.2.4 actually returns `[1,0,3, 1,3,2]`.
- **JS numbers**: `toFixed` rounds exact decimal ties up (`(2.5).toFixed(0)` is `"3"`, `printf` says `"2"`) and
  `String(n)` is the shortest round-trip form; both are implemented on exact decimal expansions (`jsnum.cpp`).
- **Object key order**: the hit-test fallback picks the first bounding box in JS key order (integer-like names
  first); attachments keep the file's order.
- **float32**: world vertices (including path input), uvs and particle buffers are stored as `float`, maths in
  `double`. The C library's `sin`/`cos`/`atan2`/`exp` were close enough to V8's that every case passes strictly.
