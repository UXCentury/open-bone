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
- Unity package: complete source, compile-checked against the stub; **not yet run in the Unity Editor**.
