# OpenBone for Haxe

A native Haxe port of the TypeScript runtime (`packages/runtime`), in pure Haxe with no dependencies (no haxelibs). It
loads `.obone` and `.obonb` files and implements everything in [docs/runtime-spec.md](../../docs/runtime-spec.md):
skeletons, skins and skin bones, every attachment type, animation mixing, IK / transform / path / physics constraints
in custom order, sliders, sprite sequences, packed / trimmed / rotated / polygon atlases, particles (same mulberry32
RNG), text templates, the draw list (clipping, two-colour tint), state machines with listeners and input bindings,
events and audio commands. It does no rendering: draw the `DrawItem`s with your engine (Heaps, OpenFL, Kha, Ceramic…).

## Status

| Target | Command | Conformance (92 cases in 21 files) |
|---|---|---|
| JS (node) | `haxe test-js.hxml` | **92/92** (scripts run on node's JavaScript engine) |
| eval (interpreter) | `haxe test.hxml` | **86/92**, 6 scripted cases skipped |
| Python 3 | `haxe test-python.hxml` | **86/92**, 6 scripted cases skipped |

Each command also runs the unit tests (`test/UnitTest.hx`: JS number strings, `toFixed` ties, `Math.fround`,
templates, mulberry32, FNV-1a, earcut, `.obonb` decoding against the TypeScript decoder's output). Checked with Haxe
4.3.7, node 20 and Python 3.12. Other targets (HashLink, C++, JVM, C#…) should work, since the runtime uses only the
standard library, but have not been run.

**Skipped: state machine scripts outside JS.** Scripts are JavaScript (docs/runtime-spec.md §11) and Haxe has no
JavaScript engine of its own. On the JS target `openbone.JsScriptHost` runs them on the engine the program runs on;
elsewhere pass no host and scripts are ignored, like the other runtimes do without one. The conformance runner then
skips the cases whose state machine uses scripts and lists them (they would fail, because the scripts move bones or
set inputs): `atlas-knight`, `atlas-polygons` and `example-knight` (parallax scrolling), `atlas-walker` and
`example-walker` (speed easing and scrolling), `interactive` (a click counter). Every other case passes. To run
scripts on another target, implement `openbone.ScriptHost` for an engine you embed (QuickJS through hxcpp externs, for
example); `ScriptPrelude.PRELUDE` is the `ob` object every host evaluates before the script.

`JsScriptHost` evaluates scripts with `new Function` in the page or process: no sandbox, memory cap or per-call time
limit (the reference QuickJS host has all three). Only run documents you trust with it.

## Build and test

Install Haxe 4.3 or newer ([haxe.org/download](https://haxe.org/download)); the JS run needs node, the Python run
python3. From this folder:

```bash
haxe test.hxml          # eval: unit tests + conformance
haxe test-js.hxml       # compile to bin/*.cjs and run on node
haxe test-python.hxml   # compile to bin/*.py and run on python3
```

Runner options: `--only <expected file name>`, `--verbose` (one line per case), `--repo <path>` (default `../..`; or
set `OPENBONE_REPO`). For example `haxe -cp src -cp test --run Conformance --only interactive --verbose` on eval, or
`node bin/conformance.cjs --only example-knight` after `haxe test-js.hxml`.

## Haxe

Add `runtimes/haxe/src` to your class path (`-cp`).

```haxe
import openbone.OpenBoneInstance;
import openbone.DrawItem;
import openbone.data.DocumentLoader;

class Main {
	static function main() {
		var doc = DocumentLoader.load(sys.io.File.getBytes("knight.obone")); // .obone or .obonb bytes
		var inst = new OpenBoneInstance(doc); // or new OpenBoneInstance(doc, new openbone.JsScriptHost()) on JS
		inst.addListener(new MyListener()); // extends InstanceListener: event(e), stateChange(layer, from, to), audio(cmd)

		var sm = inst.useStateMachine("knight"); // or inst.play("walk", true)
		sm.setInput("walk", true);
		sm.fire("attack");
		inst.pointer("down", x, y); // skeleton space, y up; inst.artboardToSkeleton(px, py) converts artboard pixels

		inst.advance(1 / 60);
		for (it in inst.drawList()) {
			// it.vertices, it.uvs, it.indices, it.color, it.dark, it.blend, it.texture.id, it.clip, it.colors, it.text…
		}
	}
}
```

`inst.skeleton` gives bones (`world` matrices), slots, `setSkin`, `findBone`, `hitTest`, particle controls and
`setText`. `inst.animationState` queues and mixes animations on tracks (`setAnimation`, `addAnimation`). Draw item
vertices are skeleton space (y up); uvs are in the item's texture (an image, or an atlas page when packed), v down.

Bounding boxes (like Spine's `SkeletonBounds`, docs/runtime-spec.md §8.10): `inst.skeleton.boundingBoxes()` returns an
`openbone.SkeletonBounds` snapshot of the current pose: `boxes` (`BoundingBoxPolygon`: `slot`, `attachment` name, world
`vertices`, own `minX`..`maxY`) for every active slot in draw order whose current attachment is a bounding box, and the
overall `minX`, `minY`, `maxX`, `maxY` (all 0 with no box). Queries: `aabbContainsPoint(x, y)`,
`aabbIntersects(minX, minY, maxX, maxY)`, `containsPoint(x, y)` / `containsPointAll`, `intersectsSegment(x1, y1, x2, y2)`
/ `intersectsSegmentAll` (first match or every match, in draw order) and `intersectsBounds(other)` (the first overlapping
`[mine, theirs]` pair with another skeleton's bounds, or null). Call `update(skeleton)` on it, or take a new one, after
the pose changes. Bounding boxes may be weighted and deformed like meshes and paths.

Path constraints honour `constantSpeed` (default true: arc-length placement). With `constantSpeed: false` the segment
is still found by arc length but the point inside it is at the raw bezier parameter, so bones bunch up where the handles
are short (Spine's "constant speed" off).

Audio: the runtime never plays sound. It emits `AudioCommand`s (`play` with sound, asset, bus, volume, rate, loop,
fade-in; `stop` with a fade; `fade`; `mix` with `bus` (null = the master) and `muted`, from a `setMute` listener
action); feed them to your audio API and apply `doc.audio` bus and master volumes, with `mix` mutes on top
(`inst.stateMachine.audio.isMuted(bus)` gives the current state).

## Porting notes

- `openbone.JsNum` gives every target JavaScript's number behaviour: `String(n)`, `toFixed` (exact, ties up),
  `toPrecision`, `Number(string)` and `Math.fround`. The JS target uses the engine's own functions; the others compute
  them exactly from the double's binary value, so text templates and float32 rounding match byte for byte.
- `openbone.Json` keeps object keys in file order on every target (hit-test fallback and attachment order depend on
  it); `haxe.Json`'s field order varies by target.
- Integer maths for the RNG and hash goes through `haxe.Int32`, so it wraps mod 2³² on JS too.
- Sorts that must be stable use `haxe.ds.ArraySort`.
- `Earcut` is a port of mapbox earcut 3.2.4 (ISC); the suite compares triangle indices exactly.

## Layout

| Path | What it is |
|---|---|
| `src/openbone/data` | Document model (`Model.hx`) and `DocumentLoader` (JSON and binary) |
| `src/openbone` | `OpenBoneInstance`, `Skeleton`, `SkeletonBounds`, `AnimationState`, `StateMachineInstance`, `AudioDirector`, `ParticleEmitter`, `DrawItem`, maths, templates, earcut, `JsScriptHost` |
| `test/Conformance.hx` | Conformance runner (same checks and tolerances as the Java, C# and C++ runners) |
| `test/UnitTest.hx`, `test/data` | Porting-trap unit tests and their `.obonb` fixtures |
