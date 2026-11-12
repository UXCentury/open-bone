# OpenBone.Runtime

The OpenBone runtime for .NET: load `.obone` and `.obonb` files and play skeletons, animations and state machines.

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging and
Rive-style interactive state machines. This package is a native C# port of the reference runtime. It covers skeletons,
skins, every attachment type, animation mixing, IK, transform, path and physics constraints, particles, sprite
sequences, text, packed atlases, state machines, events and audio commands. It passes the cross-language OpenBone
conformance suite.

The runtime does not draw anything. Each frame it gives you a draw list (vertices, UVs, triangles, texture, colour,
blend mode, clipping), so you can render it with any engine. It targets netstandard2.1 and net8.0 and has no
dependencies.

## Install

```bash
dotnet add package OpenBone.Runtime
```

- State-machine scripts need a script host: add [OpenBone.Scripting.Jint](https://www.nuget.org/packages/OpenBone.Scripting.Jint).
- MonoGame: [OpenBone.MonoGame](https://www.nuget.org/packages/OpenBone.MonoGame) adds a renderer, input and sound.
- Unity: use the `com.openbone.runtime` package instead (see below).

## Quick start

```csharp
using OpenBone;

var doc = DocumentLoader.Load(File.ReadAllBytes("knight.obone"));   // or a .obonb file
var hero = new OpenBoneInstance(doc);
hero.Event += e => Console.WriteLine($"event {e.Name} at {e.Time}");
hero.AudioCommand += c => Console.WriteLine($"audio {c.Type} {c.Sound}");

hero.Play("walk");                                      // loops by default

// Once per frame:
hero.Advance(dt);
foreach (var item in hero.DrawList())
{
    // item.Vertices: world x,y pairs (y up)    item.Uvs: 0..1 (v down)    item.Indices: triangles
    // item.Texture: image or atlas page (null = untextured)    item.Color, item.Dark, item.Blend, item.Clip
}
```

Queue animations and change skins through `AnimationState` and `Skeleton`:

```csharp
hero.Skeleton.SetSkin("default");
hero.Play("attack", loop: false);
hero.AnimationState.AddAnimation(0, "idle", loop: true);
```

## State machines

```csharp
var button = new OpenBoneInstance(DocumentLoader.Load(File.ReadAllBytes("button.obone")));
var sm = button.UseStateMachine("ui");                  // or UseStateMachine() for the first one
sm.StateChanged += s => Console.WriteLine($"{s.Layer}: {s.From} -> {s.To}");

sm.SetInput("hover", true);
sm.Fire("press");
button.Advance(dt);

// Pointer input for listeners is in skeleton space (y up). Convert from artboard pixels first:
button.ArtboardToSkeleton(px, py, out var x, out var y);
button.Pointer("down", x, y);
```

Without a script host, scripts attached to the document are skipped and everything else runs.

## Main API

| Type | What it does |
|---|---|
| `DocumentLoader` | `Load(byte[])` reads `.obone` (JSON) or `.obonb` (binary) and returns a `Document`. `FromJson(string)` reads JSON. Throws `OpenBoneFormatException` for data that is not an OpenBone document or is a newer version, and `OpenBone.Json.JsonException` for malformed JSON. |
| `Document` | The loaded data: artboard size and origin, images, fonts, atlas, skeleton, animations, state machines, scripts, audio. `Fonts` lists the document's own font files (`FontAsset`: `Family`, `Src` as a data: URI or a path relative to the document, `Weight`, `Style`); `PickFont(fontList, weight)` applies the matching rule every runtime shares (first family in the list the document has fonts for, closest weight). |
| `OpenBoneInstance` | The usual entry point. `Play`, `UseStateMachine`, `Advance(dt)`, `DrawList()`, `Pointer`, `ArtboardToSkeleton`, events `Event`, `StateChanged`, `AudioCommand`. `OpenBoneInstance.Load(bytes)` loads and creates in one call. |
| `AnimationState` | Tracks and mixing: `SetAnimation`, `AddAnimation` (with delay and mix), `ClearTrack`, `ClearTracks`. |
| `Skeleton` | Bones, slots and draw order: `FindBone`, `FindSlot`, `SetSkin`, `SetToSetupPose`, `UpdateWorldTransform`, `BoundingBoxes()`. |
| `SkeletonBounds` | Active bounding boxes of one pose (skeleton space, y up): `Boxes`, `MinX`..`MaxY`, `Update`, `AabbContainsPoint`, `AabbIntersects`, `ContainsPoint(All)`, `IntersectsSegment(All)`, `IntersectsBounds(other)`. |
| `StateMachineInstance` | `SetInput`, `SetBool`, `SetNumber`, `SetString`, `Fire`, `SetText`, `GetInput`, `ActiveStates`, events `StateChanged`, `InputChanged`, `Event`, `AudioCommand`, `Log`, `Error`. |
| `DrawItem` | One piece of geometry: `Vertices`, `Uvs`, `Indices`, `Texture`, `TextureRect`, `Color`, `Colors` (per vertex), `Dark` (two-colour tint), `Blend`, `Clip`, `Text`, `Particles`. |
| `AudioCommand` | A sound instruction for your audio backend: `Type` is `play`, `stop` or `fade`, with the sound id, asset, bus, volume, rate, loop and fade times. |
| `StateMachineOptions` | Options for state machines: `ScriptHost`. |
| `IScriptHost` | Interface for a script engine. `OpenBone.Scripting.Jint` implements it. |

## Unity

Unity users should install the `com.openbone.runtime` package, which includes this runtime plus an importer,
components, a mesh generator, a shader and an audio bridge. In the Package Manager, choose **Add package from git URL**
and enter:

```text
https://github.com/UXCentury/open-bone.git#upm
```

## Documentation

- [C# runtime](https://github.com/UXCentury/open-bone/blob/main/runtimes/csharp/README.md)
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md)
- [File format](https://github.com/UXCentury/open-bone/blob/main/docs/format.md)
- [Unity package](https://github.com/UXCentury/open-bone/blob/main/runtimes/csharp/unity/com.openbone.runtime/README.md)
- [Changelog](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md)

## License

MIT. Copyright (c) UX Century and OpenBone contributors. See
[LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE).
