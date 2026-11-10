# OpenBone.Scripting.Jint

Script host for [OpenBone](https://github.com/UXCentury/open-bone) state machines. It runs the document's JavaScript
in [Jint](https://github.com/sebastienros/jint) (BSD-2-Clause) with the same `ob` API, hooks and limits as the
reference QuickJS host: a CPU deadline per call (16 ms, 50 ms for loading, configurable) and an 8 MB memory limit.

```csharp
using OpenBone;
using OpenBone.Scripting;

var doc = DocumentLoader.Load(File.ReadAllBytes("hero.obone"));
var hero = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = new JintScriptHost() });
var sm = hero.UseStateMachine("main");
sm.SetInput("speed", 0.5);
sm.Fire("jump");
hero.Advance(dt);
```

Documentation: [C# runtime](https://github.com/UXCentury/open-bone/tree/main/runtimes/csharp#readme). License: MIT.
