# OpenBone.MonoGame

Play OpenBone animations and interactive state machines in MonoGame (DesktopGL) games.

[OpenBone](https://github.com/UXCentury/open-bone) is open-source 2D skeletal animation: Spine-style rigging and
Rive-style interactive state machines. This package connects the
[OpenBone.Runtime](https://www.nuget.org/packages/OpenBone.Runtime) C# runtime to [MonoGame](https://monogame.net)
DesktopGL. It loads a `.obone` or `.obonb` file with its textures and sounds, sends mouse and touch input to
state-machine listeners, plays audio commands with `SoundEffect`, and draws the result. State-machine scripts run in
[OpenBone.Scripting.Jint](https://www.nuget.org/packages/OpenBone.Scripting.Jint). It targets net8.0.

## Install

```bash
dotnet add package OpenBone.MonoGame
```

This also installs OpenBone.Runtime, OpenBone.Scripting.Jint and MonoGame.Framework.DesktopGL.

## Quick start

```csharp
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using OpenBone.MonoGame;

public class Game1 : Game
{
    readonly GraphicsDeviceManager graphics;
    OpenBoneMonoGame knight;

    public Game1()
    {
        graphics = new GraphicsDeviceManager(this)
        {
            // Clipping masks use the stencil buffer.
            PreferredDepthStencilFormat = DepthFormat.Depth24Stencil8,
        };
        IsMouseVisible = true;
    }

    protected override void LoadContent()
    {
        // Images and sounds are found relative to the file (or embedded as data: URIs).
        knight = OpenBoneMonoGame.Load(GraphicsDevice, "Content/knight.obone");
        knight.UseStateMachine("knight");            // or: knight.Play("walk");
        knight.Event += e => System.Console.WriteLine($"event {e.Name}");
        knight.AcceptInput = () => IsActive;          // ignore the mouse while the window is in the background
    }

    protected override void Update(GameTime gameTime)
    {
        knight.Update(gameTime);                      // pointer input -> listeners, advance, sound fades
        base.Update(gameTime);
    }

    protected override void Draw(GameTime gameTime)
    {
        GraphicsDevice.Clear(Color.CornflowerBlue);
        knight.Draw();                                // no SpriteBatch needed
        base.Draw(gameTime);
    }

    protected override void UnloadContent() => knight.Dispose();
}
```

Drive the state machine from code with `knight.StateMachine.SetInput("walk", true)` and
`knight.StateMachine.Fire("attack")`.

## Main API

| Type | What it does |
|---|---|
| `OpenBoneMonoGame` | One document in your game. `Load(device, path, options)`, `Play`, `UseStateMachine`, `SetSkin`, `Update`, `Draw`, `Pointer(type, screenPosition)`, `BoneScreenPosition`, `ScreenToSkeleton`. Settings: `View`, `AutoFit`, `FitPadding`, `TimeScale`, `PointerInput`, `AcceptInput`. Events: `Event`, `StateChanged`, `AudioCommand`, `Warning`, `PointerSent`. Gives access to `Instance`, `Renderer`, `Textures` and `Sound`. |
| `OpenBoneMonoGameOptions` | `ScriptHost` (default: a `JintScriptHost`), `DisableScripts`, `Sound` (default true), `Skin`. |
| `OpenBoneRenderer` | Draws a draw list with `DrawUserIndexedPrimitives`: one draw call per run of items that share a texture, blend mode and clip. Premultiplied alpha, normal / additive / multiply / screen blending, stencil clipping, two-colour tint. `LastDrawCalls`, `EffectError`, `UseTintEffect`, `Effect` (your own effect), `TextRenderer`. |
| `OpenBoneTextures` | Loads the document's images and atlas pages as premultiplied `Texture2D`s, from data URIs or files. `Set(id, texture)` supplies your own. |
| `OpenBoneSoundPlayer` | Plays audio commands with `SoundEffectInstance`: buses, master volume, rate as pitch (clamped to one octave), looping and fades. Loads WAV sounds; `Set(assetId, effect)` supplies other `SoundEffect`s. |
| `SkeletonView` | Maps skeleton space (y up) to screen pixels. `FitStage(doc, viewport, padding)` frames the document's artboard. |
| `SpriteFontTextRenderer` | Draws text attachments with your SpriteFonts. Without a text renderer, text is skipped. |

You can also use the parts on their own with an `OpenBoneInstance` you create yourself:

```csharp
var textures = OpenBoneTextures.Load(GraphicsDevice, doc, "Content");
var renderer = new OpenBoneRenderer(GraphicsDevice);
var sound = new OpenBoneSoundPlayer(doc, "Content");
instance.AudioCommand += sound.Handle;
var view = SkeletonView.FitStage(doc, GraphicsDevice.Viewport.Bounds, 16);

// Every frame:
instance.Advance(dt);
sound.Update(dt);
renderer.Draw(instance, textures, view);
```

## Notes

- The back buffer, or your render target, needs a stencil format such as `DepthFormat.Depth24Stencil8` for clipping
  masks.
- The two-colour tint effect is built in code for OpenGL, so no content pipeline step is needed. If MonoGame does not
  accept it, the renderer falls back to `BasicEffect`, which draws everything except the dark tint colour.
  `Renderer.EffectError` says why. The HLSL source is included as `Shaders/OpenBoneTint.fx`.
- Problems found while loading (for example a missing image) are raised on `Warning` inside `Load`, before you can
  subscribe. Texture warnings are also kept in `knight.Textures.Warnings`.
- Tested on Linux (OpenGL). Not yet run on Windows or macOS.

## Sample

The repository has a DesktopGL sample that plays the knight example. Click his body to attack, his head to salute, or
the road to walk:

```bash
git clone https://github.com/UXCentury/open-bone.git
cd open-bone/runtimes/csharp/monogame
dotnet run --project sample/OpenBone.MonoGame.Sample
```

It also takes a file, `--state-machine`, `--animation`, and `--screenshot out.png --frames 60 --click x,y@frame` to
render off-screen to a PNG.

## Unity

This package is for MonoGame. Unity users should install the `com.openbone.runtime` package instead: in the Package
Manager, choose **Add package from git URL** and enter:

```text
https://github.com/UXCentury/open-bone.git#upm
```

## Documentation

- [MonoGame section of the C# runtime README](https://github.com/UXCentury/open-bone/blob/main/runtimes/csharp/README.md#monogame)
- [C# runtime](https://github.com/UXCentury/open-bone/blob/main/runtimes/csharp/README.md)
- [Runtime specification](https://github.com/UXCentury/open-bone/blob/main/docs/runtime-spec.md)
- [Changelog](https://github.com/UXCentury/open-bone/blob/main/CHANGELOG.md)

## License

MIT. Copyright (c) UX Century and OpenBone contributors. See
[LICENSE](https://github.com/UXCentury/open-bone/blob/main/LICENSE). MonoGame is Ms-PL.
