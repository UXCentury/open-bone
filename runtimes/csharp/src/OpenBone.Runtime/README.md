# OpenBone.Runtime

The [OpenBone](https://github.com/UXCentury/open-bone) runtime for .NET (netstandard2.1 and net8.0): load `.obone`
(JSON) and `.obonb` (binary) files exported by the OpenBone editor and play them: skeletons, skins, every attachment
type, animations and mixing, IK / transform / path / physics constraints, particles, sprite sequences, text, state
machines, events and audio commands. It produces a renderer-agnostic draw list, so it works with any engine. It passes
the cross-language OpenBone conformance suite. No dependencies.

```csharp
using OpenBone;

var doc = DocumentLoader.Load(File.ReadAllBytes("hero.obone"));   // or .obonb
var hero = new OpenBoneInstance(doc);
hero.Event += e => Console.WriteLine($"{e.Name} at {e.Time}");
hero.Play("walk");                                                // or: var sm = hero.UseStateMachine("main");

// every frame
hero.Advance(dt);
foreach (var item in hero.DrawList())
{
    // item.Vertices (world x,y, y up), item.Uvs, item.Indices, item.Texture, item.Color, item.Blend, item.Clip, ...
}
```

State-machine scripts need a script host: add
[OpenBone.Scripting.Jint](https://www.nuget.org/packages/OpenBone.Scripting.Jint). For MonoGame, use
[OpenBone.MonoGame](https://www.nuget.org/packages/OpenBone.MonoGame). For Unity, install the `com.openbone.runtime`
package instead (see the [C# runtime README](https://github.com/UXCentury/open-bone/tree/main/runtimes/csharp#readme)).

Documentation: [C# runtime](https://github.com/UXCentury/open-bone/tree/main/runtimes/csharp#readme) ·
[runtime spec](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md). License: MIT.
