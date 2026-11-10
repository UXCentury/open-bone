# OpenBone.Scripting.Jint

Runs the JavaScript in OpenBone state machines on .NET, using the Jint interpreter.

[OpenBone](https://github.com/UXCentury/open-bone) state machines can carry small scripts that react to pointer input,
events and time, and that drive inputs, bones and slots. [OpenBone.Runtime](https://www.nuget.org/packages/OpenBone.Runtime)
runs state machines without them. Add this package to run the scripts too. It runs them in
[Jint](https://github.com/sebastienros/jint) (BSD-2-Clause) with the same `ob` API, hooks and limits as the reference
QuickJS host, and passes the OpenBone conformance suite. It targets netstandard2.1 and net8.0.

## Install

```bash
dotnet add package OpenBone.Scripting.Jint
```

This also installs OpenBone.Runtime.

## Quick start

Pass a `JintScriptHost` when you create the instance:

```csharp
using OpenBone;
using OpenBone.Scripting;

var doc = DocumentLoader.Load(File.ReadAllBytes("walker.obone"));
var walker = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = new JintScriptHost() });

var sm = walker.UseStateMachine("character");
sm.Log += args => Console.WriteLine("script: " + string.Join(" ", args));   // console.log / ob.log
sm.Error += e => Console.WriteLine("script error: " + e.Message);           // errors and timeouts

sm.SetInput("walk", true);
sm.SetInput("speed", 1.0);
sm.Fire("jump");

// Once per frame:
walker.Advance(dt);

// When you are done (disposes the script engines):
walker.Dispose();
```

## What scripts can do

Each script gets its own Jint engine. It sees only a frozen global `ob` object and `console.log`. Arguments and return
values cross between C# and JavaScript as JSON.

| Hook | When it runs |
|---|---|
| `onStart()` | Machine scripts: on the first `Advance`. State scripts: each time the state is entered. |
| `onUpdate(dt)` | Every `Advance`. |
| `onPointer({type, x, y})` | Machine scripts, for each pointer event, before listeners. |
| `onEvent(e)` | After posing, for each fired event. |

| `ob` call | Effect |
|---|---|
| `time()` | Seconds since the state machine started |
| `input(n)`, `setInput(n, v)`, `fire(n)` | Read and change inputs, by name or id |
| `emit(name, {int, float, string})` | Fire an event (and play its sound) |
| `bone(n)`, `setBone(n, props)` | Read a bone's pose, or override it |
| `slot(n, {color, attachment})` | Override a slot's colour or attachment |
| `pointer()` | `{x, y, down}` |
| `log(...)` | Raise the state machine's `Log` event |

A script error or timeout raises the state machine's `Error` event (a `ScriptException`), and playback goes on.

## Limits

`JintScriptHost` has public fields for its limits. The defaults match the reference host.

| Field | Default | Meaning |
|---|---|---|
| `CallTimeout` | 16 ms | CPU budget for each hook call |
| `LoadTimeout` | 50 ms | Budget for running a script's top level. Each function's first call also gets this budget, to cover warm-up. |
| `MemoryLimit` | 8 MB | Memory limit per script, in bytes (0 = no limit) |
| `MaxRecursionDepth` | 512 | Maximum call depth |

```csharp
var host = new JintScriptHost
{
    CallTimeout = TimeSpan.FromMilliseconds(32),
    LoadTimeout = TimeSpan.FromMilliseconds(100),
    MemoryLimit = 16 * 1024 * 1024,
};
```

## Unity

Unity users should install the `com.openbone.runtime` package, which brings the runtime and its script support. In the
Package Manager, choose **Add package from git URL** and enter:

```text
https://github.com/UXCentury/open-bone.git#upm
```

## Documentation

- [C# runtime](https://github.com/UXCentury/open-bone/blob/main/runtimes/csharp/README.md)
- [Scripts in the runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md#11-scripts)
- [Unity package](https://github.com/UXCentury/open-bone/blob/main/runtimes/csharp/unity/com.openbone.runtime/README.md)
- [Changelog](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md)

## License

MIT. Copyright (c) UX Century and OpenBone contributors. See
[LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE). Jint is BSD-2-Clause.
