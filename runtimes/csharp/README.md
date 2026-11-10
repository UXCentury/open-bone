# OpenBone C# runtime

A native C# port of the OpenBone runtime (`packages/runtime`), for .NET and Unity. It follows
[docs/runtime-spec.md](../../docs/runtime-spec.md) rule by rule and passes every case of the cross-language
[conformance suite](../../conformance/README.md): bone world matrices, slot states, draw lists, events, audio commands
and state-machine states, frame by frame, within the suite's tolerances.

| Project | Target | What |
|---|---|---|
| `src/OpenBone.Runtime` | netstandard2.1, net8.0 | Loading (`.obone` JSON and `.obonb` binary), skeleton, skins and skin bones, every attachment type, animations and mixing (`AnimationState`), IK / transform / path / physics constraints in custom order, reference scale, sliders, particles (same seeded RNG), sprite sequences, text templates, packed atlases (trimmed, rotated, polygon), the draw list (clipping, two-colour tint, blend modes), state machines (inputs, blend states, transitions, listeners, bindings), events and audio commands. No dependencies. |
| `src/OpenBone.Scripting.Jint` | netstandard2.1, net8.0 | Script host: state-machine scripts run in [Jint](https://github.com/sebastienros/jint) (BSD-2-Clause) with the same `ob` API, hooks and limits as the QuickJS host. |
| `tests/OpenBone.Runtime.Tests` | net8.0 | xUnit: the conformance suite, `.obonb` decoding, JS number formatting, earcut. |
| `unity/com.openbone.runtime` | Unity 2021.3+ | Unity package: importer, components, mesh generator, shader, audio bridge. See its [README](unity/com.openbone.runtime/README.md). |
| `unity/compile-check` | netstandard2.1 | Type-checks the Unity package against a stub of the Unity API (no Unity needed). |
| `monogame/src/OpenBone.MonoGame` | net8.0, MonoGame 3.8 DesktopGL | MonoGame renderer, player component and sound bridge. See [MonoGame](#monogame). |
| `monogame/sample/OpenBone.MonoGame.Sample` | net8.0 | DesktopGL sample: the knight example with its state machine. |
| `monogame/tests/OpenBone.MonoGame.Tests` | net8.0 | xUnit, no window: meshing, render states, view transform, pointer, audio maths, effect container. |

## Install

```bash
dotnet add package OpenBone.Runtime
dotnet add package OpenBone.Scripting.Jint   # state-machine scripts
dotnet add package OpenBone.MonoGame         # MonoGame DesktopGL integration (brings the other two)
```

Unity: Package Manager → Add package from git URL → `https://github.com/UXCentury/open-bone.git#upm` (or OpenUPM:
`openupm add com.openbone.runtime`); see the [Unity package README](unity/com.openbone.runtime/README.md#install).

## Build and test

Needs the [.NET 8 SDK](https://dot.net) (a user-local install works: `./dotnet-install.sh --channel 8.0`).

```bash
cd runtimes/csharp
dotnet test                         # conformance suite + unit tests
dotnet build unity/compile-check    # Unity package against the Unity API stub
```

The conformance tests find `conformance/expected/*.json` by walking up from the test binaries, so run them inside the
repository. A failure lists the case, sample time and the first differing value (bone, slot, draw item field, event,
audio command or state).

Packages: `dotnet pack OpenBone.sln -c Release -o out` and `dotnet pack monogame/src/OpenBone.MonoGame -c Release -o out`
make the three `.nupkg` / `.snupkg` pairs (shared metadata in `Directory.Build.props`, a README per package next to its
`.csproj`). Releases publish them with `.github/workflows/publish-dotnet.yml` and the Unity package with
`publish-unity.yml` (see [docs/releasing.md](../../docs/releasing.md)).

## Use

```csharp
using OpenBone;
using OpenBone.Scripting;

var doc = DocumentLoader.Load(File.ReadAllBytes("hero.obone"));   // or .obonb
var hero = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = new JintScriptHost() });
hero.Event += e => Console.WriteLine($"{e.Name} at {e.Time}");
hero.AudioCommand += c => audioBackend.Handle(c);                // play / stop / fade

hero.Skeleton.SetSkin("armored");
hero.Play("walk");                                                // or: var sm = hero.UseStateMachine("main");
hero.AnimationState.AddAnimation(0, "jump", loop: false);

// every frame
hero.Advance(dt);
foreach (var item in hero.DrawList())
{
    // item.Vertices (world x,y, y up), item.Uvs (v down), item.Indices, item.Texture (image or atlas page),
    // item.Color / item.Colors, item.Dark (two-colour tint), item.Blend, item.Clip, item.Text, item.Particles
}
```

State machines: `sm.SetInput("speed", 0.5)`, `sm.Fire("jump")`, `hero.Pointer("down", x, y)` (skeleton space, y up),
`sm.ActiveStates`, events `StateChanged`, `InputChanged`, `Error`, `Log`.

## MonoGame

`monogame/` (its own solution, `OpenBone.MonoGame.sln`, so the runtime's `dotnet test` needs no MonoGame packages):

```bash
cd runtimes/csharp/monogame
dotnet test                                              # window-less tests
dotnet run --project sample/OpenBone.MonoGame.Sample     # the knight: click his body (attack), head (salute) or the road (walk)
```

```csharp
using OpenBone.MonoGame;

// LoadContent (the back buffer needs a stencil for clipping masks:
// graphics.PreferredDepthStencilFormat = DepthFormat.Depth24Stencil8)
knight = OpenBoneMonoGame.Load(GraphicsDevice, "Content/knight.obone");   // images and sounds relative to the file
knight.UseStateMachine("knight");                                          // or knight.Play("walk")
knight.Event += e => Console.WriteLine(e.Name);
knight.AcceptInput = () => IsActive;

// Update
knight.Update(gameTime);        // mouse / touch → listeners, Advance, sound fades
// Draw (after GraphicsDevice.Clear; no SpriteBatch)
knight.Draw();
```

- **`OpenBoneRenderer`** draws a draw list with `GraphicsDevice.DrawUserIndexedPrimitives`: one call per run of items
  that share a texture, blend mode and clip (`DrawListMesher` builds the vertex / 16-bit index arrays and batches
  without a device). Textures are premultiplied on load (`Texture2D.FromStream` with a colour processor; atlas pages
  packed with `premultipliedAlpha` are uploaded as they are) and vertex colours are premultiplied, so normal, additive,
  multiply and screen are each one `BlendState` (`RenderStates`). Clipping masks write the stencil buffer
  (`DepthStencilState` replace → equal → zero), so the back buffer or render target needs a stencil format.
  `SkeletonView` maps skeleton space (y up) to screen pixels; `FitStage` frames the document's canvas.
- **Two-colour tint.** MonoGame's effect compiler (mgfxc) needs Windows or Wine to compile HLSL, so the library ships
  the effect source (`Shaders/OpenBoneTint.fx`) and builds the OpenGL effect itself: `TintEffect` writes the MGFX
  container with hand-written GLSL equivalent to the .fx (MGFX stores GLSL for OpenGL). If the running MonoGame does
  not accept it (another MGFX version, or a DirectX build), the renderer falls back to `BasicEffect`, which draws
  everything except the dark colour; `Renderer.EffectError` says why. You can pass your own compiled effect
  (`Renderer.Effect`, parameters `WorldViewProjection` and `Texture`, vertices `OpenBoneVertex`).
- **Text** items are skipped unless you set `Renderer.TextRenderer`; `SpriteFontTextRenderer` draws them with your
  SpriteFonts (size, alignment, fill × slot colour, outline as offset copies; weight is ignored).
- **`OpenBoneMonoGame`** loads a `.obone` / `.obonb` (textures from data: URIs or files relative to the document; scripts
  in Jint), plays animations or a state machine, maps `Mouse` / `TouchPanel` input into skeleton space for listeners
  (`Pointer(type, screenPosition)` to send your own), and raises `Event`, `StateChanged`, `AudioCommand` and `Warning`.
- **`OpenBoneSoundPlayer`** plays audio commands with `SoundEffect` / `SoundEffectInstance`: volume = command volume ×
  bus × master (× `Volume`), pitch = log2(rate) clamped to MonoGame's ±1 octave, looping, and fade-in / fade / stop-with-
  fade stepped every frame (`AudioMixer`, engine-independent). Sounds are WAV (embedded or files); register other
  `SoundEffect`s with `Set(assetId, effect)`.

Dependencies: [MonoGame.Framework.DesktopGL](https://github.com/MonoGame/MonoGame) 3.8.6.1 (Ms-PL, a permissive
licence: it asks to keep its notices and to license source you distribute *of MonoGame itself* under Ms-PL; it puts no
terms on your code), which brings SDL2 (zlib), NVorbis (MIT) and an OpenAL Soft build (`MonoGame.Library.OpenAL`;
OpenAL Soft is LGPL-2.0+, loaded as a shared library, as in every MonoGame DesktopGL game). Checked on Linux (Mesa,
OpenGL 4.6): the sample renders the knight in a window and off-screen (`--screenshot out.png --frames 60
--click 520,460@5`), with clipping (campfire), additive particles (rocket), the tint effect and the BasicEffect
fallback (`--basic-effect`). Not run on Windows or macOS yet.

## Porting notes

The reference is JavaScript; the places where that shows (docs/runtime-spec.md §12) are handled explicitly:

- **Numbers.** `Js.NumberToString` (shortest round-trip, JS exponent rules), `Js.ToFixed` / `Js.ToPrecision` (exact
  decimal expansion, ties round up), `Js.StringToNumber`, `Js.Hypot` (V8's scaled, compensated algorithm). Text
  templates and `.obonb` float32 decoding depend on these; `tests/.../data/js-numbers.json` holds node's outputs.
- **float32 storage** for world vertices, uvs and particle buffers (`float[]`), doubles elsewhere.
- **32-bit integer maths** for the particle RNG (mulberry32) and the FNV-1a slot hash (`uint` arithmetic).
- **Insertion-ordered maps** where JavaScript iteration order is observable: playing sounds (stop order), input values,
  attachment lookup for the hit-test fallback (JS object key order: integer-like keys first).
- **earcut**: a line-by-line port of mapbox earcut 3.x (no-holes path), checked against the library's own output.
- **Stable sorts** for constraint order, blend entries, transition candidates and gradient stops.
- **JSON**: a small built-in reader (`OpenBone.Json`) instead of System.Text.Json, so the same code runs in Unity without
  extra assemblies; object keys keep their order.
- Input values are boxed `bool` / `double` / `string`; `Js.StrictEquals`, `Js.Truthy`, `Js.ToNumber` and `Js.ToStr`
  reproduce `===`, truthiness, `Number()` and `String()` for conditions, bindings and templates.

## Scripts

`JintScriptHost` mirrors `packages/scripting` (QuickJS): one engine per script, a prelude that exposes a frozen `ob`
whose calls cross to C# as JSON, `typeof fn === "function"` checks, and a CPU deadline (16 ms per call, 50 ms for
loading, configurable) plus an 8 MB memory limit. The conformance tests give the engine generous budgets because a cold
.NET JIT can exceed 16 ms on the first call; the suite also passes with the defaults.

## Status

- Conformance: all files in `conformance/expected/` pass (`dotnet test`).
- MonoGame: library, sample and tests built and run on Linux (see [MonoGame](#monogame)).
- Unity package: checked in Unity 6 (6000.6.8f1) on Linux: every example imports (art and sounds included), runs its state machine, renders (textures, meshes, blend modes, clipping, text) and plays in the editor with pointer input and sound. Older Unity versions (2021.3+) are only compile-checked against the stub.
